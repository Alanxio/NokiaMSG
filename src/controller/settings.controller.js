import fs from 'fs';
import path from 'path';
import { sendPage } from './page.controller.js';
import { startDailyCleanup, stopDailyCleanup } from '../services/cleanup.service.js';

const envPath = process.env.ENV_FILE_PATH || path.resolve(process.cwd(), '.env');
const CLEANUP_RETENTION_OPTIONS = [
  { value: '1', label: '1 dia' },
  { value: '3', label: '3 dias' },
  { value: '5', label: '5 dias' },
  { value: '15', label: '15 dias' },
  { value: '30', label: '30 dias' },
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

export function showSettings(req, res, next) {
  const smsCurrent = process.env.SMS_NOTIFICATIONS_ENABLED === 'true' ? 'true' : 'false';
  const smsChecked = smsCurrent === 'true' ? 'checked="checked"' : '';
  const readReceiptsCurrent = process.env.SEND_READ_RECEIPTS_ENABLED === 'true' ? 'true' : 'false';
  const readReceiptsChecked = readReceiptsCurrent === 'true' ? 'checked="checked"' : '';
  const cleanupValue = process.env.DAILY_CLEANUP_ENABLED === 'false'
    ? 'never'
    : process.env.MESSAGE_RETENTION_DAYS || '3';
  const cleanupOptionsHtml = CLEANUP_RETENTION_OPTIONS
    .map((option) => {
      const selected = option.value === cleanupValue ? ' selected="selected"' : '';
      return `<option value="${option.value}"${selected}>${option.label}</option>`;
    })
    .join('');

  const body = `
    <h1>Ajustes</h1>
    <a href="/">Volver al Inicio</a>
    <br/><br/>
    <form action="/ajustes" method="post">
      <p>Notificaciones SMS:</p>
      <input type="hidden" name="sms_current" value="${smsCurrent}" /><input type="checkbox" name="sms" value="true" ${smsChecked} /><small>Activado</small>
      <br/>
      <p>Ticks azules al leer:</p>
      <input type="hidden" name="read_receipts_current" value="${readReceiptsCurrent}" /><input type="checkbox" name="readReceipts" value="true" ${readReceiptsChecked} /><small>Activado</small>
      <br/>
      <p>Borrado automatico:</p>
      <select name="messageRetentionDays">
        ${cleanupOptionsHtml}
      </select>
      <br/><br/>
      <p>Sesion:</p>
      <a href="/logout">Cerrar sesion</a>
      <br/><br/>
      <p>WhatsApp:</p>
      <a href="/whatsapp/logout">Cerrar sesion de WhatsApp</a>
      <br/><br/>
      <input type="submit" value="Guardar" />
    </form>
  `;
  sendPage(req, res, 200, 'Ajustes', body);
}

export function saveSettings(req, res, next) {
  const { sms, sms_current, readReceipts, read_receipts_current, messageRetentionDays } = req.body;
  const newSmsEnabled = sms === 'true' ? 'true' : 'false';
  const newReadReceiptsEnabled = readReceipts === 'true' ? 'true' : 'false';
  const isCleanupDisabled = messageRetentionDays === 'never';
  const allowedCleanupValues = new Set(CLEANUP_RETENTION_OPTIONS.map((option) => option.value));
  const safeRetentionValue =
    typeof messageRetentionDays === 'string' && allowedCleanupValues.has(messageRetentionDays)
      ? messageRetentionDays
      : '3';

  updateEnvVariables({
    SMS_NOTIFICATIONS_ENABLED: newSmsEnabled,
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
  )?.label || '3 dias';

  return sendPage(req, res, 200, 'Guardado',
    '<meta http-equiv="refresh" content="2; url=/"/>' +
    '<p>Ajustes guardados.</p>' +
    `<p>SMS: ${newSmsEnabled === 'true' ? 'Activado' : 'Desactivado'}</p>` +
    `<p>Ticks azules: ${newReadReceiptsEnabled === 'true' ? 'Activado' : 'Desactivado'}</p>` +
    `<p>Borrado: ${cleanupLabel}</p>` +
    '<p>Volviendo...</p>');
}
