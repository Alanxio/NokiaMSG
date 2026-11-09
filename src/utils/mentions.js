import { stmts } from '../../db/db.js';
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

function buildMentionRegex(chatId) {
  const [identifier] = chatId.split('@');
  const patterns = [
    identifier,
    `+${identifier}`,
    `lid:${identifier}`
  ];

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

  let resolvedBody = body;

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

      const regex = buildMentionRegex(chatId);
      resolvedBody = resolvedBody.replace(regex, `@${displayName}`);
    } catch (err) {
      console.warn(`[mentions] No se pudo resolver ${chatId}:`, err.message);
    }
  }

  return resolvedBody;
}
