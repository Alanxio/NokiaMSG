import { convertEmojisToAscii } from '../utils/emoji.js';

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeAsciiText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return convertEmojisToAscii(text || fallback);
}

function getPublicBaseUrl() {
  const useCloudflare = (process.env.CLOUDFLARE_ENABLED || '').toLowerCase() === 'true';
  if (useCloudflare && process.env.CLOUDFLARE_TUNNEL_HOSTNAME) {
    return `https://${process.env.CLOUDFLARE_TUNNEL_HOSTNAME}`;
  }
  if (process.env.NGROK_HTTP_URL) {
    return process.env.NGROK_HTTP_URL.replace(/\/$/, '');
  }
  return null;
}

function buildChatUrl(payload) {
  const baseUrl = getPublicBaseUrl();
  if (!baseUrl || !payload.chatId) return null;
  const path = payload.type === 'group' ? 'grupo' : 'usuario';
  return `${baseUrl}/${path}/${encodeURIComponent(payload.chatId)}`;
}

function getSmsConfig() {
  return {
    enabled: parseBoolean(process.env.SMS_NOTIFICATIONS_ENABLED, false),
    accountSid: (process.env.TWILIO_ACCOUNT_SID || '').trim(),
    authToken: (process.env.TWILIO_AUTH_TOKEN || '').trim(),
    fromNumber: (process.env.TWILIO_FROM_NUMBER || '').trim(),
    toNumber: (process.env.TWILIO_TO_NUMBER || '').trim(),
  };
}

export function getSmsNotificationStatus() {
  const config = getSmsConfig();

  if (!config.enabled) {
    return { enabled: false, status: 'disabled', missing: [] };
  }

  const missing = [];
  if (!config.accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!config.authToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!config.fromNumber) missing.push('TWILIO_FROM_NUMBER');
  if (!config.toNumber) missing.push('TWILIO_TO_NUMBER');

  if (missing.length > 0) {
    return { enabled: false, status: 'misconfigured', missing };
  }

  return { enabled: true, status: 'enabled', missing: [] };
}

export async function sendSmsNotification(payload) {
  const config = getSmsConfig();
  const status = getSmsNotificationStatus();

  if (!status.enabled) {
    return { status: status.status, missing: status.missing };
  }

  const sourceName = payload.type === 'group'
    ? payload.groupName
    : payload.username;

  const chatUrl = buildChatUrl(payload);
  const smsText = chatUrl
    ? `¡Tienes un mensaje de ${normalizeAsciiText(sourceName, 'Desconocido')}! ${chatUrl}`
    : `¡Tienes un mensaje de ${normalizeAsciiText(sourceName, 'Desconocido')}!`;

  // Basic Auth for Twilio REST API
  const authHeader = 'Basic ' + Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;

  const requestBody = new URLSearchParams({
    To: config.toNumber,
    From: config.fromNumber,
    Body: smsText,
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: requestBody.toString(),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[SMS] Error from Twilio API:', data);
      return { status: 'failed', error: data.message };
    }

    return { status: 'sent', messageId: data.sid };
  } catch (err) {
    console.error('[SMS] Network error pushing to Twilio:', err.message);
    return { status: 'failed', error: err.message };
  }
}
