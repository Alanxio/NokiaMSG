import { existsSync, unlinkSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import db, { stmts } from '../../db/db.js';

const TIMEZONE = 'Europe/Madrid';
const CLEANUP_HOUR = 2;
const CLEANUP_MIN = 0;
const CLEANUP_SEC = 0;
const DEFAULT_MESSAGE_RETENTION_DAYS = 3;
const AUTH_DATA_PATH = '.wwebjs_auth';
const PUPPETEER_CACHE_PATH = join(AUTH_DATA_PATH, '.puppeteer_cache');

function getMadridDateParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });

  return Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
}

function getMessageRetentionDays() {
  const raw = (
    process.env.RETENTION_DAYS ??
    process.env.MESSAGE_RETENTION_DAYS ??
    `${DEFAULT_MESSAGE_RETENTION_DAYS}`
  ).trim();
  const parsed = Number.parseInt(raw, 10);

  if (Number.isNaN(parsed) || parsed < 1) {
    return DEFAULT_MESSAGE_RETENTION_DAYS;
  }

  return parsed;
}

function getCleanupCutoffDate(retentionDays) {
  const parts = getMadridDateParts();
  const cutoff = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - retentionDays)
  );

  const year = cutoff.getUTCFullYear();
  const month = String(cutoff.getUTCMonth() + 1).padStart(2, '0');
  const day = String(cutoff.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function msUntilNextCleanup() {
  const now = new Date();

  const parts = getMadridDateParts(now);
  const madridYear = Number(parts.year);
  const madridMonth = Number(parts.month) - 1;
  const madridDay = Number(parts.day);
  const madridHour = Number(parts.hour);
  const madridMinute = Number(parts.minute);
  const madridSecond = Number(parts.second);

  const passedToday =
    madridHour > CLEANUP_HOUR ||
    (madridHour === CLEANUP_HOUR && madridMinute > CLEANUP_MIN) ||
    (madridHour === CLEANUP_HOUR && madridMinute === CLEANUP_MIN && madridSecond >= CLEANUP_SEC);

  const targetDate = new Date(
    Date.UTC(madridYear, madridMonth, madridDay + (passedToday ? 1 : 0),
      CLEANUP_HOUR, CLEANUP_MIN, CLEANUP_SEC)
  );

  const madridOffset = getMadridUtcOffsetMs(targetDate);

  const targetUTC = targetDate.getTime() - madridOffset;
  const delay = targetUTC - now.getTime();

  return delay > 0 ? delay : 0;
}

function getMadridUtcOffsetMs(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const localAsUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return localAsUTC - date.getTime();
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      console.log(`[cleanup] Eliminado: ${filePath}`);
    }
  } catch (err) {
    console.warn(`[cleanup] No se pudo eliminar ${filePath}: ${err.message}`);
  }
}

function cleanupMedia(retentionDays) {
  const cutoffSeconds = Math.floor(Date.now() / 1000) - (retentionDays * 86400);
  const attachments = stmts.getAttachmentsByCreatedAt.all(cutoffSeconds);
  if (attachments.length === 0) return;

  console.log(`[cleanup] Limpiando ${attachments.length} adjuntos antiguos...`);

  for (const a of attachments) {
    safeUnlink(a.file_path_thumb);
    safeUnlink(a.file_path_full);
    safeUnlink(findOriginalFile(a.file_name));
  }

  if (attachments.length > 0) {
    const ids = attachments.map(a => a.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM attachments WHERE id IN (${placeholders})`).run(...ids);
  }
}

function findOriginalFile(fileName) {
  if (!fileName) return null;
  const publicDir = join(process.cwd(), 'public', 'media');
  const ext = fileName.split('.').pop();
  const origPath = join(publicDir, `orig_${fileName}.${ext}`);
  return existsSync(origPath) ? origPath : null;
}

function cleanupPuppeteerCache() {
  try {
    if (!existsSync(PUPPETEER_CACHE_PATH)) return;
    const entries = readdirSync(PUPPETEER_CACHE_PATH);
    let cleaned = 0;
    for (const entry of entries) {
      const fullPath = join(PUPPETEER_CACHE_PATH, entry);
      try {
        rmSync(fullPath, { recursive: true, force: true });
        cleaned++;
      } catch {}
    }
    console.log(`[cleanup] Puppeteer cache: ${cleaned} entradas eliminadas`);
  } catch (err) {
    console.warn(`[cleanup] Error limpiando cache Puppeteer: ${err.message}`);
  }
}

async function runCleanup() {
  const startedAt = new Date().toISOString();
  const retentionDays = getMessageRetentionDays();
  const cutoffDate = getCleanupCutoffDate(retentionDays);
  const cutoffTimestamp = `${cutoffDate} 23:59:59`;

  console.log(
    `[cleanup] Iniciando limpieza diaria a las ${startedAt} ` +
    `(retencion: ${retentionDays} dias, corte: ${cutoffTimestamp})`
  );

  try {
    db.exec('BEGIN');

    cleanupMedia(retentionDays);

    const deleteResult = stmts.deleteMessagesOlderThan.run(cutoffTimestamp);

    const allUsers = db.prepare('SELECT chat_id FROM users').all();
    for (const user of allUsers) {
      stmts.adjustUserUnseen.run(user.chat_id);
    }

    const allGroups = db.prepare('SELECT group_id FROM wgroups').all();
    for (const group of allGroups) {
      stmts.adjustGroupUnseen.run(group.group_id);
    }

    stmts.deleteUsersWithoutMessages.run();
    stmts.deleteGroupsWithoutMessages.run();

    db.exec('COMMIT');

    cleanupPuppeteerCache();

    console.log(
      `[cleanup] Limpieza completada: ${deleteResult.changes} mensajes eliminados`
    );
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[cleanup] Error durante la limpieza:', err.message);
  }
}

let _cleanupTimer = null;

function scheduleNext() {
  const delay = msUntilNextCleanup();
  const nextRun = new Date(Date.now() + delay);

  console.log(
    `[cleanup] Proxima limpieza programada: ${nextRun.toLocaleString('es-ES', { timeZone: TIMEZONE })} ` +
    `(en ${Math.round(delay / 1000 / 60)} minutos)`
  );

  _cleanupTimer = setTimeout(async () => {
    await runCleanup();
    scheduleNext();
  }, delay);

  if (_cleanupTimer.unref) _cleanupTimer.unref();
}

export function startDailyCleanup() {
  const enabled = ['1', 'true', 'yes', 'on'].includes(
    (process.env.DAILY_CLEANUP_ENABLED || 'true').trim().toLowerCase()
  );
  const retentionDays = getMessageRetentionDays();

  if (!enabled) {
    console.log('[cleanup] Limpieza diaria desactivada (DAILY_CLEANUP_ENABLED=false)');
    return;
  }

  console.log(
    `[cleanup] Planificador de limpieza diaria iniciado ` +
    `(02:00 Europe/Madrid, retencion: ${retentionDays} dias)`
  );
  scheduleNext();
}

export function stopDailyCleanup() {
  if (_cleanupTimer) {
    clearTimeout(_cleanupTimer);
    _cleanupTimer = null;
    console.log('[cleanup] Planificador de limpieza detenido');
  }
}

export { runCleanup };