import db, { stmts } from '../../db/db.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { client, sendWhatsappSeen, resolveContactPhone, syncChatUnreadCountFromWhatsapp } from '../services/whatsapp.service.js';
import { releaseAttachmentFiles } from '../services/cleanup.service.js';
import { getAvatarUrl, renderAvatarImg } from '../services/avatar.service.js';
import {
  CONTACT_NAME_PRIORITY,
  formatWhatsappIdentifier,
  getContactDisplayName,
} from '../utils/contact-display-name.js';
import {
  DIRECTORY_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  escapeXml,
  formatPhoneNumber,
  getMessageDateInfo,
  buildMemberColorMap,
  getLetterBucket,
  getMemberColor,
  getTotal,
  isNumericOrJid,
  renderAckLabel,
  renderList,
  renderMediaLine,
  renderMessageDateSeparator,
  renderMentions,
  renderPollLine,
  renderNumberedPager,
  renderPager,
  renderPhoneLink,
  renderMessageActions,
  sendInvalidEntity,
  sendMissingEntity,
  sendPage,
  toPositiveInt,
  truncateName,
} from './page.controller.js';

// Un nombre de grupo "necesita resolución" cuando aún no tenemos el nombre real:
// vacío, el placeholder genérico, o el ID/JID en crudo (lo que el usuario ve como "sale el ID").
export function groupNameNeedsResolution(name) {
  return !name || name === 'Grupo sin nombre' || isNumericOrJid(name);
}

// whatsapp-web.js@1.34.7 falla (error interno opaco de la propia web de WhatsApp,
// del tipo "r: r") al construir el modelo completo del chat con client.getChatById()
// / client.getChats() para algunos grupos: es un bug conocido y aún abierto de la
// librería (github.com/wwebjs/whatsapp-web.js issue #201845), no un fallo de esta app.
// Internamente eso ocurre porque, para construir el chat completo, la librería
// SIEMPRE intenta refrescar los metadatos del grupo (participantes, admins, etc.)
// con "groupMetadata.update(chatWid)" — y es justo esa llamada la que revienta para
// estos grupos concretos (según los reportes, sobre todo grupos vinculados a una
// Comunidad de WhatsApp). Para el nombre no necesitamos esos metadatos: aquí se pide
// directamente el chat "en crudo" a la colección interna de WhatsApp (sin refrescar
// metadatos), evitando así la llamada que falla.
async function resolveGroupTitleDirectly(groupId) {
  if (!client?.pupPage) return null;
  try {
    const result = await client.pupPage.evaluate(async (chatId) => {
      const chatWid = window.require('WAWebWidFactory').createWid(chatId);
      let chat = window.require('WAWebCollections').Chat.get(chatWid);
      if (!chat) {
        const found = await window
          .require('WAWebFindChatAction')
          .findOrCreateLatestChat(chatWid);
        chat = found?.chat;
      }
      return {
        title: chat?.formattedTitle || chat?.name || null,
        // Metadatos ya cacheados (si los hay), sin forzar un refresco a WhatsApp:
        // sirve para saber si el grupo está vinculado a una Comunidad.
        hasParentCommunity: !!chat?.groupMetadata?.parentGroupId,
      };
    }, groupId);

    if (result?.hasParentCommunity) {
      console.log(`[grupo] ${groupId} está vinculado a una Comunidad de WhatsApp.`);
    }
    if (result?.title && !isNumericOrJid(result.title)) {
      return result.title;
    }
  } catch (err) {
    console.warn(`[grupo] resolveGroupTitleDirectly falló para ${groupId}:`, err?.name, err?.message);
  }
  return null;
}

// Igual que resolveGroupTitleDirectly, pero pidiendo también participantes/admins/
// descripción. En vez de la colección que revienta ("groupMetadata.update()"), usa el
// job de red que la propia librería usa internamente antes de añadir participantes
// (GroupChat.addParticipants()) — es una llamada distinta, no la misma implicada en el
// bug "r: r", aunque no hay garantía de que esté libre del mismo problema en todos los
// grupos. Nunca lanza excepción: si algo falla devuelve null y el controlador cae al
// respaldo con datos locales.
async function fetchGroupDetailsDirectly(groupId) {
  if (!client?.pupPage) return null;
  try {
    return await client.pupPage.evaluate(async (chatId) => {
      const chatWid = window.require('WAWebWidFactory').createWid(chatId);
      let chat = window.require('WAWebCollections').Chat.get(chatWid);
      if (!chat) {
        const found = await window
          .require('WAWebFindChatAction')
          .findOrCreateLatestChat(chatWid);
        chat = found?.chat;
      }
      if (!chat) return null;

      try {
        await window
          .require('WAWebGroupQueryJob')
          .queryAndUpdateGroupMetadataById({ id: chatId });
      } catch (e) {
        // Seguimos con lo que ya hubiera en caché, aunque el refresco fallara.
      }

      const md = chat.groupMetadata;
      if (!md) return null;
      const serialized = typeof md.serialize === 'function' ? md.serialize() : md;
      return {
        owner: serialized.owner?._serialized || serialized.owner || null,
        creation: serialized.creation || null,
        desc: serialized.desc || null,
        participants: (serialized.participants || []).map((p) => ({
          id: p.id?._serialized || p.id,
          isAdmin: !!p.isAdmin,
          isSuperAdmin: !!p.isSuperAdmin,
        })),
        hasParentCommunity: !!serialized.parentGroupId,
      };
    }, groupId);
  } catch (err) {
    console.warn(`[grupo] fetchGroupDetailsDirectly falló para ${groupId}:`, err?.name, err?.message);
    return null;
  }
}

export async function resolveGroupNameFromWhatsapp(groupId) {
  if (!client || !groupId) return null;

  const directTitle = await resolveGroupTitleDirectly(groupId);
  if (directTitle) return directTitle;

  // Respaldo por si la vía directa no está disponible por cualquier motivo
  // (p. ej. si en el futuro cambia la estructura interna de WhatsApp Web).
  if (typeof client.getChatById === 'function') {
    try {
      const chat = await client.getChatById(groupId);
      if (chat?.name && !isNumericOrJid(chat.name)) {
        return chat.name;
      }
    } catch (err) {
      console.warn(`[grupo] getChatById falló para ${groupId}:`, err?.name, err?.message);
    }
  }
  return null;
}

// Punto único usado por todas las vistas que muestran group_name: si el nombre
// guardado todavía no es válido, intenta resolverlo contra WhatsApp y persiste el
// resultado. Antes cada vista tenía su propia condición (algunas comprobaban
// "Grupo sin nombre", otras no), así que un mismo grupo podía autocorregirse en un
// sitio y seguir mostrando el ID/placeholder en otro.
export async function ensureGroupDisplayName(group) {
  if (!group || !groupNameNeedsResolution(group.group_name)) {
    return group;
  }
  const resolvedName = await resolveGroupNameFromWhatsapp(group.group_id);
  if (resolvedName) {
    stmts.upsertGroup.run(group.group_id, resolvedName);
    return { ...group, group_name: resolvedName };
  }
  return group;
}

export async function ensureGroupDisplayNames(groups) {
  const resolved = [];
  for (let offset = 0; offset < groups.length; offset += 6) {
    const batch = groups.slice(offset, offset + 6);
    resolved.push(...await Promise.all(batch.map(ensureGroupDisplayName)));
  }
  return resolved;
}

// La lista de participantes no debe depender de que alguien haya escrito antes
// en el grupo. Se actualiza al abrirla para que un contacto recién guardado
// reemplace enseguida su perfil o teléfono en la base local.
async function resolveParticipantDisplayName(chatId, storedUser) {
  if (!chatId) return 'Desconocido';

  try {
    const contact = client ? await client.getContactById(chatId) : null;
    const contactName = getContactDisplayName(contact);
    if (contactName) {
      stmts.upsertUserNameIfPreferred.run(chatId, contactName.name, contactName.priority);
      return contactName.name;
    }
  } catch (err) {
    console.debug(`[grupo] No se pudo resolver el contacto ${chatId}:`, err?.message || err);
  }

  // Un nombre de agenda o perfil ya conocido sigue siendo preferible al teléfono
  // si WhatsApp no puede responder temporalmente.
  if (storedUser?.username && storedUser.name_priority >= CONTACT_NAME_PRIORITY.PROFILE_NAME) {
    return storedUser.username;
  }

  const personalPhone = await resolveContactPhone(chatId);
  if (personalPhone) {
    stmts.upsertUserNameIfPreferred.run(chatId, personalPhone, CONTACT_NAME_PRIORITY.PERSONAL_PHONE);
    return personalPhone;
  }

  if (storedUser?.username) return storedUser.username;
  return formatWhatsappIdentifier(chatId);
}

export async function listGroups(req, res, next) {
  try {
    const requestedPage = toPositiveInt(req.query.p, 1);
    const total = stmts.countDirectoryGroups.get().total;
    const totalPages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * DIRECTORY_PAGE_SIZE;

    const resolvedGroups = await ensureGroupDisplayNames(
      stmts.getDirectoryGroupsPage.all(DIRECTORY_PAGE_SIZE, offset)
    );
    const nameCollator = new Intl.Collator('es', { sensitivity: 'base' });
    resolvedGroups.sort((a, b) =>
      nameCollator.compare(a.group_name || '', b.group_name || '') || a.group_id.localeCompare(b.group_id)
    );

    const body =
      '<h1>Grupos</h1>' +
      '<p><a href="/">Inicio</a></p>' +
      renderNumberedPager('/grupo', page, totalPages) +
      renderList(resolvedGroups, (group) => `/grupo/${group.group_id}`, (group) => `${truncateName(group.group_name)}[${group.unseen_count}]`, 'Sin grupos.', (group) => getLetterBucket(group.group_name)) +
      renderNumberedPager('/grupo', page, totalPages);

    sendPage(req, res, 200, 'Grupos', body);
  } catch (error) {
    next(error);
  }
}

// Recorre todos los grupos con nombre pendiente de resolución y los corrige. Lo
// llama whatsapp.service.js en cada conexión, para que los grupos atascados se
// autocorrijan solos sin que nadie tenga que visitar ninguna página a mano.
export async function resolvePendingGroupNames() {
  const groups = db.prepare('SELECT group_id, group_name FROM wgroups').all();
  const pending = groups.filter((group) => groupNameNeedsResolution(group.group_name));

  return Promise.all(pending.map(async (group) => {
    const resolvedName = await resolveGroupNameFromWhatsapp(group.group_id);
    if (resolvedName) {
      stmts.upsertGroup.run(group.group_id, resolvedName);
      return { group_id: group.group_id, old_name: group.group_name, new_name: resolvedName, status: 'actualizado' };
    }
    return { group_id: group.group_id, old_name: group.group_name, new_name: null, status: 'sin cambios' };
  }));
}

export async function showGroupMessages(req, res, next) {
  try {
    const groupId = req.params.id;
    if (!groupId || typeof groupId !== 'string' || groupId.trim() === '') {
      sendInvalidEntity(req, res, 'Grupo');
      return;
    }

    const groupRows = stmts.getGroupById.get(groupId);

    if (!groupRows) {
      sendMissingEntity(req, res, 'Grupo');
      return;
    }

    await syncChatUnreadCountFromWhatsapp(groupId);
    const group = await ensureGroupDisplayName(stmts.getGroupById.get(groupId) || groupRows);
    const unseenCount = group.unseen_count;

    stmts.resetGroupUnseen.run(groupId);

    // Enviar visto por WhatsApp si el ajuste está activo y había mensajes no vistos
    if (unseenCount > 0 && process.env.SEND_READ_RECEIPTS_ENABLED === 'true') {
      sendWhatsappSeen(groupId).catch(() => {});
    }

    const total = getTotal(stmts.countGroupMessages, groupId);
    const totalPages = Math.max(1, Math.ceil(total / MESSAGE_PAGE_SIZE));
    const page = Math.min(toPositiveInt(req.query.p, 1), totalPages);
    const offset = (page - 1) * MESSAGE_PAGE_SIZE;

    const messages = stmts.getGroupMessagesPaginated.all(groupId, MESSAGE_PAGE_SIZE, offset);
    const newMessageCount = unseenCount;

    // Reparto de colores sin colisiones para todo el grupo (no solo esta página de
    // mensajes), así el color de cada persona es el mismo en cualquier página y
    // coincide con el que se ve en /grupo/:id/detalles.
    const memberColorMap = buildMemberColorMap(
      stmts.getParticipantsByGroupId.all(groupId).map((p) => p.chat_id)
    );

    let messagesHtml = '';
    if (messages.length === 0) {
      messagesHtml = '<p>Sin mensajes.</p>';
    } else {
      let previousDate = null;
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const isNew = index < newMessageCount;
        const unseenMarker = isNew ? '<font color="#cc0000">[!]</font> ' : '';
        const sentAt = formatHourSend(message.hour_send);
        const dateInfo = getMessageDateInfo(message);
        const dateSeparator = dateInfo?.label && dateInfo.key !== previousDate
          ? renderMessageDateSeparator(dateInfo.label)
          : '';
        if (dateInfo) previousDate = dateInfo.key;

        if (Number(message.is_system) === 1) {
          messagesHtml += `${dateSeparator}<p align="center">${unseenMarker}<i><font size="1" color="#888888">${escapeXml(sentAt)} — ${renderMentions(message.text)}</font></i></p>`;
          continue;
        }

        const mediaLine = renderMediaLine(message, { linkToDetail: `/mensaje/${message.id}` });
        const pollLine = message.media_type === 'poll'
          ? renderPollLine(message, stmts.getPollOptionCountsByMessageId.all(message.id), { linkToDetail: `/mensaje/${message.id}` })
          : null;
        let contentPart;
        if (mediaLine) {
          contentPart = mediaLine;
        } else if (pollLine) {
          contentPart = pollLine;
        } else if (message.has_media && message.file_path_thumb) {
          contentPart = `<img src="${escapeXml(message.file_path_thumb)}" width="40" alt="thumb"/> <a href="/mensaje/${message.id}">[Ver]</a>`;
        } else if (Number(message.is_sticker) === 1) {
          contentPart = '<i>[Sticker]</i>';
        } else {
          contentPart = renderMentions(message.text);
        }
        // Un mensaje borrado se sigue mostrando, marcado en rojo como «(borrado)».
        const editedTag = Number(message.is_deleted) === 1
          ? ' <font size="1" color="#cc0000">(borrado)</font>'
          : Number(message.is_edited) === 1
            ? ' <font size="1" color="#888888">(editado)</font>'
            : '';

        const isSaliente = Number(message.from_me) === 1;
        const fromMeMarker = isSaliente
          ? `<font color="#006600">[Yo]</font> ${renderAckLabel(message.ack_status)}`
          : '';
        const messageActions = renderMessageActions(message, group.group_id, 'group');

        const senderColor = getMemberColor(message.user_chat_id, memberColorMap);
        const usernameLine = isSaliente
          ? ''
          : `<font size="1" color="${senderColor}">[${message.username ? escapeXml(truncateName(convertEmojisToAscii(message.username))) : 'Desconocido'}] dice:</font><br/>`;

        let quotedBlock = '';
        if (message.quoted_text || message.quoted_sender) {
          const quotedTag = message.quoted_sender ? `R-${escapeXml(message.quoted_sender)}` : 'R';
          const quotedPreview = message.quoted_text
            ? escapeXml(truncateName(message.quoted_text, 80))
            : '(no disponible)';
          quotedBlock = `<i><font size="1" color="#888888">[${quotedTag}]-&quot;${quotedPreview}&quot;</font></i><br/>`;
        }

        messagesHtml +=
          `${dateSeparator}<p>${unseenMarker}<font size="1" color="#666666">${escapeXml(sentAt)}</font>${editedTag}${messageActions}${messageActions && fromMeMarker ? '<br/>' : ''}${fromMeMarker}<br/>` +
          usernameLine +
          quotedBlock +
          `<font size="1" color="#000000">${contentPart}</font><br/>` +
          `----------</p>`;
      }
    }

    const isMuted = Number(group.sms_muted) === 1;
    const muteLabel = isMuted ? 'Activar SMS' : 'Silenciar SMS';
    const muteIcon = isMuted ? 'Bell_Red.png' : 'Bell_Green.png';

    const iconTag = (file, alt) =>
      `<img src="/assets/groups_icons/${file}" alt="${escapeXml(alt)}" height="24" width="24" style="vertical-align:middle;"/>`;

    const avatarHtml = renderAvatarImg(await getAvatarUrl(group.group_id, 'mini'), 'mini');
    const body =
      `<h1>${avatarHtml ? `${avatarHtml} ` : ''}${escapeXml(group.group_name)}</h1>` +
      '<p><a href="/">Inicio</a> | <a href="/grupo">Grupos</a></p>' +
      `<p><a href="/mensaje/componer?to=${encodeURIComponent(group.group_id)}&type=group">${iconTag('Writing_Lightgreen.png', 'Enviar mensaje al grupo')}</a> ` +
      `<a href="/grupo/${encodeURIComponent(group.group_id)}/silenciar">${iconTag(muteIcon, muteLabel)}</a> ` +
      `<a href="/grupo/${encodeURIComponent(group.group_id)}/detalles">${iconTag('Questionmark_Blue.png', 'Detalles')}</a> ` +
      `<a href="/grupo/${encodeURIComponent(group.group_id)}/eliminar">${iconTag('Warning_Red.png', 'Eliminar')}</a></p>` +
      renderPager(`/grupo/${group.group_id}`, page, totalPages) +
      messagesHtml +
      renderPager(`/grupo/${group.group_id}`, page, totalPages);

    sendPage(req, res, 200, group.group_name, body);
  } catch (error) {
    next(error);
  }
}

export async function showGroupDetails(req, res, next) {
  try {
    const groupId = req.params.id;
    if (!groupId || typeof groupId !== 'string' || groupId.trim() === '') {
      sendInvalidEntity(req, res, 'Grupo');
      return;
    }

    const groupRow = stmts.getGroupById.get(groupId);
    if (!groupRow) {
      sendMissingEntity(req, res, 'Grupo');
      return;
    }
    const group = await ensureGroupDisplayName(groupRow);

    const [details, bigAvatarUrl] = await Promise.all([
      fetchGroupDetailsDirectly(groupId),
      getAvatarUrl(groupId, 'big'),
    ]);

    // Misma estética que Detalles de usuario: cabecera centrada, bloques con título en
    // negrita separados por <hr/> y acción de escribir al final.
    const encodedGroupId = encodeURIComponent(groupId);
    const isMuted = Number(groupRow.sms_muted) === 1;
    const navHtml =
      '<p><font size="1"><a href="/">Inicio</a> | <a href="/grupo">Grupos</a> | ' +
      `<a href="/grupo/${encodedGroupId}">Chat</a></font></p>`;
    const renderHeader = (subtitle) =>
      '<p align="center">' +
      (bigAvatarUrl
        ? `${renderAvatarImg(bigAvatarUrl, 'big', 'Icono del grupo')}<br/>`
        : '<font size="1" color="#888888">(sin icono)</font><br/>') +
      `<b>${escapeXml(group.group_name)}</b>` +
      (subtitle ? `<br/><font size="1" color="#666666">${subtitle}</font>` : '') +
      '</p>';
    const smsHtml =
      `<p><b>Avisos SMS:</b> ${isMuted ? '<font color="#cc0000">silenciados</font>' : '<font color="#008800">activos</font>'}` +
      `<br/><a href="/grupo/${encodedGroupId}/silenciar?volver=detalles">[${isMuted ? 'Activar' : 'Silenciar'}]</a></p>`;
    const footerHtml =
      '<hr/>' +
      `<p align="center"><a href="/mensaje/componer?to=${encodedGroupId}&amp;type=group">Escribir al grupo</a></p>`;

    if (!details) {
      const fallbackParticipants = stmts.getParticipantsByGroupId.all(groupId);
      const body =
        navHtml +
        renderHeader('Grupo') +
        '<hr/>' +
        '<p><font size="1" color="#cc0000">WhatsApp no ha dado los detalles ahora mismo. ' +
        'Abre el grupo en el móvil y vuelve a intentarlo.</font></p>' +
        smsHtml +
        `<p><b>Vistos escribiendo (${fallbackParticipants.length}):</b><br/>` +
        (fallbackParticipants.length
          ? fallbackParticipants.map((p) => `- ${escapeXml(p.username || p.chat_id)}`).join('<br/>')
          : '<font color="#888888">sin datos</font>') +
        '</p>' +
        footerHtml;

      sendPage(req, res, 200, `${group.group_name} - Detalles`, body);
      return;
    }

    // Partimos de la caché local, pero refrescamos los contactos en WhatsApp para
    // que una persona desconocida muestre su perfil y un contacto recién añadido
    // muestre el nombre de agenda sin esperar a que mande un mensaje.
    const ids = details.participants.map((p) => p.id).filter(Boolean);
    const namesByChatId = new Map();
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT chat_id, username, name_priority FROM users WHERE chat_id IN (${placeholders})`)
        .all(...ids);
      const storedUsersByChatId = new Map(rows.map((r) => [r.chat_id, r]));

      // Limitar la concurrencia evita saturar WhatsApp Web en grupos grandes.
      for (let offset = 0; offset < ids.length; offset += 6) {
        const batch = ids.slice(offset, offset + 6);
        const refreshed = await Promise.all(batch.map(async (id) => [
          id,
          await resolveParticipantDisplayName(id, storedUsersByChatId.get(id)),
        ]));
        refreshed.forEach(([id, name]) => namesByChatId.set(id, name));
      }
    }

    const resolveDisplay = (id) => namesByChatId.get(id) || formatPhoneNumber(id) || id;
    if (details.owner && !namesByChatId.get(details.owner)) {
      const ownerPhone = await resolveContactPhone(details.owner);
      if (ownerPhone) namesByChatId.set(details.owner, ownerPhone);
    }

    const participantCount = details.participants.length;
    let body =
      navHtml +
      renderHeader(`Grupo &#183; ${participantCount} participante${participantCount === 1 ? '' : 's'}`) +
      '<hr/>';

    if (details.desc) {
      body += `<p><b>Descripción:</b><br/><i>${escapeXml(details.desc)}</i></p>`;
    }
    const infoLines = [];
    if (details.creation) {
      const createdDate = new Date(details.creation * 1000);
      infoLines.push(`Creado: ${escapeXml(createdDate.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' }))}`);
    }
    if (details.owner) {
      infoLines.push(`Creador: ${escapeXml(resolveDisplay(details.owner))}`);
    }
    if (details.hasParentCommunity) {
      infoLines.push('Parte de una Comunidad');
    }
    if (infoLines.length) {
      body += `<p><b>Info:</b><br/><font size="1">${infoLines.join('<br/>')}</font></p>`;
    }
    body += smsHtml;

    // "Anteriores" = gente vista escribiendo en el grupo (tabla local) que ya no
    // aparece en la lista en vivo de WhatsApp. No hay fecha de salida, solo lo sabemos.
    const currentIds = new Set(details.participants.map((p) => p.id));
    const localParticipants = stmts.getParticipantsByGroupId.all(groupId);
    const pastParticipants = localParticipants.filter((p) => !currentIds.has(p.chat_id));

    // Reparto de colores sin colisiones: actuales + anteriores juntos, y usando el
    // mismo conjunto que showGroupMessages (participantes locales) para que la misma
    // persona se vea del mismo color aquí y en el historial de mensajes.
    const memberColorMap = buildMemberColorMap([
      ...localParticipants.map((p) => p.chat_id),
      ...details.participants.map((p) => p.id),
    ]);

    const sortedParticipants = [...details.participants].sort((a, b) => {
      const rank = (p) => (p.isSuperAdmin ? 0 : p.isAdmin ? 1 : 2);
      const rankDiff = rank(a) - rank(b);
      if (rankDiff !== 0) return rankDiff;
      return resolveDisplay(a.id).localeCompare(resolveDisplay(b.id), 'es', { sensitivity: 'base' });
    });

    // Teléfonos resueltos en paralelo para todos los ids implicados (actuales +
    // anteriores) — solo se hace aquí, no por mensaje en el historial.
    const allPhoneIds = [...currentIds, ...pastParticipants.map((p) => p.chat_id)];
    const phoneEntries = await Promise.all(
      allPhoneIds.map(async (id) => {
        const phone = id ? await resolveContactPhone(id) : null;
        return [id, phone || formatPhoneNumber(id)];
      })
    );
    const phoneByChatId = new Map(phoneEntries);

    // Una persona por línea, con su color del chat; rol en pequeño y teléfono debajo.
    const renderMember = (id, name, roleTag = '') => {
      const phone = phoneByChatId.get(id);
      return `- <font color="${getMemberColor(id, memberColorMap)}">${escapeXml(name)}</font>${roleTag}` +
        (phone ? `<br/>&#160;&#160;${renderPhoneLink(phone)}` : '');
    };
    body +=
      `<p><b>Participantes (${participantCount}):</b><br/>` +
      sortedParticipants
        .map((p) => {
          const roleTag = p.isSuperAdmin
            ? ' <font color="#cc0000">[Super Admin]</font>'
            : p.isAdmin
              ? ' <font color="#0000cc">[Admin]</font>'
              : '';
          return renderMember(p.id, resolveDisplay(p.id), roleTag);
        })
        .join('<br/>') +
      '</p>';

    if (pastParticipants.length) {
      body +=
        `<p><b>Ya no están (${pastParticipants.length}):</b><br/>` +
        `<font size="1" color="#666666">${pastParticipants
          .map((p) => renderMember(p.chat_id, p.username || p.chat_id))
          .join('<br/>')}</font></p>`;
    }

    body += footerHtml;

    sendPage(req, res, 200, `${group.group_name} - Detalles`, body);
  } catch (error) {
    next(error);
  }
}

export async function toggleGroupMute(req, res, next) {
  try {
    const groupId = req.params.id;
    const group = stmts.getGroupById.get(groupId);
    if (!group) {
      sendMissingEntity(req, res, 'Grupo');
      return;
    }

    const newState = Number(group.sms_muted) === 1 ? 0 : 1;
    stmts.setGroupSmsMuted.run(newState, groupId);

    const backUrl = req.query.volver === 'detalles'
      ? `/grupo/${encodeURIComponent(groupId)}/detalles`
      : `/grupo/${encodeURIComponent(groupId)}`;
    const body = `<p><a href="${backUrl}">Volver</a></p>`;
    sendPage(req, res, 200, 'Nokia', body, `<meta http-equiv="refresh" content="0;url=${backUrl}"/>`);
  } catch (error) {
    next(error);
  }
}

export async function confirmDeleteGroup(req, res, next) {
  try {
    const groupId = req.params.id;
    const groupRow = stmts.getGroupById.get(groupId);
    if (!groupRow) {
      sendMissingEntity(req, res, 'Grupo');
      return;
    }
    const group = await ensureGroupDisplayName(groupRow);

    const body =
      `<h1>Eliminar</h1>` +
      `<p>¿Eliminar el grupo ${escapeXml(group.group_name)}? Se borrará el historial ` +
      `guardado en el Nokia. El grupo de WhatsApp en el móvil no se ve afectado.</p>` +
      `<form action="/grupo/${encodeURIComponent(groupId)}/eliminar" method="POST">` +
      `<p><input type="submit" value="Si, eliminar"/> ` +
      `<a href="/grupo/${encodeURIComponent(groupId)}">Cancelar</a></p>` +
      `</form>`;

    sendPage(req, res, 200, 'Eliminar grupo', body);
  } catch (error) {
    next(error);
  }
}

export async function deleteGroup(req, res, next) {
  try {
    const groupId = req.params.id;
    const group = stmts.getGroupById.get(groupId);
    if (!group) {
      sendMissingEntity(req, res, 'Grupo');
      return;
    }

    const attachments = stmts.getAttachmentsByGroupId.all(groupId);

    db.exec('BEGIN');
    try {
      stmts.deleteAttachmentsByGroupId.run(groupId);
      stmts.deleteMessagesByGroupId.run(groupId);
      stmts.deleteParticipantsByGroupId.run(groupId);
      stmts.deleteGroupRow.run(groupId);

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    releaseAttachmentFiles(attachments);

    const body =
      '<h1>Nokia</h1>' +
      '<p>Eliminado.</p>' +
      '<p><a href="/grupo">Grupos</a></p>';
    sendPage(req, res, 200, 'Eliminado', body, '<meta http-equiv="refresh" content="2;url=/grupo"/>');
  } catch (error) {
    next(error);
  }
}



function formatHourSend(hourSend) {
  if (!hourSend) return "00:00";
  if (typeof hourSend === 'string') {
    const match = hourSend.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
    if (match) return match[2];
  }
  const ms = typeof hourSend === 'number' && hourSend < 2000000000 ? hourSend * 1000 : Number(hourSend);
  const date = new Date(ms);
  if (isNaN(date.getTime())) return "00:00";
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}
