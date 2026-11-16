// Envío de mensajes salientes del Nokia — ÚNICA implementación, compartida por la web XHTML
// (message.controller.js) y la API JSON del cliente J2ME (mobile.controller.js).
//
// Aquí vive lo que es igual para ambos: resolver el destino, dar de alta el contacto o grupo,
// enviar por WhatsApp marcando el envío «en curso», guardar la fila local y enlazarla con su
// whatsapp_msg_id (ver pending-outgoing.service.js), y guardar los adjuntos enviados.
// Lo propio de cada interfaz (validar el formulario, menciones con pantalla de elección,
// páginas de error XHTML o respuestas JSON) se queda en su controlador.
import pkg from 'whatsapp-web.js';
import { stmts } from '../../db/db.js';
import { client as liveClient, syncOutgoingMessageAck } from '../services/whatsapp.service.js';
import {
  beginNokiaSend, endNokiaSend, registerPendingOutgoing, removeObservedOutgoing, takeObservedOutgoing,
} from '../services/pending-outgoing.service.js';
import { processAndAttachMedia, processAndAttachVideo } from '../utils/media.js';
import { getMessageQuotePreview } from '../utils/message-preview.js';
import { isNumericOrJid } from '../utils/jid.js';

const { MessageMedia } = pkg;

// Fallo de WhatsApp al enviar uno de los mensajes. `cause` es el error original.
// Los mensajes anteriores del mismo envío (p. ej. la 1.ª foto de dos) ya se enviaron y
// guardaron; sus adjuntos NO se guardan (mismo comportamiento que antes de unificar).
export class SendMessageError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.cause = cause;
  }
}

export function isGroupTarget(targetJid, type) {
  return type === 'group' || targetJid.endsWith('@g.us');
}

// JID de WhatsApp para un número o JID escrito por el usuario; null si el número no tiene
// WhatsApp. Sin cliente conectado lanza (igual que antes: client.getNumberId sobre null).
export async function resolveTargetJid(rawTarget, { waClient = liveClient } = {}) {
  const target = String(rawTarget).trim();
  if (target.includes('@')) return target;
  const numberDetails = await waClient.getNumberId(target);
  return numberDetails ? numberDetails._serialized : null;
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

// Alta del grupo, o mejora de su nombre si el guardado es un número/JID en bruto.
async function ensureGroupRow(targetJid, waClient) {
  const existingGroup = stmts.getGroupById.get(targetJid);
  const existingIsRaw = existingGroup ? isNumericOrJid(existingGroup.group_name) : false;
  let nameToSave = existingGroup ? existingGroup.group_name : null;

  if (!nameToSave || existingIsRaw) {
    let candidateName = targetJid.replace(/@.*$/, '');
    if (waClient) {
      try {
        const chat = await waClient.getChatById(targetJid);
        if (chat?.name && !isNumericOrJid(chat.name)) {
          candidateName = chat.name;
        }
      } catch (e) {
        // Ignorar error de resolución de grupo.
      }
    }
    nameToSave = normalizeGroupName(candidateName) || 'Grupo sin nombre';
  }

  if (!existingGroup || existingGroup.group_name !== nameToSave) {
    stmts.upsertGroup.run(targetJid, nameToSave);
  }
}

async function ensureUserRow(targetJid, waClient) {
  if (stmts.getUserByChatId.get(targetJid)) return;
  let finalName = `+${targetJid.split('@')[0]}`;
  try {
    const contact = await waClient.getContactById(targetJid);
    if (contact) {
      finalName = contact.name || contact.pushname || contact.shortName || contact.verifiedName || finalName;
    }
  } catch (e) {
    // Ignorar error de resolución de contacto, se guarda con nombre genérico.
  }
  stmts.upsertUser.run(targetJid, finalName);
}

// Fecha y hora actuales en Madrid, en el formato de day_send / hour_send.
function madridTimestamps() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const pad = (n) => String(n).padStart(2, '0');
  const daySend = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hourSend = `${daySend} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return { daySend, hourSend };
}

// Alias del mismo chat privado: el JID resuelto y su @lid / @c.us. Un número escrito a mano
// se resuelve a @c.us, pero si WhatsApp lleva ese chat por LID el message_create propio
// llega con @lid; sin los alias ese envío parecería hecho desde otro dispositivo.
async function getPrivateChatAliases(targetJid, waClient) {
  const aliases = [targetJid];
  if (typeof waClient?.getContactLidAndPhone !== 'function') return aliases;
  try {
    const [result] = await waClient.getContactLidAndPhone([targetJid]);
    for (const value of [result?.lid, result?.pn]) {
      const id = typeof value === 'string' ? value : value?._serialized;
      if (id && id.includes('@') && !aliases.includes(id)) aliases.push(id);
    }
  } catch (err) {
    console.debug(`[mensaje] No se pudo resolver el LID/teléfono de ${targetJid}:`, err?.message || err);
  }
  return aliases;
}

// Fila de usuario donde guardar el chat: la que ya exista con cualquiera de los alias; si no
// hay ninguna, el @lid (es el id con el que llegarán las respuestas), o el JID resuelto.
function pickPrivateStorageJid(aliases) {
  for (const id of aliases) {
    if (stmts.getUserByChatId.get(id)) return id;
  }
  return aliases.find((id) => id.endsWith('@lid')) || aliases[0];
}

// Enlaza la fila recién insertada con su whatsapp_msg_id: el que devolvió sendMessage, el
// que message_create ya dejó «observado», o se deja pendiente para cuando llegue.
function linkOutgoingRow(chatIds, insertedMessageId, whatsappMsgId, ack) {
  if (whatsappMsgId) {
    for (const chatId of chatIds) removeObservedOutgoing(chatId, whatsappMsgId);
    syncOutgoingMessageAck(whatsappMsgId, ack);
    return whatsappMsgId;
  }
  for (const chatId of chatIds) {
    const observedId = takeObservedOutgoing(chatId);
    if (observedId) {
      stmts.setMessageWhatsappId.run(observedId, insertedMessageId);
      syncOutgoingMessageAck(observedId, ack);
      return observedId;
    }
  }
  for (const chatId of chatIds) registerPendingOutgoing(chatId, insertedMessageId);
  return null;
}

async function saveSentAttachments(sentMedia) {
  for (const { messageId, mediaFile, mediaType } of sentMedia) {
    try {
      const options = {
        mediaKey: `out_${messageId}_${Date.now()}`,
        filename: mediaFile.originalname || (mediaType === 'video' ? `out_${messageId}.3gp` : `out_${messageId}.jpg`),
        mimeType: mediaType === 'video' ? 'video/3gpp' : mediaFile.mimetype || 'image/jpeg',
      };
      const saved = mediaType === 'video'
        ? await processAndAttachVideo(messageId, mediaFile.buffer, options)
        : await processAndAttachMedia(messageId, mediaFile.buffer, options);
      if (saved.previewError) {
        console.error('[mensaje] Video guardado sin fotograma de vista previa:', saved.previewError.message);
      }
    } catch (mediaErr) {
      console.error(`[mensaje] Error guardando attachment saliente (${mediaType}):`, mediaErr.message);
    }
  }
}

/**
 * Envía uno o varios mensajes a un chat y los guarda como propios.
 *
 * @param {object} p
 * @param {string} p.targetJid      JID ya resuelto (resolveTargetJid).
 * @param {boolean} p.isGroup
 * @param {string} [p.text]         Texto ya procesado (emojis, menciones «@<número>»).
 * @param {Array<{file, mediaType: 'image'|'video'}>} [p.mediaFiles]  Archivos de multer.
 *        Con varios, el texto va como pie del primero y cada archivo es un mensaje.
 * @param {object|null} [p.replyMessage]  Fila de getReplyMessageById (ya validada).
 * @param {string[]|null} [p.mentions]    JIDs mencionados en el texto.
 * @returns {Promise<Array<{messageId, whatsappMsgId, chatId, text, daySend, hourSend}>>}
 *          chatId: chat donde quedó guardado (en privados puede ser el @lid del número).
 * @throws {SendMessageError} code 'SEND_FAILED' si WhatsApp rechaza un envío.
 */
export async function sendOutgoingMessages({
  targetJid,
  isGroup,
  text = '',
  mediaFiles = [],
  replyMessage = null,
  mentions = null,
  waClient = liveClient,
}) {
  if (isGroup) await ensureGroupRow(targetJid, waClient);
  const chatAliases = isGroup ? [targetJid] : await getPrivateChatAliases(targetJid, waClient);
  const storageJid = isGroup ? targetJid : pickPrivateStorageJid(chatAliases);

  const options = {};
  if (mentions?.length) options.mentions = mentions;
  if (replyMessage) {
    options.quotedMessageId = replyMessage.whatsapp_msg_id;
    options.ignoreQuoteErrors = false;
  }
  options.waitUntilMsgSent = true;

  const outgoingMessages = mediaFiles.length
    ? mediaFiles.map(({ file, mediaType }, index) => ({
      mediaFile: file,
      mediaType,
      text: index === 0 ? text : '',
    }))
    : [{ mediaFile: null, mediaType: null, text }];

  const results = [];
  const sentMedia = [];

  for (const { mediaFile, mediaType, text: messageText } of outgoingMessages) {
    // Marca este envío como «en curso» hasta haber enlazado su fila: el message_create
    // propio que WhatsApp emite mientras tanto es de este envío, no de otro dispositivo.
    const sendToken = beginNokiaSend(chatAliases, { text: messageText, hasMedia: Boolean(mediaFile) });
    try {
      let sentMessage;
      try {
        if (mediaFile) {
          const media = new MessageMedia(
            mediaType === 'video' ? 'video/3gpp' : mediaFile.mimetype,
            mediaFile.buffer.toString('base64'),
            mediaFile.originalname
          );
          const mediaOptions = { ...options, caption: messageText };
          if (!messageText) delete mediaOptions.mentions;
          sentMessage = await waClient.sendMessage(targetJid, media, mediaOptions);
        } else {
          sentMessage = await waClient.sendMessage(targetJid, messageText, options);
        }
      } catch (error) {
        throw new SendMessageError('SEND_FAILED', error?.message || 'No se pudo enviar el mensaje.', { cause: error });
      }

      // whatsapp-web.js puede no devolver el id, así que se enlaza después del evento
      // message_create cuando WhatsApp confirme el envío.
      const returnedId = sentMessage?.id?._serialized || sentMessage?.id?.$1 || null;
      const { daySend, hourSend } = madridTimestamps();
      const finalText = messageText || (mediaType === 'video' ? '[Video]' : '[Imagen]');
      const hasAttachment = Boolean(mediaFile);
      let insertedMessageId;

      // Red de seguridad: si message_create ya guardó este mismo mensaje como «de otro
      // dispositivo» (no se reconoció el envío en curso), se adopta esa fila en vez de
      // insertar otra con el mismo whatsapp_msg_id (UNIQUE) y fallar tras haberlo enviado.
      const alreadySaved = returnedId ? stmts.findMessageByWhatsappId.get(returnedId) : null;
      if (alreadySaved) {
        console.warn(`[mensaje] ${returnedId} ya estaba guardado (fila #${alreadySaved.id}); se reutiliza.`);
        syncOutgoingMessageAck(returnedId, sentMessage?.ack);
        results.push({ messageId: alreadySaved.id, whatsappMsgId: returnedId, chatId: storageJid, text: finalText, daySend, hourSend });
        continue;
      }

      if (isGroup) {
        if (!stmts.getGroupById.get(targetJid)) {
          let groupName = 'Grupo sin nombre';
          try {
            const chat = await waClient.getChatById(targetJid);
            if (chat && chat.name) groupName = chat.name;
          } catch (e) {}
          stmts.upsertGroup.run(targetJid, groupName);
        }
        const result = hasAttachment
          ? stmts.insertMessageWithMedia.run(finalText, daySend, hourSend, 1, null, targetJid, null, returnedId)
          : stmts.insertMessage.run(finalText, daySend, hourSend, 1, null, targetJid, returnedId);
        insertedMessageId = result.lastInsertRowid;
      } else {
        await ensureUserRow(storageJid, waClient);
        const result = hasAttachment
          ? stmts.insertMessageWithMedia.run(finalText, daySend, hourSend, 1, storageJid, null, null, returnedId)
          : stmts.insertMessage.run(finalText, daySend, hourSend, 1, storageJid, null, returnedId);
        insertedMessageId = result.lastInsertRowid;
      }

      if (replyMessage && insertedMessageId) {
        stmts.updateMessageQuote.run(
          getMessageQuotePreview(replyMessage),
          (Number(replyMessage.from_me) === 1 ? 'Yo' : (replyMessage.username || 'Desconocido')).slice(0, 100),
          insertedMessageId
        );
      }

      let whatsappMsgId = returnedId;
      if (insertedMessageId) {
        whatsappMsgId = linkOutgoingRow(chatAliases, insertedMessageId, returnedId, sentMessage?.ack);
      }

      if (mediaType === 'video' && insertedMessageId) {
        stmts.setMessageMediaType.run('video', insertedMessageId);
      }

      if (mediaFile && insertedMessageId) {
        sentMedia.push({ messageId: insertedMessageId, mediaFile, mediaType });
      }

      results.push({ messageId: insertedMessageId, whatsappMsgId, chatId: storageJid, text: finalText, daySend, hourSend });
    } finally {
      endNokiaSend(sendToken);
    }
  }

  await saveSentAttachments(sentMedia);
  return results;
}
