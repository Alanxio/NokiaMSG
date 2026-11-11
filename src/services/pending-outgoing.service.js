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
  // El mismo mensaje puede llegar dos veces (evento de la librería + listener directo):
  // un id repetido en la cola acabaría enlazado a OTRO envío posterior del Nokia.
  if (queue.includes(whatsappMsgId)) return;
  queue.push(whatsappMsgId);
  observedByChatId.set(chatId, queue);
}

// ── Envíos del Nokia en curso ────────────────────────────────────────────────
// Mientras client.sendMessage() está en vuelo, WhatsApp emite message_create (fromMe) ANTES
// de que el controlador inserte la fila local. Sin esto, ese mensaje no se distinguiría de
// uno escrito desde otro dispositivo (móvil, WhatsApp Web) y se guardaría dos veces. Se
// compara también el texto: así un mensaje del móvil al mismo chat en ese mismo instante
// no se confunde con el del Nokia.
const IN_FLIGHT_MAX_MS = 3 * 60_000;
const inFlightSends = new Map(); // token → { chatId, text, hasMedia, startedAt }
let inFlightSeq = 0;

function normalizeSendText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function beginNokiaSend(chatId, { text = '', hasMedia = false } = {}) {
  const token = ++inFlightSeq;
  inFlightSends.set(token, { chatId, text: normalizeSendText(text), hasMedia: Boolean(hasMedia), startedAt: Date.now() });
  return token;
}

export function endNokiaSend(token) {
  inFlightSends.delete(token);
}

// ¿Es este mensaje propio el que el Nokia está enviando ahora mismo a ese chat?
// anyText: true → solo pregunta si hay algún envío en curso a ese chat (para diagnóstico).
export function matchesNokiaSendInFlight(chatId, { body = '', hasMedia = false, anyText = false } = {}) {
  const now = Date.now();
  const text = normalizeSendText(body);
  for (const [token, send] of inFlightSends) {
    if (now - send.startedAt > IN_FLIGHT_MAX_MS) { inFlightSends.delete(token); continue; }
    if (send.chatId !== chatId) continue;
    if (anyText) return true;
    // Con texto: tiene que coincidir. Adjunto sin pie de foto: basta con que también lleve media.
    if (send.text ? send.text === text : (send.hasMedia && hasMedia)) return true;
  }
  return false;
}

// ── Mensajes propios de otros dispositivos en proceso ───────────────────────
// El mismo mensaje puede llegar por el evento de la librería y por el listener directo; el
// primero que lo reclama lo guarda (la descarga de media tarda, así que mirar solo la BD no
// basta para evitar el doble guardado).
const OWN_CLAIM_TTL_MS = 10 * 60_000;
const ownClaims = new Map(); // whatsappMsgId → instante

export function claimOwnMessage(whatsappMsgId) {
  const now = Date.now();
  for (const [id, at] of ownClaims) if (now - at > OWN_CLAIM_TTL_MS) ownClaims.delete(id);
  if (!whatsappMsgId || ownClaims.has(whatsappMsgId)) return false;
  ownClaims.set(whatsappMsgId, now);
  return true;
}

export function isOwnMessageClaimed(whatsappMsgId) {
  return ownClaims.has(whatsappMsgId);
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

// accepts(rowId) decide si esa fila pendiente corresponde al mensaje que acaba de llegar.
// Sin él se tomaría la primera de la cola, y un mensaje escrito desde el móvil al mismo chat
// mientras el Nokia esperaba su confirmación se quedaría con la fila del Nokia.
export function takePendingOutgoing(chatId, accepts = () => true) {
  const queue = pendingByChatId.get(chatId);
  if (!queue || queue.length === 0) return null;
  const index = queue.findIndex((rowId) => accepts(rowId));
  if (index === -1) return null;
  const [rowId] = queue.splice(index, 1);
  if (queue.length === 0) pendingByChatId.delete(chatId);
  return rowId ?? null;
}

// ¿La fila local del Nokia (texto que guardó al enviar) es este mensaje de WhatsApp? El
// Nokia guarda el texto enviado, o «[Imagen]» / «[Video]» si era media sin pie de foto.
export function isSameOutgoingMessage(row, { body = '', hasMedia = false } = {}) {
  if (!row) return false;
  const rowText = normalizeSendText(row.text);
  const text = normalizeSendText(body);
  if (text) return rowText === text;
  return Boolean(hasMedia) && Number(row.has_media) === 1;
}

// Chats en los que se sincronizan los mensajes propios escritos desde otros dispositivos:
// conversaciones normales y grupos. Fuera quedan los estados (status@broadcast), las listas
// de difusión (@broadcast) y los canales (@newsletter), que no son conversaciones.
export function isSyncableOwnChat(chatId) {
  if (typeof chatId !== 'string' || !chatId.includes('@')) return false;
  return !chatId.endsWith('@broadcast') && !chatId.endsWith('@newsletter');
}
