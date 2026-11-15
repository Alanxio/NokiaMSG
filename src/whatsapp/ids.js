// Identificadores de WhatsApp. Funciones puras (sin cliente ni BD).

// whatsapp-web.js entrega los ids como string o como objeto { _serialized } — y en este
// entorno a veces sin _serialized pero con el id ya serializado bajo la clave interna '$1'.
export function getSerializedId(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const serialized = value._serialized || value.$1;
  return typeof serialized === 'string' && serialized ? serialized : null;
}

export function getWhatsappMessageId(message) {
  return getSerializedId(message?.id)
    || getSerializedId(message?._data?.id)
    || getSerializedId(message?.rawData?.id);
}
