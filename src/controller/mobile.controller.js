import bcrypt from 'bcryptjs';
import { stmts } from '../../db/db.js';
import {
  getClientIp,
  isRateLimited,
  recordFailedAttempt,
  resetAttempts,
  createTrustToken,
  revokeTrustToken,
} from '../services/auth.service.js';
import { client, getConnectionStatus, sendWhatsappSeen } from '../services/whatsapp.service.js';
import { getPollingState, limpiarNovedad } from '../services/polling.service.js';
import { registerPendingOutgoing } from '../services/pending-outgoing.service.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { ensureGroupDisplayName } from './group.controller.js';
import { DIRECTORY_PAGE_SIZE, MESSAGE_PAGE_SIZE, getTotal, toPositiveInt } from './page.controller.js';

function jsonError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function mobileLogin(req, res) {
  const ip = getClientIp(req);

  if (isRateLimited(ip)) {
    return jsonError(res, 429, 'RATE_LIMITED', 'Demasiados intentos. Espera unos minutos.');
  }

  const { pin } = req.body || {};
  const hash = process.env.ACCESS_PIN_HASH_BCRYPT;

  if (!hash) {
    console.error('[Mobile] ERROR CRITICO: No hay ACCESS_PIN_HASH_BCRYPT en .env');
    return jsonError(res, 500, 'SERVER_MISCONFIGURED', 'Sistema mal configurado');
  }

  if (!pin) {
    recordFailedAttempt(ip);
    return jsonError(res, 400, 'MISSING_PIN', 'Falta el PIN');
  }

  try {
    const isValid = await bcrypt.compare(String(pin), hash);

    if (!isValid) {
      recordFailedAttempt(ip);
      return jsonError(res, 401, 'INVALID_PIN', 'PIN incorrecto');
    }

    resetAttempts(ip);
    const { token, days } = createTrustToken();
    console.log(`[Mobile] Login exitoso desde ${ip}`);
    return res.status(200).json({ token, expiresInDays: days });
  } catch (error) {
    console.error('[Mobile] Error en mobileLogin:', error.message);
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Error interno.');
  }
}

export function mobileLogout(req, res) {
  const token = req.headers['x-nokia-token'];
  if (token) revokeTrustToken(token);
  return res.status(200).json({ success: true });
}

// ── Estado ────────────────────────────────────────────────────────────────────

export function mobileStatus(req, res) {
  res.json(getConnectionStatus());
}

// ── Bandeja de entrada / directorio ──────────────────────────────────────────

export async function mobileInbox(req, res, next) {
  try {
    const recentUsers = stmts.getRecentUsersWithUnseen.all(10);
    const recentGroups = stmts.getRecentGroupsWithUnseen.all(10);
    const resolvedRecentGroups = await Promise.all(recentGroups.map(ensureGroupDisplayName));

    const items = [
      ...recentUsers.map((u) => ({
        type: 'user',
        id: u.chat_id,
        name: u.username,
        unseenCount: u.unseen_count,
        lastMessageAt: u.last_message,
      })),
      ...resolvedRecentGroups.map((g) => ({
        type: 'group',
        id: g.group_id,
        name: g.group_name,
        unseenCount: g.unseen_count,
        lastMessageAt: g.last_message,
      })),
    ]
      .sort((a, b) => ((a.lastMessageAt || '') < (b.lastMessageAt || '') ? 1 : -1))
      .slice(0, 10);

    res.json({ count: items.length, items });
  } catch (error) {
    next(error);
  }
}

export async function mobileDirectoryUsers(req, res, next) {
  try {
    const allUsers = stmts.getAllUsers.all();
    allUsers.sort((a, b) => (a.username || '').localeCompare(b.username || '', 'es', { sensitivity: 'base' }));

    const requestedPage = toPositiveInt(req.query.p, 1);
    const totalPages = Math.max(1, Math.ceil(allUsers.length / DIRECTORY_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * DIRECTORY_PAGE_SIZE;
    const users = allUsers.slice(offset, offset + DIRECTORY_PAGE_SIZE);

    res.json({
      page,
      totalPages,
      total: allUsers.length,
      pageSize: DIRECTORY_PAGE_SIZE,
      users: users.map((u) => ({ id: u.chat_id, name: u.username, unseenCount: u.unseen_count })),
    });
  } catch (error) {
    next(error);
  }
}

export async function mobileDirectoryGroups(req, res, next) {
  try {
    const allGroups = await Promise.all(stmts.getAllGroups.all().map(ensureGroupDisplayName));
    allGroups.sort((a, b) => (a.group_name || '').localeCompare(b.group_name || '', 'es', { sensitivity: 'base' }));

    const requestedPage = toPositiveInt(req.query.p, 1);
    const totalPages = Math.max(1, Math.ceil(allGroups.length / DIRECTORY_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * DIRECTORY_PAGE_SIZE;
    const groups = allGroups.slice(offset, offset + DIRECTORY_PAGE_SIZE);

    res.json({
      page,
      totalPages,
      total: allGroups.length,
      pageSize: DIRECTORY_PAGE_SIZE,
      groups: groups.map((g) => ({ id: g.group_id, name: g.group_name, unseenCount: g.unseen_count })),
    });
  } catch (error) {
    next(error);
  }
}

// ── Adjuntos (solo metadatos — el binario se sirve por /media y /descargar/:file) ──

function buildAttachmentInfo(message) {
  if (Number(message.is_sticker) === 1) {
    return { kind: 'sticker', fileName: null, durationSec: null, downloadUrl: null, thumbUrl: message.file_path_thumb || null };
  }

  const type = message.media_type;
  const fileName = message.file_path_full ? String(message.file_path_full).split('/').pop() : null;
  const downloadUrl = fileName ? `/descargar/${fileName}` : null;

  if (type) {
    switch (type) {
      case 'ptt':
      case 'audio':
      case 'video':
        return { kind: type, fileName: message.file_name || null, durationSec: message.duration_sec || null, downloadUrl };
      case 'document':
        return { kind: 'document', fileName: message.file_name || null, durationSec: null, downloadUrl };
      case 'location':
        return { kind: 'location', fileName: message.file_name || null, durationSec: null, downloadUrl: null };
      case 'poll':
        return { kind: 'poll', fileName: null, durationSec: null, downloadUrl: null };
      default:
        return null;
    }
  }

  if (message.has_media && message.file_path_thumb) {
    return { kind: 'image', fileName: message.file_name || null, durationSec: null, downloadUrl, thumbUrl: message.file_path_thumb };
  }

  return null;
}

function mapMessageRow(row, { includeSender, isNew }) {
  return {
    id: row.id,
    text: row.text,
    displayText: convertEmojisToAscii(row.text || ''),
    sentAt: row.hour_send,
    fromMe: Number(row.from_me) === 1,
    ackStatus: row.ack_status != null ? Number(row.ack_status) : 0,
    isNew,
    isDeleted: Number(row.is_deleted) === 1,
    isEdited: Number(row.is_edited) === 1,
    isSystem: Number(row.is_system) === 1,
    quotedText: row.quoted_text || null,
    quotedSender: row.quoted_sender || null,
    senderId: includeSender ? row.user_chat_id || null : null,
    senderName: includeSender ? row.username || null : null,
    attachment: buildAttachmentInfo(row),
  };
}

// ── Historial de mensajes ─────────────────────────────────────────────────────

export async function mobileUserMessages(req, res, next) {
  try {
    const chatId = req.params.chatId;
    if (!chatId || typeof chatId !== 'string' || chatId.trim() === '') {
      return jsonError(res, 400, 'INVALID_ID', 'Usuario invalido.');
    }

    const user = stmts.getUserByChatId.get(chatId);
    if (!user) {
      return jsonError(res, 404, 'USER_NOT_FOUND', 'Usuario no existe.');
    }

    const unseenCount = user.unseen_count;
    stmts.resetUserUnseen.run(chatId);

    if (unseenCount > 0 && process.env.SEND_READ_RECEIPTS_ENABLED === 'true') {
      sendWhatsappSeen(chatId).catch(() => {});
    }

    const total = getTotal(stmts.countUserMessages, chatId);
    const totalPages = Math.max(1, Math.ceil(total / MESSAGE_PAGE_SIZE));
    const page = Math.min(toPositiveInt(req.query.p, 1), totalPages);
    const offset = (page - 1) * MESSAGE_PAGE_SIZE;

    const messages = stmts.getUserMessagesPaginated.all(chatId, MESSAGE_PAGE_SIZE, offset);

    res.json({
      chat: { type: 'user', id: user.chat_id, name: user.username },
      page,
      totalPages,
      total,
      pageSize: MESSAGE_PAGE_SIZE,
      unseenCountBeforeReset: unseenCount,
      messages: messages.map((m, i) => mapMessageRow(m, { includeSender: false, isNew: i < unseenCount })),
    });
  } catch (error) {
    next(error);
  }
}

export async function mobileGroupMessages(req, res, next) {
  try {
    const groupId = req.params.groupId;
    if (!groupId || typeof groupId !== 'string' || groupId.trim() === '') {
      return jsonError(res, 400, 'INVALID_ID', 'Grupo invalido.');
    }

    const groupRow = stmts.getGroupById.get(groupId);
    if (!groupRow) {
      return jsonError(res, 404, 'GROUP_NOT_FOUND', 'Grupo no existe.');
    }

    const group = await ensureGroupDisplayName(groupRow);
    const unseenCount = group.unseen_count;
    stmts.resetGroupUnseen.run(groupId);

    if (unseenCount > 0 && process.env.SEND_READ_RECEIPTS_ENABLED === 'true') {
      sendWhatsappSeen(groupId).catch(() => {});
    }

    const total = getTotal(stmts.countGroupMessages, groupId);
    const totalPages = Math.max(1, Math.ceil(total / MESSAGE_PAGE_SIZE));
    const page = Math.min(toPositiveInt(req.query.p, 1), totalPages);
    const offset = (page - 1) * MESSAGE_PAGE_SIZE;

    const messages = stmts.getGroupMessagesPaginated.all(groupId, MESSAGE_PAGE_SIZE, offset);

    res.json({
      chat: { type: 'group', id: group.group_id, name: group.group_name },
      page,
      totalPages,
      total,
      pageSize: MESSAGE_PAGE_SIZE,
      unseenCountBeforeReset: unseenCount,
      messages: messages.map((m, i) => mapMessageRow(m, { includeSender: true, isNew: i < unseenCount })),
    });
  } catch (error) {
    next(error);
  }
}

// ── Envío de mensajes (solo texto) ───────────────────────────────────────────

export async function mobileSendMessage(req, res) {
  try {
    const { to, type, text } = req.body || {};
    const trimmedText = typeof text === 'string' ? text.trim() : '';

    if (!to || !trimmedText) {
      return jsonError(res, 400, 'INVALID_INPUT', 'Debes indicar destino y texto.');
    }

    const processedText = convertEmojisToAscii(trimmedText);
    let targetJid = String(to).trim();

    if (!targetJid.includes('@')) {
      const numberDetails = await client.getNumberId(targetJid);
      if (!numberDetails) {
        return jsonError(res, 404, 'NUMBER_NOT_ON_WHATSAPP', 'El numero no tiene WhatsApp registrado.');
      }
      targetJid = numberDetails._serialized;
    }

    const isGroup = type === 'group' || targetJid.endsWith('@g.us');

    if (isGroup) {
      const existingGroup = stmts.getGroupById.get(targetJid);
      if (!existingGroup) {
        let groupName = 'Grupo sin nombre';
        try {
          const chat = await client.getChatById(targetJid);
          if (chat && chat.name) groupName = chat.name;
        } catch (e) {
          // Ignorar error de resolucion de grupo, se guarda con nombre generico.
        }
        stmts.upsertGroup.run(targetJid, groupName);
      }
    }

    let sentMessage;
    try {
      sentMessage = await client.sendMessage(targetJid, processedText, { waitUntilMsgSent: true });
    } catch (error) {
      console.error('[Mobile] Error enviando mensaje a WhatsApp:', error.message);
      return jsonError(res, 502, 'WHATSAPP_SEND_FAILED', 'No se pudo enviar el mensaje.');
    }

    // client.sendMessage() puede no devolver el Message con su id en este entorno — el ID
    // real se enlaza mas tarde de forma asincrona via message_create + pending-outgoing.
    const whatsappMsgId = sentMessage?.id?._serialized || null;

    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const pad = (n) => String(n).padStart(2, '0');
    const daySend = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const hourSend = `${daySend} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    let insertedMessageId;
    if (isGroup) {
      const result = stmts.insertMessage.run(processedText, daySend, hourSend, 1, null, targetJid, whatsappMsgId);
      insertedMessageId = result.lastInsertRowid;
    } else {
      const existingUser = stmts.getUserByChatId.get(targetJid);
      if (!existingUser) {
        let finalName = `+${targetJid.split('@')[0]}`;
        try {
          const contact = await client.getContactById(targetJid);
          if (contact) {
            finalName = contact.name || contact.pushname || contact.shortName || contact.verifiedName || finalName;
          }
        } catch (e) {
          // Ignorar error de resolucion de contacto, se guarda con nombre generico.
        }
        stmts.upsertUser.run(targetJid, finalName);
      }
      const result = stmts.insertMessage.run(processedText, daySend, hourSend, 1, targetJid, null, whatsappMsgId);
      insertedMessageId = result.lastInsertRowid;
    }

    // La fila debe insertarse aqui mismo: message_create (whatsapp.service.js) NO reinserta
    // mensajes propios (fromMe), solo enlaza whatsapp_msg_id a posteriori sobre esta fila.
    if (!whatsappMsgId && insertedMessageId) {
      registerPendingOutgoing(targetJid, insertedMessageId);
    }

    res.status(201).json({
      id: insertedMessageId,
      chatId: targetJid,
      type: isGroup ? 'group' : 'user',
      text: processedText,
      sentAt: hourSend,
      whatsappMsgId,
    });
  } catch (error) {
    console.error('[Mobile] Error en mobileSendMessage:', error);
    jsonError(res, 500, 'INTERNAL_ERROR', 'Error interno.');
  }
}

// ── Polling de novedades ──────────────────────────────────────────────────────

export function mobileUpdates(req, res) {
  const state = getPollingState();

  if (!state.huboNovedad) {
    return res.json({ hasUpdates: false });
  }

  const result = {
    hasUpdates: true,
    lastMessagePreview: state.ultimoMensaje || null,
    at: state.timestampUltimaNovedad || null,
  };
  limpiarNovedad();
  res.json(result);
}
