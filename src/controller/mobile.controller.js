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
import { getConnectionStatus, sendWhatsappSeen } from '../services/whatsapp.service.js';
import { getPollingState, limpiarNovedad } from '../services/polling.service.js';
import { isGroupTarget, resolveTargetJid, sendOutgoingMessages, SendMessageError } from '../domain/messaging.service.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { ensureGroupDisplayName, ensureGroupDisplayNames } from './group.controller.js';
import { DIRECTORY_PAGE_SIZE, MESSAGE_PAGE_SIZE, getTotal, toPositiveInt } from './page.controller.js';
import { alertNewLogin } from '../services/security-alert.service.js';
import { isTlsRequest } from '../utils/public-url.js';

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
    const { token, days } = createTrustToken('mobile');
    console.log(`[Mobile] Login exitoso desde ${ip}`);
    alertNewLogin({ ip, via: 'J2ME', remember: true, tls: isTlsRequest(req) });
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
    const requestedPage = toPositiveInt(req.query.p, 1);
    const total = stmts.countDirectoryUsers.get().total;
    const totalPages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * DIRECTORY_PAGE_SIZE;
    const users = stmts.getDirectoryUsersPage.all(DIRECTORY_PAGE_SIZE, offset);
    users.sort((a, b) =>
      (a.username || '').localeCompare(b.username || '', 'es', { sensitivity: 'base' })
      || a.chat_id.localeCompare(b.chat_id)
    );

    res.json({
      page,
      totalPages,
      total,
      pageSize: DIRECTORY_PAGE_SIZE,
      users: users.map((u) => ({ id: u.chat_id, name: u.username, unseenCount: u.unseen_count })),
    });
  } catch (error) {
    next(error);
  }
}

export async function mobileDirectoryGroups(req, res, next) {
  try {
    const requestedPage = toPositiveInt(req.query.p, 1);
    const total = stmts.countDirectoryGroups.get().total;
    const totalPages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * DIRECTORY_PAGE_SIZE;
    const groups = await ensureGroupDisplayNames(
      stmts.getDirectoryGroupsPage.all(DIRECTORY_PAGE_SIZE, offset)
    );
    const nameCollator = new Intl.Collator('es', { sensitivity: 'base' });
    groups.sort((a, b) =>
      nameCollator.compare(a.group_name || '', b.group_name || '') || a.group_id.localeCompare(b.group_id)
    );

    res.json({
      page,
      totalPages,
      total,
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
        return {
          kind: type,
          fileName: message.file_name || null,
          durationSec: message.duration_sec || null,
          downloadUrl,
          ...(type === 'video' && message.file_path_thumb ? { thumbUrl: message.file_path_thumb } : {}),
        };
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
    const targetJid = await resolveTargetJid(to);
    if (!targetJid) {
      return jsonError(res, 404, 'NUMBER_NOT_ON_WHATSAPP', 'El numero no tiene WhatsApp registrado.');
    }
    const isGroup = isGroupTarget(targetJid, type);

    let sent;
    try {
      [sent] = await sendOutgoingMessages({ targetJid, isGroup, text: processedText });
    } catch (error) {
      if (!(error instanceof SendMessageError)) throw error;
      console.error('[Mobile] Error enviando mensaje a WhatsApp:', error.cause?.message || error.message);
      return jsonError(res, 502, 'WHATSAPP_SEND_FAILED', 'No se pudo enviar el mensaje.');
    }

    res.status(201).json({
      id: sent.messageId,
      chatId: sent.chatId || targetJid,
      type: isGroup ? 'group' : 'user',
      text: sent.text,
      sentAt: sent.hourSend,
      whatsappMsgId: sent.whatsappMsgId,
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
