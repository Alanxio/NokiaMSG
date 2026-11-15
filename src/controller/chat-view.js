import { stmts } from '../../db/db.js';
import { convertEmojisToAscii } from '../utils/emoji.js';
import { stripRichText } from '../utils/rich-text.js';
import {
  escapeXml,
  getMemberColor,
  getMessageDateInfo,
  renderAckLabel,
  renderMediaLine,
  mentionsToPlainText,
  renderMentions,
  renderMessageActions,
  renderMessageDateSeparator,
  renderPollLine,
  truncateName,
} from './page.controller.js';

// Historial de un chat (privado o grupo). Maquetado clásico: hora, [Yo] + estado,
// «[Nombre] dice:» en grupos, cita y contenido, con una línea <hr/> entre mensajes. El texto del
// mensaje sí lleva formato (negrita, cursiva, enlaces…: ver renderMentions).

export function formatHourSend(hourSend) {
  if (!hourSend) return '00:00';
  if (typeof hourSend === 'string') {
    const match = hourSend.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
    if (match) return match[2];
  }
  const ms = typeof hourSend === 'number' && hourSend < 2000000000 ? hourSend * 1000 : Number(hourSend);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '00:00';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// Imagen o sticker con miniatura (lo que antes llevaba «[Ver]»). Las notas de voz, vídeos,
// documentos… tienen su propia línea con sus acciones (renderMediaLine).
function hasViewableImage(message) {
  return !renderMediaLine(message) && message.media_type !== 'poll'
    && Boolean(message.has_media && message.file_path_thumb);
}

function renderContent(message) {
  const detailHref = `/mensaje/${message.id}`;
  const mediaLine = renderMediaLine(message, { linkToDetail: detailHref, audioInHeader: true });
  if (mediaLine) return mediaLine;
  if (message.media_type === 'poll') {
    const pollLine = renderPollLine(message, stmts.getPollOptionCountsByMessageId.all(message.id), { linkToDetail: detailHref });
    if (pollLine) return pollLine;
  }
  if (message.has_media && message.file_path_thumb) {
    // Sin «[Ver]»: se abre con el icono Max de la cabecera (ver hasViewableImage).
    return `<img src="${escapeXml(message.file_path_thumb)}" width="40" alt="${Number(message.is_sticker) === 1 ? 'Sticker' : 'Imagen'}"/>`;
  }
  if (Number(message.is_sticker) === 1) return '<i>[Sticker]</i>';
  return renderMentions(message.text);
}

// Respuesta a otro mensaje, en una línea pequeña y gris: «| Autor: texto citado».
//  · Autor recortado (hay nombres de 50+ caracteres) y sin emojis.
//  · «[Nota de voz]», «[Imagen] pie»…: la etiqueta va aparte, sin cursiva, y el pie después.
//  · Menciones con número («@5727343925…») → nombre guardado; formato (*, _, ~) fuera.
const QUOTE_NAME_LENGTH = 14;
const QUOTE_TEXT_LENGTH = 50;
const QUOTE_LABEL_RE = /^\[([^\]\n]{1,20})\]\s*/;

function cleanQuoteText(value) {
  return convertEmojisToAscii(stripRichText(mentionsToPlainText(value)))
    // Mención a alguien sin nombre guardado (número / LID de 15 cifras): solo el final.
    .replace(/@\+?\d{8,}/g, (m) => `@…${m.slice(-4)}`)
    .replace(/\s+/g, ' ')
    .trim();
}

function renderQuote(message) {
  if (!message.quoted_text && !message.quoted_sender) return '';

  const senderName = message.quoted_sender ? cleanQuoteText(message.quoted_sender) || message.quoted_sender.trim() : '';
  const author = senderName ? `<b>${escapeXml(truncateName(senderName, QUOTE_NAME_LENGTH))}</b>: ` : '';

  let body = '<i>(no disponible)</i>';
  if (message.quoted_text) {
    const text = cleanQuoteText(message.quoted_text);
    const label = text.match(QUOTE_LABEL_RE);
    const rest = label ? text.slice(label[0].length) : text;
    const labelHtml = label ? `[${escapeXml(label[1])}]` : '';
    const restHtml = rest ? `<i>${escapeXml(truncateName(rest, QUOTE_TEXT_LENGTH))}</i>` : '';
    body = [labelHtml, restHtml].filter(Boolean).join(' ') || '<i>(vacío)</i>';
  }

  // <small> (como los avisos del Estado del servidor): en el 6111 sale más pequeño que
  // <font size="1">.
  return `<small><font color="#888888">| ${author}${body}</font></small><br/>`;
}

/**
 * messages: más reciente primero (como salen de la BD).
 * options:
 *   chatId, type ('user' | 'group')  — para los enlaces de responder / leídos
 *   newMessageCount                  — los N primeros se marcan como nuevos
 *   memberColorMap                   — grupo: color de cada participante
 *   contactName                      — privado: nombre del contacto
 */
export function renderChatMessages(messages, { chatId, type, newMessageCount = 0, memberColorMap = null, contactName = '' }) {
  if (!messages.length) return '<p>Sin mensajes.</p>';

  const isGroup = type === 'group';
  let html = '';
  let previousDate = null;
  // <hr/> entre mensajes. Si entre dos hay un cambio de fecha, la línea va encima de la
  // fecha (cerrando el mensaje anterior) y no se repite debajo. Tras un aviso no se pone.
  let needsSeparator = false;

  messages.forEach((message, index) => {
    const isNew = index < newMessageCount;
    const unseenMarker = isNew ? '<font color="#cc0000">[!]</font> ' : '';
    const sentAt = formatHourSend(message.hour_send);
    const dateInfo = getMessageDateInfo(message);
    let dateSeparator = '';
    if (dateInfo?.label && dateInfo.key !== previousDate) {
      dateSeparator = (needsSeparator ? '<hr/>' : '') + renderMessageDateSeparator(dateInfo.label);
      needsSeparator = false;
    }
    if (dateInfo) previousDate = dateInfo.key;

    if (Number(message.is_system) === 1) {
      needsSeparator = false;
      html += `${dateSeparator}<p align="center">${unseenMarker}<i><font size="1" color="#888888">${escapeXml(sentAt)} — ${renderMentions(message.text)}</font></i></p>`;
      return;
    }

    // Un mensaje borrado se sigue mostrando, marcado en rojo como «(borrado)».
    const editedTag = Number(message.is_deleted) === 1
      ? ' <font size="1" color="#cc0000">(borrado)</font>'
      : Number(message.is_edited) === 1
        ? ' <font size="1" color="#888888">(editado)</font>'
        : '';

    const isSaliente = Number(message.from_me) === 1;
    const fromMeMarker = isSaliente
      ? `<font color="#006600">[Yo]</font> ${renderAckLabel(message.ack_status)}`
      : '';
    // Imágenes y stickers: icono Max para abrirlos a tamaño completo. Notas de voz y
    // audios: Text (detalle con la transcripción) y Volume para escucharlos.
    const isAudio = message.media_type === 'ptt' || message.media_type === 'audio';
    const messageActions = renderMessageActions(message, chatId, type, {
      viewHref: hasViewableImage(message) ? `/mensaje/${message.id}` : null,
      transcriptHref: isAudio ? `/mensaje/${message.id}` : null,
      listen: isAudio,
    });
    const contentPart = renderContent(message);
    const separator = needsSeparator ? '<hr/>' : '';
    needsSeparator = true;

    // Cabecera: [!] e iconos (leídos / responder) a la izquierda, hora a la derecha. Tabla
    // de dos celdas porque el navegador del 6111 no respeta float ni text-align por tramos.
    const timeHtml = isGroup
      ? `<font size="1" color="#666666">${escapeXml(sentAt)}</font>`
      : escapeXml(sentAt);
    const headerHtml =
      '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
      `<td align="left">${unseenMarker}${messageActions || '&#160;'}</td>` +
      `<td align="right">${editedTag ? `${editedTag.trim()} ` : ''}${timeHtml}</td>` +
      '</tr></table>';

    let usernameLine = '';
    if (!isSaliente) {
      // Grupo: color de cada participante. Privado: el contacto en azul.
      const rawName = isGroup ? message.username : (message.username || contactName);
      const color = isGroup ? getMemberColor(message.user_chat_id, memberColorMap) : '#000099';
      usernameLine = `<font size="1" color="${color}">[${rawName ? escapeXml(truncateName(convertEmojisToAscii(rawName))) : 'Desconocido'}] dice:</font><br/>`;
    }
    const fromMeLine = fromMeMarker ? `${fromMeMarker}<br/>` : '';
    const body = isGroup ? `<font size="1" color="#000000">${contentPart}</font>` : contentPart;

    html +=
      `${dateSeparator}${separator}${headerHtml}` +
      `<p>${fromMeLine}${usernameLine}${renderQuote(message)}${body}</p>`;
  });

  return html;
}
