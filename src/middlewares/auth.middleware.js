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

  console.log(`[Auth] Acceso denegado en ${req.originalUrl} desde ${ip}`);
  return wapDeny(req, res);
}
