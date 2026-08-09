import db, { stmts } from '../../db/db.js';
import { sendPage, escapeXml } from './page.controller.js';
import { getConnectionStatus, getUsersPresence, sendWhatsappSeen } from '../services/whatsapp.service.js';
import { ensureGroupDisplayName } from './group.controller.js';

const USER_ICON_HTML = '<img src="/assets/user.jpeg" alt="U" height="14" width="18" style="vertical-align:5px; margin-top:-5px; margin-bottom:-5px;" />';
const GROUP_ICON_HTML = '<img src="/assets/group.jpeg" alt="G" height="14" width="18" style="vertical-align:5px; margin-top:-5px; margin-bottom:-5px;" />';

export async function showHome(req, res, next) {
  try {
    const recentUsers = stmts.getRecentUsersWithUnseen.all(10);
    const recentGroups = stmts.getRecentGroupsWithUnseen.all(10);

    const resolvedRecentGroups = await Promise.all(recentGroups.map(ensureGroupDisplayName));

    const recentItems = [
      ...recentUsers.map(u => ({ type: 'user', id: u.chat_id, name: u.username, chat_id: u.chat_id, unseen_count: u.unseen_count, last_message: u.last_message })),
      ...resolvedRecentGroups.map(g => ({ type: 'group', id: g.group_id, name: g.group_name, chat_id: null, unseen_count: g.unseen_count, last_message: g.last_message })),
    ].sort((a, b) => {
      const aTime = a.last_message || '';
      const bTime = b.last_message || '';
      return aTime < bTime ? 1 : -1;
    }).slice(0, 10);

    const userChatIds = recentItems
      .filter((item) => item.type === 'user' && item.chat_id)
      .map((item) => item.chat_id);
    const presenceMap = await getUsersPresence(userChatIds);

    const count = recentItems.length;

    let itemsHtml = '';
    if (count === 0) {
      itemsHtml = '<p>Sin mensajes recientes.</p>';
    } else {
      itemsHtml = '';
      recentItems.forEach((item) => {
        const url = item.type === 'user' ? `/usuario/${item.id}` : `/grupo/${item.id}`;
        const icon = item.type === 'user' ? USER_ICON_HTML : GROUP_ICON_HTML;
        const presence = item.chat_id ? presenceMap.get(item.chat_id) : null;
        const onlineTag = presence && presence.isOnline ? '*' : '';
        const countTag = item.unseen_count > 0 ? `[${item.unseen_count}]` : '';

        itemsHtml += `<p>${icon} <a href="${url}">${escapeXml(item.name)}${onlineTag}${countTag}</a></p>`;
      });
    }

    const waStatus = getConnectionStatus();
    const waStatusLabels = {
      connected: 'Conectado',
      authenticated: 'Autenticado',
      connecting: 'Conectando...',
      waiting_qr: 'Esperando QR',
      reconnecting: 'Reconectando...',
      disconnected: 'Desconectado',
    };
    const waLabel = waStatusLabels[waStatus.status] || waStatus.status;
    const waStatusHtml =
      '<p><b>WHATSAPP:</b><br/>' +
      `Estado: ${waLabel}<br/>` +
      (waStatus.status === 'connected'
        ? 'Sesion activa'
        : waStatus.status === 'authenticated'
          ? 'Conectando...'
          : '<a href="/whatsapp/qr">Vincular dispositivo (QR)</a>') +
      '</p>';

    const readAllLink = count > 0 ? ' <a href="/leer-todo">[Leer Todo]</a>' : '';

    const body =
      '<h1>Nokia</h1>' +
      `<p><a href="/usuario">Usuarios</a> | <a href="/grupo">Grupos</a></p>` +
      '<p><a href="/mensaje/componer">[Enviar Mensaje]</a></p>' +
      `<p style="margin-bottom:0">Ultimos mensajes (${count}/10)${readAllLink}</p>` +
      itemsHtml +
      waStatusHtml +
      '<br/><p><a href="/ajustes">Ajustes del Sistema</a></p>';

    sendPage(req, res, 200, 'Nokia', body);
  } catch (error) {
    next(error);
  }
}

export async function markAllAsRead(req, res, next) {
  try {
    const usersWithUnseen = stmts.getUsersWithUnseen.all().map((row) => row.chat_id);
    const groupsWithUnseen = stmts.getGroupsWithUnseen.all().map((row) => row.group_id);

    stmts.resetAllUsersUnseen.run();
    stmts.resetAllGroupsUnseen.run();

    if (process.env.SEND_READ_RECEIPTS_ENABLED === 'true') {
      const allChatIds = [...usersWithUnseen, ...groupsWithUnseen];
      allChatIds.forEach((chatId, index) => {
        setTimeout(() => {
          sendWhatsappSeen(chatId).catch(() => {});
        }, index * 1200);
      });
    }

    const body =
      '<h1>Nokia</h1>' +
      '<p>Leiendo mensajes...</p>' +
      '<p><a href="/">Inicio</a></p>';

    sendPage(req, res, 200, 'Leyendo', body, '<meta http-equiv="refresh" content="3;url=/"/>');
  } catch (error) {
    next(error);
  }
}
