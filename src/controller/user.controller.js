import db, { stmts } from '../../db/db.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { client, getUsersPresence, sendWhatsappSeen, resolveContactPhone, getContactProfileInfo, syncChatUnreadCountFromWhatsapp } from '../services/whatsapp.service.js';
import { getContactDisplayName } from '../utils/contact-display-name.js';
import { getAvatarUrl, renderAvatarImg } from '../services/avatar.service.js';
import { releaseAttachmentFiles } from '../services/cleanup.service.js';
import {
  DIRECTORY_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  escapeXml,
  formatPhoneNumber,
  getMessageDateInfo,
  getLetterBucket,
  getTotal,
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
  getSearchQuery,
  normalizeSearchText,
  renderDirectorySearch,
} from './page.controller.js';

export async function listUsers(req, res, next) {
  try {
    const requestedPage = toPositiveInt(req.query.p, 1);
    const query = getSearchQuery(req);
    const byName = (a, b) =>
      (a.username || '').localeCompare(b.username || '', 'es', { sensitivity: 'base' })
      || a.chat_id.localeCompare(b.chat_id);

    let users;
    let total;
    let page;
    let totalPages;
    if (query) {
      const needle = normalizeSearchText(query);
      const matches = stmts.getAllDirectoryUsers.all()
        .filter((u) => normalizeSearchText(u.username).includes(needle) || u.chat_id.includes(needle))
        .sort(byName);
      total = matches.length;
      totalPages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
      page = Math.min(requestedPage, totalPages);
      users = matches.slice((page - 1) * DIRECTORY_PAGE_SIZE, page * DIRECTORY_PAGE_SIZE);
    } else {
      total = stmts.countDirectoryUsers.get().total;
      totalPages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
      page = Math.min(requestedPage, totalPages);
      users = stmts.getDirectoryUsersPage.all(DIRECTORY_PAGE_SIZE, (page - 1) * DIRECTORY_PAGE_SIZE).sort(byName);
    }
    const pagerParams = query ? { q: query } : {};

    const chatIds = users.map((u) => u.chat_id).filter(Boolean);
    const presenceMap = await getUsersPresence(chatIds);

    const body =
      '<h1>Usuarios</h1>' +
      renderDirectorySearch('/usuario', query, query ? total : null) +
      '<p><a href="/">Inicio</a></p>' +
      renderNumberedPager('/usuario', page, totalPages, pagerParams) +
      renderList(users, (user) => `/usuario/${user.chat_id}`, (user) => {
        const presence = user.chat_id ? presenceMap.get(user.chat_id) : null;
        const onlineTag = presence && presence.isOnline ? '*' : '';
        return `${truncateName(user.username)}${onlineTag}[${user.unseen_count}]`;
      }, query ? 'Ningún usuario coincide.' : 'Sin usuarios.', (user) => getLetterBucket(user.username)) +
      renderNumberedPager('/usuario', page, totalPages, pagerParams);

    sendPage(req, res, 200, 'Usuarios', body);
  } catch (error) {
    next(error);
  }
}

export async function showUserMessages(req, res, next) {
  try {
    const chatId = req.params.id;
    if (!chatId || typeof chatId !== 'string' || chatId.trim() === '') {
      sendInvalidEntity(req, res, 'Usuario');
      return;
    }

    const userRows = stmts.getUserByChatId.get(chatId);

    if (!userRows) {
      sendMissingEntity(req, res, 'Usuario');
      return;
    }

    await syncChatUnreadCountFromWhatsapp(chatId);
    const user = stmts.getUserByChatId.get(chatId) || userRows;
    const presence = user.chat_id ? await getUsersPresence([user.chat_id]) : new Map();
    const userPresence = user.chat_id ? presence.get(user.chat_id) : null;
    const onlineTag = userPresence && userPresence.isOnline ? ' *' : '';

    const unseenCount = user.unseen_count;

    // Reseteo del contador usando las sentencias estables de tu db.js
    stmts.resetUserUnseen.run(chatId);

    // Enviar visto por WhatsApp si el ajuste está activo y había mensajes no vistos
    if (unseenCount > 0 && process.env.SEND_READ_RECEIPTS_ENABLED === 'true') {
      sendWhatsappSeen(chatId).catch(() => {});
    }

    const total = getTotal(stmts.countUserMessages, chatId);
    const totalPages = Math.max(1, Math.ceil(total / MESSAGE_PAGE_SIZE));
    const page = Math.min(toPositiveInt(req.query.p, 1), totalPages);
    const offset = (page - 1) * MESSAGE_PAGE_SIZE;

    const messages = stmts.getUserMessagesPaginated.all(chatId, MESSAGE_PAGE_SIZE, offset);
    const newMessageCount = unseenCount;

    let messagesHtml = '';
    if (messages.length === 0) {
      messagesHtml = '<p>Sin mensajes.</p>';
    } else {
      let previousDate = null;
      messages.forEach((message, index) => {
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
          return;
        }

        const groupPart = message.group_name ? ` | ${escapeXml(message.group_name)}` : '';

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

        let quotedBlock = '';
        if (message.quoted_text || message.quoted_sender) {
          const quotedTag = message.quoted_sender ? `R-${escapeXml(message.quoted_sender)}` : 'R';
          const quotedPreview = message.quoted_text
            ? escapeXml(truncateName(message.quoted_text, 80))
            : '(no disponible)';
          quotedBlock = `<i><font size="1" color="#888888">[${quotedTag}]-&quot;${quotedPreview}&quot;</font></i><br/>`;
        }

        // CORRECCIÓN DEFINITIVA: Comprobación numérica estricta para evitar falsos positivos
        const isSaliente = Number(message.from_me) === 1;
        const fromMeMarker = isSaliente
          ? `<font color="#006600">[Yo]</font> ${renderAckLabel(message.ack_status)}`
          : '';
        const messageActions = renderMessageActions(message, user.chat_id, 'user');

        messagesHtml +=
          `${dateSeparator}<p>${unseenMarker}${escapeXml(sentAt)}${groupPart}${editedTag}${messageActions}${messageActions && fromMeMarker ? '<br/>' : ''}${fromMeMarker}<br/>` +
          `${quotedBlock}${contentPart}<br/>----------</p>`;
      });
    }

    // Siempre se pide el número personal: el del JID puede ser el de empresa.
    let phone = user.chat_id ? await resolveContactPhone(user.chat_id) : null;
    if (!phone) {
      phone = formatPhoneNumber(user.chat_id, user.username);
    }
    const phoneHtml = phone ? `<p style="margin-top:-5px;margin-bottom:5px;">${renderPhoneLink(phone)}</p>` : '';

    const isMuted = Number(user.sms_muted) === 1;
    const muteLabel = isMuted ? 'Activar SMS' : 'Silenciar SMS';
    const muteIcon = isMuted ? 'Bell_Red.png' : 'Bell_Green.png';

    const iconTag = (file, alt) =>
      `<img src="/assets/groups_icons/${file}" alt="${escapeXml(alt)}" height="24" width="24" style="vertical-align:middle;"/>`;

    const avatarHtml = renderAvatarImg(await getAvatarUrl(user.chat_id, 'mini', { fallback: 'user' }), 'mini');
    const body =
      `<h1>${avatarHtml ? `${avatarHtml} ` : ''}${escapeXml(user.username)}${onlineTag}</h1>` +
      phoneHtml +
      '<p><a href="/">Inicio</a> | <a href="/usuario">Usuarios</a></p>' +
      `<p><a href="/mensaje/componer?to=${encodeURIComponent(user.chat_id)}&type=user">${iconTag('Writing_Lightgreen.png', 'Enviar mensaje')}</a> ` +
      `<a href="/usuario/${encodeURIComponent(user.chat_id)}/silenciar">${iconTag(muteIcon, muteLabel)}</a> ` +
      `<a href="/usuario/${encodeURIComponent(user.chat_id)}/detalles">${iconTag('Questionmark_Blue.png', 'Detalles')}</a> ` +
      `<a href="/usuario/${encodeURIComponent(user.chat_id)}/eliminar">${iconTag('Warning_Red.png', 'Eliminar')}</a></p>` +
      renderPager(`/usuario/${user.chat_id}`, page, totalPages) +
      messagesHtml +
      renderPager(`/usuario/${user.chat_id}`, page, totalPages);

    sendPage(req, res, 200, `${user.username}${onlineTag}`, body);
  } catch (error) {
    next(error);
  }
}

export async function showUserDetails(req, res, next) {
  try {
    const chatId = req.params.id;
    if (!chatId || typeof chatId !== 'string' || chatId.trim() === '') {
      sendInvalidEntity(req, res, 'Usuario');
      return;
    }

    // Vista temporal: contacto que aún no está en el Nokia (p. ej. desde el buscador, para
    // distinguir a dos «Oscar»). Se consulta a WhatsApp y NO se guarda nada en la BD.
    let user = stmts.getUserByChatId.get(chatId);
    const isPreview = !user;
    if (isPreview) {
      const isUserJid = /^[0-9]{6,20}@(c\.us|lid|s\.whatsapp\.net)$/.test(chatId);
      let contact = null;
      if (isUserJid && client) {
        try {
          contact = await client.getContactById(chatId);
        } catch (err) {
          console.warn(`[detalles] No se pudo consultar ${chatId}:`, err?.message || err);
        }
      }
      if (!contact) {
        sendMissingEntity(req, res, 'Usuario');
        return;
      }
      user = {
        chat_id: chatId,
        username: getContactDisplayName(contact)?.name || `+${chatId.split('@')[0]}`,
        sms_muted: 0,
      };
    }
    const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 50) : '';

    const [profileInfo, presenceMap, bigAvatarUrl] = await Promise.all([
      getContactProfileInfo(user.chat_id),
      getUsersPresence([user.chat_id]),
      getAvatarUrl(user.chat_id, 'big', { fallback: 'user' }),
    ]);
    const presence = presenceMap.get(user.chat_id);

    let phone = await resolveContactPhone(user.chat_id);
    if (!phone) {
      phone = formatPhoneNumber(user.chat_id, user.username);
    }
    const encodedId = encodeURIComponent(user.chat_id);

    // Estado: «En línea» en verde; si no, la última conexión en corto («hoy 17:45»,
    // «ayer 09:10», «03/11 21:00») para que quepa en una línea del 6111.
    let presenceHtml;
    if (presence?.isOnline) {
      presenceHtml = '<font color="#008800">&#9679; En línea</font>';
    } else if (presence?.lastSeen) {
      const seen = new Date(presence.lastSeen * 1000);
      const fmt = (opts) => new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', ...opts }).format(seen);
      const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d);
      const today = new Date();
      const yesterday = new Date(today.getTime() - 86_400_000);
      const day = dayKey(seen) === dayKey(today) ? 'hoy'
        : dayKey(seen) === dayKey(yesterday) ? 'ayer'
          : fmt({ day: '2-digit', month: '2-digit' });
      presenceHtml = `<font color="#666666">Últ. vez ${day} ${fmt({ hour: '2-digit', minute: '2-digit' })}</font>`;
    } else {
      presenceHtml = '<font color="#666666">Últ. vez desconocida</font>';
    }

    const headerHtml =
      '<p align="center">' +
      (bigAvatarUrl
        ? `${renderAvatarImg(bigAvatarUrl, 'big', 'Foto de perfil')}<br/>`
        : '<font size="1" color="#888888">(sin foto)</font><br/>') +
      `<b>${escapeXml(user.username)}</b>` +
      (phone ? `<br/>${renderPhoneLink(phone)}` : '') +
      `<br/><font size="1">${presenceHtml}</font>` +
      '</p>';

    const aboutHtml = profileInfo.about
      ? `<p><b>Info:</b><br/><i>${escapeXml(profileInfo.about)}</i></p>`
      : '';

    const isMuted = Number(user.sms_muted) === 1;
    const smsHtml = isPreview ? '' :
      `<p><b>Avisos SMS:</b> ${isMuted ? '<font color="#cc0000">silenciados</font>' : '<font color="#008800">activos</font>'}` +
      `<br/><a href="/usuario/${encodedId}/silenciar?volver=detalles">[${isMuted ? 'Activar' : 'Silenciar'}]</a></p>`;

    const commonGroups = profileInfo.commonGroupIds
      .map((gid) => {
        const g = stmts.getGroupById.get(gid);
        return g ? `<a href="/grupo/${encodeURIComponent(gid)}">${escapeXml(g.group_name)}</a>` : null;
      })
      .filter(Boolean);
    const commonGroupsHtml = commonGroups.length
      ? `<p><b>Grupos en común (${commonGroups.length}):</b><br/>${commonGroups.map((n) => `- ${n}`).join('<br/>')}</p>`
      : '<p><b>Grupos en común:</b> ninguno</p>';

    const backToSearch = searchQuery
      ? `<a href="/mensaje/componer?q=${encodeURIComponent(searchQuery)}">Volver a la búsqueda</a>`
      : '<a href="/mensaje/componer">Buscar</a>';
    const navHtml = isPreview
      ? `<p><font size="1"><a href="/">Inicio</a> | ${backToSearch}</font></p>`
      : '<p><font size="1"><a href="/">Inicio</a> | <a href="/usuario">Usuarios</a> | ' +
        `<a href="/usuario/${encodedId}">Chat</a></font></p>`;
    const previewNoteHtml = isPreview
      ? '<p align="center"><font size="1" color="#cc6600">Aún no está en tus contactos del Nokia</font></p>'
      : '';

    const body =
      navHtml +
      headerHtml +
      previewNoteHtml +
      '<hr/>' +
      aboutHtml +
      smsHtml +
      commonGroupsHtml +
      '<hr/>' +
      `<p align="center"><a href="/mensaje/componer?to=${encodedId}&amp;type=user">Escribir mensaje</a></p>`;

    sendPage(req, res, 200, `${user.username} - Detalles`, body);
  } catch (error) {
    next(error);
  }
}

export async function toggleUserMute(req, res, next) {
  try {
    const chatId = req.params.id;
    const user = stmts.getUserByChatId.get(chatId);
    if (!user) {
      sendMissingEntity(req, res, 'Usuario');
      return;
    }

    const newState = Number(user.sms_muted) === 1 ? 0 : 1;
    stmts.setUserSmsMuted.run(newState, chatId);

    const backUrl = req.query.volver === 'detalles'
      ? `/usuario/${encodeURIComponent(chatId)}/detalles`
      : `/usuario/${encodeURIComponent(chatId)}`;
    const body = `<p><a href="${backUrl}">Volver</a></p>`;
    sendPage(req, res, 200, 'Nokia', body, `<meta http-equiv="refresh" content="0;url=${backUrl}"/>`);
  } catch (error) {
    next(error);
  }
}

export async function confirmDeleteUser(req, res, next) {
  try {
    const chatId = req.params.id;
    const user = stmts.getUserByChatId.get(chatId);
    if (!user) {
      sendMissingEntity(req, res, 'Usuario');
      return;
    }

    const body =
      `<h1>Eliminar</h1>` +
      `<p>¿Eliminar a ${escapeXml(user.username)}? Se borrará el historial guardado en el ` +
      `Nokia. La conversación de WhatsApp en el móvil no se ve afectada.</p>` +
      `<form action="/usuario/${encodeURIComponent(chatId)}/eliminar" method="POST">` +
      `<p><input type="submit" value="Si, eliminar"/> ` +
      `<a href="/usuario/${encodeURIComponent(chatId)}">Cancelar</a></p>` +
      `</form>`;

    sendPage(req, res, 200, 'Eliminar usuario', body);
  } catch (error) {
    next(error);
  }
}

export async function deleteUser(req, res, next) {
  try {
    const chatId = req.params.id;
    const user = stmts.getUserByChatId.get(chatId);
    if (!user) {
      sendMissingEntity(req, res, 'Usuario');
      return;
    }

    const attachments = stmts.getDmAttachmentsByUserChatId.all(chatId);

    db.exec('BEGIN');
    try {
      stmts.deleteDmAttachmentsByUserChatId.run(chatId);
      stmts.deleteDmMessagesByUserChatId.run(chatId);

      const remaining = getTotal(stmts.countMessagesByUserChatId, chatId);
      if (remaining === 0) {
        stmts.deleteParticipantsByUserChatId.run(chatId);
        stmts.deleteUserRow.run(chatId);
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    releaseAttachmentFiles(attachments);

    const body =
      '<h1>Nokia</h1>' +
      '<p>Eliminado.</p>' +
      '<p><a href="/usuario">Usuarios</a></p>';
    sendPage(req, res, 200, 'Eliminado', body, '<meta http-equiv="refresh" content="2;url=/usuario"/>');
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
