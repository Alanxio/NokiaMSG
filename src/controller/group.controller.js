import db, { stmts } from '../../db/db.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { client, sendWhatsappSeen, resolveContactPhone } from '../services/whatsapp.service.js';
import {
  DIRECTORY_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  escapeXml,
  formatPhoneNumber,
  getTotal,
  isNumericOrJid,
  renderList,
  renderMentions,
  renderPager,
  renderPhoneLink,
  sendInvalidEntity,
  sendMissingEntity,
  sendPage,
  toPositiveInt,
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
    const requestedPage = toPositiveInt(req.query.p, 1);
    const total = getTotal(stmts.countGroups);
    const totalPages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * DIRECTORY_PAGE_SIZE;

    const groups = stmts.getAllGroupsPaginated.all(DIRECTORY_PAGE_SIZE, offset);
    const resolvedGroups = await Promise.all(groups.map(ensureGroupDisplayName));

    const body =
      '<h1>Grupos</h1>' +
      '<p><a href="/">Inicio</a></p>' +
      renderPager('/grupo', page, totalPages) +
      renderList(resolvedGroups, (group) => `/grupo/${group.group_id}`, (group) => `${escapeXml(group.group_name)}[${group.unseen_count}]`, 'Sin grupos.') +
      renderPager('/grupo', page, totalPages);

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
        const fromMeMarker = isSaliente ? '<font color="#006600">[Yo]</font> ' : '';

        let senderPhone = null;
        if (!isSaliente && message.user_chat_id) {
          senderPhone = await resolveContactPhone(message.user_chat_id);
          if (!senderPhone) {
            senderPhone = formatPhoneNumber(message.user_chat_id, message.username);
          }
        }
        const phoneLink = senderPhone ? ` ${renderPhoneLink(senderPhone)}` : '';

        const usernameLine = isSaliente
          ? ''
          : `<font size="1" color="#000000">[${message.username ? escapeXml(convertEmojisToAscii(message.username)) : 'Desconocido'}]${phoneLink} dice:</font><br/>`;

        messagesHtml +=
          `<p>${unseenMarker}${fromMeMarker}<font size="1" color="#666666">${escapeXml(sentAt)}</font><br/>` +
          usernameLine +
          `<font size="1" color="#000000">${contentPart}</font><br/>` +
          `----------</p>`;
      }
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
