// Menciones (@Nombre) — lógica pura, sin BD ni WhatsApp, para poder probarla aislada.
//
// · Al ESCRIBIR desde el Nokia: el usuario teclea «@ana» o «@ana gar» (sin mayúsculas ni
//   tildes) y findComposeMentions() lo resuelve contra los participantes del grupo.
// · Al MOSTRAR: findKnownNameAt() delimita exactamente dónde acaba el nombre mencionado
//   (los nombres llevan espacios: «@Ana García hola» no debe resaltarse entero).

// Caracteres de aislamiento bidireccional (U+2066–U+2069) que WhatsApp pone alrededor de
// las menciones. Son invisibles en un móvil moderno, pero el 6111 los pinta como cuadros.
const BIDI_ISOLATES = /[\u2066-\u2069]/g;
// Palabras que como mucho puede tener un nombre mencionado.
const MAX_MENTION_WORDS = 4;

export function stripBidiIsolates(text) {
  return String(text ?? '').replace(BIDI_ISOLATES, '');
}

// Forma de comparar nombres: minúsculas, sin tildes, solo letras/dígitos y un espacio
// entre palabras. «Ana García 💃» → «ana garcia».
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// ¿Puede empezar una mención en esta posición? Al principio o tras un espacio/signo de
// apertura; así «correo@dominio.com» no es una mención.
function canStartMention(text, index) {
  if (text[index] !== '@') return false;
  if (index === 0) return true;
  return /[\s([{¡¿"'«\u2066-\u2069]/.test(text[index - 1]);
}

// Lo que va tras el nombre debe ser un límite: fin, espacio o signo de puntuación.
function isBoundary(char) {
  return char === undefined || /[\s.,;:!?¡¿)\]}"'»\u2066-\u2069]/.test(char);
}

// ── Mostrar ──────────────────────────────────────────────────────────────────────
// Nombre conocido (exacto) más largo que empieza justo tras la «@» de `text[at]`.
// names: lista de nombres tal y como se guardaron en el texto. Devuelve el nombre o null.
export function findKnownNameAt(text, at, names) {
  const rest = text.slice(at + 1);
  let best = null;
  for (const name of names) {
    if (!name || (best && name.length <= best.length)) continue;
    // «@Alanxio 07tu»: si el nombre acaba en número, la palabra siguiente puede ir pegada.
    const next = rest[name.length];
    const glued = /\d$/.test(name) && next !== undefined && /\p{L}/u.test(next);
    if (rest.startsWith(name) && (isBoundary(next) || glued)) best = name;
  }
  return best;
}

// Mención a todo el grupo («@all», «@todos»…): WhatsApp la permite y también me incluye.
const MENTION_EVERYONE = /^(?:all|todos|todas|everyone|tothom)(?![\p{L}\p{N}_])/iu;

export function mentionsEveryone(text) {
  const source = stripBidiIsolates(text);
  for (let i = source.indexOf('@'); i !== -1; i = source.indexOf('@', i + 1)) {
    if (canStartMention(source, i) && MENTION_EVERYONE.test(source.slice(i + 1))) return true;
  }
  return false;
}

// Igual que findKnownNameAt pero comparando como al escribir (sin emojis, mayúsculas ni
// tildes): WhatsApp quita los emojis decorativos al mencionar («@GirlEmø» por
// «💞GirlEmø💞»). Devuelve el trozo tal y como está escrito en el texto, o null.
export function findNormalizedNameAt(text, at, names) {
  const known = new Set(names.map(normalizeName).filter(Boolean));
  if (/\s/.test(text[at + 1] ?? ' ')) return null;
  const re = /\S+/g;
  re.lastIndex = at + 1;
  const words = [];
  let m;
  while (words.length < MAX_MENTION_WORDS && (m = re.exec(text))) {
    if (words.length && (/\n/.test(text.slice(words[words.length - 1].end, m.index)) || m[0].includes('@'))) break;
    words.push({ raw: m[0], end: m.index + m[0].length });
  }
  for (let n = words.length; n >= 1; n -= 1) {
    const candidate = text.slice(at + 1, words[n - 1].end);
    // Sin la puntuación final («@Juliana,»): el signo queda fuera de la mención.
    const trimmed = candidate.replace(/[.,;:!?)\]}"'»]+$/u, '');
    if (known.has(normalizeName(trimmed))) return trimmed;
  }
  return null;
}

// Divide un texto en trozos { text } y { mention, name } para pintarlo. Solo es mención una
// «@» seguida de un nombre conocido (entero, aunque tenga espacios) o de un número de
// teléfono / LID (así viajan las que envía el Nokia y las que no se pudieron resolver). El
// resto («sígueme en @pepito_92», «@gmail.com») se queda como texto normal.
export function splitMentions(text, names = []) {
  const source = stripBidiIsolates(text);
  const parts = [];
  let plainStart = 0;
  let i = 0;
  while (i < source.length) {
    if (!canStartMention(source, i)) { i += 1; continue; }
    let name = findKnownNameAt(source, i, names);
    let everyone = false;
    if (!name) name = findNormalizedNameAt(source, i, names);
    if (!name) {
      const all = source.slice(i + 1).match(MENTION_EVERYONE);
      if (all) { name = all[0]; everyone = true; }
    }
    if (!name) {
      const digits = source.slice(i + 1).match(/^\+?\d{8,}/);
      if (!digits || !isBoundary(source[i + 1 + digits[0].length])) { i += 1; continue; }
      name = digits[0];
    }
    if (i > plainStart) parts.push({ text: source.slice(plainStart, i) });
    parts.push(everyone ? { mention: true, name, everyone: true } : { mention: true, name });
    i += 1 + name.length;
    plainStart = i;
  }
  if (plainStart < source.length) parts.push({ text: source.slice(plainStart) });
  return parts;
}

// ── Escribir ─────────────────────────────────────────────────────────────────────
// participants: [{ id, name }] (id = chat_id de WhatsApp). picks: { [nº de mención]: id }
// con las elecciones del usuario para las que eran ambiguas.
//
// Devuelve:
//   sendText    texto para WhatsApp: cada mención resuelta pasa a «@<número>» (es lo que
//               WhatsApp necesita en el cuerpo para resaltarla y avisar a esa persona)
//   mentionedIds  ids mencionados (para options.mentions)
//   ambiguous   [{ index, query, candidates: [{ id, name }] }] — hay que preguntar
//   unmatched   [«@algo»] que no encajan con nadie (se quedan como texto)
function participantMatches(participant, query, words) {
  const norm = participant.norm;
  if (norm === query || norm.startsWith(`${query} `)) return true;
  if (norm.startsWith(query)) return true;
  // Una sola palabra también puede ser el apellido: «@garcia» → «Ana García».
  return words === 1 && norm.split(' ').some((w) => w.startsWith(query));
}

export function findComposeMentions(text, participants, picks = {}) {
  const people = dedupeParticipants(participants);
  const out = [];
  const mentionedIds = [];
  const ambiguous = [];
  const unmatched = [];
  let index = 0;
  let i = 0;
  let plainStart = 0;

  while (i < text.length) {
    if (!canStartMention(text, i)) { i += 1; continue; }
    // Palabras que siguen a la «@», con su posición en el texto original.
    const words = [];
    const re = /\S+/g;
    re.lastIndex = i + 1;
    if (/\s/.test(text[i + 1] ?? ' ')) { i += 1; continue; }   // «@ » suelta
    let m;
    while (words.length < MAX_MENTION_WORDS && (m = re.exec(text))) {
      // Solo palabras seguidas (un salto de línea corta la mención).
      const gap = text.slice(words.length ? words[words.length - 1].end : i + 1, m.index);
      if (words.length && /\n/.test(gap)) break;
      if (m[0].includes('@') && words.length) break;
      words.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
    }
    if (!words.length) { i += 1; continue; }

    // La versión más larga (más palabras) que encaje con alguien. A partir de la 2.ª
    // palabra se exigen 3 letras: «@ana a las 5» no debe tragarse la «a».
    let chosen = null;
    for (let n = words.length; n >= 1; n -= 1) {
      if (n > 1 && normalizeName(words[n - 1].raw).length < 3) continue;
      const query = normalizeName(words.slice(0, n).map((w) => w.raw).join(' '));
      if (!query) continue;
      const candidates = people.filter((p) => participantMatches(p, query, n));
      if (candidates.length) { chosen = { n, query, candidates }; break; }
    }
    if (!chosen) {   // nadie encaja: se queda como texto
      unmatched.push(text.slice(i, words[0].end));
      i += 1;
      continue;
    }

    // Fin de la mención en el texto original: la última palabra usada, sin la
    // puntuación final («@ana,» → la coma se conserva tras la mención).
    const last = words[chosen.n - 1];
    const trailing = last.raw.match(/[.,;:!?)\]}"'»]+$/u);
    const end = last.end - (trailing ? trailing[0].length : 0);

    const mentionIndex = index;
    index += 1;
    let target = resolveCandidates(chosen.query, chosen.candidates);
    if (picks[mentionIndex]) {
      target = chosen.candidates.find((c) => c.id === picks[mentionIndex]) || target;
    }

    out.push(text.slice(plainStart, i));
    if (target) {
      out.push(`@${target.id.split('@')[0]}`);
      if (!mentionedIds.includes(target.id)) mentionedIds.push(target.id);
    } else {
      ambiguous.push({
        index: mentionIndex,
        query: text.slice(i, end),
        candidates: chosen.candidates.map(({ id, name }) => ({ id, name })),
      });
      out.push(text.slice(i, end));
    }
    plainStart = end;
    i = end;
  }
  out.push(text.slice(plainStart));
  return { sendText: out.join(''), mentionedIds, ambiguous, unmatched };
}

// Un único candidato, o uno cuyo nombre (o primer nombre) es exactamente lo escrito
// («@ana» con «Ana» y «Anabel» → Ana). Si no, null: hay que preguntar.
function resolveCandidates(query, candidates) {
  if (candidates.length === 1) return candidates[0];
  const exact = candidates.filter((c) => c.norm === query);
  if (exact.length === 1) return exact[0];
  // «@ana» con «Ana García» y «Anabel»: solo una se llama Ana de primer nombre.
  const firstWord = candidates.filter((c) => c.norm.split(' ')[0] === query);
  if (firstWord.length === 1) return firstWord[0];
  return null;
}

// La misma persona puede venir dos veces (número @c.us y LID @lid) con el mismo nombre;
// se queda la primera aparición (la lista en vivo de WhatsApp va primero).
function dedupeParticipants(participants) {
  const seen = new Set();
  const out = [];
  for (const p of participants) {
    if (!p?.id || !p?.name) continue;
    const norm = normalizeName(p.name);
    if (!norm) continue;
    const key = `${norm}|${p.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: p.id, name: p.name, norm });
  }
  return out;
}
