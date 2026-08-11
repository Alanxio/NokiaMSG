import db, { stmts } from '../../db/db.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { getUsersPresence, sendWhatsappSeen, resolveContactPhone } from '../services/whatsapp.service.js';
import { resolveMediaFsPath, safeUnlink } from '../services/cleanup.service.js';
import {
  DIRECTORY_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  escapeXml,
  formatPhoneNumber,
  getLetterBucket,
  getTotal,
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

export async function listUsers(req, res, next) {
  try {
    const allUsers = stmts.getAllUsers.all();
    allUsers.sort((a, b) =>
      (a.username || '').localeCompare(b.username || '', 'es', { sensitivity: 'base' })
    );

    const requestedPage = toPositiveInt(req.query.p, 1);
    const totalPages = Math.max(1, Math.ceil(allUsers.length / DIRECTORY_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * DIRECTORY_PAGE_SIZE;

    const users = allUsers.slice(offset, offset + DIRECTORY_PAGE_SIZE);

    const chatIds = users.map((u) => u.chat_id).filter(Boolean);
    const presenceMap = await getUsersPresence(chatIds);

    const body =
      '<h1>Usuarios</h1>' +
      '<p><a href="/">Inicio</a></p>' +
      renderNumberedPager('/usuario', page, totalPages) +
      renderList(users, (user) => `/usuario/${user.chat_id}`, (user) => {
        const presence = user.chat_id ? presenceMap.get(user.chat_id) : null;
        const onlineTag = presence && presence.isOnline ? '*' : '';
        return `${truncateName(user.username)}${onlineTag}[${user.unseen_count}]`;
      }, 'Sin usuarios.', (user) => getLetterBucket(user.username)) +
      renderNumberedPager('/usuario', page, totalPages);

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

    const user = userRows;
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
      messages.forEach((message, index) => {
        const isNew = index < newMessageCount;
        const unseenMarker = isNew ? '<font color="#cc0000">[!]</font> ' : '';
        const sentAt = formatHourSend(message.hour_send);
        const groupPart = message.group_name ? ` | ${escapeXml(message.group_name)}` : '';

        let contentPart;
        if (message.has_media && message.file_path_thumb) {
          contentPart = `<img src="${escapeXml(message.file_path_thumb)}" width="40" alt="thumb"/> <a href="/mensaje/${message.id}">[Ver]</a>`;
        } else if (Number(message.is_sticker) === 1) {
          contentPart = '<i>[Sticker]</i>';
        } else {
          contentPart = renderMentions(message.text);
        }

        // CORRECCIÓN DEFINITIVA: Comprobación numérica estricta para evitar falsos positivos
        const isSaliente = Number(message.from_me) === 1;
        const fromMeMarker = isSaliente
          ? `<font color="#006600">[Yo]</font> ${renderAckLabel(message.ack_status)}`
          : '';

        messagesHtml +=
          `<p>${unseenMarker}${fromMeMarker}${escapeXml(sentAt)}${groupPart}<br/>` +
          `${contentPart}<br/>----------</p>`;
      });
    }

    let phone = null;
    if (user.chat_id && user.chat_id.endsWith('@lid')) {
      phone = await resolveContactPhone(user.chat_id);
    }
    if (!phone) {
      phone = formatPhoneNumber(user.chat_id, user.username);
    }
    const phoneHtml = phone ? `<p style="margin-top:-5px;margin-bottom:5px;">${renderPhoneLink(phone)}</p>` : '';

    const isMuted = Number(user.sms_muted) === 1;
    const muteLabel = isMuted ? 'Activar SMS' : 'Silenciar SMS';

    const body =
      `<h1>${escapeXml(user.username)}${onlineTag}</h1>` +
      phoneHtml +
      '<p><a href="/">Inicio</a> | <a href="/usuario">Usuarios</a></p>' +
      `<p><a href="/mensaje/componer?to=${encodeURIComponent(user.chat_id)}&type=user"><b>[Enviar mensaje]</b></a></p>` +
      `<p><a href="/usuario/${encodeURIComponent(user.chat_id)}/silenciar">[${escapeXml(muteLabel)}]</a> | ` +
      `<a href="/usuario/${encodeURIComponent(user.chat_id)}/eliminar">[Eliminar]</a></p>` +
      renderPager(`/usuario/${user.chat_id}`, page, totalPages) +
      messagesHtml +
      renderPager(`/usuario/${user.chat_id}`, page, totalPages);

    sendPage(req, res, 200, `${user.username}${onlineTag}`, body);
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

    const backUrl = `/usuario/${encodeURIComponent(chatId)}`;
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

    attachments.forEach((a) => {
      safeUnlink(resolveMediaFsPath(a.file_path_thumb));
      safeUnlink(resolveMediaFsPath(a.file_path_full));
      safeUnlink(resolveMediaFsPath(a.file_path_view));
    });

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
