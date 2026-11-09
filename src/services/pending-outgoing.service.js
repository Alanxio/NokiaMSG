// Correlaciona mensajes salientes recién insertados en la BD (por chat_id) con su fila
// local, para que el listener de message_create en whatsapp.service.js pueda rellenar
// whatsapp_msg_id en cuanto WhatsApp confirme el envío — client.sendMessage() no devuelve el
// Message con su id de forma fiable en este entorno (comprobado en vivo varias veces).
const pendingByChatId = new Map();
const observedByChatId = new Map();
const pendingAckByMessageId = new Map();

export function registerPendingOutgoing(chatId, messageRowId) {
  const queue = pendingByChatId.get(chatId) || [];
  queue.push(messageRowId);
  pendingByChatId.set(chatId, queue);
}

export function registerObservedOutgoing(chatId, whatsappMsgId) {
  if (!chatId || !whatsappMsgId) return;
  const queue = observedByChatId.get(chatId) || [];
  queue.push(whatsappMsgId);
  observedByChatId.set(chatId, queue);
}

export function takeObservedOutgoing(chatId) {
  const queue = observedByChatId.get(chatId);
  if (!queue || queue.length === 0) return null;
  const whatsappMsgId = queue.shift();
  if (queue.length === 0) observedByChatId.delete(chatId);
  return whatsappMsgId ?? null;
}

export function removeObservedOutgoing(chatId, whatsappMsgId) {
  const queue = observedByChatId.get(chatId);
  if (!queue) return;
  const remaining = queue.filter((id) => id !== whatsappMsgId);
  if (remaining.length > 0) observedByChatId.set(chatId, remaining);
  else observedByChatId.delete(chatId);
}

export function rememberPendingOutgoingAck(whatsappMsgId, ack) {
  if (!whatsappMsgId || !Number.isFinite(Number(ack))) return;
  const nextAck = Number(ack);
  const previousAck = pendingAckByMessageId.get(whatsappMsgId);
  pendingAckByMessageId.set(whatsappMsgId, previousAck == null ? nextAck : Math.max(previousAck, nextAck));

  if (pendingAckByMessageId.size > 500) {
    const oldestId = pendingAckByMessageId.keys().next().value;
    pendingAckByMessageId.delete(oldestId);
  }
}

export function takePendingOutgoingAck(whatsappMsgId) {
  const ack = pendingAckByMessageId.get(whatsappMsgId);
  pendingAckByMessageId.delete(whatsappMsgId);
  return ack ?? null;
}

export function takePendingOutgoing(chatId) {
  const queue = pendingByChatId.get(chatId);
  if (!queue || queue.length === 0) return null;
  const rowId = queue.shift();
  if (queue.length === 0) pendingByChatId.delete(chatId);
  return rowId ?? null;
}
