import db, { stmts } from '../../db/db.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { getUsersPresence } from '../services/whatsapp.service.js';
import {
  DIRECTORY_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  escapeXml,
  getTotal,
  renderList,
  nl2br,
  renderPager,
  sendInvalidEntity,
  sendMissingEntity,
  sendPage,
  toPositiveInt,
} from './page.controller.js';

export async function listUsers(req, res, next) {
  try {
    const requestedPage = toPositiveInt(req.query.p, 1);
    const total = getTotal(stmts.countUsers);
    const totalPages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * DIRECTORY_PAGE_SIZE;

    const users = stmts.getAllUsersPaginated.all(DIRECTORY_PAGE_SIZE, offset);

    const chatIds = users.map((u) => u.chat_id).filter(Boolean);
    const presenceMap = await getUsersPresence(chatIds);

    const body =
      '<h1>Usuarios</h1>' +
      '<p><a href="/">Inicio</a></p>' +
      renderPager('/usuario', page, totalPages) +
      renderList(users, (user) => `/usuario/${user.chat_id}`, (user) => {
        const presence = user.chat_id ? presenceMap.get(user.chat_id) : null;
        const onlineTag = presence && presence.isOnline ? '*' : '';
        return `${escapeXml(user.username)}${onlineTag}[${user.unseen_count}]`;
      }, 'Sin usuarios.') +
      renderPager('/usuario', page, totalPages);

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

    const userRows = db.prepare(`
      SELECT chat_id, username, unseen_count FROM users WHERE chat_id = ? LIMIT 1
    `).get(chatId);

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
        } else {
          contentPart = nl2br(escapeXml(message.text));
        }

        // CORRECCIÓN DEFINITIVA: Comprobación numérica estricta para evitar falsos positivos
        const isSaliente = Number(message.from_me) === 1;
        const fromMeMarker = isSaliente ? '<font color="#006600">[Yo]</font> ' : '';

        messagesHtml +=
          `<p><a href="/mensaje/${message.id}">Ver</a><br/>` +
          `${unseenMarker}${fromMeMarker}${escapeXml(sentAt)}${groupPart}<br/>` +
          `${contentPart}<br/>----------</p>`;
      });
    }

    const body =
      `<h1>${escapeXml(user.username)}${onlineTag}</h1>` +
      '<p><a href="/">Inicio</a> | <a href="/usuario">Usuarios</a></p>' +
      `<p><a href="/mensaje/componer?to=${encodeURIComponent(user.chat_id)}&type=user"><b>[Enviar mensaje]</b></a></p>` +
      renderPager(`/usuario/${user.chat_id}`, page, totalPages) +
      messagesHtml +
      renderPager(`/usuario/${user.chat_id}`, page, totalPages);

    sendPage(req, res, 200, `${user.username}${onlineTag}`, body);
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
