// Avisos por SMS de seguridad. El 6111 no admite HTTPS moderno y el PIN puede viajar en
// claro por la entrada HTTP: si alguien lo copia, la defensa es enterarse en cuanto lo use.
// El aviso incluye la ubicación aproximada y la operadora de la IP (ver geoip.service.js).
//
// Siempre en UN solo SMS (160 caracteres GSM-7): si se parte en trozos, el 6111 a veces
// pierde alguno y muestra «Falta texto». Si no cabe, se recorta por orden de importancia.
import { sendSecurityAlertSms } from './sms-notification.service.js';
import { isPublicIp, lookupIpLocation } from './geoip.service.js';

const SMS_MAX = 160;

function nowLabel() {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
}

// Los SMS van en GSM-7 mientras no haya letras fuera de ese alfabeto; una sola «á» u «ó»
// los pasa a UCS-2 (70 caracteres por trozo). GSM-7 sí tiene ñ, Ñ, é, É, ü, Ü, à, è, ì,
// ò, ù, ¿ y ¡: se conservan y el resto de acentos se quitan.
const GSM7_KEEP = new Set(['ñ', 'Ñ', 'é', 'É', 'ü', 'Ü', 'à', 'è', 'ì', 'ò', 'ù', '¿', '¡']);
function toGsm7(text) {
  return [...String(text)].map((ch) => (GSM7_KEEP.has(ch) ? ch : ch.normalize('NFD').replace(/[̀-ͯ]/g, ''))).join('');
}

// IPv6 larga → sus 4 primeros bloques («2a0c:5a84:9300:5500::»); IPv4 se queda igual.
function shortIp(ip) {
  const clean = String(ip).replace(/^::ffff:/, '');
  if (!clean.includes(':')) return clean;
  return `${clean.split(':').slice(0, 4).join(':')}::`;
}

// «Digi Spain Telecom S.A» → «Digi Spain»; «Telefónica de España…» → «Telefónica» (sin
// dejar colgando «de», «la», «del»…).
const DANGLING = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'of', 'the', 'and']);
function shortIsp(isp) {
  if (!isp) return null;
  const words = isp.replace(/[,.]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2);
  while (words.length > 1 && DANGLING.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ');
}

// Variantes del origen, de la más completa a la más corta.
async function originVariants(ip, tls) {
  if (!isPublicIp(ip)) {
    return [tls ? 'IP oculta (HTTPS)' : `IP local ${ip}`];
  }
  const loc = await lookupIpLocation(ip);
  const fullIp = String(ip).replace(/^::ffff:/, '');
  if (!loc) return [`IP ${fullIp}`, `IP ${shortIp(ip)}`];
  const cityCountry = [loc.city, loc.country].filter((p, i, all) => p && all.indexOf(p) === i).join(', ');
  const isp = loc.isp;
  const ispShort = shortIsp(isp);
  const withIsp = (place, provider) => (provider ? `${place} (${provider})` : place);
  return [
    `${withIsp(loc.place, isp)} IP ${fullIp}`,
    `${withIsp(loc.place, isp)} IP ${shortIp(ip)}`,
    `${withIsp(loc.place, ispShort)} IP ${shortIp(ip)}`,
    withIsp(loc.place, ispShort),
    withIsp(cityCountry, ispShort),
    cityCountry || loc.place,
  ].filter(Boolean).map(toGsm7);
}

// Primera combinación (origen × cierre) que cabe en un SMS.
function fit(head, origins, tails) {
  for (const tail of tails) {
    for (const origin of origins) {
      const text = toGsm7(`${head}${origin}${tail}`);
      if (text.length <= SMS_MAX) return text;
    }
  }
  return toGsm7(`${head}${origins[origins.length - 1]}${tails[tails.length - 1]}`).slice(0, SMS_MAX);
}

async function send(buildText) {
  try {
    await sendSecurityAlertSms(await buildText());
  } catch (err) {
    console.error('[Seguridad] No se pudo enviar la alerta SMS:', err?.message || err);
  }
}

// via: 'web' | 'J2ME'; tls: la petición llegó cifrada por nokia-tls.
export function alertNewLogin({ ip, via, remember = false, tls = false }) {
  const when = nowLabel();
  send(async () => fit(
    `NokiaMSN: login ${via}${tls ? ' HTTPS' : ''}${remember ? ' recordado' : ''} ${when} desde `,
    await originVariants(ip, tls),
    ['. ¿No eras tu? Cambia el PIN y cierra sesiones en Ajustes.', '. ¿No eras tu? Cambia el PIN.'],
  ));
}

export function alertTokenTheft({ ip, tls = false }) {
  const when = nowLabel();
  send(async () => fit(
    `NokiaMSN ALERTA: sesion copiada ${when} desde `,
    await originVariants(ip, tls),
    ['. Sesiones cerradas; entra con el PIN y cambialo.', '. Sesiones cerradas.'],
  ));
}

// Solo para pruebas.
export const _test = { fit, originVariants, shortIp, shortIsp, toGsm7 };
