import { stmts } from '../../db/db.js';

function getDisplayName(contact, fallback) {
  return contact?.name
    || contact?.pushname
    || contact?.verifiedName
    || contact?.shortName
    || fallback;
}

function buildMentionRegex(chatId) {
  const [identifier, server] = chatId.split('@');
  const patterns = [identifier];

  if (server === 'lid') {
    patterns.push(`lid:${identifier}`);
  }

  const escaped = patterns.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`@(${escaped.join('|')})`, 'g');
}

export async function resolveMentions(body, mentionedIds, client) {
  if (!body || !Array.isArray(mentionedIds) || mentionedIds.length === 0) {
    return body;
  }

  let resolvedBody = body;

  for (const chatId of mentionedIds) {
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
