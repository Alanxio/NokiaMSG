import fs from 'fs';
import crypto from 'crypto';

// ── Tokens de confianza («Recordarme») ──────────────────────────────────────
// El 6111 no admite HTTPS: el token viaja en claro y alguien que vea el tráfico podría
// copiarlo. Para limitar el daño:
//  · En disco solo se guarda la huella SHA-256 del token (quien se lleve el archivo no
//    puede usarlo).
//  · Los tokens web se renuevan cada TRUST_ROTATE_INTERVAL_MS de uso: un token copiado
//    deja de servir en cuanto el Nokia vuelve a entrar.
//  · Si llega un token ya sustituido cuyo sustituto sí se ha usado, alguien lo copió:
//    se cierran todas las sesiones y se avisa por SMS.
// Los tokens del cliente J2ME (cabecera X-Nokia-Token) no se renuevan: el MIDlet no
// sabe recibir uno nuevo.
const TRUSTED_FILE = process.env.TRUSTED_DEVICES_FILE || '/data/trusted_devices.json';
const TRUST_ROTATE_INTERVAL_MS = 60 * 60 * 1000; // renovar como mucho una vez por hora
const TRUST_GRACE_MS = 2 * 60 * 1000;            // el viejo vale 2 min tras renovarlo
const REPLACED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // ventana para detectar un token copiado

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Registro: { expiresAt, createdAt, kind: 'web'|'mobile', used, replacedBy, graceUntil }
function loadTrustedTokens() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(TRUSTED_FILE, 'utf8'));
  } catch {
    return new Map();
  }
  const now = Date.now();
  const map = new Map();
  let migrated = 0;
  for (const [key, value] of Object.entries(raw || {})) {
    if (typeof value === 'number') {
      // Formato antiguo { token: expiresAt }: se pasa a huella sin cerrar la sesión.
      // No se sabe si era web o J2ME: se marca 'legacy' (no se renueva; vale hasta caducar).
      if (value > now) {
        map.set(hashToken(key), { expiresAt: value, createdAt: now, kind: 'legacy', used: true, replacedBy: null, graceUntil: 0 });
        migrated += 1;
      }
    } else if (value && typeof value === 'object' && value.expiresAt > now) {
      map.set(key, value);
    }
  }
  if (migrated > 0) {
    console.log(`[Auth] ${migrated} token(s) de confianza migrados a huella SHA-256.`);
    saveTrustedTokens(map);
  }
  return map;
}

function saveTrustedTokens(map) {
  try {
    const now = Date.now();
    for (const [hash, record] of map) {
      const replacedLongAgo = record.replacedBy && now - record.graceUntil > REPLACED_RETENTION_MS;
      if (record.expiresAt <= now || replacedLongAgo) map.delete(hash);
    }
    fs.writeFileSync(TRUSTED_FILE, JSON.stringify(Object.fromEntries(map.entries()), null, 2), 'utf8');
  } catch (e) {
    console.error('[Auth] No se pudo guardar trusted_devices.json:', e.message);
  }
}

// ── Almacenamiento en memoria ─────────────────────────────────────────────────
const sessions      = new Map();
const rateLimits    = new Map();
const trustedTokens = loadTrustedTokens(); // huella → registro

const SESSION_DURATION_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS        = 5;
const LOCK_DURATION_MS    = 10 * 60 * 1000;

// Límite GLOBAL de fallos, independiente de la IP. El límite por IP se puede saltar:
// getClientIp se fía del primer valor de X-Forwarded-For, que pone el propio cliente
// (el Gateway lo conserva y solo añade la IP real al final), así que un atacante podría
// inventarse una IP distinta en cada intento. Como solo hay un usuario, bloquear el
// login para todos durante un rato no molesta y no depende de ninguna cabecera.
// Solo afecta a iniciar sesión: quien ya tiene sesión o «Recordarme» sigue entrando.
const GLOBAL_MAX_FAILURES     = 10;
const GLOBAL_WINDOW_MS        = 10 * 60 * 1000;
const GLOBAL_LOCK_DURATION_MS = 15 * 60 * 1000;
let globalFailures = [];   // timestamps de los fallos dentro de la ventana
let globalLockUntil = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getClientIp(req) {
  const normalizeIp = (ip) => {
    if (!ip) return 'unknown';
    if (typeof ip !== 'string') return String(ip);
    // IPv4-mapped IPv6 addresses like ::ffff:172.19.0.1 -> strip prefix
    if (ip.startsWith('::ffff:')) return ip.slice(7);
    // Remove surrounding brackets for IPv6 if present
    if (ip.startsWith('[') && ip.endsWith(']')) return ip.slice(1, -1);
    return ip;
  };

  const forwarded = req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return normalizeIp(first.trim());
  }

  const remote = req.socket?.remoteAddress || req.connection?.remoteAddress || null;
  return normalizeIp(remote);
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

function isGloballyLocked() {
  if (globalLockUntil > Date.now()) return true;
  if (globalLockUntil) {
    globalLockUntil = 0;
    globalFailures = [];
    console.log('[Auth] Fin del bloqueo global de login.');
  }
  return false;
}

export function isRateLimited(ip) {
  if (isGloballyLocked()) return true;
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
  const now = Date.now();
  globalFailures = globalFailures.filter((t) => now - t < GLOBAL_WINDOW_MS);
  globalFailures.push(now);
  if (globalFailures.length >= GLOBAL_MAX_FAILURES && !isGloballyLocked()) {
    globalLockUntil = now + GLOBAL_LOCK_DURATION_MS;
    console.warn(
      `[Auth] BLOQUEO GLOBAL de login durante ${GLOBAL_LOCK_DURATION_MS / 60000} min: ` +
      `${globalFailures.length} PIN fallidos en ${GLOBAL_WINDOW_MS / 60000} min (último desde ${ip}).`
    );
  }

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
  globalFailures = [];
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

export function createTrustToken(kind = 'web') {
  const days = Number.parseInt(process.env.REMEMBER_DEVICE_DAYS || '30', 10);
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + days * 24 * 60 * 60 * 1000;
  trustedTokens.set(hashToken(token), { expiresAt, createdAt: now, kind, used: false, replacedBy: null, graceUntil: 0 });
  saveTrustedTokens(trustedTokens);
  console.log(`[Auth] Nuevo token de confianza (${kind}) creado por ${days} dias.`);
  return { token, days, expiresAt };
}

function getLiveRecord(hash) {
  const record = trustedTokens.get(hash);
  if (!record) return null;
  if (Date.now() > record.expiresAt) {
    trustedTokens.delete(hash);
    saveTrustedTokens(trustedTokens);
    return null;
  }
  return record;
}

// Marca el token como usado y, si venía migrado ('legacy'), fija su tipo según por dónde
// ha llegado (cookie → 'web', cabecera → 'mobile'). Solo escribe a disco si cambia algo.
function markUsed(record, kind) {
  let changed = false;
  if (record.kind === 'legacy') {
    record.kind = kind;
    changed = true;
  }
  if (!record.used) {
    record.used = true;
    changed = true;
  }
  if (changed) saveTrustedTokens(trustedTokens);
}

// Validación simple (cliente J2ME por cabecera): sin renovación. Un token web ya
// sustituido no vale por esta vía.
export function isValidTrustToken(token) {
  if (!token) return false;
  const record = getLiveRecord(hashToken(token));
  if (!record || record.replacedBy) return false;
  markUsed(record, 'mobile');
  return true;
}

// Sustituye `oldHash` por un token nuevo con la misma caducidad. Devuelve el token nuevo.
function rotate(oldHash, oldRecord) {
  const token = crypto.randomBytes(32).toString('hex');
  const newHash = hashToken(token);
  const now = Date.now();
  trustedTokens.set(newHash, {
    expiresAt: oldRecord.expiresAt, createdAt: now, kind: 'web', used: false, replacedBy: null, graceUntil: 0,
  });
  oldRecord.replacedBy = newHash;
  oldRecord.graceUntil = now + TRUST_GRACE_MS;
  saveTrustedTokens(trustedTokens);
  return { token, hash: newHash, expiresAt: oldRecord.expiresAt };
}

// Validación del token web (cookie trust_token), con renovación y detección de robo.
// `allowRotate`: solo en páginas (no en imágenes/media), que es donde el Nokia procesa
// la cookie nueva. Devuelve:
//   { ok: true, hash, newToken?, expiresAt? }   → acceso; si hay newToken, mandar cookie
//   { ok: false }                               → token inválido/caducado
//   { ok: false, theft: true }                  → token robado: ya se ha cerrado todo
export function useWebTrustToken(token, { allowRotate = false } = {}) {
  if (!token) return { ok: false };
  const hash = hashToken(token);
  const record = getLiveRecord(hash);
  if (!record) return { ok: false };

  if (record.replacedBy) {
    // Token ya sustituido.
    if (Date.now() < record.graceUntil) {
      // Peticiones que salieron antes de recibir la cookie nueva (p. ej. imágenes).
      return { ok: true, hash };
    }
    const successor = getLiveRecord(record.replacedBy);
    if (!successor) return { ok: false };
    if (!successor.used) {
      // El nuevo nunca llegó a usarse: el Nokia no guardó la cookie (respuesta perdida).
      // No es un robo: se descarta el nuevo y se emite otro.
      trustedTokens.delete(record.replacedBy);
      record.replacedBy = null;
      const rotated = rotate(hash, record);
      return { ok: true, hash: rotated.hash, newToken: rotated.token, expiresAt: rotated.expiresAt };
    }
    // El sustituto ya se usó y alguien vuelve con el viejo: copia del token.
    const closed = revokeAllSessions();
    console.warn(`[Auth] ROBO DE TOKEN detectado: se reutilizó un token ya renovado. Cerradas ${closed.tokens} sesión(es) recordada(s) y ${closed.sessions} sesión(es).`);
    return { ok: false, theft: true };
  }

  markUsed(record, 'web');
  const isWeb = record.kind === 'web';
  if (allowRotate && isWeb && Date.now() - record.createdAt >= TRUST_ROTATE_INTERVAL_MS) {
    const rotated = rotate(hash, record);
    return { ok: true, hash: rotated.hash, newToken: rotated.token, expiresAt: rotated.expiresAt };
  }
  return { ok: true, hash };
}

export function revokeTrustToken(token) {
  if (token) {
    trustedTokens.delete(hashToken(token));
    saveTrustedTokens(trustedTokens);
  }
}

// Cierra todas las sesiones y tokens «Recordarme», salvo los que se indiquen (la
// sesión actual de quien lo pide). Devuelve cuántos se han cerrado.
export function revokeAllSessions({ keepSessionId = null, keepTrustHash = null } = {}) {
  // Se conserva el token actual y, si se está renovando, también su sustituto (el Nokia
  // puede tener ya guardada la cookie nueva).
  const keep = new Set();
  if (keepTrustHash && trustedTokens.has(keepTrustHash)) {
    keep.add(keepTrustHash);
    const successor = trustedTokens.get(keepTrustHash).replacedBy;
    if (successor) keep.add(successor);
  }
  let tokens = 0;
  for (const hash of [...trustedTokens.keys()]) {
    if (keep.has(hash)) continue;
    trustedTokens.delete(hash);
    tokens += 1;
  }
  saveTrustedTokens(trustedTokens);

  let sessionsClosed = 0;
  for (const id of [...sessions.keys()]) {
    if (id === keepSessionId) continue;
    sessions.delete(id);
    sessionsClosed += 1;
  }
  return { tokens, sessions: sessionsClosed };
}
