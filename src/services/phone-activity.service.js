import { getLastActivityAt } from '../middlewares/auth.middleware.js';

// Actividad reciente en el smartphone (u otro dispositivo de WhatsApp) por chat. Si estás
// hablando con alguien desde el móvil, cada mensaje que lees deja el chat a 0 no leídos, lo
// que reinicia la «racha» de SMS: sin esto, cada respuesta que recibes dispara otro SMS.
// Mientras haya actividad reciente en ese chat el SMS se aplaza (y se descarta si lo lees).

// Si el Nokia ha cargado una página hace menos de esto, el SMS se aplaza (estás en la web).
export function getNokiaActiveWindowMs() {
  const seconds = Number.parseInt(process.env.SMS_ACTIVE_WINDOW_SECONDS || '15', 10);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 15) * 1000;
}

export function getPhoneActiveWindowMs() {
  const seconds = Number.parseInt(process.env.SMS_PHONE_ACTIVE_WINDOW_SECONDS || '300', 10);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 300) * 1000;
}

export function isNokiaActive() {
  return Date.now() - getLastActivityAt() < getNokiaActiveWindowMs();
}

// WhatsApp puede identificar el mismo chat como @lid en un sitio y como @c.us en otro: se
// indexa por la parte anterior a la '@' (dígitos / id de grupo), igual que updateUserUnseen.
function keyOf(chatId) {
  if (typeof chatId !== 'string' || !chatId) return null;
  return chatId.split('@')[0] || null;
}

const lastPhoneActivity = new Map();

export function markPhoneActivity(...chatIds) {
  const now = Date.now();
  for (const chatId of chatIds) {
    const key = keyOf(chatId);
    if (key) lastPhoneActivity.set(key, now);
  }
  // Limpieza perezosa para que el Map no crezca sin límite.
  if (lastPhoneActivity.size > 500) {
    const cutoff = now - getPhoneActiveWindowMs();
    for (const [key, at] of lastPhoneActivity) {
      if (at < cutoff) lastPhoneActivity.delete(key);
    }
  }
}

// Milisegundos que faltan para que acabe la ventana de actividad en el móvil (0 = inactivo).
export function getPhoneActiveRemainingMs(chatId) {
  const key = keyOf(chatId);
  const at = key ? lastPhoneActivity.get(key) : undefined;
  if (!at) return 0;
  return Math.max(0, getPhoneActiveWindowMs() - (Date.now() - at));
}
