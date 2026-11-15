// Formato de WhatsApp → XHTML para el navegador del Nokia. Lógica pura (sin BD), para
// poder probarla aislada.
//
//   *negrita*   _cursiva_   ~tachado~   `código`   ```bloque```
//   > cita      - viñeta / * viñeta
//   URLs (http://, https://, www.), emails y teléfonos → enlaces
//
// Los trozos que no deben tocarse (menciones ya pintadas, enlaces, código) se sustituyen
// por un carácter de uso privado («átomo») mientras se aplica el resto del formato, y se
// restauran al final. Así un «_» dentro de una URL no abre una cursiva.

const ATOM_START = 0xE000;
const ATOM_END = 0xF8FF;
const ATOM_RE = /[-]/g;

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// En pantalla, una URL larga desborda los 128 px del 6111: se muestra recortada.
const MAX_LINK_LABEL = 28;

function shortenLabel(text) {
  const label = text.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return label.length > MAX_LINK_LABEL ? `${label.slice(0, MAX_LINK_LABEL - 3)}...` : label;
}

const URL_RE = /(?<![\p{L}\p{N}@./])(?:https?:\/\/|www\.)[^\s<>"-]+/giu;
const EMAIL_RE = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}])/gu;
// Con prefijo internacional (admite espacios/guiones) o móvil/fijo español de 9 cifras.
const PHONE_RE = /(?<![\p{L}\p{N}+\-/.,:])(?:\+\d[\d -]{7,16}\d|[6789]\d{8})(?![\p{L}\p{N}])/gu;

// Puntuación final que casi nunca forma parte de la URL («mira www.x.com.»).
function trimUrl(raw) {
  let url = raw.replace(/[.,;:!?'"»]+$/u, '');
  while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
    url = url.slice(0, -1).replace(/[.,;:!?'"»]+$/u, '');
  }
  return url;
}

function linkHtml(href, label) {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

// Emphasis de WhatsApp: el marcador de apertura va al principio o tras algo que no sea
// letra/número, seguido de algo que no sea espacio; el de cierre al revés. Así
// «mi_archivo_v2» o «2*3*4» no se formatean.
const EMPHASIS = [
  ['*', '<b>', '</b>'],
  ['_', '<i>', '</i>'],
  ['~', '<span style="text-decoration:line-through">', '</span>'],
];

function emphasisRe(marker) {
  const m = marker === '*' ? '\\*' : marker;
  return new RegExp(
    `(^|[^\\p{L}\\p{N}${m}])${m}(?!\\s)([^${m}\\n]*?[^\\s${m}])${m}(?![\\p{L}\\p{N}${m}])`,
    'gu',
  );
}
const EMPHASIS_RES = EMPHASIS.map(([marker, open, close]) => [emphasisRe(marker), open, close]);

function applyEmphasis(line) {
  let out = line;
  for (const [re, open, close] of EMPHASIS_RES) {
    out = out.replace(re, (_, before, inner) => `${before}${open}${inner}${close}`);
  }
  return out;
}

const MONO_OPEN = '<font color="#555555"><tt>';
const MONO_CLOSE = '</tt></font>';

/**
 * parts: [{ text }] (texto plano) o [{ html }] (HTML ya listo, p. ej. una mención).
 * Devuelve HTML con saltos de línea como <br/>. No convierte emojis (eso va después).
 */
export function formatRichText(parts) {
  const atoms = [];
  const atom = (html) => {
    if (ATOM_START + atoms.length > ATOM_END) return escapeHtml(html);
    atoms.push(html);
    return String.fromCharCode(ATOM_START + atoms.length - 1);
  };

  // 1. Fuente con las partes HTML ya convertidas en átomos.
  let src = parts
    .map((p) => (p.html != null ? atom(p.html) : String(p.text ?? '').replace(ATOM_RE, '')))
    .join('');

  // 2. Código: su contenido no se formatea ni se enlaza.
  src = src.replace(/```([\s\S]+?)```/g, (_, code) =>
    atom(`${MONO_OPEN}${escapeHtml(code.replace(/^\n|\n$/g, '')).replace(/\r?\n/g, '<br/>')}${MONO_CLOSE}`));
  src = src.replace(/`([^`\n]+)`/g, (_, code) => atom(`${MONO_OPEN}${escapeHtml(code)}${MONO_CLOSE}`));

  // 3. Enlaces.
  src = src.replace(URL_RE, (raw) => {
    const url = trimUrl(raw);
    const rest = raw.slice(url.length);
    const href = /^https?:\/\//i.test(url) ? url : `http://${url}`;
    return atom(linkHtml(href, shortenLabel(url))) + rest;
  });
  src = src.replace(EMAIL_RE, (email) => atom(linkHtml(`mailto:${email}`, email)));
  src = src.replace(PHONE_RE, (phone) => {
    const digits = phone.replace(/[^0-9]/g, '');
    if (digits.length < 9 || digits.length > 15) return phone;
    const dial = phone.startsWith('+') ? `+${digits}` : digits;
    return atom(linkHtml(`wtai://wp/mc;${dial}`, phone));
  });

  // 4. Escapar el resto y dar formato línea a línea.
  const lines = escapeHtml(src).split(/\r?\n/).map((line) => {
    const quote = line.match(/^&gt; ?(.*)$/);
    if (quote) {
      return `<font color="#666666">| <i>${applyEmphasis(quote[1])}</i></font>`;
    }
    const bullet = line.match(/^\s*[-*•] (.+)$/);
    if (bullet) return `&#8226; ${applyEmphasis(bullet[1])}`;
    return applyEmphasis(line);
  });

  // 5. Restaurar átomos.
  return lines.join('<br/>').replace(ATOM_RE, (ch) => atoms[ch.charCodeAt(0) - ATOM_START] ?? '');
}

// Texto sin marcadores, para vistas previas de una línea (citas, listas).
export function stripRichText(value = '') {
  let text = String(value).replace(/```([\s\S]+?)```/g, '$1').replace(/`([^`\n]+)`/g, '$1');
  for (const [marker] of EMPHASIS) {
    text = text.replace(emphasisRe(marker), (_, before, inner) => `${before}${inner}`);
  }
  return text.replace(/^&gt; ?|^> ?/gm, '').replace(/\s*\n\s*/g, ' ').trim();
}
