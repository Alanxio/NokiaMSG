import db, { stmts } from '../../db/db.js';
import { getRequestPayload } from '../utils/request.js';
import { join } from 'path';
import { randomBytes } from 'crypto';
import {
  getSmsNotificationStatus,
  sendCallSmsNotification,
  sendSmsNotification,
} from '../services/sms-notification.service.js';
import { isNumericOrJid } from './page.controller.js';
import { getLastActivityAt } from '../middlewares/auth.middleware.js';

// Si el Nokia ha cargado una página hace menos de esto, el SMS se aplaza (estás en la web).
function getActiveWindowMs() {
  const seconds = Number.parseInt(process.env.SMS_ACTIVE_WINDOW_SECONDS || '15', 10);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 15) * 1000;
}
const SMS_RETRY_DELAY_MS = 5_000;
// Un aviso aplazado se sigue reintentando mientras sigas en la web, hasta este límite.
const SMS_DEFERRED_MAX_MS = 10 * 60_000;

function readChatSmsState(isGroup, chatId) {
  const row = isGroup ? stmts.getGroupById.get(chatId) : stmts.getUserByChatId.get(chatId);
  return {
    unseen: Number(row?.unseen_count) || 0,
    muted: Number(row?.sms_muted) === 1,
    notified: Number(row?.sms_notified) === 1,
  };
}

function markSmsNotified(isGroup, chatId, value) {
  if (isGroup) (value ? stmts.setGroupSmsNotified : stmts.clearGroupSmsNotified).run(chatId);
  else (value ? stmts.setUserSmsNotified : stmts.clearUserSmsNotified).run(chatId);
}

// Envía el SMS de la racha con un reintento. Si Twilio falla dos veces se quita la marca
// «ya avisado»: si no, ese chat no volvería a avisar hasta que se leyera.
async function deliverChatSms(isGroup, chatId, payload) {
  markSmsNotified(isGroup, chatId, true);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await sendSmsNotification(payload);
    if (result?.status === 'sent') return;
    if (result?.status !== 'failed') {
      // Desactivado o mal configurado: no es un fallo puntual, no reintentar.
      markSmsNotified(isGroup, chatId, false);
      console.log(`[SMS] No enviado (${result?.status}${result?.missing?.length ? `, falta ${result.missing.join(', ')}` : ''})`);
      return;
    }
    if (attempt === 1) {
      console.warn(`[SMS] Fallo enviando aviso de ${chatId}, reintento en ${SMS_RETRY_DELAY_MS / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, SMS_RETRY_DELAY_MS));
    }
  }
  markSmsNotified(isGroup, chatId, false);
  console.error(`[SMS] Aviso de ${chatId} no enviado tras 2 intentos; el próximo mensaje lo volverá a intentar.`);
}

async function deliverCallSms(payload) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await sendCallSmsNotification(payload);
    if (result?.status === 'sent') return;
    if (result?.status !== 'failed') {
      console.log(`[SMS] Aviso de llamada no enviado (${result?.status}${result?.missing?.length ? `, falta ${result.missing.join(', ')}` : ''})`);
      return;
    }
    if (attempt === 1) {
      console.warn(`[SMS] Fallo enviando aviso de llamada, reintento en ${SMS_RETRY_DELAY_MS / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, SMS_RETRY_DELAY_MS));
    }
  }
  console.error('[SMS] Aviso de llamada no enviado tras 2 intentos.');
}

// Avisos omitidos por estar activo en la web: se revisan al acabar la ventana para que
// un mensaje que llega justo al dejar el Nokia no se quede sin SMS.
const deferredSmsChecks = new Map();

function scheduleDeferredSms(isGroup, chatId, payload, startedAt = Date.now()) {
  if (deferredSmsChecks.has(chatId)) return;
  const waitMs = Math.max(1_000, getActiveWindowMs() - (Date.now() - getLastActivityAt()) + 1_000);
  const timer = setTimeout(() => {
    deferredSmsChecks.delete(chatId);
    try {
      const state = readChatSmsState(isGroup, chatId);
      if (state.unseen === 0 || state.notified || state.muted) {
        console.log(`[SMS] Aviso aplazado de ${chatId} descartado (${state.unseen === 0 ? 'ya leído' : state.notified ? 'ya notificado' : 'silenciado'})`);
        return;
      }
      if (Date.now() - getLastActivityAt() < getActiveWindowMs()) {
        if (Date.now() - startedAt < SMS_DEFERRED_MAX_MS) {
          scheduleDeferredSms(isGroup, chatId, payload, startedAt);
        } else {
          console.log(`[SMS] Aviso aplazado de ${chatId} descartado (sigues en la web desde hace 10 min)`);
        }
        return;
      }
      console.log(`[SMS] Enviando aviso aplazado de ${chatId} (${state.unseen} sin leer)`);
      deliverChatSms(isGroup, chatId, payload)
        .catch((err) => console.error('[SMS] Fallo al lanzar aviso aplazado:', err));
    } catch (err) {
      console.error('[SMS] Error revisando aviso aplazado:', err);
    }
  }, waitMs);
  timer.unref?.();
  deferredSmsChecks.set(chatId, timer);
}

function normalizeGroupName(rawName) {
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return null;
  }
  const trimmed = rawName.trim();
  if (isNumericOrJid(trimmed)) {
    return null;
  }
  return trimmed.slice(0, 100);
}

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
    const isSystem = payload.is_system ?? 0;
    const isCall = payload.is_call === true || payload.is_call === 1 || payload.is_call === 'true';
    const mediaType = (typeof payload.media_type === 'string' && payload.media_type.trim())
      ? payload.media_type.trim().slice(0, 20)
      : null;
    const quotedText = typeof payload.quoted_text === 'string' && payload.quoted_text.trim()
      ? payload.quoted_text.trim().slice(0, 300)
      : null;
    const quotedSender = typeof payload.quoted_sender === 'string' && payload.quoted_sender.trim()
      ? payload.quoted_sender.trim().slice(0, 100)
      : null;

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

    // La clasificación explícita (chat_type/is_group), cuando viene informada por el
    // llamador, manda siempre sobre el heurístico de ":" en el título. Un pushname o
    // nombre de grupo que contenga ":" desbarataba el heurístico y hacía que este
    // bloque y el de más abajo (que decide a qué contador de no-leídos sumar) discreparan
    // entre sí, dejando el contador de esa conversación congelado para siempre.
    const explicitType = typeof payload.chat_type === 'string' ? payload.chat_type.trim().toLowerCase() : '';
    const explicitIsGroup = payload.is_group === 1 || payload.is_group === true || payload.is_group === 'true';
    const explicitIsUser = payload.is_group === 0 || payload.is_group === false || payload.is_group === 'false';
    const hasExplicitType = explicitType === 'group' || explicitType === 'user' || explicitIsGroup || explicitIsUser;

    const cleanPattern = /\s*\(\d+\s*(mensajes?|messages?)\)/gi;
    const normalizedTitle = title.replace(cleanPattern, '').trim();
    const lastColon = normalizedTitle.lastIndexOf(':');
    const looksLikeGroup = lastColon > 0 && lastColon < normalizedTitle.length - 1;

    const isGroup = hasExplicitType ? (explicitType === 'group' || explicitIsGroup) : looksLikeGroup;

    // Campos explícitos opcionales (los usa whatsapp.service.js) para no depender de
    // partir el título por ":" cuando el nombre del grupo o del remitente lo contenga.
    const explicitGroupName = typeof payload.group_name === 'string' ? payload.group_name.trim().slice(0, 100) : '';
    const explicitSenderName = typeof payload.sender_name === 'string' ? payload.sender_name.trim().slice(0, 100) : '';
    const senderNamePriority = Number.isInteger(Number(payload.sender_name_priority))
      ? Math.max(0, Math.min(4, Number(payload.sender_name_priority)))
      : 0;

    let nameOrGroupName, username;
    if (isGroup) {
      if (explicitGroupName) {
        nameOrGroupName = explicitGroupName;
        username = (explicitSenderName || 'Desconocido').slice(0, 100);
      } else if (looksLikeGroup) {
        nameOrGroupName = normalizedTitle.slice(0, lastColon).trim().slice(0, 100);
        username = (normalizedTitle.slice(lastColon + 1).trim() || 'Desconocido').slice(0, 100);
      } else {
        nameOrGroupName = normalizedTitle.slice(0, 100);
        username = 'Desconocido';
      }
    } else {
      nameOrGroupName = (explicitSenderName || normalizedTitle).slice(0, 100);
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

    const processedMessage = message.trim().slice(0, 65535);

    db.exec('BEGIN');

    try {
      let finalGroupId = null;
      let finalUserChatId = null;

      if (isGroup) {
        finalGroupId = chatId || makeId('g_');
        const existingGroup = stmts.getGroupById.get(finalGroupId) || (nameOrGroupName ? stmts.getGroupByName.get(nameOrGroupName) : null);
        const normalizedGroupName = normalizeGroupName(nameOrGroupName) || (existingGroup?.group_name || 'Grupo sin nombre');

        if (existingGroup) {
          finalGroupId = existingGroup.group_id;
          if (existingGroup.group_name !== normalizedGroupName) {
            const shouldUpdate = !isNumericOrJid(normalizedGroupName) || isNumericOrJid(existingGroup.group_name);
            if (shouldUpdate) {
              stmts.upsertGroup.run(finalGroupId, normalizedGroupName);
            }
          }
        } else {
          stmts.upsertGroup.run(finalGroupId, normalizedGroupName);
        }

        // Usar senderChatId (msg.author) para el usuario emisor, NO chatId (que es el grupo)
        const userKey = senderChatId || null;
        if (userKey) {
          const existingUser = stmts.getUserByChatId.get(userKey);
          if (existingUser) {
            finalUserChatId = existingUser.chat_id;
            // Actualizar el nombre si ha cambiado
            stmts.upsertUserNameIfPreferred.run(finalUserChatId, username, senderNamePriority);
          } else {
            finalUserChatId = userKey;
            stmts.upsertUserNameIfPreferred.run(finalUserChatId, username, senderNamePriority);
          }
        } else if (isCall) {
          finalUserChatId = null;
        } else {
          // Fallback: buscar por nombre si no hay sender_chat_id
          const existingUser = stmts.getUserByUsername.get(username);
          if (existingUser) {
            finalUserChatId = existingUser.chat_id;
          } else {
            finalUserChatId = makeId('u_');
            stmts.upsertUserNameIfPreferred.run(finalUserChatId, username, senderNamePriority);
          }
        }

        if (finalUserChatId) {
          stmts.insertParticipant.run(finalUserChatId, finalGroupId);
        }
      } else {
        // Lógica de usuario individual
        const existingUser = stmts.getUserByChatId.get(chatId || '');
        finalUserChatId = existingUser?.chat_id || chatId || makeId('u_');
        stmts.upsertUserNameIfPreferred.run(finalUserChatId, nameOrGroupName, senderNamePriority);
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
        INSERT OR IGNORE INTO messages (text, day_send, hour_send, from_me, user_chat_id, group_id, has_media, is_sticker, media_key, whatsapp_msg_id, quoted_text, quoted_sender, is_system, media_type)
        VALUES (@text, @day_send, @hour_send, @from_me, @user_chat_id, @group_id, @has_media, @is_sticker, @media_key, @whatsapp_msg_id, @quoted_text, @quoted_sender, @is_system, @media_type)
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
        whatsapp_msg_id: whatsappMsgId,
        quoted_text: quotedText,
        quoted_sender: quotedSender,
        is_system: isSystem ? 1 : 0,
        media_type: mediaType
      });

      if (msgResult.changes === 0) {
        db.exec('ROLLBACK');
        console.log(`[DB] Mensaje duplicado (INSERT OR IGNORE): whatsappMsgId=${whatsappMsgId}`);
        res.status(200).json({ success: true, duplicate: true });
        return;
      }

      const messageId = msgResult.lastInsertRowid;

      // sms_notified (no unseen_count) decide si toca SMS: unseen_count también lo escribe
      // por su cuenta el listener de unreadCount de WhatsApp (ver applyChatUnreadCount en
      // whatsapp.service.js), y esa escritura puede adelantarse a esta — sobre todo con
      // media, que tarda en descargarse antes de llegar aquí — dejando previousUnseen en 1
      // aunque sea el primer mensaje real. sms_notified es un estado que solo esta función
      // controla, así que no sufre esa carrera.
      let previousUnseen = 0;
      let isSmsMuted = false;
      let alreadyNotified = false;
      if (isGroup) {
        const groupRow = stmts.getGroupById.get(finalGroupId);
        previousUnseen = groupRow?.unseen_count || 0;
        isSmsMuted = Number(groupRow?.sms_muted) === 1;
        alreadyNotified = Number(groupRow?.sms_notified) === 1;
        stmts.incrementGroupUnseen.run(finalGroupId);
      } else {
        const userRow = stmts.getUserByChatId.get(finalUserChatId);
        previousUnseen = userRow?.unseen_count || 0;
        isSmsMuted = Number(userRow?.sms_muted) === 1;
        alreadyNotified = Number(userRow?.sms_notified) === 1;
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
          mediaInfo.durationSec ?? null,
          0,
          Math.floor(Date.now() / 1000)
        );
      }

      db.exec('COMMIT');

      if (isCall && isSmsMuted) {
        console.log(`[SMS] Aviso de llamada omitido (chat silenciado, ${isGroup ? finalGroupId : finalUserChatId})`);
      } else if (isCall) {
        // Las llamadas tienen prioridad: SMS siempre que el chat no esté silenciado, sin
        // mirar mensajes sin leer, si ya se avisó de la racha ni si estás en la web.
        const callPayload = {
          type: isGroup ? 'group' : 'user',
          callerName: (typeof payload.call_caller_name === 'string' && payload.call_caller_name.trim()) || username,
          groupName: isGroup ? (stmts.getGroupById.get(finalGroupId)?.group_name || nameOrGroupName) : null,
          phoneNumber: payload.phone_number,
          isVideo: payload.is_video === true || payload.is_video === 1 || payload.is_video === 'true',
        };
        console.log(`[SMS] Aviso de llamada de ${callPayload.callerName}`);
        deliverCallSms(callPayload)
          .catch(err => console.error('[SMS] Fallo al lanzar aviso de llamada:', err));
      } else {
        // Los mensajes normales respetan la racha de no leídos, el silencio del chat y la
        // actividad reciente en la web. Las llamadas solo omiten esos límites, no el silencio.
        const msSinceActivity = Date.now() - getLastActivityAt();
        const isActiveOnWeb = msSinceActivity < getActiveWindowMs();
        const smsChatId = isGroup ? finalGroupId : finalUserChatId;

        if (!fromMe && !alreadyNotified && !isSmsMuted) {
          // Para el nombre de grupo del SMS, usar el que ya está guardado en wgroups (el
          // dato fiable, protegido por la lógica de "shouldUpdate" de más arriba) en vez
          // de nameOrGroupName, que viene directo de la ingesta y puede ser un ID en
          // crudo si la resolución en vivo falló para este mensaje en concreto.
          const smsGroupName = isGroup
            ? (stmts.getGroupById.get(finalGroupId)?.group_name || nameOrGroupName)
            : nameOrGroupName;
          const smsPayload = {
            type: isGroup ? 'group' : 'user',
            groupName: smsGroupName,
            username: username,
            chatId: smsChatId,
          };
          if (isActiveOnWeb) {
            console.log(`[SMS] Aplazado (activo en la web hace ${Math.round(msSinceActivity / 1000)}s), se revisará al acabar la ventana`);
            scheduleDeferredSms(isGroup, smsChatId, smsPayload);
          } else {
            console.log(`[SMS] Disparando notificación (previousUnseen=${previousUnseen})`);
            // deliverChatSms marca «ya avisado» de forma síncrona antes del primer await,
            // así dos mensajes casi simultáneos no disparan dos SMS para la misma racha.
            deliverChatSms(isGroup, smsChatId, smsPayload)
              .catch(err => console.error('[SMS] Fallo al lanzar notificación:', err));
          }
        } else if (!fromMe) {
          const motivo = alreadyNotified ? 'ya notificado' : isSmsMuted ? 'silenciado' : 'desconocido';
          console.log(`[SMS] Omitido (motivo=${motivo}, previousUnseen=${previousUnseen})`);
        }
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
