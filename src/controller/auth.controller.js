import bcrypt from 'bcryptjs';
import {
  getClientIp,
  isRateLimited,
  recordFailedAttempt,
  resetAttempts,
  createSession,
  destroySession,
  createTrustToken,
  revokeTrustToken
} from '../services/auth.service.js';
import { sendPage, isOperaMini } from './page.controller.js';

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

export function showLogin(req, res) {
  const body = `
    <h1>Nokia</h1>
    <form action="/login" method="post">
      <p>PIN:</p>
      <input type="number" name="pin" format="*N" style="-wap-input-format: '*N';" inputmode="numeric" pattern="[0-9]*" emptyok="false" /><input type="checkbox" name="remember" value="yes" /><small>Recordarme</small>
      <br/>
      <input type="submit" value="Entrar" />
    </form>
  `;
  sendPage(req, res, 200, 'Login', body);
}

export async function processLogin(req, res, next) {
  const ip = getClientIp(req);

  if (isRateLimited(ip)) {
    return sendPage(req, res, 200, 'Bloqueado', '<p>Demasiados intentos. Espera unos minutos.</p>');
  }

  const { pin, remember } = req.body;
  const hash = process.env.ACCESS_PIN_HASH_BCRYPT;

  if (!hash) {
    console.error('[Auth] ERROR CRITICO: No hay ACCESS_PIN_HASH_BCRYPT en .env');
    return sendPage(req, res, 200, 'Error', '<p>Sistema mal configurado</p>');
  }

  if (!pin) {
    recordFailedAttempt(ip);
    const body = `
      <h1>Nokia</h1>
      <form action="/login" method="post">
        <p>PIN:</p>
        <input type="number" name="pin" format="*N" style="-wap-input-format: '*N';" inputmode="numeric" pattern="[0-9]*" emptyok="false" /><input type="checkbox" name="remember" value="yes" /><small>Recordarme</small>
        <br/>
        <input type="submit" value="Entrar" />
      </form>
    `;
    return sendPage(req, res, 200, 'Login', body);
  }

  try {
    const isValid = await bcrypt.compare(pin, hash);

    if (isValid) {
      resetAttempts(ip);
      const sessionId = createSession(ip);

      // Cookie de sesión corta (15 min)
      const cookies = [`session_id=${sessionId}; HttpOnly; Max-Age=900; Path=/`];

      // Cookie de larga duración si marcó "Recordarme"
      if (remember === 'yes') {
        const { token, days } = createTrustToken();
        const maxAge = days * 24 * 60 * 60;
        cookies.push(`trust_token=${token}; HttpOnly; Max-Age=${maxAge}; Path=/`);
      }

      res.setHeader('Set-Cookie', cookies);
      console.log(`[Auth] Login exitoso desde ${ip} (recordar=${remember === 'yes'})`);

      // Saltar a inicio usando meta-refresh (sin código 3xx que el Nokia rechaza)
      const contentType = isOperaMini(req)
        ? 'text/html; charset=UTF-8'
        : 'application/vnd.wap.xhtml+xml; charset=UTF-8';

      const page = `<!DOCTYPE html PUBLIC "-//WAPFORUM//DTD XHTML Mobile 1.0//EN" "http://www.wapforum.org/DTD/xhtml-mobile10.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>Cargando</title>
  <meta http-equiv="refresh" content="0; url=/" />
</head>
<body><p>Entrando...</p></body></html>`;

      res.status(200);
      res.set({ 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      return res.send(page);

    } else {
      recordFailedAttempt(ip);
      return sendPage(req, res, 200, 'Error PIN', '<p>PIN incorrecto</p><br/><a href="/login">Volver</a>');
    }
  } catch (err) {
    next(err);
  }
}

export function processLogout(req, res) {
  const cookies = parseCookies(req.headers.cookie);

  if (cookies['session_id']) destroySession(cookies['session_id']);
  if (cookies['trust_token']) revokeTrustToken(cookies['trust_token']);

  // Borrar ambas cookies del Nokia
  res.setHeader('Set-Cookie', [
    'session_id=; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
    'trust_token=; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'
  ]);
  return sendPage(req, res, 200, 'Adios', '<p>Sesion cerrada.</p><br/><a href="/login">Identificarse</a>');
}
