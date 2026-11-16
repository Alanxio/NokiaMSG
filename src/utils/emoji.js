// Emojis para el Nokia 6111, que no tiene ninguna fuente con emojis.
//
//  · convertEmojisToAscii: texto plano (nombres, citas, SMS, API J2ME) → equivalente ASCII.
//  · renderEmojisHtml: cuerpo de los mensajes en XHTML → iconos de assets/outline_emojis
//    (pixel art 16×16; los corazones em_heart_* están dibujados con la misma paleta). Lo
//    que no tenga icono sale en ASCII, y lo que no esté en la tabla se quita.
//
// Cada entrada: [emoji, ascii, icono(s)]. El icono es el número de em_outline_<n>.png, el
// nombre de un em_heart_<color>.png, o una lista de variantes (p. ej. las 15 gafas de sol de
// 😎): se elige una de forma estable según el mensaje, para que todas se usen pero el mismo
// mensaje se vea siempre igual. Las claves van sin el selector de variación U+FE0F
// (se quita antes de buscar), así «❤» y «❤️» son el mismo.
// El ASCII se queda en caracteres GSM (va también por SMS): nada de «¬» ni «¯».
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const EMOJIS = [
  // ── Caras sonrientes ──
  ['😀', ':D', 49],
  ['😃', ':D', 50],
  ['😄', ':D', 53],
  ['😁', ':D', 48],
  ['😆', 'XD', 53],
  ['😅', '^^U', 52],
  ['🤣', 'XD', 40],
  ['😂', 'XD', 40],
  ['🙂', ':)', 82],
  ['🙃', '(:', 82],
  ['😉', ';)', 121],
  ['😊', '^^', [51, 124]],
  ['☺', '^^', 83],
  ['😇', 'O:)', 84],
  ['🫠', ':S', 62],
  ['🥹', ":')", 23],
  ['🥲', ":')", 104],

  // ── Cariño ──
  ['🥰', '<3', 86],
  ['😍', '<3', 85],
  ['🤩', '*_*', 118],
  ['😘', ':*', 21],
  ['😗', ':*', 57],
  ['😚', ':*', 58],
  ['😙', ':*', 59],

  // ── Lengua ──
  ['😋', ':P', 18],
  ['🤤', ':P~', 18],
  ['😛', ':P', 42],
  ['😜', ';P', 123],
  ['🤪', ';P', 126],
  ['😝', 'XP', 117],
  ['🤑', '$_$', 64],

  // ── Manos en la cara ──
  ['🤗', '^^', 124],
  ['🤭', ':x', 28],
  ['🫢', ':o', 32],
  ['🫣', '|o_o|', 34],
  ['🤫', ':x', 61],
  ['🤔', ':?', 77],
  ['🫡', 'o7', 63],
  ['🤦', '-_-', 55],
  ['🥱', ':O', 125],

  // ── Neutras y escépticas ──
  ['🤐', ':#', 127],
  ['🤨', ':/', 10],
  ['😐', ':|', 36],
  ['😑', '-_-', [20, 109]],
  ['😶‍🌫', ':|', 43],
  ['😶', ':|', 43],
  ['🫥', ':|', 35],
  ['😏', ':]', [122, 116]],
  ['😒', '-_-', [107, ...range(110, 114)]],
  ['🙄', '-_-', 108],
  ['👀', 'o_o', [105, 106]],
  ['😬', ':S', 6],
  ['😮‍💨', ':3', 22],
  ['🫨', 'o_O', 119],

  // ── Sueño y enfermedad ──
  ['😌', '^_^', [69, 74, 88]],
  ['😔', ':(', 13],
  ['😞', ':(', 13],
  ['😪', '-_-zz', 80],
  ['😴', 'zzz', 79],
  ['🫩', '-_-', 115],
  ['😷', ':#', 30],
  ['🤒', ':(', 41],
  ['🤕', ':(', 29],
  ['🤢', ':S', 65],
  ['🤮', 'X_X', 26],
  ['🤧', ':(', 30],
  ['🥵', ':O', 54],
  ['🥶', ':S', 8],
  ['🥴', '@_@', 37],
  ['😵‍💫', '@_@', 37],
  ['😵', 'X_X', 15],
  ['🤯', 'O_O', 76],

  // ── Sombreros, gafas, disfraces ──
  ['🤠', '<:)', 11],
  ['🥳', '\\o/', 68],
  ['🥸', ':{', 14],
  ['😎', 'B)', range(89, 103)],
  ['🕶', 'B)', range(89, 103)],
  ['🤓', '8)', 66],
  ['🧐', 'o_O', 31],

  // ── Preocupación, sorpresa, tristeza ──
  ['😕', ':/', 67],
  ['🫤', ':/', 27],
  ['😟', ':(', 81],
  ['🙁', ':(', 46],
  ['☹', ':(', 46],
  ['😮', ':O', 5],
  ['😯', ':o', 56],
  ['😲', ':O', 33],
  ['😳', 'O_O', 45],
  ['🥺', ':(', 72],
  ['😦', 'D:', 47],
  ['😧', 'D:', 3],
  ['😨', 'D:', 44],
  ['😰', 'D:', 4],
  ['😥', ":'(", 75],
  ['😢', ":'(", 12],
  ['😭', 'T_T', 60],
  ['😱', 'O_O', 25],
  ['😖', '>_<', 9],
  ['😣', '>_<', 70],
  ['😓', '^^U', 17],
  ['😩', 'D:', 120],
  ['😫', 'D:', 120],

  // ── Enfado y otros ──
  ['😤', '>:(', 38],
  ['😡', '>:(', 73],
  ['😠', '>:(', 1],
  ['🤬', '#!@*', 39],
  ['👹', '>:E', 39],
  ['😈', '>:)', 87],
  ['👿', '>:(', 2],
  ['💀', 'X_X', 78],
  ['☠', 'X_X', 78],
  ['💩', '[caca]', 71],
  ['🤡', ':o)', 7],

  // ── Personas (las que tiene el pack) ──
  ['🧑‍🍳', ':)', 19],
  ['👨‍🍳', ':)', 19],
  ['👩‍🍳', ':)', 19],
  ['🧔', ':)', 16],
  ['👴', ':)', 24],
  ['🧓', ':)', 24],
  ['👵', ':)', 24],

  // ── Corazones ──
  ['❤‍🔥', '<3', 'red'],
  ['❤‍🩹', '<3', 'red'],
  ['❤', '<3', 'red'],
  ['♥', '<3', 'red'],
  ['🧡', '<3', 'orange'],
  ['💛', '<3', 'yellow'],
  ['💚', '<3', 'green'],
  ['💙', '<3', 'blue'],
  ['💜', '<3', 'purple'],
  ['🖤', '<3', 'black'],
  ['🤍', '<3', 'white'],
  ['🤎', '<3', 'brown'],
  ['🩷', '<3', 'pink'],
  ['🩵', '<3', 'lightblue'],
  ['🩶', '<3', 'grey'],
  ['💔', '</3', 'broken'],
  ['💕', '<3<3', 'pink'],
  ['💞', '<3<3', 'pink'],
  ['💓', '<3', 'pink'],
  ['💗', '<3', 'pink'],
  ['💖', '<3', 'pink'],
  ['💘', '<3', 'pink'],
  ['💝', '<3', 'pink'],
  ['💟', '<3', 'purple'],
  ['❣', '<3!', 'red'],
  ['😻', '<3', 85],
  ['💋', ':*', 21],

  // ── Sin icono: solo ASCII ──
  ['👍', '(Y)', null],
  ['👎', '(N)', null],
  ['👌', '(ok)', null],
  ['✌', 'V', null],
  ['🤞', '(x)', null],
  ['🙏', '(gracias)', null],
  ['👏', '(clap)', null],
  ['🙌', '\\o/', null],
  ['👋', 'o/', null],
  ['🤝', '(trato)', null],
  ['💪', '(fuerza)', null],
  ['🫶', '<3', null],
  ['🤙', '(llama)', null],
  ['👉', '->', null],
  ['👈', '<-', null],
  ['👆', '^', null],
  ['👇', 'v', null],
  ['🖕', '(-_-)', null],
  ['🤷', '\\_(o_o)_/', null],
  ['🙈', '(no miro)', null],
  ['🙉', '(no oigo)', null],
  ['🙊', '(callo)', null],
  ['👻', '(boo)', null],
  ['👽', '(ET)', null],
  ['🤖', '[o_o]', null],
  ['🎃', '(calabaza)', null],
  ['⭐', '*', null],
  ['🌟', '*', null],
  ['✨', '**', null],
  ['🔥', '(fuego)', null],
  ['💯', '100', null],
  ['⚡', '(rayo)', null],
  ['💥', '(boom)', null],
  ['💤', 'zzz', null],
  ['💦', '(gotas)', null],
  ['💨', '(prisa)', null],
  ['🚀', '-->', null],
  ['🎉', '(fiesta)', null],
  ['🎊', '(fiesta)', null],
  ['🎈', '(o)', null],
  ['🎁', '[regalo]', null],
  ['🎂', '[tarta]', null],
  ['🍺', '[birra]', null],
  ['🍻', '[birras]', null],
  ['🍷', '[vino]', null],
  ['☕', '[cafe]', null],
  ['🍕', '[pizza]', null],
  ['⚽', '(balon)', null],
  ['🎵', '(musica)', null],
  ['🎶', '(musica)', null],
  ['☀', '(sol)', null],
  ['🌙', '(luna)', null],
  ['🌈', '(arcoiris)', null],
  ['☔', '(lluvia)', null],
  ['❄', '(nieve)', null],
  ['🌹', '@}->--', null],
  ['🌸', '(flor)', null],
  ['🐶', '(perro)', null],
  ['🐱', '(gato)', null],
  ['📱', '[TEL]', null],
  ['📞', '[LLAMADA]', null],
  ['📧', '[EMAIL]', null],
  ['📷', '[FOTO]', null],
  ['📸', '[FOTO]', null],
  ['📝', '[NOTA]', null],
  ['📋', '[LISTA]', null],
  ['📍', '[AQUI]', null],
  ['🏠', '[CASA]', null],
  ['🚗', '[COCHE]', null],
  ['⏰', '[ALARMA]', null],
  ['🔔', '[AVISO]', null],
  ['📶', '[RED]', null],
  ['🌐', '[WWW]', null],
  ['✅', '[OK]', null],
  ['✔', '[OK]', null],
  ['☑', '[OK]', null],
  ['❌', '[X]', null],
  ['✖', 'x', null],
  ['❗', '!', null],
  ['❓', '?', null],
  ['⚠', '[!]', null],
  ['➡', '->', null],
  ['⬅', '<-', null],
];

// Más largas primero: «😮‍💨» antes que «😮», «❤‍🔥» antes que «❤».
const ENTRIES = EMOJIS
  .map(([emoji, ascii, icons]) => ({
    emoji,
    ascii,
    icons: icons == null ? [] : (Array.isArray(icons) ? icons : [icons]),
  }))
  .sort((a, b) => b.emoji.length - a.emoji.length);

const BY_EMOJI = new Map(ENTRIES.map((entry) => [entry.emoji, entry]));
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const KNOWN_RE = new RegExp(ENTRIES.map((entry) => escapeRegExp(entry.emoji)).join('|'), 'gu');

// Cualquier otro emoji Unicode desconocido se quita. Cubre: emojis, tonos de piel,
// selectores de variación, ZWJ, banderas, teclas (20E3) y etiquetas.
const UNKNOWN_EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{2B05}-\u{2B07}\u{231A}\u{231B}\u{25AA}-\u{25FE}\u{2934}\u{2935}\u{2190}-\u{21FF}\u{3030}\u{303D}\u{3297}\u{3299}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}]/gu;

const VARIATION_SELECTOR_RE = /\uFE0F/g;

function escapeAscii(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function convertEmojisToAscii(text) {
  if (!text) return text;
  return String(text)
    .replace(VARIATION_SELECTOR_RE, '')
    .replace(KNOWN_RE, (emoji) => BY_EMOJI.get(emoji).ascii)
    .replace(UNKNOWN_EMOJI_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Hash simple (FNV-1a) para elegir variante de forma estable por mensaje.
function hashText(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function iconFile(icon) {
  return typeof icon === 'number' ? `em_outline_${icon}.png` : `em_heart_${icon}.png`;
}

// Mensaje que es solo 1–3 emojis (como hace WhatsApp): se pintan al doble, 32×32, con los
// PNG ya escalados sin suavizado de assets/outline_emojis/x2 (el navegador del 6111 no
// garantiza escalar el pixel art de forma nítida).
const BIG_EMOJI_MAX = 3;

// Sustituye los emojis por <img> si tienen icono; si no, por su ASCII. Recibe HTML ya
// escapado (los emojis no los toca escapeXml), así que el ASCII se escapa aquí.
export function renderEmojisHtml(text) {
  if (!text) return text;

  const source = String(text).replace(VARIATION_SELECTOR_RE, '');
  const matches = source.match(KNOWN_RE) || [];
  const rest = source.replace(KNOWN_RE, '').replace(UNKNOWN_EMOJI_RE, '').trim();
  const big = rest === '' && matches.length > 0 && matches.length <= BIG_EMOJI_MAX
    && matches.every((emoji) => BY_EMOJI.get(emoji).icons.length > 0);
  const size = big ? 32 : 16;
  const dir = big ? '/assets/outline_emojis/x2' : '/assets/outline_emojis';

  const seed = hashText(source);
  let occurrence = 0;
  const result = source.replace(KNOWN_RE, (emoji) => {
    const { ascii, icons } = BY_EMOJI.get(emoji);
    if (!icons.length) return escapeAscii(ascii);
    const icon = icons[(seed + occurrence++) % icons.length];
    // alt con el ASCII (no el emoji): si no se carga la imagen, se lee algo con sentido.
    // vertical-align:middle centra el icono con la línea de texto en vez de apoyarlo en la
    // base (así sobresalía por encima de las letras).
    return `<img src="${dir}/${iconFile(icon)}" width="${size}" height="${size}" alt="${escapeAscii(ascii)}" style="vertical-align:middle;"/>`;
  });

  return result
    .replace(UNKNOWN_EMOJI_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Un solo emoji en pequeño (12×12, assets/outline_emojis/mini) para las reacciones. Sin
// icono: su ASCII; fuera de la tabla (p. ej. 🦩): «*», para que la reacción no desaparezca.
export function renderMiniEmoji(emoji) {
  const key = String(emoji || '').replace(VARIATION_SELECTOR_RE, '');
  // Tono de piel u otros añadidos detrás («👍🏽»): vale el emoji base.
  const entry = BY_EMOJI.get(key) || BY_EMOJI.get((key.match(KNOWN_RE) || [])[0]);
  if (!entry) return '*';
  if (!entry.icons.length) return escapeAscii(entry.ascii);
  const icon = entry.icons[hashText(key) % entry.icons.length];
  return `<img src="/assets/outline_emojis/mini/${iconFile(icon)}" width="12" height="12" alt="${escapeAscii(entry.ascii)}" style="vertical-align:middle;"/>`;
}

export function hasEmojis(text) {
  if (!text) return false;
  return /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{27BF}]|[\u{1FA70}-\u{1FAFF}]/u.test(text);
}

// Ficheros de icono que usa la tabla (para los tests).
export function listEmojiIconFiles() {
  return [...new Set(ENTRIES.flatMap((entry) => entry.icons.map(iconFile)))];
}
