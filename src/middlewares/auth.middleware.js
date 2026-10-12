import { getClientIp, isValidSession, isValidTrustToken } from '../services/auth.service.js';

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    list[name] = rest.join('=').trim();
  });
  return list;
}

function wapDeny(req, res) {
  const contentType = 'text/html; charset=UTF-8';
  const page = `<!DOCTYPE html PUBLIC "-//WAPFORUM//DTD XHTML Mobile 1.0//EN" "http://www.wapforum.org/DTD/xhtml-mobile10.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Acceso</title>
  <meta http-equiv="Content-Type" content="${contentType}"/>
  <meta http-equiv="refresh" content="0; url=/login" />
</head>
<body><p>Identificandose...</p></body></html>`;
  res.status(200);
  res.set({ 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  return res.send(page);
}

// Última vez que el Nokia cargó una página autenticada — usado para saber si "sigue en la
// web" y así no mandarle un SMS de aviso que ya es redundante.
let lastActivityAt = 0;

export function getLastActivityAt() {
  return lastActivityAt;
}

export function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId  = cookies['session_id'];
  const trustToken = cookies['trust_token'];
  const ip = getClientIp(req);

  // 1. Sesión activa válida
  if (sessionId && isValidSession(sessionId, ip)) {
    lastActivityAt = Date.now();
    return next();
  }

  // 2. Token de "Recordarme" de larga duración (no depende de la IP)
  if (isValidTrustToken(trustToken)) {
    lastActivityAt = Date.now();
    return next();
  }

  // 3. Mismo token de "Recordarme", enviado como header en vez de cookie — así el
  // cliente Java2ME (sin cookie jar) puede reutilizar /media y /descargar/:file con
  // el token que ya recibió de POST /mobile/login.
  if (isValidTrustToken(req.headers['x-nokia-token'])) {
    lastActivityAt = Date.now();
    return next();
  }

  console.log(`[Auth] Acceso denegado en ${req.originalUrl} desde ${ip}`);
  return wapDeny(req, res);
}

// Auth para la API JSON /mobile: solo el token largo de "Recordarme", enviado por
// header (nunca por cookie) — el MIDlet no tiene concepto de sesión corta atada a IP.
// A diferencia de requireAuth, en fallo responde JSON 401, no la página XHTML de
// wapDeny (pensada para el navegador WAP, no para un cliente que parsea JSON).
export function requireMobileAuth(req, res, next) {
  const token = req.headers['x-nokia-token'];

  if (isValidTrustToken(token)) {
    lastActivityAt = Date.now();
    return next();
  }

  return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Token invalido o caducado' } });
}
