// Mapeo de emojis a caracteres ASCII para compatibilidad con Nokia 6111
const emojiMap = {
  // Caras
  '😊': ':)',
  '😂': ':D',
  '😍': '<3',
  '😎': 'B-)',
  '😢': ':(',
  '😡': '>:(',
  '😴': '|-)',
  '🤔': ':?',
  '😱': 'O_O',
  '😋': ':P',
  '😏': ':-)',
  '😐': ':|',
  '😉': ';)',
  '🤗': 'Hug',
  '😆': ':D',
  '😅': ':D',
  '🥰': '<3',
  '😘': ';)',
  '😜': ';P',
  '😖': ':(',
  '😩': ':(',
  '🥺': ':(',
  '😶': ':-o',
  '😤': '>:(',
  '🥳': '!!!',
  '😇': '0:)',
  '🤢': ':P',
  '🤮': 'X_X',
  '😵': 'o_o',
  '🤪': ':P',
  '😈': '}:-)',
  '👿': '}:(',
  '😠': '>:(',
  '😳': 'o_o',
  '😲': ':O',
  '🤕': ':-[',
  '🤑': '$_$',
  '😎': '8-)',
  '🤓': ':-)',
  '😛': ':P',
  '🤡': '[*]',
  '👽': '[E.T]',
  '💀': 'X_X',
  '👻': '[BOO]',
  '🎃': '[*]',
  
  // Gestos
  '👍': '[+]',
  '👎': '[-]',
  '🙏': '[*]',
  '👋': 'Hi',
  '🤝': '[=]',
  '💪': '[!]',
  
  // Corazones
  '❤️': '<3',
  '🧡': '<3',
  '💛': '<3',
  '💚': '<3',
  '💙': '<3',
  '💜': '<3',
  '🖤': '<3',
  '💔': '</3',
  '💕': 'xx',
  '💘': '<3*',
  
  // Destacados
  '⭐': '*',
  '✨': '**',
  '🔥': '!!!',
  '💯': '100',
  '⚡': '>>',
  '🚀': '-->',
  '📱': '[TEL]',
  '📞': '[CALL]',
  '📧': '[EMAIL]',
  '📝': '[NOTE]',
  '📋': '[LIST]',
  
  // Otros
  '✅': '[OK]',
  '❌': '[NO]',
  '⚠️': '[!]',
  '🔔': '[BELL]',
  '📶': '[NET]',
  '🌐': '[WWW]',
  '🎉': '!!!',
  '🎊': '!!!',
  '🎈': '(o)',
  '🎁': '[GIFT]',
};

// Reemplaza cualquier otro emoji Unicode desconocido por nada.
// Cubre: emojis, modificadores de tono de piel, variaciones, ZWJ, indicadores regionales
const UNKNOWN_EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{231A}\u{231B}\u{25AA}-\u{25FE}\u{2934}\u{2935}\u{2190}-\u{21FF}\u{3030}\u{303D}\u{3297}\u{3299}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}]/gu;

export function convertEmojisToAscii(text) {
  if (!text) return text;

  let result = text;

  // Reemplazar emojis conocidos: texto ASCII plano, nada de HTML
  for (const [emoji, ascii] of Object.entries(emojiMap)) {
    if (result.includes(emoji)) {
      result = result.split(emoji).join(ascii);
    }
  }

  result = result.replace(UNKNOWN_EMOJI_RE, '');

  // Limpiar espacios múltiples que quedan tras eliminar emojis
  result = result.replace(/\s{2,}/g, ' ').trim();

  return result;
}

// Emojis de cara con equivalente claro en el pack local assets/outline_emojis
// (127 iconos, todos caras — no hay corazones/gestos/símbolos en el pack).
const emojiImageMap = {
  // Caras
  '😊': 1,   '😂': 40,  '😍': 85,  '😎': 100, '😢': 23,
  '😡': 38,  '😴': 20,  '🤔': 48,  '😱': 25,  '😋': 18,
  '😏': 5,   '😐': 36,  '😉': 121, '😆': 53,  '😅': 17,
  '🥰': 85,  '😘': 86,  '😜': 123, '😖': 38,  '😩': 29,
  '🥺': 22,  '😶': 46,  '😤': 38,  '🥳': 55,  '🤢': 26,
  '🤮': 19,  '😵': 14,  '🤪': 37,  '😈': 39,  '👿': 39,
  '😠': 38,  '😳': 58,  '😲': 28,  '🤕': 41,  '🤓': 66,
  '😛': 126, '🤡': 7,   '👽': 87,  '💀': 78,

  // Gestos
  '👍': 1,   '👎': 38,  '🙏': 32,  '👋': 61,  '🤝': 35,  '💪': 99,

  // Corazones
  '❤️': 85,  '🧡': 85,  '💛': 85,  '💚': 85,  '💙': 85,
  '🖤': 85,  '💜': 85,  '💔': 23,  '💕': 86,  '💘': 21,

  // Destacados (solo los que transmiten ánimo, no objetos)
  '⭐': 56,  '✨': 59,  '🔥': 91,  '💯': 92,  '⚡': 6,   '🚀': 34,

  // Otros (solo los que transmiten ánimo, no objetos)
  '✅': 51,  '❌': 12,  '⚠️': 13,  '🎉': 55,  '🎊': 55,
};

// Sustituye emojis por <img> cuando hay imagen local; el resto de emojis
// conocidos (corazones, gestos, símbolos) siguen en ASCII como respaldo, y
// cualquier emoji desconocido se descarta — igual que convertEmojisToAscii.
export function renderEmojisHtml(text) {
  if (!text) return text;

  let result = text;

  for (const [emoji, iconNum] of Object.entries(emojiImageMap)) {
    if (result.includes(emoji)) {
      // El alt usa el ASCII de respaldo (no el emoji crudo): si dejáramos el emoji
      // en el alt, el bucle de abajo lo encontraría de nuevo y lo corrompería.
      const alt = emojiMap[emoji] || '';
      const img = `<img src="/assets/outline_emojis/em_outline_${iconNum}.png" width="16" height="16" alt="${alt}"/>`;
      result = result.split(emoji).join(img);
    }
  }

  for (const [emoji, ascii] of Object.entries(emojiMap)) {
    if (result.includes(emoji)) {
      result = result.split(emoji).join(ascii);
    }
  }

  result = result.replace(UNKNOWN_EMOJI_RE, '');

  return result.replace(/\s{2,}/g, ' ').trim();
}

export function hasEmojis(text) {
  if (!text) return false;
  const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]/gu;
  return emojiRegex.test(text);
}
