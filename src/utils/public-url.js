// URLs absolutas que se mandan al Nokia (descriptores .dd, enlaces de los SMS).
//
// Hay dos formas de entrar:
//   · HTTP en claro, por el túnel HTTP de ngrok → Gateway → app.
//   · HTTPS (TLS 1.0), por el túnel TCP de ngrok → nokia-tls → Gateway → app. nokia-tls
//     marca la petición con «X-Nokia-TLS: 1» y pone en X-Forwarded-Host la dirección
//     pública «host:puerto».
// La dirección TCP de ngrok cambia en cada arranque: expose.sh la escribe en
// /data/tls/public-address y aquí se lee (con caché por fecha de modificación).
import fs from 'node:fs';
import path from 'node:path';

const PUBLIC_ADDRESS_FILE = path.join(path.dirname(process.env.DB_PATH || '/data/nokia.db'), 'tls', 'public-address');
let cached = { mtimeMs: -1, value: null };

// «host:puerto» de la entrada HTTPS actual, o null si no hay túnel TLS.
export function getPublicTlsAddress() {
  try {
    const { mtimeMs } = fs.statSync(PUBLIC_ADDRESS_FILE);
    if (mtimeMs !== cached.mtimeMs) {
      const value = fs.readFileSync(PUBLIC_ADDRESS_FILE, 'utf8').trim();
      cached = { mtimeMs, value: /^[a-z0-9.-]+:\d{1,5}$/i.test(value) ? value : null };
    }
    return cached.value;
  } catch {
    cached = { mtimeMs: -1, value: null };
    return null;
  }
}

export function getPublicTlsBaseUrl() {
  const address = getPublicTlsAddress();
  return address ? `https://${address}` : null;
}

// La petición llegó cifrada por nokia-tls.
export function isTlsRequest(req) {
  return req?.headers?.['x-nokia-tls'] === '1';
}

// Base para URLs absolutas que el Nokia va a pedir a continuación, por la misma vía por
// la que ha entrado. OJO: no usar X-Forwarded-Proto: el Gateway lo fija a «https» en
// todas las peticiones, incluso las que llegan por HTTP en claro.
export function getRequestBaseUrl(req) {
  const first = (value) => String(value || '').split(',')[0].trim();
  const host = first(req.headers['x-forwarded-host']) || req.headers.host;
  return `${isTlsRequest(req) ? 'https' : 'http'}://${host}`;
}

// Atributo «; Secure» para cookies emitidas en una petición HTTPS: así nunca viajan por
// la entrada en claro.
export function secureCookieSuffix(req) {
  return isTlsRequest(req) ? '; Secure' : '';
}
