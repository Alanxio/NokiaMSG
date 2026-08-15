// Correlaciona mensajes salientes recién insertados en la BD (por chat_id) con su fila
// local, para que el listener de message_create en whatsapp.service.js pueda rellenar
// whatsapp_msg_id en cuanto WhatsApp confirme el envío — client.sendMessage() no devuelve el
// Message con su id de forma fiable en este entorno (comprobado en vivo varias veces).
const pendingByChatId = new Map();

export function registerPendingOutgoing(chatId, messageRowId) {
  pendingByChatId.set(chatId, messageRowId);
}

export function takePendingOutgoing(chatId) {
  const rowId = pendingByChatId.get(chatId);
  if (rowId !== undefined) pendingByChatId.delete(chatId);
  return rowId ?? null;
}
