// Fotos de perfil (usuarios) e iconos de grupo, ya preparadas para el Nokia.
//
// WhatsApp entrega la foto original (640x640, 50-100 KB). Aquí se descarga una vez,
// se guarda en dos tamaños JPEG pequeños y se reutiliza durante AVATAR_TTL_MS:
//   mini (32x32, ~1-2 KB)  → cabecera de los chats, al estilo Messenger
//   big  (96x96, ~4-6 KB)  → pantallas de Detalles
// La URL lleva ?v=<versión> para que el Nokia pueda cachearla sin miedo: si la persona
// cambia de foto, cambia la versión y por tanto la URL.
//
// Se guardan en /data/avatars (no en public/media: la limpieza de huérfanos de esa
// carpeta borraría todo lo que no esté en la tabla attachments).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { client, getConnectionStatus } from './whatsapp.service.js';

const AVATAR_DIR = join(dirname(process.env.DB_PATH || '/data/nokia.db'), 'avatars');
const AVATAR_TTL_MS = 24 * 60 * 60 * 1000;
// «Sin foto» caduca antes: puede ser un fallo puntual o que la acaben de poner.
const NO_PHOTO_TTL_MS = 30 * 60 * 1000;
const RENDER_WAIT_MS = 2500; // lo máximo que una página espera a una foto nueva
export const AVATAR_SIZES = Object.freeze({ mini: 32, big: 96 });

const inFlight = new Map();

function baseName(chatId) {
  return createHash('sha1').update(String(chatId)).digest('hex').slice(0, 24);
}

function metaPath(chatId) {
  return join(AVATAR_DIR, `${baseName(chatId)}.json`);
}

export function avatarFilePath(chatId, size) {
  return join(AVATAR_DIR, `${baseName(chatId)}_${AVATAR_SIZES[size]}.jpg`);
}

function readMeta(chatId) {
  try {
    return JSON.parse(readFileSync(metaPath(chatId), 'utf8'));
  } catch {
    return null;
  }
}

function writeMeta(chatId, meta) {
  writeFileSync(metaPath(chatId), JSON.stringify(meta));
}

async function refreshAvatar(chatId) {
  const previous = readMeta(chatId);
  const isConnected = client && ['connected', 'authenticated'].includes(getConnectionStatus().status);
  if (!isConnected) return previous;

  let url = null;
  let source = 'servidor';
  let serverError = null;
  try {
    url = await client.getProfilePicUrl(chatId);
  } catch (err) {
    serverError = err;
  }
  if (!url) {
    // Respaldo: la miniatura que WhatsApp Web ya tiene en memoria para ese chat.
    try {
      url = await client.pupPage.evaluate(async (id) => {
        const { ProfilePicThumb } = window.require('WAWebCollections');
        const wid = window.require('WAWebWidFactory').createWid(id);
        let thumb = ProfilePicThumb.get(wid) || ProfilePicThumb.get(id);
        if (!thumb && typeof ProfilePicThumb.find === 'function') {
          try { thumb = await ProfilePicThumb.find(wid); } catch { thumb = null; }
        }
        return thumb?.eurl || thumb?.imgFull || thumb?.img || null;
      }, chatId);
      source = 'miniatura';
    } catch (err) {
      console.log(`[avatar] Respaldo de miniatura falló para ${chatId}:`, err?.message || err);
    }
  }

  if (!url) {
    if (serverError) {
      console.log(`[avatar] ${chatId}: error pidiendo la foto (${serverError?.message || serverError}), se reintentará`);
      return previous;
    }
    console.log(`[avatar] ${chatId}: sin foto (o privacidad), se reintentará en 30 min`);
    const meta = { fetchedAt: Date.now(), hasPhoto: false, version: null };
    writeMeta(chatId, meta);
    return meta;
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} descargando la foto`);
  const original = Buffer.from(await response.arrayBuffer());

  const { default: sharp } = await import('sharp');
  const resized = await Promise.all(Object.values(AVATAR_SIZES).map((px) => sharp(original)
    .resize(px, px, { fit: 'cover' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: px <= 32 ? 80 : 75 })
    .toBuffer()));

  // Misma foto que ya teníamos: no cambiar la versión (el Nokia la conserva en caché).
  const contentHash = createHash('sha1').update(original).digest('hex').slice(0, 12);
  const unchanged = previous?.hasPhoto && previous.contentHash === contentHash
    && Object.keys(AVATAR_SIZES).every((size) => existsSync(avatarFilePath(chatId, size)));
  if (!unchanged) {
    Object.keys(AVATAR_SIZES).forEach((size, i) => writeFileSync(avatarFilePath(chatId, size), resized[i]));
  }
  const meta = {
    fetchedAt: Date.now(),
    hasPhoto: true,
    contentHash,
    version: unchanged ? previous.version : contentHash,
  };
  writeMeta(chatId, meta);
  console.log(`[avatar] ${chatId}: foto ${unchanged ? 'sin cambios' : 'actualizada'} (${source})`);
  return meta;
}

function ensureAvatar(chatId) {
  if (inFlight.has(chatId)) return inFlight.get(chatId);
  const job = refreshAvatar(chatId)
    .catch((err) => {
      console.warn(`[avatar] No se pudo actualizar la foto de ${chatId}:`, err?.message || err);
      return readMeta(chatId);
    })
    .finally(() => inFlight.delete(chatId));
  inFlight.set(chatId, job);
  return job;
}

// URL de la foto lista para <img>, o null si no tiene (o aún no se sabe).
// Si la caché está vigente responde al momento; si no, espera como mucho RENDER_WAIT_MS
// y, si WhatsApp tarda más, usa la versión anterior mientras termina en segundo plano.
export async function getAvatarUrl(chatId, size = 'mini') {
  if (!chatId || !AVATAR_SIZES[size]) return null;
  try {
    mkdirSync(AVATAR_DIR, { recursive: true });
  } catch {
    return null;
  }

  let meta = readMeta(chatId);
  const isFresh = meta && Date.now() - meta.fetchedAt < (meta.hasPhoto ? AVATAR_TTL_MS : NO_PHOTO_TTL_MS);
  if (!isFresh) {
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve(meta), RENDER_WAIT_MS).unref?.();
    });
    meta = await Promise.race([ensureAvatar(chatId), timeout]);
  }

  if (!meta?.hasPhoto || !existsSync(avatarFilePath(chatId, size))) return null;
  return `/avatar/${size}/${encodeURIComponent(chatId)}?v=${meta.version}`;
}

export function renderAvatarImg(url, size = 'mini', alt = '') {
  if (!url) return '';
  const px = AVATAR_SIZES[size];
  const escapedUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  // La grande va sola en su párrafo centrado: sin alineación vertical con el texto.
  const style = size === 'mini' ? ' style="vertical-align:bottom;"' : '';
  return `<img src="${escapedUrl}" width="${px}" height="${px}" alt="${alt}"${style}/>`;
}

// GET /avatar/:size/:id — la URL está versionada, así que el Nokia la puede cachear.
export function serveAvatar(req, res) {
  const { size, id } = req.params;
  if (!AVATAR_SIZES[size]) return res.status(404).end();
  const filePath = avatarFilePath(id, size);
  if (!existsSync(filePath)) return res.status(404).end();
  res.set({
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'private, max-age=604800',
  });
  return res.sendFile(filePath);
}
