// Identidad propia en WhatsApp: los ids con los que aparece esta cuenta (número @c.us y
// LID @lid, según la migración de identidad de WhatsApp) y los nombres con los que se
// muestra en las menciones. La rellena whatsapp.service.js al conectar; la usan el render
// de menciones («@Tú») y el guardado (mentions_me) sin depender del cliente de WhatsApp.
import { stmts } from '../../db/db.js';
import { normalizeName } from './mention-text.js';

let myIds = new Set();
let myDigits = new Set();
let myNames = new Set();
let myNormalizedNames = new Set();
let myExtraNames = [];

export function setMyIdentity(ids = [], extraNames = []) {
  myIds = new Set(ids.filter(Boolean));
  myDigits = new Set([...myIds].map((id) => String(id).split('@')[0]).filter(Boolean));
  myExtraNames = extraNames.filter(Boolean);
  refreshMyNames();
}

// Vuelve a leer de la BD los nombres propios (tras guardar una mención nueva a mí mismo).
export function refreshMyNames() {
  const names = new Set(myExtraNames);
  // Nombres con los que esta cuenta quedó guardada (resolveMentions guarda el nombre de
  // cada persona mencionada, también el propio).
  for (const id of myIds) {
    try {
      const row = stmts.getUserByChatId.get(id);
      if (row?.username) names.add(row.username);
    } catch { /* sin BD todavía */ }
  }
  myNames = names;
  myNormalizedNames = new Set([...names].map(normalizeName).filter(Boolean));
}

export function isMyId(id) {
  if (!id) return false;
  const value = String(id);
  return myIds.has(value) || myDigits.has(value.split('@')[0]);
}

// ¿Alguno de estos ids (msg.mentionedIds) soy yo?
export function mentionsMe(mentionedIds) {
  return Array.isArray(mentionedIds) && mentionedIds.some((id) => isMyId(id?._serialized || id));
}

// ¿Este texto de mención («Alanxio 07», «34600111222») me nombra a mí?
export function isMyMentionName(name) {
  if (!name) return false;
  // Normalizado: WhatsApp quita los emojis del nombre al mencionar.
  return myNames.has(name) || myNormalizedNames.has(normalizeName(name))
    || myDigits.has(String(name).replace(/[^0-9]/g, ''));
}

export function getMyMentionNames() {
  return [...myNames];
}
