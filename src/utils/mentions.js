import { stmts } from '../../db/db.js';
import { stripBidiIsolates } from './mention-text.js';
import {
  CONTACT_NAME_PRIORITY,
  formatWhatsappIdentifier,
  getContactDisplayName,
} from './contact-display-name.js';

function toPhone(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return digits.length >= 8 ? `+${digits}` : null;
}

async function resolvePersonalPhone(client, chatId, contact) {
  try {
    // Un LID no es un teléfono: pedir su pn asociado antes de usar cualquier
    // identificador que WhatsApp haya entregado para la mención.
    // También para @c.us: el número del JID puede ser el de empresa.
    if (typeof client.getContactLidAndPhone === 'function') {
      const [result] = await client.getContactLidAndPhone([chatId]);
      const phone = toPhone(result?.pn?._serialized || result?.pn);
      if (phone) return phone;
    }

    const number = toPhone(contact?.number);
    if (number) return number;
    if (typeof contact?.getFormattedNumber === 'function') {
      return toPhone(await contact.getFormattedNumber());
    }
  } catch {
    // Se cae al siguiente respaldo sin impedir que se componga el mensaje.
  }
  return null;
}

async function resolveMentionDisplayName(client, chatId) {
  const storedUser = stmts.getUserByChatId.get(chatId);
  let contact = null;
  try {
    contact = await client.getContactById(chatId);
    const contactName = getContactDisplayName(contact);
    if (contactName) {
      // Si WhatsApp aún no ha sincronizado un contacto recién añadido, la
      // caché local de agenda sigue siendo más fiable que su pushname.
      if (storedUser?.username && storedUser.name_priority > contactName.priority) {
        return { name: storedUser.username, priority: storedUser.name_priority };
      }
      return contactName;
    }
  } catch (err) {
    console.warn(`[mentions] No se pudo consultar ${chatId}:`, err.message);
  }

  // Mantener un nombre de agenda/perfil conocido si WhatsApp no lo devuelve
  // temporalmente, antes de sustituirlo por un número.
  if (storedUser?.username && storedUser.name_priority >= CONTACT_NAME_PRIORITY.PROFILE_NAME) {
    return { name: storedUser.username, priority: storedUser.name_priority };
  }

  const personalPhone = await resolvePersonalPhone(client, chatId, contact);
  if (personalPhone) {
    return { name: personalPhone, priority: CONTACT_NAME_PRIORITY.PERSONAL_PHONE };
  }
  if (storedUser?.username) {
    return { name: storedUser.username, priority: storedUser.name_priority || 0 };
  }
  return {
    name: formatWhatsappIdentifier(chatId),
    priority: CONTACT_NAME_PRIORITY.BUSINESS_NUMBER,
  };
}

// Identificadores (sin @dominio) con los que puede aparecer la persona en el cuerpo del
// mensaje. WhatsApp a veces escribe «@<LID>» en el texto pero pasa el número @c.us en
// mentionedIds, o al revés: sin probar ambos, la mención se quedaba como «@43834469789905».
async function resolveMentionAliases(client, chatId) {
  const aliases = new Set([chatId.split('@')[0]]);
  try {
    if (typeof client?.getContactLidAndPhone === 'function') {
      const [result] = await client.getContactLidAndPhone([chatId]);
      for (const value of [result?.lid, result?.pn]) {
        const id = value?._serialized || value;
        if (typeof id === 'string' && id.includes('@')) aliases.add(id.split('@')[0]);
      }
    }
  } catch {
    // Solo el identificador recibido.
  }
  return [...aliases].filter(Boolean);
}

function buildMentionRegex(identifiers) {
  const patterns = identifiers.flatMap((identifier) => [identifier, `+${identifier}`, `lid:${identifier}`]);

  const escaped = patterns.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // (?!\d): evita que el identificador de una persona quede "atrapado" como
  // prefijo del identificador (más largo) de otra persona mencionada en el
  // mismo mensaje (p. ej. dos IDs numéricos donde uno empieza igual que otro).
  return new RegExp(`@(${escaped.join('|')})(?!\\d)`, 'g');
}

export async function resolveMentions(body, mentionedIds, client) {
  if (!body || !Array.isArray(mentionedIds) || mentionedIds.length === 0) {
    return body;
  }

  let resolvedBody = stripBidiIsolates(body);

  // Resolver primero los identificadores más largos: si un ID es prefijo
  // numérico de otro, así se sustituye siempre por el correcto.
  const orderedIds = [...mentionedIds].sort((a, b) => b.split('@')[0].length - a.split('@')[0].length);

  for (const chatId of orderedIds) {
    try {
      const identity = await resolveMentionDisplayName(client, chatId);
      const displayName = identity.name;

      // Mantener en la BD el mejor dato conocido; una mención nunca debe rebajar
      // un contacto guardado a nombre de perfil o número.
      stmts.upsertUserNameIfPreferred.run(chatId, displayName, identity.priority);

      const regex = buildMentionRegex(await resolveMentionAliases(client, chatId));
      resolvedBody = resolvedBody.replace(regex, `@${displayName}`);
    } catch (err) {
      console.warn(`[mentions] No se pudo resolver ${chatId}:`, err.message);
    }
  }

  return resolvedBody;
}

// ── Al mostrar ────────────────────────────────────────────────────────────────────
// Menciones que se quedaron como número («@229604673507579»): las de mensajes guardados
// antes de resolverse, o las del texto citado de una respuesta. Antes de pintar un chat se
// consulta a WhatsApp el nombre de perfil de esas personas y se guarda en users, igual que
// hace resolveMentions al recibir; renderMentions ya lo encuentra por los dígitos.
const NUMERIC_MENTION_RE = /(?:^|[\s([{¡¿"'«])@\+?(\d{8,20})(?!\d)/g;
const MENTION_LOOKUP_RETRY_MS = 10 * 60_000;
const MENTION_LOOKUP_MAX = 10;
const MENTION_LOOKUP_TIMEOUT_MS = 2_500;
const mentionLookupAttempts = new Map();

function hasStoredName(digits) {
  const row = stmts.getUserByPhonePattern.get(`${digits}@%`);
  return Boolean(row?.username && !/^\+?\d[\d\s]*$/.test(row.username));
}

async function lookupMentionName(client, digits) {
  // 14+ cifras: casi siempre un LID; si no, un teléfono. Se prueba también el otro.
  const ids = digits.length >= 14 ? [`${digits}@lid`, `${digits}@c.us`] : [`${digits}@c.us`, `${digits}@lid`];
  for (const id of ids) {
    try {
      const identity = getContactDisplayName(await client.getContactById(id));
      if (identity) {
        stmts.upsertUserNameIfPreferred.run(id, identity.name, identity.priority);
        return;
      }
    } catch {
      // Siguiente formato.
    }
  }
}

export async function resolveUnknownMentionNames(texts, client) {
  if (!client?.info) return;
  const pending = new Set();
  for (const text of texts) {
    if (!text || !String(text).includes('@')) continue;
    for (const match of stripBidiIsolates(text).matchAll(NUMERIC_MENTION_RE)) {
      const digits = match[1];
      const lastTry = mentionLookupAttempts.get(digits) || 0;
      if (Date.now() - lastTry < MENTION_LOOKUP_RETRY_MS || hasStoredName(digits)) continue;
      pending.add(digits);
      if (pending.size >= MENTION_LOOKUP_MAX) break;
    }
  }
  if (!pending.size) return;

  for (const digits of pending) mentionLookupAttempts.set(digits, Date.now());
  // Con un tope de tiempo: si WhatsApp tarda, la página sale igual (con el número) y
  // la próxima vez ya estará resuelto.
  await Promise.race([
    Promise.all([...pending].map((digits) => lookupMentionName(client, digits))),
    new Promise((resolve) => { setTimeout(resolve, MENTION_LOOKUP_TIMEOUT_MS).unref?.(); }),
  ]);
}
