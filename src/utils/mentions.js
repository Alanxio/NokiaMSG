import { stmts } from '../../db/db.js';

function getDisplayName(contact, fallback) {
  return contact?.name
    || contact?.pushname
    || contact?.shortName
    || contact?.verifiedName
    || fallback;
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
      const contact = await client.getContactById(chatId);
      const baseIdentifier = chatId.split('@')[0];
      const fallback = chatId.endsWith('@lid') ? baseIdentifier : `+${baseIdentifier}`;
      const displayName = getDisplayName(contact, fallback);

      // Crear/actualizar el usuario en BD, igual que al recibir un mensaje normal
      stmts.upsertUser.run(chatId, displayName);

      const regex = buildMentionRegex(chatId);
      resolvedBody = resolvedBody.replace(regex, `@${displayName}`);
    } catch (err) {
      console.warn(`[mentions] No se pudo resolver ${chatId}:`, err.message);
    }
  }

  return resolvedBody;
}
