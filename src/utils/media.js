import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { Jimp, JimpMime } from 'jimp';
import db, { stmts } from '../../db/db.js';

const FULL_MAX_WIDTH = 320;
const FULL_MAX_HEIGHT = 240;
const VIEW_MAX_WIDTH = 120;
const VIEW_MAX_HEIGHT = 140;
const THUMB_WIDTH = 40;
const JPEG_QUALITY = 90;

export function getMediaDir() {
  return join(process.cwd(), 'public', 'media');
}

export function ensureMediaDir() {
  const dir = getMediaDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function sanitizeMediaKey(key) {
  if (!key) return `k_${Date.now()}`;
  return String(key)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 100) || `k_${Date.now()}`;
}

export function getMediaPaths(mediaKey) {
  const safeKey = sanitizeMediaKey(mediaKey);
  return {
    fullFile: `full_${safeKey}.jpg`,
    viewFile: `view_${safeKey}.jpg`,
    thumbFile: `thumb_${safeKey}.jpg`,
    fullRel: `/media/full_${safeKey}.jpg`,
    viewRel: `/media/view_${safeKey}.jpg`,
    thumbRel: `/media/thumb_${safeKey}.jpg`,
  };
}

function fitDimensions(origWidth, origHeight, maxWidth, maxHeight) {
  const scale = Math.min(maxWidth / origWidth, maxHeight / origHeight, 1);
  return {
    width: Math.max(1, Math.round(origWidth * scale)),
    height: Math.max(1, Math.round(origHeight * scale)),
  };
}

export async function processImageBuffer(buffer) {
  const image = await Jimp.read(buffer);
  const origWidth = image.bitmap.width;
  const origHeight = image.bitmap.height;

  // ---- Full: 320x240 max without upscaling ----
  const fullDim = fitDimensions(origWidth, origHeight, FULL_MAX_WIDTH, FULL_MAX_HEIGHT);
  const fullImage = image.clone().resize({ w: fullDim.width, h: fullDim.height });
  const fullBuffer = await fullImage.getBuffer(JimpMime.jpeg, { quality: JPEG_QUALITY });

  // ---- View: 120x140 max without upscaling ----
  const viewDim = fitDimensions(origWidth, origHeight, VIEW_MAX_WIDTH, VIEW_MAX_HEIGHT);
  const viewImage = image.clone().resize({ w: viewDim.width, h: viewDim.height });
  const viewBuffer = await viewImage.getBuffer(JimpMime.jpeg, { quality: JPEG_QUALITY });

  // ---- Thumbnail: 40px wide ----
  const thumbHeight = Math.max(1, Math.round(THUMB_WIDTH * origHeight / origWidth));
  const thumbImage = image.clone().resize({ w: THUMB_WIDTH, h: thumbHeight });
  const thumbBuffer = await thumbImage.getBuffer(JimpMime.jpeg, { quality: JPEG_QUALITY });

  return {
    fullDim,
    viewDim,
    fullBuffer,
    viewBuffer,
    thumbBuffer,
  };
}

export async function saveImageVersions(mediaKey, buffer) {
  const dir = ensureMediaDir();
  const { fullFile, viewFile, thumbFile, fullRel, viewRel, thumbRel } = getMediaPaths(mediaKey);

  const versions = await processImageBuffer(buffer);

  const fullPath = join(dir, fullFile);
  const viewPath = join(dir, viewFile);
  const thumbPath = join(dir, thumbFile);

  writeFileSync(fullPath, versions.fullBuffer);
  writeFileSync(viewPath, versions.viewBuffer);
  writeFileSync(thumbPath, versions.thumbBuffer);

  return {
    mediaKey: sanitizeMediaKey(mediaKey),
    fullPath,
    viewPath,
    thumbPath,
    fullRel,
    viewRel,
    thumbRel,
    fullDim: versions.fullDim,
    viewDim: versions.viewDim,
    fullSize: versions.fullBuffer.length,
    viewSize: versions.viewBuffer.length,
    thumbSize: versions.thumbBuffer.length,
  };
}

export function insertAttachment(messageId, mediaInfo) {
  if (!messageId || !mediaInfo) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return stmts.insertAttachment.run(
    messageId,
    mediaInfo.mediaKey,
    mediaInfo.mimeType || 'image/jpeg',
    mediaInfo.filename || `media_${nowSeconds}.jpg`,
    mediaInfo.bufferLength || 0,
    mediaInfo.filePathFull || mediaInfo.fullRel,
    mediaInfo.filePathView || mediaInfo.viewRel,
    mediaInfo.filePathThumb || mediaInfo.thumbRel,
    0,
    nowSeconds
  );
}

export async function processAndAttachMedia(messageId, buffer, options = {}) {
  const mediaKey = options.mediaKey || `msg_${Date.now()}`;
  const filename = options.filename || `media_${Date.now()}.jpg`;
  const mimeType = options.mimeType || 'image/jpeg';

  const saved = await saveImageVersions(mediaKey, buffer);

  insertAttachment(messageId, {
    mediaKey: saved.mediaKey,
    mimeType,
    filename,
    bufferLength: buffer.length,
    filePathFull: saved.fullRel,
    filePathView: saved.viewRel,
    filePathThumb: saved.thumbRel,
  });

  return saved;
}

export function cleanupOrphanMediaFiles() {
  try {
    const dir = getMediaDir();
    if (!existsSync(dir)) return;

    const referenced = new Set();
    const attachments = db.prepare('SELECT file_path_full, file_path_view, file_path_thumb FROM attachments').all();
    for (const a of attachments) {
      ['file_path_full', 'file_path_view', 'file_path_thumb'].forEach((col) => {
        if (a[col]) {
          const fileName = a[col].split('/').pop();
          if (fileName) referenced.add(fileName);
        }
      });
    }

    const files = readdirSync(dir);
    let removed = 0;
    for (const file of files) {
      if (!referenced.has(file)) {
        const fullPath = join(dir, file);
        try {
          const st = statSync(fullPath);
          if (st.isDirectory()) {
            rmSync(fullPath, { recursive: true, force: true });
          } else {
            unlinkSync(fullPath);
          }
          removed++;
        } catch (cleanupErr) {
          console.warn(`[media] No se pudo eliminar ${fullPath}:`, cleanupErr.message);
        }
      }
    }

    if (removed > 0) {
      console.log(`[media] ${removed} archivos huérfanos eliminados de public/media`);
    }
  } catch (err) {
    console.error('[media] Error limpiando archivos huérfanos:', err.message);
  }
}

export async function convertStickerToPng(buffer) {
  const { default: sharp } = await import('sharp');
  return sharp(buffer, { pages: 1 })
    .png()
    .toBuffer();
}

export async function processSticker(messageId, buffer, options = {}) {
  const mediaKey = options.mediaKey || `sticker_${Date.now()}`;
  const filename = options.filename || 'sticker.png';

  const pngBuffer = await convertStickerToPng(buffer);

  const image = await Jimp.read(pngBuffer);
  const origWidth = image.bitmap.width;
  const origHeight = image.bitmap.height;

  // ---- Thumbnail only: 40px wide PNG ----
  const thumbHeight = Math.max(1, Math.round(THUMB_WIDTH * origHeight / origWidth));
  const thumbImage = image.clone().resize({ w: THUMB_WIDTH, h: thumbHeight });
  const thumbBuffer = await thumbImage.getBuffer(JimpMime.png, {});

  const dir = ensureMediaDir();
  const safeKey = sanitizeMediaKey(mediaKey);
  const thumbFile = `thumb_${safeKey}.png`;
  const thumbPath = join(dir, thumbFile);
  const thumbRel = `/media/${thumbFile}`;

  writeFileSync(thumbPath, thumbBuffer);

  insertAttachment(messageId, {
    mediaKey: safeKey,
    mimeType: 'image/png',
    filename,
    bufferLength: buffer.length,
    filePathFull: null,
    filePathView: null,
    filePathThumb: thumbRel,
  });

  return {
    mediaKey: safeKey,
    thumbPath,
    thumbRel,
    thumbSize: thumbBuffer.length,
  };
}

export async function migrateAttachmentsToView() {
  try {
    const attachments = db.prepare(`
      SELECT id, message_id, media_key, file_path_full, file_path_view, file_path_thumb
      FROM attachments
      WHERE file_path_view IS NULL OR file_path_view = ''
    `).all();

    if (attachments.length === 0) return;

    console.log(`[media] Migrando ${attachments.length} attachments antiguos a nuevo formato...`);

    const dir = getMediaDir();
    let migrated = 0;

    for (const a of attachments) {
      try {
        if (!a.file_path_full) continue;

        const oldFullName = a.file_path_full.split('/').pop();
        if (!oldFullName) continue;

        const oldFullPath = join(dir, oldFullName);
        if (!existsSync(oldFullPath)) continue;

        const mediaKey = a.media_key || `migrated_${a.id}_${Date.now()}`;
        const { fullFile, viewFile, thumbFile, fullRel, viewRel, thumbRel } = getMediaPaths(mediaKey);

        const fullPath = join(dir, fullFile);
        const viewPath = join(dir, viewFile);
        const thumbPath = join(dir, thumbFile);

        // Rename existing full file to new full path
        renameSync(oldFullPath, fullPath);

        // Generate view from the full file
        const buffer = readFileSync(fullPath);
        const image = await Jimp.read(buffer);
        const viewDim = fitDimensions(image.bitmap.width, image.bitmap.height, VIEW_MAX_WIDTH, VIEW_MAX_HEIGHT);
        const viewImage = image.clone().resize({ w: viewDim.width, h: viewDim.height });
        const viewBuffer = await viewImage.getBuffer(JimpMime.jpeg, { quality: JPEG_QUALITY });
        writeFileSync(viewPath, viewBuffer);

        // Regenerate thumb if missing
        if (!a.file_path_thumb || !existsSync(join(dir, a.file_path_thumb.split('/').pop()))) {
          const thumbHeight = Math.max(1, Math.round(THUMB_WIDTH * image.bitmap.height / image.bitmap.width));
          const thumbImage = image.clone().resize({ w: THUMB_WIDTH, h: thumbHeight });
          const thumbBuffer = await thumbImage.getBuffer(JimpMime.jpeg, { quality: JPEG_QUALITY });
          writeFileSync(thumbPath, thumbBuffer);
        }

        // Update DB
        stmts.updateAttachmentPaths.run(fullRel, thumbRel, a.id);
        db.prepare('UPDATE attachments SET file_path_view = ? WHERE id = ?').run(viewRel, a.id);

        migrated++;
      } catch (migrateErr) {
        console.error(`[media] Error migrando attachment ${a.id}:`, migrateErr.message);
      }
    }

    if (migrated > 0) {
      console.log(`[media] ${migrated} attachments migrados correctamente.`);
    }
  } catch (err) {
    console.error('[media] Error en migración de attachments:', err.message);
  }
}
