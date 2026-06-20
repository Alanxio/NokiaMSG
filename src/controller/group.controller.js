import db, { stmts } from '../../db/db.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { sendWhatsappSeen } from '../services/whatsapp.service.js';
import {
  DIRECTORY_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  escapeXml,
  getTotal,
  renderList,
  renderMentions,
  renderPager,
  sendInvalidEntity,
  sendMissingEntity,
  sendPage,
  toPositiveInt,
} from './page.controller.js';

export async function listGroups(req, res, next) {
  try {
    const requestedPage = toPositiveInt(req.query.p, 1);
    const total = getTotal(stmts.countGroups);
    const totalPages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * DIRECTORY_PAGE_SIZE;

    const groups = stmts.getAllGroupsPaginated.all(DIRECTORY_PAGE_SIZE, offset);

    const body =
      '<h1>Grupos</h1>' +
      '<p><a href="/">Inicio</a></p>' +
      renderPager('/grupo', page, totalPages) +
      renderList(groups, (group) => `/grupo/${group.group_id}`, (group) => `${escapeXml(group.group_name)}[${group.unseen_count}]`, 'Sin grupos.') +
      renderPager('/grupo', page, totalPages);

    sendPage(req, res, 200, 'Grupos', body);
  } catch (error) {
    next(error);
  }
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

    const group = groupRows;
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

    let messagesHtml = '';
    if (messages.length === 0) {
      messagesHtml = '<p>Sin mensajes.</p>';
    } else {
      messages.forEach((message, index) => {
        const isNew = index < newMessageCount;
        const unseenMarker = isNew ? '<font color="#cc0000">[!]</font> ' : '';
        const sentAt = formatHourSend(message.hour_send);
        let contentPart;
        if (message.has_media && message.file_path_thumb) {
          contentPart = `<img src="${escapeXml(message.file_path_thumb)}" width="40" alt="thumb"/> <a href="/mensaje/${message.id}">[Ver]</a>`;
        } else {
          contentPart = renderMentions(message.text);
        }

        const isSaliente = Number(message.from_me) === 1;
        const fromMeMarker = isSaliente ? '<font color="#006600">[Yo]</font> ' : '';

        const usernameLine = isSaliente 
          ? '' 
          : `<font size="1" color="#000000">[${message.username ? escapeXml(convertEmojisToAscii(message.username)) : 'Desconocido'}] dice:</font><br/>`;

        messagesHtml +=
          `<p>` +
          `<a href="/mensaje/${message.id}">Ver</a><br/>` +
          `${unseenMarker}${fromMeMarker}` +
          usernameLine +
          `<font size="1" color="#000000">${contentPart}</font><br/>` +
          `<font size="1" color="#666666">${escapeXml(sentAt)}</font><br/>` +
          `----------</p>`;
      });
    }

    const body =
      `<h1>${escapeXml(group.group_name)}</h1>` +
      '<p><a href="/">Inicio</a> | <a href="/grupo">Grupos</a></p>' +
      `<p><a href="/mensaje/componer?to=${encodeURIComponent(group.group_id)}&type=group"><b>[Enviar mensaje al grupo]</b></a></p>` +
      renderPager(`/grupo/${group.group_id}`, page, totalPages) +
      messagesHtml +
      renderPager(`/grupo/${group.group_id}`, page, totalPages);

    sendPage(req, res, 200, group.group_name, body);
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
