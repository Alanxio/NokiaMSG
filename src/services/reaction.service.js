// Reacciones de WhatsApp (evento message_reaction de whatsapp-web.js). Solo se guardan para
// mostrarlas bajo el mensaje: no cuentan como no leídos ni avisan por SMS.
//
// El evento llega al poner, cambiar y quitar una reacción (texto vacío = quitada), también
// las propias hechas desde el móvil. Cada persona tiene como mucho una por mensaje.
import { stmts } from '../../db/db.js';
import { getSerializedId } from '../whatsapp/ids.js';

// «false_<chat>_<ID>[_<autor>]» → «<ID>». null si no tiene esa forma.
export function getShortMessageId(serializedId) {
  if (typeof serializedId !== 'string') return null;
  const parts = serializedId.split('_');
  if (parts.length < 3 || !parts[1].includes('@')) return null;
  return /^[A-Za-z0-9]+$/.test(parts[2]) ? parts[2] : null;
}

// Fila local del mensaje al que se reacciona: por id completo y, si no, por su id corto.
export function findReactedMessageId(parentKey) {
  const serialized = getSerializedId(parentKey);
  if (!serialized) return null;
  const exact = stmts.findMessageByWhatsappId.get(serialized);
  if (exact) return exact.id;
  const shortId = getShortMessageId(serialized);
  return shortId ? (stmts.findMessageByShortId.get({ shortId })?.id ?? null) : null;
}

// Devuelve 'set', 'removed' o null (mensaje que no está en el Nokia / evento incompleto).
export function applyReaction(reaction) {
  const senderId = getSerializedId(reaction?.senderId);
  if (!senderId) return null;
  const messageId = findReactedMessageId(reaction?.msgId);
  if (!messageId) return null;

  const text = typeof reaction.reaction === 'string' ? reaction.reaction.trim() : '';
  if (!text) {
    stmts.deleteReaction.run(messageId, senderId);
    return 'removed';
  }
  const timestamp = Number(reaction.timestamp);
  const reactedAt = Number.isFinite(timestamp) && timestamp > 0
    ? Math.floor(timestamp)
    : Math.floor(Date.now() / 1000);
  stmts.upsertReaction.run(messageId, senderId, text.slice(0, 32), reactedAt);
  return 'set';
}

// Reacciones de varios mensajes de una vez → Map(message_id → [{ sender_id, reaction }]).
export function getReactionsByMessage(messageIds) {
  const byMessage = new Map();
  if (!messageIds.length) return byMessage;
  for (const row of stmts.getReactionsForMessages.all(JSON.stringify(messageIds))) {
    if (!byMessage.has(row.message_id)) byMessage.set(row.message_id, []);
    byMessage.get(row.message_id).push(row);
  }
  return byMessage;
}

// Agrupa por emoji en orden de aparición: [{ reaction, count, senderIds }].
export function groupReactions(reactions = []) {
  const groups = new Map();
  for (const { reaction, sender_id: senderId } of reactions) {
    if (!groups.has(reaction)) groups.set(reaction, { reaction, count: 0, senderIds: [] });
    const group = groups.get(reaction);
    group.count += 1;
    group.senderIds.push(senderId);
  }
  return [...groups.values()];
}
