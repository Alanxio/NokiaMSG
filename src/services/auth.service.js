import fs from 'fs';
import crypto from 'crypto';

// ── Persistencia de tokens de confianza ──────────────────────────────────────
const TRUSTED_FILE = '/data/trusted_devices.json';

function loadTrustedTokens() {
  try {
    const raw = fs.readFileSync(TRUSTED_FILE, 'utf8');
    const obj = JSON.parse(raw);
    const now = Date.now();
    // Limpiar caducados al arrancar
    const clean = Object.fromEntries(
      Object.entries(obj).filter(([, exp]) => exp > now)
    );
    return new Map(Object.entries(clean));
  } catch {
    return new Map();
  }
}

function saveTrustedTokens(map) {
  try {
    const obj = Object.fromEntries(map.entries());
    fs.writeFileSync(TRUSTED_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('[Auth] No se pudo guardar trusted_devices.json:', e.message);
  }
}

// ── Almacenamiento en memoria ─────────────────────────────────────────────────
const sessions      = new Map();
const rateLimits    = new Map();
const trustedTokens = loadTrustedTokens(); // token → expiresAt

const SESSION_DURATION_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS        = 5;
const LOCK_DURATION_MS    = 10 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

export function isRateLimited(ip) {
  const record = rateLimits.get(ip);
  if (!record) return false;
  if (record.lockUntil && record.lockUntil > Date.now()) return true;
  if (record.lockUntil && record.lockUntil <= Date.now()) {
    rateLimits.delete(ip);
    return false;
  }
  return false;
}

export function recordFailedAttempt(ip) {
  let record = rateLimits.get(ip) || { attempts: 0, lockUntil: null };
  record.attempts += 1;
  if (record.attempts >= MAX_ATTEMPTS) {
    record.lockUntil = Date.now() + LOCK_DURATION_MS;
    console.log(`[Auth] IP ${ip} bloqueada por fuerza bruta.`);
  }
  rateLimits.set(ip, record);
}

export function resetAttempts(ip) {
  rateLimits.delete(ip);
}

// ── Sesiones cortas (15 min) ──────────────────────────────────────────────────

export function createSession(ip) {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { ip, expires: Date.now() + SESSION_DURATION_MS });
  return sessionId;
}

export function destroySession(sessionId) {
  sessions.delete(sessionId);
}

export function isValidSession(sessionId, ip) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (Date.now() > session.expires) { sessions.delete(sessionId); return false; }
  if (session.ip !== ip) return false;
  return true;
}

// ── Tokens de confianza de larga duración (Recordarme) ───────────────────────

export function createTrustToken() {
  const days = Number.parseInt(process.env.REMEMBER_DEVICE_DAYS || '30', 10);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
  trustedTokens.set(token, expiresAt);
  saveTrustedTokens(trustedTokens);
  console.log(`[Auth] Nuevo token de confianza creado por ${days} dias.`);
  return { token, days };
}

export function isValidTrustToken(token) {
  if (!token) return false;
  const expiresAt = trustedTokens.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    trustedTokens.delete(token);
    saveTrustedTokens(trustedTokens);
    return false;
  }
  return true;
}

export function revokeTrustToken(token) {
  if (token) {
    trustedTokens.delete(token);
    saveTrustedTokens(trustedTokens);
  }
}
