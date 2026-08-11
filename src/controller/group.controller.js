import db, { stmts } from '../../db/db.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { client, sendWhatsappSeen, resolveContactPhone } from '../services/whatsapp.service.js';
import { resolveMediaFsPath, safeUnlink } from '../services/cleanup.service.js';
import {
  DIRECTORY_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  escapeXml,
  formatPhoneNumber,
  buildMemberColorMap,
  getLetterBucket,
  getMemberColor,
  getTotal,
  isNumericOrJid,
  renderAckLabel,
  renderList,
  renderMentions,
  renderNumberedPager,
  renderPager,
  renderPhoneLink,
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

export async function listGroups(req, res, next) {
  try {
    // Resolvemos los nombres pendientes ANTES de ordenar, para que el orden alfabético
    // y las cabeceras de letra reflejen el nombre real y no el ID/JID en crudo.
    const allGroups = await Promise.all(stmts.getAllGroups.all().map(ensureGroupDisplayName));
    allGroups.sort((a, b) =>
      (a.group_name || '').localeCompare(b.group_name || '', 'es', { sensitivity: 'base' })
    );

    const requestedPage = toPositiveInt(req.query.p, 1);
    const totalPages = Math.max(1, Math.ceil(allGroups.length / DIRECTORY_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * DIRECTORY_PAGE_SIZE;

    const resolvedGroups = allGroups.slice(offset, offset + DIRECTORY_PAGE_SIZE);

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

    const group = await ensureGroupDisplayName(groupRows);
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
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const isNew = index < newMessageCount;
        const unseenMarker = isNew ? '<font color="#cc0000">[!]</font> ' : '';
        const sentAt = formatHourSend(message.hour_send);
        let contentPart;
        if (message.has_media && message.file_path_thumb) {
          contentPart = `<img src="${escapeXml(message.file_path_thumb)}" width="40" alt="thumb"/> <a href="/mensaje/${message.id}">[Ver]</a>`;
        } else if (Number(message.is_sticker) === 1) {
          contentPart = '<i>[Sticker]</i>';
        } else {
          contentPart = renderMentions(message.text);
        }

        const isSaliente = Number(message.from_me) === 1;
        const fromMeMarker = isSaliente
          ? `<font color="#006600">[Yo]</font> ${renderAckLabel(message.ack_status)}`
          : '';

        const senderColor = getMemberColor(message.user_chat_id, memberColorMap);
        const usernameLine = isSaliente
          ? ''
          : `<font size="1" color="${senderColor}">[${message.username ? escapeXml(truncateName(convertEmojisToAscii(message.username))) : 'Desconocido'}] dice:</font><br/>`;

        messagesHtml +=
          `<p>${unseenMarker}${fromMeMarker}<font size="1" color="#666666">${escapeXml(sentAt)}</font><br/>` +
          usernameLine +
          `<font size="1" color="#000000">${contentPart}</font><br/>` +
          `----------</p>`;
      }
    }

    const isMuted = Number(group.sms_muted) === 1;
    const muteLabel = isMuted ? 'Activar SMS' : 'Silenciar SMS';

    const body =
      `<h1>${escapeXml(group.group_name)}</h1>` +
      '<p><a href="/">Inicio</a> | <a href="/grupo">Grupos</a></p>' +
      `<p><a href="/mensaje/componer?to=${encodeURIComponent(group.group_id)}&type=group"><b>[Enviar mensaje al grupo]</b></a></p>` +
      `<p><a href="/grupo/${encodeURIComponent(group.group_id)}/detalles">[Detalles]</a> | ` +
      `<a href="/grupo/${encodeURIComponent(group.group_id)}/silenciar">[${escapeXml(muteLabel)}]</a> | ` +
      `<a href="/grupo/${encodeURIComponent(group.group_id)}/eliminar">[Eliminar]</a></p>` +
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

    const details = await fetchGroupDetailsDirectly(groupId);

    let body =
      `<h1>${escapeXml(group.group_name)}</h1>` +
      '<p><a href="/">Inicio</a> | <a href="/grupo">Grupos</a> | ' +
      `<a href="/grupo/${encodeURIComponent(groupId)}">Mensajes</a></p>`;

    if (!details) {
      const fallbackParticipants = stmts.getParticipantsByGroupId.all(groupId);
      body +=
        '<p>No se han podido obtener los detalles en este momento — puede que WhatsApp ' +
        'no los tenga cacheados todavía. Prueba a abrir el grupo desde el móvil y vuelve ' +
        'a intentarlo aquí.</p>' +
        '<p>Participantes vistos escribiendo en este grupo (lista parcial, sin datos de ' +
        'quién es admin):</p>';
      body += fallbackParticipants.length
        ? '<ul>' + fallbackParticipants.map((p) => `<li>${escapeXml(p.username || p.chat_id)}</li>`).join('') + '</ul>'
        : '<p>Sin datos.</p>';

      sendPage(req, res, 200, `${group.group_name} - Detalles`, body);
      return;
    }

    // Resolver nombres locales de todos los participantes en una sola consulta,
    // en vez de una llamada async por persona (un grupo puede tener decenas de gente).
    const ids = details.participants.map((p) => p.id).filter(Boolean);
    const namesByChatId = new Map();
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT chat_id, username FROM users WHERE chat_id IN (${placeholders})`)
        .all(...ids);
      rows.forEach((r) => namesByChatId.set(r.chat_id, r.username));
    }

    const resolveDisplay = (id) => namesByChatId.get(id) || formatPhoneNumber(id) || id;

    if (details.desc) {
      body += `<p>${escapeXml(details.desc)}</p>`;
    }
    if (details.creation) {
      const createdDate = new Date(details.creation * 1000);
      body += `<p><font size="1" color="#666666">Creado: ${escapeXml(createdDate.toLocaleDateString('es-ES'))}</font></p>`;
    }
    if (details.owner) {
      body += `<p><font size="1" color="#666666">Propietario: ${escapeXml(resolveDisplay(details.owner))}</font></p>`;
    }
    if (details.hasParentCommunity) {
      body += '<p><font size="1" color="#666666">Vinculado a una Comunidad de WhatsApp.</font></p>';
    }

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
        const phone = id?.endsWith('@lid') ? await resolveContactPhone(id) : null;
        return [id, phone || formatPhoneNumber(id)];
      })
    );
    const phoneByChatId = new Map(phoneEntries);

    body += `<p>${sortedParticipants.length} participante${sortedParticipants.length === 1 ? '' : 's'}:</p>`;
    body +=
      '<ul>' +
      sortedParticipants
        .map((p) => {
          const roleTag = p.isSuperAdmin
            ? ' <font color="#cc0000">[Super Admin]</font>'
            : p.isAdmin
              ? ' <font color="#0000cc">[Admin]</font>'
              : '';
          const nameHtml = `<font color="${getMemberColor(p.id, memberColorMap)}">${escapeXml(resolveDisplay(p.id))}</font>${roleTag}`;
          const phone = phoneByChatId.get(p.id);
          const phoneHtml = phone ? `<br/>${renderPhoneLink(phone)}` : '';
          return `<li>${nameHtml}${phoneHtml}</li>`;
        })
        .join('') +
      '</ul>';

    if (pastParticipants.length) {
      body +=
        '<p><font size="1" color="#666666">Participantes anteriores (ya no están en el ' +
        'grupo, vistos en el historial):</font></p>';
      body +=
        '<ul>' +
        pastParticipants
          .map((p) => {
            const nameHtml = `<font color="${getMemberColor(p.chat_id, memberColorMap)}">${escapeXml(p.username || p.chat_id)}</font>`;
            const phone = phoneByChatId.get(p.chat_id);
            const phoneHtml = phone ? `<br/>${renderPhoneLink(phone)}` : '';
            return `<li>${nameHtml}${phoneHtml}</li>`;
          })
          .join('') +
        '</ul>';
    }

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

    const backUrl = `/grupo/${encodeURIComponent(groupId)}`;
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

    attachments.forEach((a) => {
      safeUnlink(resolveMediaFsPath(a.file_path_thumb));
      safeUnlink(resolveMediaFsPath(a.file_path_full));
      safeUnlink(resolveMediaFsPath(a.file_path_view));
    });

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
