import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { spawn } from 'node:child_process';
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

export async function processImageBuffer(buffer, { includeFull = true } = {}) {
  const image = await Jimp.read(buffer);
  const origWidth = image.bitmap.width;
  const origHeight = image.bitmap.height;

  const fullDim = fitDimensions(origWidth, origHeight, FULL_MAX_WIDTH, FULL_MAX_HEIGHT);
  const viewDim = fitDimensions(origWidth, origHeight, VIEW_MAX_WIDTH, VIEW_MAX_HEIGHT);
  const thumbHeight = Math.max(1, Math.round(THUMB_WIDTH * origHeight / origWidth));
  const encodeResized = (width, height) => image.clone()
    .resize({ w: width, h: height })
    .getBuffer(JimpMime.jpeg, { quality: JPEG_QUALITY });
  const [fullBuffer, viewBuffer, thumbBuffer] = await Promise.all([
    includeFull ? encodeResized(fullDim.width, fullDim.height) : null,
    encodeResized(viewDim.width, viewDim.height),
    encodeResized(THUMB_WIDTH, thumbHeight),
  ]);

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
    mediaInfo.durationSec ?? null,
    0,
    nowSeconds
  );
}

export async function processAndAttachMedia(messageId, buffer, options = {}) {
  const mediaKey = options.mediaKey || `msg_${Date.now()}`;
  const filename = options.filename || `media_${Date.now()}.jpg`;
  const mimeType = options.mimeType || 'image/jpeg';
  const safeKey = sanitizeMediaKey(mediaKey);
  const extension = mimeType === 'image/png' ? '.png' : '.jpg';
  const { viewFile, thumbFile, viewRel, thumbRel } = getMediaPaths(safeKey);
  const fullFile = `full_${safeKey}${extension}`;
  const dir = ensureMediaDir();
  const fullPath = join(dir, fullFile);
  const viewPath = join(dir, viewFile);
  const thumbPath = join(dir, thumbFile);
  const versions = await processImageBuffer(buffer, { includeFull: false });

  writeFileSync(fullPath, buffer);
  writeFileSync(viewPath, versions.viewBuffer);
  writeFileSync(thumbPath, versions.thumbBuffer);
  const fullRel = `/media/${fullFile}`;

  insertAttachment(messageId, {
    mediaKey: safeKey,
    mimeType,
    filename,
    bufferLength: buffer.length,
    filePathFull: fullRel,
    filePathView: viewRel,
    filePathThumb: thumbRel,
  });

  return {
    mediaKey: safeKey,
    fullPath,
    viewPath,
    thumbPath,
    fullRel,
    viewRel,
    thumbRel,
    fullSize: buffer.length,
    viewSize: versions.viewBuffer.length,
    thumbSize: versions.thumbBuffer.length,
  };
}

function extractVideoFirstFrame(buffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-vf', `scale=${FULL_MAX_WIDTH}:${FULL_MAX_HEIGHT}:force_original_aspect_ratio=decrease`,
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ]);
    const output = [];
    let errorOutput = '';

    ffmpeg.stdout.on('data', (chunk) => output.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg no pudo extraer el primer fotograma: ${errorOutput.trim() || `código ${code}`}`));
        return;
      }
      if (output.length === 0) {
        reject(new Error('FFmpeg no generó ningún fotograma para el video.'));
        return;
      }
      resolve(Buffer.concat(output));
    });
    ffmpeg.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    ffmpeg.stdin.end(buffer);
  });
}

export async function processAndAttachVideo(messageId, buffer, options = {}) {
  const mediaKey = options.mediaKey || `video_${Date.now()}`;
  const filename = options.filename || `video_${Date.now()}.3gp`;
  const mimeType = options.mimeType || 'video/3gpp';
  const safeKey = sanitizeMediaKey(mediaKey);
  const dir = ensureMediaDir();
  const fullFile = `full_${safeKey}.3gp`;
  const fullPath = join(dir, fullFile);
  const fullRel = `/media/${fullFile}`;
  let viewRel = null;
  let thumbRel = null;
  let previewError = null;

  writeFileSync(fullPath, buffer);

  try {
    const firstFrame = await extractVideoFirstFrame(buffer);
    const versions = await processImageBuffer(firstFrame, { includeFull: false });
    const { viewFile, thumbFile, viewRel: savedViewRel, thumbRel: savedThumbRel } = getMediaPaths(safeKey);
    writeFileSync(join(dir, viewFile), versions.viewBuffer);
    writeFileSync(join(dir, thumbFile), versions.thumbBuffer);
    viewRel = savedViewRel;
    thumbRel = savedThumbRel;
  } catch (error) {
    previewError = error;
  }

  insertAttachment(messageId, {
    mediaKey: safeKey,
    mimeType,
    filename,
    bufferLength: buffer.length,
    filePathFull: fullRel,
    filePathView: viewRel,
    filePathThumb: thumbRel,
  });

  return {
    mediaKey: safeKey,
    fullPath,
    fullRel,
    viewRel,
    thumbRel,
    fullSize: buffer.length,
    previewError,
  };
}

const EXT_BY_MIME = {
  'audio/ogg': '.ogg',
  'audio/opus': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'video/quicktime': '.mov',
  'application/pdf': '.pdf',
};

function guessExtension(mimeType, filename) {
  if (filename && filename.includes('.')) {
    return filename.slice(filename.lastIndexOf('.'));
  }
  const bareMime = (mimeType || '').split(';')[0].trim();
  return EXT_BY_MIME[bareMime] || '.bin';
}

export function saveRawMediaFile(mediaKey, buffer, options = {}) {
  const dir = ensureMediaDir();
  const safeKey = sanitizeMediaKey(mediaKey);
  const ext = guessExtension(options.mimeType, options.filename);
  const fullFile = `full_${safeKey}${ext}`;
  const fullPath = join(dir, fullFile);
  const fullRel = `/media/${fullFile}`;

  writeFileSync(fullPath, buffer);

  return {
    mediaKey: safeKey,
    fullPath,
    fullRel,
    fullSize: buffer.length,
  };
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
      if (file.startsWith('voz_') && file.endsWith('.amr')) {
        const base = file.slice(4, -4);
        if ([...referenced].some((ref) => ref.replace(/\.[^.]+$/, '') === base)) continue;
      }
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
  return sharp(buffer, { pages: 1 }).png().toBuffer();
}

export async function processSticker(messageId, buffer, options = {}) {
  const mediaKey = options.mediaKey || `sticker_${Date.now()}`;
  const { default: sharp } = await import('sharp');
  const source = sharp(buffer, { animated: true });
  const metadata = await source.metadata();
  const isAnimated = (metadata.pages || 1) > 1;
  const stats = metadata.hasAlpha && !isAnimated
    ? await sharp(buffer).stats()
    : null;
  const hasTransparency = !isAnimated
    && metadata.hasAlpha
    && !stats.isOpaque;
  const format = isAnimated ? 'gif' : hasTransparency ? 'png' : 'jpeg';
  const mimeType = `image/${format}`;
  const extension = format === 'jpeg' ? 'jpg' : format;
  const filename = options.filename
    ? options.filename.replace(/\.[^.]+$/, `.${extension}`)
    : `sticker.${extension}`;
  const dir = ensureMediaDir();
  const safeKey = sanitizeMediaKey(mediaKey);
  const fullFile = `full_${safeKey}.${extension}`;
  const viewFile = `view_${safeKey}.${extension}`;
  const thumbFile = `thumb_${safeKey}.${extension}`;
  const fullPath = join(dir, fullFile);
  const viewPath = join(dir, viewFile);
  const thumbPath = join(dir, thumbFile);
  const fullRel = `/media/${fullFile}`;
  const viewRel = `/media/${viewFile}`;
  const thumbRel = `/media/${thumbFile}`;

  const createVersion = async (width, height) => {
    const image = sharp(buffer, isAnimated ? { animated: true } : {});
    image.resize({ width, height, fit: 'inside', withoutEnlargement: true });
    if (format === 'gif') {
      image.gif({ loop: 0 });
    } else if (format === 'png') {
      image.png();
    } else {
      image.jpeg({ quality: JPEG_QUALITY });
    }
    return image.toBuffer();
  };

  const [fullBuffer, viewBuffer, thumbBuffer] = await Promise.all([
    createVersion(FULL_MAX_WIDTH, FULL_MAX_HEIGHT),
    createVersion(VIEW_MAX_WIDTH, VIEW_MAX_HEIGHT),
    createVersion(THUMB_WIDTH, THUMB_WIDTH),
  ]);

  writeFileSync(fullPath, fullBuffer);
  writeFileSync(viewPath, viewBuffer);
  writeFileSync(thumbPath, thumbBuffer);

  insertAttachment(messageId, {
    mediaKey: safeKey,
    mimeType,
    filename,
    bufferLength: buffer.length,
    filePathFull: fullRel,
    filePathView: viewRel,
    filePathThumb: thumbRel,
  });

  return {
    mediaKey: safeKey,
    fullPath,
    viewPath,
    thumbPath,
    fullRel,
    viewRel,
    thumbRel,
    fullSize: fullBuffer.length,
    viewSize: viewBuffer.length,
    thumbSize: thumbBuffer.length,
    mimeType,
  };
}

export async function migrateAttachmentsToView() {
  try {
    const attachments = db.prepare(`
      SELECT id, message_id, media_key, file_path_full, file_path_view, file_path_thumb
      FROM attachments
      WHERE (file_path_view IS NULL OR file_path_view = '')
        AND mime_type LIKE 'image/%'
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

        const buffer = readFileSync(oldFullPath);
        const image = await Jimp.read(buffer);
        const viewDim = fitDimensions(image.bitmap.width, image.bitmap.height, VIEW_MAX_WIDTH, VIEW_MAX_HEIGHT);
        const viewImage = image.clone().resize({ w: viewDim.width, h: viewDim.height });
        const viewBuffer = await viewImage.getBuffer(JimpMime.jpeg, { quality: JPEG_QUALITY });

        let thumbBuffer;
        if (!existsSync(thumbPath)) {
          const thumbHeight = Math.max(1, Math.round(THUMB_WIDTH * image.bitmap.height / image.bitmap.width));
          const thumbImage = image.clone().resize({ w: THUMB_WIDTH, h: thumbHeight });
          thumbBuffer = await thumbImage.getBuffer(JimpMime.jpeg, { quality: JPEG_QUALITY });
        }

        if (oldFullPath !== fullPath) writeFileSync(fullPath, buffer);
        writeFileSync(viewPath, viewBuffer);
        if (thumbBuffer) writeFileSync(thumbPath, thumbBuffer);

        stmts.updateAttachmentPaths.run(fullRel, thumbRel, a.id);
        db.prepare('UPDATE attachments SET file_path_view = ? WHERE id = ?').run(viewRel, a.id);
        if (oldFullPath !== fullPath) unlinkSync(oldFullPath);

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


// ─── Audio para Nokia ────────────────────────────────────────────────────────
// WhatsApp entrega las notas de voz en OGG/Opus, que los Nokia no reproducen.
// Se convierten bajo demanda a AMR-NB (códec de voz nativo de Nokia: mono, 8 kHz,
// 12,2 kbps ≈ 1,5 KB/s) y el resultado se guarda junto al original como caché.
const amrConversions = new Map();

export function getAmrFileName(sourceFileName) {
  const base = String(sourceFileName).replace(/\.[^.]+$/, '');
  return `voz_${base}.amr`;
}

export function convertAudioToAmr(sourceFileName) {
  const dir = getMediaDir();
  const sourcePath = join(dir, sourceFileName);
  const amrName = getAmrFileName(sourceFileName);
  const amrPath = join(dir, amrName);

  if (existsSync(amrPath)) return Promise.resolve(amrPath);
  if (!existsSync(sourcePath)) return Promise.reject(new Error(`No existe el audio ${sourceFileName}`));
  if (amrConversions.has(amrPath)) return amrConversions.get(amrPath);

  const tmpPath = `${amrPath}.tmp`;
  const job = encodeAmrWithFfmpeg(sourcePath, tmpPath)
    .catch((ffmpegErr) => {
      // Debian no compila ffmpeg con libopencore_amrnb: decodificar con ffmpeg
      // y codificar con sox (que sí usa libopencore-amrnb).
      console.debug('[audio] ffmpeg sin AMR, se usa sox:', ffmpegErr.message);
      return encodeAmrWithSox(sourcePath, tmpPath);
    })
    .then(() => {
      renameSync(tmpPath, amrPath);
      return amrPath;
    })
    .catch((err) => {
      try { unlinkSync(tmpPath); } catch { /* nada que limpiar */ }
      throw err;
    })
    .finally(() => amrConversions.delete(amrPath));

  amrConversions.set(amrPath, job);
  return job;
}

function runProcess(command, args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let errorOutput = '';
    proc.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label}: ${errorOutput.trim() || `código ${code}`}`));
    });
  });
}

// AMR-NB 12,2 kbps, mono, 8 kHz.
function encodeAmrWithFfmpeg(sourcePath, outputPath) {
  return runProcess('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', sourcePath,
    '-vn', '-ac', '1', '-ar', '8000',
    '-c:a', 'libopencore_amrnb', '-b:a', '12.2k',
    '-f', 'amr', outputPath,
  ], 'FFmpeg no pudo convertir a AMR');
}

function encodeAmrWithSox(sourcePath, outputPath) {
  return new Promise((resolve, reject) => {
    const decoder = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', sourcePath,
      '-vn', '-ac', '1', '-ar', '8000',
      '-f', 's16le', 'pipe:1',
    ]);
    const encoder = spawn('sox', [
      '-t', 'raw', '-r', '8000', '-e', 'signed', '-b', '16', '-c', '1', '-',
      '-t', 'amr-nb', '-C', '7', outputPath,
    ]);
    let errorOutput = '';
    let pending = 2;
    let failed = false;
    const finish = (name) => (code) => {
      if (failed) return;
      if (code !== 0) {
        failed = true;
        reject(new Error(`${name} no pudo convertir a AMR: ${errorOutput.trim() || `código ${code}`}`));
        return;
      }
      pending -= 1;
      if (pending === 0) resolve();
    };
    const fail = (err) => { if (!failed) { failed = true; reject(err); } };

    decoder.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    encoder.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    decoder.on('error', fail);
    encoder.on('error', fail);
    encoder.stdin.on('error', (err) => { if (err.code !== 'EPIPE') fail(err); });
    decoder.stdout.pipe(encoder.stdin);
    decoder.on('close', finish('ffmpeg'));
    encoder.on('close', finish('sox'));
  });
}
