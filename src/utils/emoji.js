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

export function convertEmojisToAscii(text) {
  if (!text) return text;

  let result = text;

  // Reemplazar emojis conocidos: texto ASCII plano, nada de HTML
  for (const [emoji, ascii] of Object.entries(emojiMap)) {
    if (result.includes(emoji)) {
      result = result.split(emoji).join(ascii);
    }
  }

  // Reemplazar cualquier otro emoji Unicode desconocido por [?]
  // Cubre: emojis, modificadores de tono de piel, variaciones, ZWJ, indicadores regionales
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{231A}\u{231B}\u{25AA}-\u{25FE}\u{2934}\u{2935}\u{2190}-\u{21FF}\u{3030}\u{303D}\u{3297}\u{3299}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}]/gu;
  result = result.replace(emojiRegex, '');

  // Limpiar espacios múltiples que quedan tras eliminar emojis
  result = result.replace(/\s{2,}/g, ' ').trim();

  return result;
}

export function hasEmojis(text) {
  if (!text) return false;
  const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]/gu;
  return emojiRegex.test(text);
}
