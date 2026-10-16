// Correlaciona mensajes salientes recién insertados en la BD (por chat_id) con su fila
// local, para que el listener de message_create en whatsapp.service.js pueda rellenar
// whatsapp_msg_id en cuanto WhatsApp confirme el envío — client.sendMessage() no devuelve el
// Message con su id de forma fiable en este entorno (comprobado en vivo varias veces).
const pendingByChatId = new Map();

export function registerPendingOutgoing(chatId, messageRowId) {
  const queue = pendingByChatId.get(chatId) || [];
  queue.push(messageRowId);
  pendingByChatId.set(chatId, queue);
}

export function takePendingOutgoing(chatId) {
  const queue = pendingByChatId.get(chatId);
  if (!queue || queue.length === 0) return null;
  const rowId = queue.shift();
  if (queue.length === 0) pendingByChatId.delete(chatId);
  return rowId ?? null;
}
