import fs from 'fs';
import { sendPage } from './page.controller.js';
import { startDailyCleanup, stopDailyCleanup } from '../services/cleanup.service.js';
import { SETTINGS_ENV_PATH } from '../utils/settings-env.js';
import { revokeAllSessions } from '../services/auth.service.js';
import { getTwilioMissingConfig } from '../services/sms-notification.service.js';

const envPath = SETTINGS_ENV_PATH;
const CLEANUP_RETENTION_OPTIONS = [
  { value: '1', label: '1 día' },
  { value: '3', label: '3 días' },
  { value: '5', label: '5 días' },
  { value: '15', label: '15 días' },
  { value: '30', label: '30 días' },
  { value: 'never', label: 'Nunca' },
];

function updateEnvVariables(updates) {
  let envContent = fs.readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
    // Actualizar en memoria para que surta efecto sin reiniciar Docker
    process.env[key] = value;
  }
  fs.writeFileSync(envPath, envContent, 'utf8');
}

// Misma estética que Detalles de usuario/grupo: navegación pequeña arriba, título
// centrado, <hr/> y bloques con el título en negrita, el estado actual en color y una
// explicación corta en pequeño y gris.
const STATE_ON = '<font color="#008800">activado</font>';
const STATE_OFF = '<font color="#cc0000">desactivado</font>';
const HINT = (text) => `<br/><font size="1" color="#888888">${text}</font>`;
const SMS_ICON = (file, alt) =>
  `<img src="/assets/${file}" width="12" height="12" alt="${alt}" style="vertical-align:middle;"/>`;

function renderSettingBlock(title, stateHtml, controlHtml, hint) {
  return `<p><b>${title}:</b> ${stateHtml}<br/>${controlHtml}${hint ? HINT(hint) : ''}</p>`;
}

export function showSettings(req, res, next) {
  const smsCurrent = process.env.SMS_NOTIFICATIONS_ENABLED === 'true' ? 'true' : 'false';
  const smsChecked = smsCurrent === 'true' ? ' checked="checked"' : '';
  // Avisos del gateway: activados salvo que se hayan quitado expresamente.
  const gatewayAlertsOn = process.env.SMS_GATEWAY_ALERTS_ENABLED !== 'false';
  const gatewayChecked = gatewayAlertsOn ? ' checked="checked"' : '';
  const readReceiptsCurrent = process.env.SEND_READ_RECEIPTS_ENABLED === 'true' ? 'true' : 'false';
  const readReceiptsChecked = readReceiptsCurrent === 'true' ? ' checked="checked"' : '';
  const cleanupValue = process.env.DAILY_CLEANUP_ENABLED === 'false'
    ? 'never'
    : process.env.MESSAGE_RETENTION_DAYS || process.env.RETENTION_DAYS || '3';
  const cleanupOptionsHtml = CLEANUP_RETENTION_OPTIONS
    .map((option) => {
      const selected = option.value === cleanupValue ? ' selected="selected"' : '';
      return `<option value="${option.value}"${selected}>${option.label}</option>`;
    })
    .join('');
  const cleanupLabel = CLEANUP_RETENTION_OPTIONS.find((o) => o.value === cleanupValue)?.label || '3 días';

  // Dos casillas con icono en vez de texto: sobre = mensajes y llamadas, campana = avisos
  // del gateway. Si alguna está activa pero falta Twilio, no saldría ninguno: se avisa.
  const twilioMissing = getTwilioMissingConfig();
  const activeCount = (smsCurrent === 'true' ? 1 : 0) + (gatewayAlertsOn ? 1 : 0);
  let smsState = activeCount === 2 ? STATE_ON : activeCount === 1 ? '<font color="#cc6600">en parte</font>' : STATE_OFF;
  if (activeCount > 0 && twilioMissing.length > 0) {
    smsState = '<font color="#cc6600">sin configurar</font>';
  }
  // Sin descripciones; solo se avisa si falta configurar Twilio (no saldría ningún SMS).
  const smsHint = twilioMissing.length > 0 ? `Falta en el servidor: ${twilioMissing.join(', ')}` : null;
  const smsControls =
    `<input type="checkbox" name="sms" value="true"${smsChecked}/>${SMS_ICON('Mail.png', 'Mensajes')}` +
    '&#160;&#160;&#160;' +
    `<input type="checkbox" name="gatewayAlerts" value="true"${gatewayChecked}/>${SMS_ICON('Notification.png', 'Avisos del gateway')}`;

  const cleanupState = cleanupValue === 'never'
    ? '<font color="#888888">nunca</font>'
    : `<font color="#000099">${cleanupLabel}</font>`;

  const body =
    '<p><font size="1"><a href="/">Inicio</a></font></p>' +
    '<p align="center"><b>Ajustes</b></p>' +
    '<hr/>' +
    '<form action="/ajustes" method="post">' +
    `<input type="hidden" name="sms_current" value="${smsCurrent}"/>` +
    `<input type="hidden" name="read_receipts_current" value="${readReceiptsCurrent}"/>` +
    renderSettingBlock('Avisos SMS', smsState, smsControls, smsHint) +
    renderSettingBlock(
      'Ticks azules',
      readReceiptsCurrent === 'true' ? STATE_ON : STATE_OFF,
      `<input type="checkbox" name="readReceipts" value="true"${readReceiptsChecked}/> Activar`,
    ) +
    renderSettingBlock(
      'Borrado automático',
      cleanupState,
      `<select name="messageRetentionDays">${cleanupOptionsHtml}</select>`,
    ) +
    '<p><input type="submit" value="Guardar"/></p>' +
    '</form>' +
    '<hr/>' +
    '<p><b>Sesión:</b><br/>' +
    '- <a href="/logout">Cerrar sesión</a><br/>' +
    '- <a href="/ajustes/cerrar-sesiones">Cerrar las demás</a></p>' +
    '<p><b>Servidor:</b><br/>' +
    '- <a href="/estado">Estado del servidor</a></p>' +
    '<p><b>WhatsApp:</b><br/>' +
    '- <a href="/whatsapp/logout"><font color="#cc0000">Cerrar sesión de WhatsApp</font></a></p>' +
    '<hr/>' +
    '<p><font size="1"><a href="/">Inicio</a></font></p>';
  sendPage(req, res, 200, 'Ajustes', body);
}

export function saveSettings(req, res, next) {
  const { sms, gatewayAlerts, readReceipts, messageRetentionDays } = req.body;
  const newSmsEnabled = sms === 'true' ? 'true' : 'false';
  const newGatewayAlertsEnabled = gatewayAlerts === 'true' ? 'true' : 'false';
  const newReadReceiptsEnabled = readReceipts === 'true' ? 'true' : 'false';
  const isCleanupDisabled = messageRetentionDays === 'never';
  const allowedCleanupValues = new Set(CLEANUP_RETENTION_OPTIONS.map((option) => option.value));
  const safeRetentionValue =
    typeof messageRetentionDays === 'string' && allowedCleanupValues.has(messageRetentionDays)
      ? messageRetentionDays
      : '3';

  updateEnvVariables({
    SMS_NOTIFICATIONS_ENABLED: newSmsEnabled,
    SMS_GATEWAY_ALERTS_ENABLED: newGatewayAlertsEnabled,
    SEND_READ_RECEIPTS_ENABLED: newReadReceiptsEnabled,
    DAILY_CLEANUP_ENABLED: isCleanupDisabled ? 'false' : 'true',
    MESSAGE_RETENTION_DAYS: isCleanupDisabled ? (process.env.MESSAGE_RETENTION_DAYS || '3') : safeRetentionValue,
  });

  stopDailyCleanup();
  if (!isCleanupDisabled) {
    startDailyCleanup();
  }

  const cleanupLabel = CLEANUP_RETENTION_OPTIONS.find(
    (option) => option.value === (isCleanupDisabled ? 'never' : safeRetentionValue)
  )?.label || '3 días';

  return sendPage(req, res, 200, 'Guardado',
    '<p align="center"><b><font color="#008800">Ajustes guardados</font></b></p>' +
    '<hr/>' +
    `<p>${SMS_ICON('Mail.png', 'Mensajes')} <b>SMS mensajes:</b> ${newSmsEnabled === 'true' ? STATE_ON : STATE_OFF}<br/>` +
    `${SMS_ICON('Notification.png', 'Gateway')} <b>SMS gateway:</b> ${newGatewayAlertsEnabled === 'true' ? STATE_ON : STATE_OFF}<br/>` +
    `<b>Ticks azules:</b> ${newReadReceiptsEnabled === 'true' ? STATE_ON : STATE_OFF}<br/>` +
    `<b>Borrado:</b> ${isCleanupDisabled ? 'nunca' : cleanupLabel}</p>` +
    '<hr/>' +
    '<p><font size="1" color="#888888">Volviendo...</font> <font size="1"><a href="/ajustes">Ajustes</a> | <a href="/">Inicio</a></font></p>',
    '<meta http-equiv="refresh" content="2; url=/"/>');
}

// «Cerrar las demás sesiones»: anula todos los «Recordarme» y sesiones salvo la actual.
// Confirmación con formulario POST (no un enlace GET, para que no se pueda disparar
// desde otra página o al precargar enlaces).
export function confirmCloseSessions(req, res) {
  const body =
    '<p><font size="1"><a href="/">Inicio</a> | <a href="/ajustes">Ajustes</a></font></p>' +
    '<p align="center"><b>Sesiones</b></p>' +
    '<hr/>' +
    '<p>Se cerrarán todas las sesiones abiertas menos esta.' +
    HINT('Otros móviles, navegadores o un «Recordarme» copiado.') + '</p>' +
    '<form action="/ajustes/cerrar-sesiones" method="post">' +
    '<p><input type="submit" value="Cerrar las demás"/></p>' +
    '</form>' +
    '<p><font size="1"><a href="/ajustes">Cancelar</a></font></p>';
  sendPage(req, res, 200, 'Sesiones', body);
}

export function closeOtherSessions(req, res) {
  const closed = revokeAllSessions({
    keepSessionId: req.auth?.sessionId || null,
    keepTrustHash: req.auth?.trustHash || null,
  });
  console.log(`[Auth] Cerradas las demás sesiones: ${closed.tokens} recordada(s), ${closed.sessions} sesión(es).`);
  const total = closed.tokens + closed.sessions;
  sendPage(req, res, 200, 'Sesiones',
    `<p align="center"><b><font color="#008800">${total} sesión${total === 1 ? '' : 'es'} cerrada${total === 1 ? '' : 's'}</font></b></p>` +
    '<hr/>' +
    '<p>Esta sigue abierta.</p>' +
    '<p><font size="1"><a href="/ajustes">Volver a Ajustes</a></font></p>',
    '<meta http-equiv="refresh" content="3; url=/ajustes"/>');
}
