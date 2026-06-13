import { getQrText, getConnectionStatus, logoutWhatsapp } from '../services/whatsapp.service.js';
import { sendPage } from './page.controller.js';

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

  if (status.status === 'waiting_qr' && getQrText()) {
    return sendPage(req, res, 200, 'QR WhatsApp',
      '<meta http-equiv="refresh" content="3; url=/whatsapp/qr"/>' +
      '<div style="text-align:center">' +
      '<img src="/assets/qr.png" alt="QR" width="100" height="100" style="border:0;display:block;margin:0 auto"/>' +
      '</div>' +
      '<p style="margin:2px 0;text-align:center;font-size:10px">Escanea con WhatsApp</p>' +
      '<p style="text-align:center"><a href="/">Volver al Inicio</a></p>');
  }

  const loadingLabels = {
    connecting: 'Conectando...',
    reconnecting: 'Reconectando...',
    waiting_qr: 'Generando QR...',
    disconnected: 'Desconectado',
  };
  const loadingLabel = loadingLabels[status.status] || 'Inicializando...';

  return sendPage(req, res, 200, 'WhatsApp',
    `<meta http-equiv="refresh" content="3; url=/whatsapp/qr"/>` +
    `<p><b>${loadingLabel}</b></p><p>Espere...</p>`);
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
