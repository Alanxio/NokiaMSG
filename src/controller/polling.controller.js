import { getConnectionStatus } from '../services/whatsapp.service.js';
import { getPollingState, limpiarNovedad } from '../services/polling.service.js';
import { sendXhtmlFrame } from './page.controller.js';

export function checkAuthStatus(req, res, next) {
  const status = getConnectionStatus();

  if (status.status === 'connected' || status.status === 'authenticated') {
    return sendXhtmlFrame(res, 0, '/');
  }
  return sendXhtmlFrame(res, 5);
}

export function checkMessages(req, res, next) {
  const { huboNovedad } = getPollingState();

  if (huboNovedad) {
    limpiarNovedad();
    return sendXhtmlFrame(res, 1, '/', '/sounds/msn_alert.amr');
  }
  return sendXhtmlFrame(res, 15);
}