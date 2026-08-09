import db, { stmts } from '../../db/db.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { getRequestPayload } from '../utils/request.js';
import { join } from 'path';
import { randomBytes } from 'crypto';
import {
  getSmsNotificationStatus,
  sendSmsNotification,
} from '../services/sms-notification.service.js';

function normalizeNotificationDate(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return trimmed;

  const slashMatch = trimmed.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (slashMatch) return `${slashMatch[3]}-${slashMatch[2]}-${slashMatch[1]}`;
  return null;
}

function normalizeNotificationTime(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  const ampmMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?\s*m?\.?$/);
  if (ampmMatch) {
    let hour = Number.parseInt(ampmMatch[1], 10);
    const minute = ampmMatch[2];
    const second = ampmMatch[3] || '00';
    const meridiem = ampmMatch[4];
    if (hour === 12) hour = meridiem === 'a' ? 0 : 12;
    else if (meridiem === 'p') hour += 12;
    return `${String(hour).padStart(2, '0')}:${minute}:${second}`;
  }

  const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeMatch) {
    const hour = Number.parseInt(timeMatch[1], 10);
    const minute = Number.parseInt(timeMatch[2], 10);
    const second = Number.parseInt(timeMatch[3] || '0', 10);
    if (hour > 23 || minute > 59 || second > 59) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
  }
  return null;
}

function getSpainNow() {
  const now = new Date();
  return new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
}

function buildNotificationTimestamps(rawDate, rawTime) {
  const spainNow = getSpainNow();
  const date = normalizeNotificationDate(rawDate);
  const time = normalizeNotificationTime(rawTime);

  if (date && time) {
    return { daySend: date, hourSend: `${date} ${time}`, usedFallback: false };
  }
  if (date) {
    return { daySend: date, hourSend: `${date} 00:00:00`, usedFallback: false };
  }
  if (time) {
    const today = spainNow.toISOString().slice(0, 10);
    return { daySend: today, hourSend: `${today} ${time}`, usedFallback: false };
  }

  const nowStr = spainNow.toISOString().slice(0, 19).replace('T', ' ');
  return { daySend: nowStr.slice(0, 10), hourSend: nowStr, usedFallback: true };
}

function makeId(prefix) {
  return `${prefix}${Date.now()}_${randomBytes(4).toString('hex')}`;
}

export async function saveInteraction(req, res, next, mediaInfo = null) {
  try {
    const payload = await getRequestPayload(req);
    console.log('[DB] saveInteraction:', payload);

    let title = payload.title ?? payload.name ?? payload.chat ?? payload.chat_name;
    let message = payload.message ?? payload.text ?? payload.body ?? payload.content;
    let time = payload.time ?? payload.hour ?? payload.sent_at;
    if (time && typeof time === 'string' && time.includes(' ')) {
      time = time.split(' ')[1];
      console.log('[DB] Hora extraída del datetime:', time);
    }
    let date = payload.date ?? payload.day ?? payload.sent_date;
    let chatId = (payload.chat_id && typeof payload.chat_id === 'string')
      ? payload.chat_id.trim().slice(0, 100) || null
      : null;

    // sender_chat_id: en grupos es msg.author (el emisor real), en chats privados es msg.from
    let senderChatId = (payload.sender_chat_id && typeof payload.sender_chat_id === 'string')
      ? payload.sender_chat_id.trim().slice(0, 100) || null
      : null;

    let whatsappMsgId = payload.whatsapp_msg_id || null;
    let fromMe = payload.from_me ?? 0;
    let isSticker = payload.is_sticker ?? 0;

    // =========================================================================
    // SEGURIDAD RADICAL: Forzar from_me a 0 o 1 basándonos en el ID oficial
    // =========================================================================
    if (whatsappMsgId && typeof whatsappMsgId === 'string') {
      if (whatsappMsgId.startsWith('false_')) {
        fromMe = 0;
      } else if (whatsappMsgId.startsWith('true_')) {
        fromMe = 1;
      }
    } else {
      fromMe = (payload.from_me === 1 || payload.from_me === true || payload.from_me === 'true') ? 1 : 0;
    }

    const hasMedia = mediaInfo?.hasMedia ?? false;
    const mediaKey = mediaInfo?.mediaKey ?? null;

    if (!title || !message) {
      res.status(400).json({ error: 'title y message son requeridos' });
      return;
    }

    const cleanPattern = /\s*\(\d+\s*(mensajes?|messages?)\)/gi;
    const normalizedTitle = title.replace(cleanPattern, '').trim();
    const lastColon = normalizedTitle.lastIndexOf(':');
    const looksLikeGroup = lastColon > 0 && lastColon < normalizedTitle.length - 1;

    let isGroup, nameOrGroupName, username;
    if (looksLikeGroup) {
      isGroup = true;
      nameOrGroupName = normalizedTitle.slice(0, lastColon).trim().slice(0, 100);
      username = (normalizedTitle.slice(lastColon + 1).trim() || 'Desconocido').slice(0, 100);
    } else {
      isGroup = false;
      nameOrGroupName = normalizedTitle.slice(0, 100);
      username = nameOrGroupName;
    }

    console.log(`[DB] Tipo: ${isGroup ? 'GRUPO' : 'USUARIO'} | group="${nameOrGroupName}" | user="${username}"`);

    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: 'message no puede estar vacío' });
      return;
    }

    const { daySend, hourSend: initialHourSend, usedFallback } = buildNotificationTimestamps(date, time);
    let hourSend = initialHourSend;
    if (usedFallback) console.log('[DB] Fecha/hora no válida, usando actual.');

    if (hourSend && (hourSend.includes('00:00:00') || hourSend === '00:00' || hourSend === '00:00:00')) {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
      const pad = (n) => String(n).padStart(2, '0');
      const correctedTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      hourSend = hourSend.includes(' ') ? `${daySend} ${correctedTime}` : correctedTime;
      console.log('[DB] ¡Hora cazada y corregida de 00:00 a:', correctedTime);
    }

    const processedMessage = convertEmojisToAscii(message.trim().slice(0, 65535));

    db.exec('BEGIN');

    try {
      let finalGroupId = null;
      let finalUserChatId = null;
      const explicitType = typeof payload.chat_type === 'string' ? payload.chat_type.trim().toLowerCase() : '';
      const explicitIsGroup = payload.is_group === 1 || payload.is_group === true || payload.is_group === 'true';
      const explicitIsUser = payload.is_group === 0 || payload.is_group === false || payload.is_group === 'false';
      const hasExplicitType = explicitType === 'group' || explicitType === 'user' || explicitIsGroup || explicitIsUser;

      if (hasExplicitType ? (explicitType === 'group' || explicitIsGroup) : isGroup) {
        const existingGroup = stmts.getGroupByName.get(nameOrGroupName);
        if (existingGroup) {
          finalGroupId = existingGroup.group_id;
        } else {
          finalGroupId = chatId || makeId('g_');
          stmts.upsertGroup.run(finalGroupId, nameOrGroupName);
        }

        // Usar senderChatId (msg.author) para el usuario emisor, NO chatId (que es el grupo)
        const userKey = senderChatId || null;
        if (userKey) {
          const existingUser = stmts.getUserByChatId.get(userKey);
          if (existingUser) {
            finalUserChatId = existingUser.chat_id;
            // Actualizar el nombre si ha cambiado
            stmts.upsertUser.run(finalUserChatId, username);
          } else {
            finalUserChatId = userKey;
            stmts.upsertUser.run(finalUserChatId, username);
          }
        } else {
          // Fallback: buscar por nombre si no hay sender_chat_id
          const existingUser = stmts.getUserByUsername.get(username);
          if (existingUser) {
            finalUserChatId = existingUser.chat_id;
          } else {
            finalUserChatId = makeId('u_');
            stmts.upsertUser.run(finalUserChatId, username);
          }
        }

        stmts.insertParticipant.run(finalUserChatId, finalGroupId);
      } else {
        // Lógica de usuario individual
        const existingUser = stmts.getUserByChatId.get(chatId || '');
        if (existingUser) {
          finalUserChatId = existingUser.chat_id;
        } else {
          finalUserChatId = chatId || makeId('u_');
          stmts.upsertUser.run(finalUserChatId, nameOrGroupName);
        }
      }

      if (whatsappMsgId) {
        const existing = stmts.findMessageByWhatsappId.get(whatsappMsgId);
        if (existing) {
          db.exec('ROLLBACK');
          console.log(`[DB] Mensaje duplicado descartado: whatsappMsgId=${whatsappMsgId}`);
          res.status(200).json({ success: true, duplicate: true, messageId: existing.id });
          return;
        }
      }

      // =========================================================================
      // SOLUCIÓN AL [Yo]: Inserción segura con parámetros explícitos y nombrados
      // =========================================================================
      const msgResult = db.prepare(`
        INSERT OR IGNORE INTO messages (text, day_send, hour_send, from_me, user_chat_id, group_id, has_media, is_sticker, media_key, whatsapp_msg_id)
        VALUES (@text, @day_send, @hour_send, @from_me, @user_chat_id, @group_id, @has_media, @is_sticker, @media_key, @whatsapp_msg_id)
      `).run({
        text: processedMessage,
        day_send: daySend,
        hour_send: hourSend,
        from_me: Number(fromMe), // Fuerza entero 0 o 1 estricto para SQLite
        user_chat_id: finalUserChatId,
        group_id: finalGroupId,
        has_media: hasMedia ? 1 : 0,
        is_sticker: isSticker ? 1 : 0,
        media_key: mediaKey,
        whatsapp_msg_id: whatsappMsgId
      });

      if (msgResult.changes === 0) {
        db.exec('ROLLBACK');
        console.log(`[DB] Mensaje duplicado (INSERT OR IGNORE): whatsappMsgId=${whatsappMsgId}`);
        res.status(200).json({ success: true, duplicate: true });
        return;
      }

      const messageId = msgResult.lastInsertRowid;

      // Consultar unseen ANTES de incrementar para decidir si enviar SMS
      let previousUnseen = 0;
      if (isGroup) {
        const groupRow = stmts.getGroupById.get(finalGroupId);
        previousUnseen = groupRow?.unseen_count || 0;
        stmts.incrementGroupUnseen.run(finalGroupId);
      } else {
        const userRow = stmts.getUserByChatId.get(finalUserChatId);
        previousUnseen = userRow?.unseen_count || 0;
        stmts.incrementUserUnseen.run(finalUserChatId);
      }

      if (hasMedia && mediaInfo) {
        stmts.insertAttachment.run(
          messageId,
          mediaKey,
          mediaInfo.mimeType,
          mediaInfo.filename,
          mediaInfo.bufferLength,
          mediaInfo.filePathFull || mediaInfo.originalPath,
          mediaInfo.filePathView || null,
          mediaInfo.filePathThumb || null,
          0,
          Math.floor(Date.now() / 1000)
        );
      }

      db.exec('COMMIT');

      // Disparar la notificación SMS solo si pasamos de 0 a 1 mensaje no visto
      if (!fromMe && previousUnseen === 0) {
        sendSmsNotification({
          type: isGroup ? 'group' : 'user',
          groupName: nameOrGroupName,
          username: username
        }).catch(err => console.error('[SMS] Fallo al lanzar notificación:', err));
      }

      res.status(201).json({ success: true, messageId });
      return messageId;

    } catch (dbError) {
      db.exec('ROLLBACK');
      throw dbError;
    }

  } catch (error) {
    next(error);
    return null;
  }
}
