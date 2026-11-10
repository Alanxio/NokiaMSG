import qrcode from 'qrcode';
import {
  getQrText,
  getQrVersion,
  getConnectionStatus,
  getPairingPhone,
  getPairingState,
  requestWhatsappPairingCode,
  logoutWhatsapp,
} from '../services/whatsapp.service.js';
import { sendPage, escapeXml } from './page.controller.js';

// El Nokia 6111 no tiene JS: la única forma de que la página cambie sola es un
// meta refresh. Para que no recargue a ciegas cada X segundos, el refresh apunta a
// /whatsapp/qr/wait, que el servidor deja colgado hasta que cambie algo (QR nuevo,
// sesión iniciada, cambio de estado) o pase QR_WAIT_MS. Mientras tanto el móvil
// sigue mostrando el QR.
const QR_WAIT_MS = 25_000;
const QR_WAIT_CHECK_MS = 500;
// Segundos antes de lanzar la espera: deja que el móvil termine de bajar la imagen.
const QR_REFRESH_DELAY_S = 2;

function isLoggedIn(status) {
  return status === 'connected' || status === 'authenticated';
}

// Huella de lo que muestra la página: si cambia, hay que recargarla.
function currentStateKey() {
  return `${getConnectionStatus().status}.${getQrVersion()}`;
}

function waitRefreshMeta() {
  const url = `/whatsapp/qr/wait?k=${encodeURIComponent(currentStateKey())}`;
  return `<meta http-equiv="refresh" content="${QR_REFRESH_DELAY_S}; url=${url}"/>`;
}

export function showQrPage(req, res) {
  const status = getConnectionStatus();

  if (status.status === 'connected') {
    return sendPage(req, res, 200, 'Conectado',
      '<meta http-equiv="refresh" content="0; url=/"/>' +
      '<p><b>Conectado</b></p><p>Redirigiendo...</p>');
  }

  if (status.status === 'authenticated') {
    return sendPage(req, res, 200, 'WhatsApp',
      '<meta http-equiv="refresh" content="0; url=/"/>' +
      '<p><b>Autenticado</b></p><p>Redirigiendo al inicio...</p>');
  }

  const pairing = getPairingState();
  if (status.status === 'waiting_qr' && pairing.active) {
    return sendPairingCodePage(req, res, pairing);
  }

  if (status.status === 'waiting_qr' && getQrText()) {
    const codeLink = getPairingPhone()
      ? '<p style="text-align:center"><a href="/whatsapp/qr/codigo">Vincular con codigo</a></p>'
      : '';
    return sendPage(req, res, 200, 'QR WhatsApp',
      waitRefreshMeta() +
      '<div style="text-align:center">' +
      `<img src="/whatsapp/qr/img/${getQrVersion()}.png" alt="QR" width="100" height="100" style="border:0;display:block;margin:0 auto"/>` +
      '</div>' +
      '<p style="margin:2px 0;text-align:center;font-size:10px">Escanea con WhatsApp</p>' +
      codeLink +
      '<p style="text-align:center"><a href="/whatsapp/qr">Actualizar</a> | <a href="/">Inicio</a></p>');
  }

  const loadingLabels = {
    connecting: 'Conectando...',
    reconnecting: 'Reconectando...',
    waiting_qr: 'Generando QR...',
    disconnected: 'Desconectado',
  };
  const loadingLabel = loadingLabels[status.status] || 'Inicializando...';

  return sendPage(req, res, 200, 'WhatsApp',
    waitRefreshMeta() +
    `<p><b>${loadingLabel}</b></p><p>Espere...</p>` +
    '<p><a href="/whatsapp/qr">Actualizar</a> | <a href="/">Inicio</a></p>');
}

// "ABCD1234" -> "ABCD-1234", como lo enseña WhatsApp.
function formatPairingCode(code) {
  const clean = String(code).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

function sendPairingCodePage(req, res, pairing) {
  const phone = getPairingPhone();
  let body;
  if (pairing.code) {
    body =
      '<p style="text-align:center;font-size:10px">Codigo de vinculacion:</p>' +
      `<p style="text-align:center;font-size:large"><b>${escapeXml(formatPairingCode(pairing.code))}</b></p>` +
      '<p style="margin:2px 0;text-align:center;font-size:10px">' +
      'WhatsApp &gt; Dispositivos vinculados &gt; Vincular con numero de telefono</p>' +
      `<p style="margin:2px 0;text-align:center;font-size:10px">Numero: +${escapeXml(phone)}</p>`;
  } else if (pairing.error) {
    body =
      `<p><b>${escapeXml(pairing.error)}</b></p>` +
      '<p><a href="/whatsapp/qr/codigo">Reintentar</a></p>';
  } else {
    body = '<p><b>Pidiendo codigo...</b></p><p>Espere...</p>';
  }

  return sendPage(req, res, 200, 'Codigo WhatsApp',
    waitRefreshMeta() + body +
    '<p style="text-align:center"><a href="/whatsapp/qr">Actualizar</a> | <a href="/">Inicio</a></p>');
}

// Pasa a vinculación por código y vuelve a la página, que enseña el código en
// cuanto llega (la espera larga la recarga sola).
export function requestPairingCodePage(req, res) {
  if (!getPairingPhone()) {
    return sendPage(req, res, 400, 'WhatsApp',
      '<p>Falta WHATSAPP_PAIRING_PHONE en .env.</p><p><a href="/whatsapp/qr">Volver</a></p>');
  }
  if (getConnectionStatus().status === 'waiting_qr') {
    requestWhatsappPairingCode().catch(() => {});
  }
  res.set('Cache-Control', 'no-store');
  return res.redirect(302, '/whatsapp/qr');
}

// Espera larga: responde (redirección) solo cuando hay algo nuevo que enseñar.
export function waitQrChange(req, res) {
  const shownKey = String(req.query.k || '');
  const deadline = Date.now() + QR_WAIT_MS;
  let timer = null;

  res.on('close', () => clearTimeout(timer));

  const check = () => {
    if (res.writableEnded || res.destroyed) return;

    const { status } = getConnectionStatus();
    let target = null;
    if (isLoggedIn(status)) target = '/';
    else if (currentStateKey() !== shownKey || Date.now() >= deadline) target = '/whatsapp/qr';

    if (!target) {
      timer = setTimeout(check, QR_WAIT_CHECK_MS);
      return;
    }

    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.redirect(302, target);
  };

  check();
}

// Imagen del QR con la versión en la URL: cada QR tiene su propia dirección, así
// que el móvil puede guardarla en caché y solo la descarga cuando el QR cambia.
let qrImageCache = { version: -1, buffer: null };

export async function serveQrImage(req, res, next) {
  const match = /^(\d+)\.png$/.exec(req.params.file || '');
  const version = getQrVersion();
  const qr = getQrText();

  if (!match || Number(match[1]) !== version || !qr) {
    res.set('Cache-Control', 'no-store');
    return res.status(404).end();
  }

  try {
    if (qrImageCache.version !== version) {
      const buffer = await qrcode.toBuffer(qr, {
        type: 'png',
        width: 100,
        margin: 1,
        errorCorrectionLevel: 'L',
        color: { dark: '#000000', light: '#ffffff' },
      });
      qrImageCache = { version, buffer };
    }
  } catch (err) {
    return next(err);
  }

  res.set({
    'Content-Type': 'image/png',
    'Cache-Control': 'private, max-age=600',
  });
  res.send(qrImageCache.buffer);
}

export function getQrApi(req, res) {
  const status = getConnectionStatus();
  res.json({ ...status, hasQr: getQrText() !== null });
}

export function getStatusApi(req, res) {
  res.json(getConnectionStatus());
}

export async function logoutWhatsappPage(req, res) {
  await logoutWhatsapp();

  return sendPage(req, res, 200, 'WhatsApp',
    '<meta http-equiv="refresh" content="0; url=/"/>' +
    '<p><b>Sesion de WhatsApp cerrada.</b></p><p>Volviendo...</p>');
}
