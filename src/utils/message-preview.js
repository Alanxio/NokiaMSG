const MEDIA_LABELS = {
  image: 'Imagen',
  sticker: 'Sticker',
  ptt: 'Nota de voz',
  audio: 'Audio',
  video: 'Video',
  document: 'Documento',
  location: 'Ubicación',
  poll: 'Encuesta',
  poll_creation: 'Encuesta',
  vcard: 'Contacto',
};

export function getMessageQuotePreview(message) {
  const type = message?.media_type || message?.type || '';
  const isSticker = Number(message?.is_sticker) === 1 || type === 'sticker';
  const hasMedia = Boolean(message?.has_media || message?.isMedia || message?.mimetype);
  const mediaLabel = isSticker
    ? MEDIA_LABELS.sticker
    : MEDIA_LABELS[type] || (
      message?.has_media
        ? MEDIA_LABELS.image
        : (hasMedia ? 'Archivo adjunto' : null)
    );
  const caption = typeof message?.caption === 'string' ? message.caption.trim() : '';
  const text = typeof message?.text === 'string' ? message.text.trim() : '';

  if (!mediaLabel) {
    return (text || (typeof message?.body === 'string' ? message.body.trim() : '') || caption || '[Mensaje]').slice(0, 300);
  }

  const placeholder = `[${mediaLabel}]`;
  const isGeneratedMediaText = /^\[[^\]]+\](?:\s.*)?$/.test(text);
  const detail = caption || (
    message?.media_type && text && !isGeneratedMediaText
      ? text
      : ''
  );
  const cleanDetail = detail && detail !== placeholder ? detail : '';
  return `${placeholder}${cleanDetail ? ` ${cleanDetail}` : ''}`.slice(0, 300);
}
