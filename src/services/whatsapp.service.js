import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { existsSync, writeFileSync, unlinkSync, statSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import db, { stmts } from '../../db/db.js';
import { saveInteraction } from '../controller/notification.controller.js';
import { marcarNovedad } from './polling.service.js';
import { resolveMentions } from '../utils/mentions.js';
import { saveImageVersions, processSticker, saveRawMediaFile, getStickerKey, attachExistingSticker } from '../utils/media.js';
import { resolvePendingGroupNames, resolveGroupNameFromWhatsapp } from '../controller/group.controller.js';
import {
  claimOwnMessage,
  isOwnMessageClaimed,
  isSameOutgoingMessage,
  isSyncableOwnChat,
  matchesNokiaSendInFlight,
  rememberPendingOutgoingAck,
  registerObservedOutgoing,
  takePendingOutgoing,
  takePendingOutgoingAck,
} from './pending-outgoing.service.js';
import { sendCallSmsNotification, sendInfraAlertSms } from './sms-notification.service.js';
import { queueAudioTranscription } from './audio-transcription.service.js';
import { isViewOnceMessage } from '../utils/view-once.js';
import {
  CONTACT_NAME_PRIORITY,
  formatWhatsappIdentifier,
  getContactDisplayName,
} from '../utils/contact-display-name.js';
import { getMessageQuotePreview } from '../utils/message-preview.js';

const { Client, LocalAuth, Message } = pkg;

const AUTH_DATA_PATH = '.wwebjs_auth';
const RECONNECT_BASE_DELAY = 5000;
const RECONNECT_MAX_DELAY = 30000;
const RECONNECT_MAX_ATTEMPTS = 3;
const AUTH_READY_TIMEOUT = 25000;
const SEND_SEEN_RETRY_DELAY_MS = 250;
// Mismo umbral que /healthz (src/index.js) para decidir si WhatsApp lleva "demasiado"
// desconectado — evita marcar como problema una reconexión normal de unos segundos.
const DISCONNECT_ALERT_THRESHOLD_MS = 5 * 60 * 1000;

export let client = null;
let currentQr = null;
// Sube con cada QR nuevo: la página del QR la usa para pedir la imagen con una URL
// distinta por QR (cacheable en el móvil) y para saber cuándo hay que recargar.
let qrVersion = 0;
// Vinculación con código (número de teléfono) en vez de QR. Va atada a la
// instancia de cliente que lo pidió: si el cliente se recrea, vuelve el modo QR.
let pairingClient = null;
let pairingCode = null;
let pairingError = null;
let pairingPromise = null;
let connectionStatus = 'waiting_qr';
let lastStatusChange = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let authReadyTimer = null;
let storedProcessMessageFn = null;
let hasEverAuthenticated = false;
let readyPollInterval = null;
let disconnectAlertTimer = null;
let disconnectAlertSent = false;

const activeChatsSinceStart = new Set();
const directMessageListenerPages = new WeakMap();
const directMessageListenerRetries = new WeakMap();

function getSerializedId(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const serialized = value._serialized || value.$1;
  return typeof serialized === 'string' && serialized ? serialized : null;
}

function getWhatsappMessageId(message) {
  return getSerializedId(message?.id)
    || getSerializedId(message?._data?.id)
    || getSerializedId(message?.rawData?.id);
}

function checkDisconnectAlert() {
  if (connectionStatus === 'connected') {
    disconnectAlertSent = false;
    return;
  }
  if (disconnectAlertSent || !lastStatusChange) return;
  const msSinceChange = Date.now() - new Date(lastStatusChange).getTime();
  if (msSinceChange < DISCONNECT_ALERT_THRESHOLD_MS) return;

  disconnectAlertSent = true;
  const minutos = Math.round(DISCONNECT_ALERT_THRESHOLD_MS / 60000);
  sendInfraAlertSms(`Aviso NokiaMSN: el puente de WhatsApp lleva desconectado (estado: ${connectionStatus}) mas de ${minutos} minutos.`)
    .catch((err) => console.error('[whatsapp] Fallo al enviar alerta SMS de desconexion:', err.message));
}

export async function resolveContactPhone(chatId) {
  if (!client || !chatId || typeof chatId !== 'string') return null;
  const cleanChatId = chatId.trim();

  const toPhoneNumber = (value) => {
    const digits = String(value || '').replace(/[^0-9]/g, '');
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  };

  // Resolver primero el PN personal de WhatsApp, también cuando el chat ya viene
  // identificado por número: el número del JID/contacto puede ser empresarial.
  if (typeof client.getContactLidAndPhone === 'function') {
    try {
      const [result] = await client.getContactLidAndPhone([cleanChatId]);
      const personalPhone = toPhoneNumber(result?.pn?._serialized || result?.pn);
      if (personalPhone) return personalPhone;
    } catch (err) {
      console.debug(`[whatsapp] No se pudo resolver el teléfono personal de ${cleanChatId}:`, err?.message || err);
    }
  }

  if (typeof client.getContactById === 'function') {
    try {
      const contact = await client.getContactById(cleanChatId);
      if (contact) {
        const candidateNumbers = [];
        if (typeof contact.number === 'string' && contact.number.trim()) {
          candidateNumbers.push(contact.number);
        }
        if (typeof contact.getFormattedNumber === 'function') {
          try {
            const formatted = await contact.getFormattedNumber();
            if (formatted) candidateNumbers.push(formatted);
          } catch {
            // Ignorar error de formato y probar los siguientes datos de contacto.
          }
        }
        if (typeof contact.id === 'object' && contact.id?._serialized) {
          candidateNumbers.push(contact.id._serialized);
        }

        for (const candidate of candidateNumbers) {
          const phoneNumber = toPhoneNumber(candidate);
          if (phoneNumber) return phoneNumber;
        }
      }
    } catch (err) {
      console.debug(`[whatsapp] No se pudo consultar el número de ${cleanChatId}:`, err?.message || err);
    }
  }

  return null;
}

function formatWhatsappTimestamp(timestamp) {
  if (!timestamp) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(0, 19).replace('T', ' ');
    return { date: dateStr, time: timeStr };
  }

  const d = new Date(timestamp * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeStr = `${dateStr} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  return { date: dateStr, time: timeStr };
}

function cleanStaleLocks() {
  try {
    const sessionDir = join(AUTH_DATA_PATH, 'session');
    if (!existsSync(sessionDir)) return;
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const p = join(sessionDir, name);
      try { unlinkSync(p); } catch { }
    }
    console.log('[whatsapp] Lock files limpiados.');
  } catch { }
}

async function syncChatsMetadata() {
  // Sincronización deshabilitada: usuarios y grupos se crean dinámicamente
  // cuando se recibe el primer mensaje de ellos
  console.log('[whatsapp] 🔄 Modo dinámico: usuarios y grupos se crearán al recibir mensajes.');
}

// client.getChats() (whatsapp-web.js@1.34.7) construye el modelo COMPLETO de cada
// chat con Promise.all — y ese modelo completo intenta refrescar metadatos de grupo
// vía "groupMetadata.update()", una llamada que falla con un error interno opaco de
// la propia web de WhatsApp para algunos grupos (ver resolveGroupNameFromWhatsapp en
// group.controller.js). Como Promise.all aborta entero si UNA sola promesa falla,
// un solo grupo problemático tira abajo la sincronización de TODOS los chats. Aquí
// se lee la lista de chats "en crudo" (id, si es grupo, contador de no leídos), que
// no depende de esa llamada, así que no se ve afectada por ese bug.
async function getChatUnreadSummariesDirectly() {
  if (!client?.pupPage) return [];
  try {
    return await client.pupPage.evaluate(() => {
      const chats = window.require('WAWebCollections').Chat.getModelsArray();
      return chats.map((chat) => ({
        id: chat.id?._serialized || null,
        isGroup: !!chat.groupMetadata,
        unreadCount: typeof chat.unreadCount === 'number' ? chat.unreadCount : 0,
      }));
    });
  } catch (err) {
    console.warn('[whatsapp] getChatUnreadSummariesDirectly falló:', err?.name, err?.message);
    return [];
  }
}

async function applyChatUnreadCount(chat) {
  const chatId = chat.id?._serialized || chat.id;
  if (!chatId || typeof chatId !== 'string') return;
  const unreadCount = typeof chat.unreadCount === 'number' ? chat.unreadCount : 0;

  if (chat.isGroup || chatId.endsWith('@g.us')) {
    stmts.updateGroupUnseen.run(unreadCount, unreadCount, chatId);
    return;
  }

  const baseDigits = chatId.split('@')[0];
  const result = stmts.updateUserUnseen.run(unreadCount, unreadCount, chatId, `${baseDigits}@%`);

  if (result.changes === 0) {
    // El usuario puede estar guardado en BD bajo un identificador distinto al que
    // reporta este evento (WhatsApp puede identificar el mismo chat como @lid en un
    // sitio y como @c.us en otro). Sin esto, el estado de "leído" de esa conversación
    // se queda desincronizado entre dispositivos porque nunca encontramos la fila a
    // actualizar.
    const altPhone = await resolveContactPhone(chatId);
    if (altPhone) {
      const altDigits = altPhone.replace(/[^0-9]/g, '');
      if (altDigits && altDigits !== baseDigits) {
        stmts.updateUserUnseen.run(unreadCount, unreadCount, `${altDigits}@c.us`, `${altDigits}@%`);
      }
    }
  }
}

// El evento 'unread_count' oficial de whatsapp-web.js (Client.js: onChatUnreadCountEvent)
// hace "const chat = await this.getChatById(data.id)" antes de emitir el evento — es decir,
// pasa por la MISMA llamada que falla con el bug "r: r" para ciertos chats (ver
// resolveGroupNameFromWhatsapp en group.controller.js). Cuando eso pasa, el evento
// simplemente no llega a emitirse para ese chat y la lectura en tiempo real se queda
// desincronizada hasta la próxima reconexión (que sí se autocorrige, vía
// syncUnreadCountsFromWhatsapp en 'ready'). Para no depender de esperar a una reconexión,
// aquí nos enganchamos directamente a la colección interna de WhatsApp (el mismo evento
// que usa la librería por debajo) pero leyendo el chat "en crudo", sin la llamada que falla.
async function attachDirectUnreadCountListener() {
  if (!client?.pupPage) return;
  try {
    await client.pupPage.exposeFunction('onRawUnreadCountEvent', (data) => {
      applyChatUnreadCount(data).then(() => {
        console.log(`[whatsapp] 👁 (directo) unreadCount=${data.unreadCount} para ${data.id}`);
      }).catch((err) => {
        console.warn('[whatsapp] Error aplicando unreadCount (listener directo):', err.message);
      });
    });
    await client.pupPage.evaluate(() => {
      const { Chat } = window.require('WAWebCollections');
      Chat.on('change:unreadCount', (chat) => {
        window.onRawUnreadCountEvent({
          id: chat.id?._serialized || null,
          unreadCount: typeof chat.unreadCount === 'number' ? chat.unreadCount : 0,
          isGroup: !!chat.groupMetadata,
        });
      });
    });
    console.log('[whatsapp] 👁 Listener directo de unreadCount adjuntado (evita el bug de getChatById).');
  } catch (err) {
    console.warn('[whatsapp] No se pudo adjuntar el listener directo de unreadCount:', err?.message);
  }
}

async function attachDirectMessageListener() {
  if (!client?.pupPage) return;
  const page = client.pupPage;
  const existingSetup = directMessageListenerPages.get(page);
  if (existingSetup) return existingSetup;

  const setup = (async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (client?.pupPage !== page || page.isClosed()) return false;

      const bindingExists = await page.evaluate(
        () => typeof window.onNokiaDirectMessageAdded === 'function'
      );
      if (!bindingExists) {
        await page.exposeFunction('onNokiaDirectMessageAdded', async (data) => {
          try {
            // También los propios (fromMe): los escritos desde otro dispositivo se sincronizan;
            // los del Nokia los reconoce message_create y solo los enlaza.
            const messageId = getWhatsappMessageId(data);
            if (!messageId || stmts.findMessageByWhatsappId.get(messageId)) return;

            await new Promise((resolve) => setTimeout(resolve, 5000));
            // isOwnMessageClaimed: la librería ya lo está guardando (la media tarda en bajar).
            if (stmts.findMessageByWhatsappId.get(messageId) || isOwnMessageClaimed(messageId) || !client) return;

            const message = new Message(client, data);
            client.emit('message_create', message);
          } catch (err) {
            console.error('[whatsapp] Error reenviando mensaje desde listener directo:', err?.stack || err?.message || err);
          }
        });
      }

      const recoveredMessages = await page.evaluate((cutoff) => {
        const { Msg } = window.require('WAWebCollections');
        if (!window.__nokiaDirectMessageListener) {
          Msg.on('add', (msg) => {
            if (!msg.isNewMsg) return;
            window.onNokiaDirectMessageAdded(window.WWebJS.getMessageModel(msg));
          });
          window.__nokiaDirectMessageListener = true;
        }

        if (window.__nokiaRecentMessagesRecovered) return [];
        window.__nokiaRecentMessagesRecovered = true;
        return Msg.getModelsArray()
          .filter((msg) => msg.isNewMsg && Number(msg.t) >= cutoff)
          .sort((a, b) => Number(a.t) - Number(b.t))
          .slice(-500)
          .map((msg) => window.WWebJS.getMessageModel(msg));
      }, Math.floor(Date.now() / 1000) - 24 * 60 * 60);

      if (recoveredMessages.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        let recoveredCount = 0;
        for (const data of recoveredMessages) {
          const messageId = getWhatsappMessageId(data);
          if (!messageId || stmts.findMessageByWhatsappId.get(messageId)) continue;

          const message = new Message(client, data);
          message.isNokiaBackfill = true;
          client.emit('message_create', message);
          recoveredCount += 1;
        }
        if (recoveredCount > 0) {
          console.log(`[whatsapp] Recuperando ${recoveredCount} mensajes recientes no guardados.`);
        }
      }
      console.log('[whatsapp] Listener directo de mensajes adjuntado.');
      return true;
    } catch (err) {
      console.error('[whatsapp] No se pudo adjuntar el listener directo de mensajes:', err?.stack || err?.message || err);
      return false;
    }
  })();

  directMessageListenerPages.set(page, setup);
  const attached = await setup;
  if (attached) {
    directMessageListenerRetries.delete(page);
    return;
  }

  directMessageListenerPages.delete(page);
  const retries = directMessageListenerRetries.get(page) || 0;
  if (retries < 2 && connectionStatus === 'connected') {
    directMessageListenerRetries.set(page, retries + 1);
    const retryTimer = setTimeout(() => {
      if (client?.pupPage) {
        attachDirectMessageListener().catch((err) => {
          console.error('[whatsapp] Error reintentando listener directo de mensajes:', err?.message || err);
        });
      }
    }, 3000);
    retryTimer.unref?.();
  }
}

// quiet: la página de inicio del Nokia lo llama en cada carga; solo se registra al conectar.
export async function syncUnreadCountsFromWhatsapp({ quiet = false } = {}) {
  if (!client || connectionStatus !== 'connected') return;
  try {
    const chats = await getChatUnreadSummariesDirectly();
    for (const chat of chats) {
      if (chat.id) await applyChatUnreadCount(chat);
    }
    if (!quiet) console.log(`[whatsapp] 🔄 Sincronizados contadores de no leídos con WhatsApp (${chats.length} chats).`);
  } catch (err) {
    console.warn('[whatsapp] Error sincronizando unread counts:', err.message);
  }
}

export async function syncChatUnreadCountFromWhatsapp(chatId) {
  if (!chatId || !client || connectionStatus !== 'connected') return false;

  const chats = await getChatUnreadSummariesDirectly();
  const chat = chats.find((entry) => entry.id === chatId);
  if (!chat) return false;

  await applyChatUnreadCount(chat);
  return true;
}

export function syncOutgoingMessageAck(whatsappMsgId, initialAck = 0) {
  if (!whatsappMsgId) return;
  const pendingAck = takePendingOutgoingAck(whatsappMsgId);
  const ack = Math.max(Number(initialAck) || 0, Number(pendingAck) || 0);
  if (ack <= 0) return;
  stmts.updateMessageAckByWhatsappId.run(ack, whatsappMsgId, ack);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendSeenWithFallback(chatId) {
  const strategies = [
    {
      name: 'direct',
      run: async () => client.sendSeen(chatId),
    },
    {
      name: 'chat',
      run: async () => {
        const chat = await client.getChatById(chatId);
        if (!chat) {
          throw new Error('Chat no encontrado en WhatsApp');
        }
        return chat.sendSeen();
      },
    },
  ];

  let lastError = null;

  for (const strategy of strategies) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await strategy.run();
        if (strategy.name !== 'direct' || attempt > 1) {
          console.debug(`[whatsapp] Visto enviado a ${chatId} usando ${strategy.name} (reintento ${attempt}).`);
        }
        return result;
      } catch (err) {
        lastError = err;
        if (attempt < 2) {
          await delay(SEND_SEEN_RETRY_DELAY_MS);
        }
      }
    }
  }

  throw lastError;
}

function scheduleReconnect() {
  if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    console.log('[whatsapp] Maximos intentos alcanzados. Limpiando sesion y mostrando QR...');
    hasEverAuthenticated = false;
    connectionStatus = 'waiting_qr';
    lastStatusChange = new Date().toISOString();
    try {
      const sessionDir = join(AUTH_DATA_PATH, 'session');
      if (existsSync(sessionDir)) {
        rmSync(sessionDir, { recursive: true, force: true });
        console.log('[whatsapp] Sesion eliminada.');
      }
    } catch { }
    return;
  }

  const delay = Math.min(RECONNECT_BASE_DELAY * (2 ** reconnectAttempts), RECONNECT_MAX_DELAY);
  reconnectAttempts++;

  console.log(`[whatsapp] Reconexion ${reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS} en ${Math.round(delay / 1000)}s...`);
  connectionStatus = 'reconnecting';
  lastStatusChange = new Date().toISOString();

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await startWhatsappClient(storedProcessMessageFn);
    } catch (err) {
      console.error('[whatsapp] Error en reconexion:', err.message);
    }
  }, delay);
}

export async function startWhatsappClient(processMessageFn) {
  if (client) {
    console.log('[whatsapp] Cliente ya inicializado, ignorando.');
    return;
  }

  storedProcessMessageFn = processMessageFn;
  cleanStaleLocks();
  connectionStatus = 'connecting';
  lastStatusChange = new Date().toISOString();
  console.log('[whatsapp] Inicializando cliente...');

  if (!disconnectAlertTimer) {
    disconnectAlertTimer = setInterval(checkDisconnectAlert, 60 * 1000);
  }

  let gotQrOrAuth = false;

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DATA_PATH }),
    webVersionCache: { type: 'none' },
    puppeteer: {
      headless: 'shell',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--mute-audio',
        '--no-default-browser-check',
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-ipc-flooding-protection',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-session-crashed-bubble',
        '--disable-crash-reporter',
        '--disable-oopr-debug-crash-dump',
      ],
    },
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`[whatsapp] Loading screen: ${percent}% - ${message}`);
  });

  client.on('auth_failure', (msg) => {
    console.error('[whatsapp] Auth failure:', msg);
  });

  client.on('change_state', (state) => {
    console.log('[whatsapp] Cambio de estado interno:', state);
  });

  client.on('code', (code) => {
    if (!client || pairingClient !== client) return;
    pairingCode = code;
    qrVersion += 1;
    console.log('[whatsapp] Codigo de vinculacion actualizado.');
  });

  client.on('qr', async (qr) => {
    gotQrOrAuth = true;
    // En modo código WhatsApp Web puede seguir emitiendo QR, pero ya no valen.
    if (pairingClient && pairingClient === client) return;
    console.log('\n[whatsapp] ═══════════════════════════════════════');
    console.log('[whatsapp] ESCANEA EL QR PARA VINCULAR WHATSAPP');
    console.log('[whatsapp] ═══════════════════════════════════════\n');
    qrcodeTerminal.generate(qr, { small: true });

    currentQr = qr;
    qrVersion += 1;
    connectionStatus = 'waiting_qr';
    lastStatusChange = new Date().toISOString();

    try {
      await qrcode.toFile('assets/qr.png', qr, {
        width: 100,
        margin: 1,
        errorCorrectionLevel: 'L',
        color: { dark: '#000000', light: '#ffffff' },
      });
      console.log('[whatsapp] QR guardado en assets/qr.png');
    } catch (err) {
      console.error('[whatsapp] Error generando QR:', err.message);
    }

    console.log('[whatsapp] QR actualizado. Endpoint: GET /whatsapp/qr\n');
  });

  client.on('authenticated', () => {
    gotQrOrAuth = true;
    console.log('[whatsapp] Autenticado correctamente.');
    connectionStatus = 'authenticated';
    lastStatusChange = new Date().toISOString();
    hasEverAuthenticated = true;

    if (readyPollInterval) clearInterval(readyPollInterval);
    let pollCount = 0;
    const MAX_POLLS = 20;
    readyPollInterval = setInterval(async () => {
      pollCount++;
      if (connectionStatus !== 'authenticated' || !client) {
        clearInterval(readyPollInterval);
        readyPollInterval = null;
        return;
      }
      try {
        const page = client.pupPage;
        if (!page) return;
        const stores = await page.evaluate(() => ({
          Store: typeof window.Store !== 'undefined',
          WWebJS: typeof window.WWebJS !== 'undefined',
          chatList: !!document.querySelector('div[aria-label="Chat list"]'),
        }));
        if (stores.Store || stores.WWebJS || stores.chatList) {
          clearInterval(readyPollInterval);
          readyPollInterval = null;
          console.log('[whatsapp] ✓ WhatsApp listo detectado (polling propio).');
          if (authReadyTimer) { clearTimeout(authReadyTimer); authReadyTimer = null; }
          connectionStatus = 'connected';
          lastStatusChange = new Date().toISOString();
          currentQr = null;
          reconnectAttempts = 0;
          try { writeFileSync('assets/qr.png', ''); } catch { }
          await attachDirectMessageListener();
        }
        if (pollCount >= MAX_POLLS) {
          clearInterval(readyPollInterval);
          readyPollInterval = null;
          console.log('[whatsapp] Polling de ready agotado tras', MAX_POLLS * 2, 's');
        }
      } catch (err) {
        if (pollCount >= MAX_POLLS) {
          clearInterval(readyPollInterval);
          readyPollInterval = null;
        }
      }
    }, 2000);

    if (authReadyTimer) clearTimeout(authReadyTimer);
    authReadyTimer = setTimeout(async () => {
      authReadyTimer = null;
      if (readyPollInterval) { clearInterval(readyPollInterval); readyPollInterval = null; }
      if (connectionStatus === 'authenticated' && client) {
        console.log('[whatsapp] ⚠ Sin evento ready tras autenticacion (timeout 25s). Sesion probablemente corrupta.');
        const oldClient = client;
        client = null;
        oldClient.removeAllListeners();
        try { await oldClient.destroy(); } catch { }
        hasEverAuthenticated = false;
        connectionStatus = 'waiting_qr';
        lastStatusChange = new Date().toISOString();
        try {
          const sessionDir = join(AUTH_DATA_PATH, 'session');
          if (existsSync(sessionDir)) {
            rmSync(sessionDir, { recursive: true, force: true });
            console.log('[whatsapp] Sesion eliminada. Reiniciando con QR limpio...');
          }
        } catch { }
        try {
          await startWhatsappClient(storedProcessMessageFn);
        } catch { }
      }
    }, AUTH_READY_TIMEOUT);
  });

  client.on('ready', async () => {
    if (authReadyTimer) { clearTimeout(authReadyTimer); authReadyTimer = null; }
    if (readyPollInterval) { clearInterval(readyPollInterval); readyPollInterval = null; }
    console.log('[whatsapp] Cliente conectado y listo.');
    try {
      console.log(`[whatsapp] Versión de WhatsApp Web: ${await client.getWWebVersion()}`);
    } catch (error) {
      console.warn('[whatsapp] No se pudo consultar la versión de WhatsApp Web:', error?.message || error);
    }
    connectionStatus = 'connected';
    lastStatusChange = new Date().toISOString();
    currentQr = null;
    reconnectAttempts = 0;
    try { writeFileSync('assets/qr.png', ''); } catch { }

    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const page = client?.pupPage;
        if (!page) {
          if (attempt < maxRetries) {
            console.log(`[whatsapp] pupPage no disponible (intento ${attempt}/${maxRetries}), reintentando en 1s...`);
            await new Promise(r => setTimeout(r, 1000));
            continue;
          } else {
            console.log('[whatsapp] pupPage null tras agotar reintentos, omitiendo verificacion de listeners.');
            break;
          }
        }

        const hasListeners = await page.evaluate(() => typeof window.onAddMessageEvent === 'function');
        if (!hasListeners) {
          console.log('[whatsapp] Listeners no expuestos, re-adjuntando...');
          await client.attachEventListeners();
          const recheck = await page.evaluate(() => typeof window.onAddMessageEvent === 'function');
          console.log('[whatsapp] Listeners despues de re-attach:', recheck ? 'OK' : 'FALLO');
        } else {
          console.log('[whatsapp] Listeners OK.');
        }
        break;
      } catch (err) {
        if (attempt < maxRetries) {
          console.log(`[whatsapp] Error verificando listeners (intento ${attempt}/${maxRetries}): ${err.message}, reintentando en 1s...`);
          await new Promise(r => setTimeout(r, 1000));
        } else {
          console.error('[whatsapp] Error verificando listeners tras agotar reintentos:', err.message);
        }
      }
    }

    // Sincronizar metadatos (actualmente deshabilitado - modo dinámico)
    await syncChatsMetadata();
    // Sincronizar contadores de no leídos con WhatsApp al conectar
    await syncUnreadCountsFromWhatsapp();
    // Enganchar el listener directo de unreadCount para que la lectura en tiempo real
    // (marcar como leído en el móvil) llegue también a los chats afectados por el bug
    // de getChatById, sin esperar a la próxima reconexión.
    await attachDirectUnreadCountListener();
    await attachDirectMessageListener();
    // Reintentar la resolución de nombres de grupo que quedaron como ID/placeholder
    // (p. ej. porque fallaron en su momento al no estar el chat aún cacheado).
    try {
      const results = await resolvePendingGroupNames();
      const updated = results.filter((r) => r.status === 'actualizado');
      console.log(`[whatsapp] 🏷 Resolución de nombres de grupo: ${updated.length}/${results.length} corregidos.`);
      if (updated.length > 0) {
        console.log(`[whatsapp] 🏷 Nombres de grupo corregidos: ${updated.map((r) => `${r.group_id}→${r.new_name}`).join(', ')}`);
      }
    } catch (err) {
      console.warn('[whatsapp] Error resolviendo nombres de grupo pendientes:', err.message);
    }
  });

  client.on('unread_count', async (chat) => {
    try {
      const chatId = chat.id?._serialized || chat.id;
      if (!chatId) return;
      const unreadCount = typeof chat.unreadCount === 'number' ? chat.unreadCount : 0;
      await applyChatUnreadCount(chat);
      console.log(`[whatsapp] 👁 Sincronizado estado de lectura para ${chatId}: unreadCount = ${unreadCount}`);
    } catch (err) {
      console.warn('[whatsapp] Error en evento unread_count:', err.message);
    }
  });

  client.on('disconnected', (reason) => {
    if (authReadyTimer) { clearTimeout(authReadyTimer); authReadyTimer = null; }
    if (readyPollInterval) { clearInterval(readyPollInterval); readyPollInterval = null; }
    console.log('[whatsapp] Desconectado:', reason);
    lastStatusChange = new Date().toISOString();
    currentQr = null;
    client = null;

    if (hasEverAuthenticated) {
      console.log('[whatsapp] Habia sesion activa, reintentando conexion...');
      scheduleReconnect();
    } else {
      console.log('[whatsapp] No habia sesion activa, esperando QR.');
      connectionStatus = 'waiting_qr';
    }
  });

  client.on('message_ciphertext', (msg) => {
    console.log('[whatsapp] Mensaje cifrado recibido de:', msg.from);
  });

  client.on('message_ack', (message, ack) => {
    try {
      const whatsappMsgId = getWhatsappMessageId(message);
      if (!whatsappMsgId) return;
      const localMessage = stmts.findMessageByWhatsappId.get(whatsappMsgId);
      if (localMessage) {
        stmts.updateMessageAckByWhatsappId.run(ack, whatsappMsgId, ack);
      } else {
        rememberPendingOutgoingAck(whatsappMsgId, ack);
      }
    } catch (e) {
      console.error('[whatsapp] Error actualizando estado de mensaje (ack):', e.message);
    }
  });

  // Eventos fiables (no de la familia "r: r") — traen el id ya poblado, igual que cualquier
  // mensaje entrante, así que se buscan directamente por whatsapp_msg_id sin ningún bypass.
  // Si el mensaje es de antes de que la app estuviera despierta, el UPDATE no toca ninguna
  // fila y no pasa nada.
  client.on('message_revoke_everyone', (message) => {
    try {
      const whatsappMsgId = message?.id?._serialized || null;
      if (!whatsappMsgId) return;
      stmts.markMessageDeleted.run(whatsappMsgId); // conserva el texto original
    } catch (e) {
      console.error('[whatsapp] Error marcando mensaje eliminado (everyone):', e.message);
    }
  });

  client.on('message_revoke_me', (message) => {
    try {
      const whatsappMsgId = message?.id?._serialized || null;
      if (!whatsappMsgId) return;
      stmts.markMessageDeleted.run(whatsappMsgId); // conserva el texto original
    } catch (e) {
      console.error('[whatsapp] Error marcando mensaje eliminado (me):', e.message);
    }
  });

  client.on('message_edit', (message, newBody) => {
    try {
      const whatsappMsgId = message?.id?._serialized || null;
      if (!whatsappMsgId || typeof newBody !== 'string') return;
      stmts.markMessageEdited.run(newBody.trim().slice(0, 65535), whatsappMsgId);
    } catch (e) {
      console.error('[whatsapp] Error marcando mensaje editado:', e.message);
    }
  });

  // vote_update trae SIEMPRE la selección COMPLETA actual de un votante (nunca un delta) —
  // se borra su estado anterior en esta encuesta y se reinserta desde cero lo que diga el
  // evento. parentMessage es el propio mensaje de creación de la encuesta.
  client.on('vote_update', (vote) => {
    try {
      const whatsappMsgId = getWhatsappMessageId(vote?.parentMessage);
      const voterChatId = getSerializedId(vote?.voter)
        || getSerializedId(vote?.senderUserJid)
        || getSerializedId(vote?.sender);
      if (!whatsappMsgId || !voterChatId) return;

      const localRow = stmts.findMessageByWhatsappId.get(whatsappMsgId);
      if (!localRow) return;
      const messageId = localRow.id;

      // interractedAtTs viene en milisegundos (campo origen: senderTimestampMs) — convertir
      // a segundos para que sea consistente con el resto de timestamps de la app.
      const votedAtTs = Number.isFinite(vote.interractedAtTs)
        ? Math.floor(vote.interractedAtTs / 1000)
        : Math.floor(Date.now() / 1000);
      const selected = Array.isArray(vote.selectedOptions) ? vote.selectedOptions : [];
      applyPollVoteSelection(messageId, voterChatId, selected, votedAtTs);
    } catch (e) {
      console.error('[whatsapp] Error procesando vote_update:', e.message);
    }
  });

  // Las llamadas de WhatsApp no se pueden "reenviar" a una llamada real (son audio/vídeo
  // en directo por WebRTC) — lo único posible es dejar constancia en el chat de que han
  // llamado, igual que ya se hace con los stickers.
  // ── Llamadas entrantes ─────────────────────────────────────────────────────
  // Dos vías, porque ninguna es 100% fiable por separado:
  //  1. Evento 'call' de whatsapp-web.js (al sonar). OJO: call.from es un objeto Wid
  //     (peerJid), no un string; antes se usaba tal cual, SQLite rechazaba el bind y
  //     ninguna llamada llegó a registrarse nunca. En llamadas de grupo peerJid es quien
  //     llama, no el grupo.
  //  2. Mensaje 'call_log' que WhatsApp mete en el chat tras la llamada (antes se
  //     descartaba por no tener texto).
  // Si llegan las dos para la misma llamada, solo se registra/avisa la primera.
  const recentCalls = new Map(); // clave de quien llama -> timestamp
  const CALL_DEDUP_MS = 3 * 60_000;

  async function registerIncomingCall({ callerId, groupId = null, isGroupCall = false, isVideo = false, callKey }) {
    if (!callerId) return;
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timeStr = `${dateStr} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    let phoneNumber = await resolveContactPhone(callerId);
    if (!phoneNumber && /@(c\.us|s\.whatsapp\.net)$/.test(callerId)) {
      const digits = callerId.split('@')[0].replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15) phoneNumber = `+${digits}`;
    }

    // Misma persona por @lid y por @c.us: se deduplica por teléfono si se conoce.
    const dedupKey = phoneNumber || callerId;
    const lastSeen = recentCalls.get(dedupKey);
    if (lastSeen && Date.now() - lastSeen < CALL_DEDUP_MS) {
      console.log(`[whatsapp] 📞 Llamada de ${callerId} ya registrada hace ${Math.round((Date.now() - lastSeen) / 1000)}s (${callKey}) — omitida.`);
      return;
    }
    recentCalls.set(dedupKey, Date.now());
    for (const [key, ts] of recentCalls) if (Date.now() - ts > CALL_DEDUP_MS) recentCalls.delete(key);

    const caller = await resolveDisplayNameForChatId(callerId);
    const callerName = caller?.name || phoneNumber || 'Desconocido';
    const kind = isVideo ? 'videollamada' : 'llamada';

    let chatName;
    if (groupId) {
      chatName = stmts.getGroupById.get(groupId)?.group_name || null;
      if (!chatName) {
        try {
          chatName = await resolveGroupNameFromWhatsapp(groupId);
        } catch (err) {
          console.warn(`[whatsapp] No se pudo resolver el nombre del grupo de llamada ${groupId}:`, err?.message || err);
        }
      }
      chatName ||= 'Grupo de WhatsApp';
    }

    const message = groupId
      ? `${callerName} ha hecho una ${kind} grupal`
      : `${callerName} te ha llamado${isGroupCall ? ` (${kind} grupal)` : isVideo ? ' por videollamada' : ''}${phoneNumber && callerName !== phoneNumber ? ` (${phoneNumber})` : ''}`;

    const fakeReq = {
      body: {
        title: groupId ? chatName : callerName,
        message,
        date: dateStr,
        time: timeStr,
        chat_id: groupId || callerId,
        sender_chat_id: callerId,
        whatsapp_msg_id: `call_${callKey}`,
        from_me: 0,
        chat_type: groupId ? 'group' : 'user',
        is_group: groupId ? 1 : 0,
        sender_name: callerName,
        group_name: groupId ? chatName : null,
        is_system: 1,
        is_call: true,
        is_video: Boolean(isVideo),
        phone_number: phoneNumber,
        call_caller_name: callerName,
      },
    };
    const mockRes = {
      statusCode: 200,
      _json: null,
      status(code) { this.statusCode = code; return this; },
      json(data) { this._json = data; },
    };

    const messageId = await saveInteraction(
      fakeReq,
      mockRes,
      (err) => {
        if (err) console.error('[whatsapp] Error guardando notificación de llamada:', err.message || err);
      },
      null
    );
    if (messageId) {
      console.log(`[whatsapp] 📞 ${kind} de ${callerName}${groupId ? ` en ${chatName}` : ''} registrada (${callKey})`);
    }
  }

  client.on('call', async (call) => {
    try {
      if (call.fromMe) return;
      const callerId = getSerializedId(call.from);
      if (!callerId) {
        console.warn('[whatsapp] Llamada entrante sin peerJid legible:', call?.id);
        return;
      }
      await registerIncomingCall({
        callerId,
        isGroupCall: Boolean(call.isGroup),
        isVideo: Boolean(call.isVideo),
        callKey: `evt_${call.id}`,
      });
    } catch (err) {
      console.error('[whatsapp] Error registrando llamada:', err?.stack || err?.message || err);
    }
  });

  async function handleCallLogMessage(msg, whatsappMsgId) {
    try {
      if (msg.fromMe) return;
      const age = Math.floor(Date.now() / 1000) - Number(msg.timestamp || 0);
      if (age > 300) {
        console.log(`[whatsapp] 📞 call_log antiguo omitido (edad ${age}s) de ${msg.from}`);
        return;
      }
      const chatId = getSerializedId(msg.from);
      const isGroupChat = Boolean(chatId?.endsWith('@g.us'));
      const callerId = isGroupChat ? getSerializedId(msg.author) : chatId;
      await registerIncomingCall({
        callerId,
        groupId: isGroupChat ? chatId : null,
        isVideo: Boolean(msg._data?.isVideoCall),
        callKey: `log_${whatsappMsgId || `${chatId}_${msg.timestamp}`}`,
      });
    } catch (err) {
      console.error('[whatsapp] Error registrando call_log:', err?.stack || err?.message || err);
    }
  }

  // Cambios de grupo (entra/sale/admin/nombre/foto) — mismo patrón que las llamadas: un
  // mensaje sintético dentro del propio chat de grupo vía saveInteraction, marcado
  // is_system para que se renderice como notificación y no como si lo hubiera "dicho"
  // alguien. Un whatsapp_msg_id propio (no viene de WhatsApp para estos eventos) permite que
  // el UNIQUE + INSERT OR IGNORE ya existente descarte duplicados si el evento se repite.
  async function resolveDisplayNameForChatId(chatId) {
    if (!chatId) return { name: 'Desconocido', priority: 0 };
    const existing = stmts.getUserByChatId.get(chatId);

    // group_join suele traer un @lid. La tabla local todavía no conoce a esa
    // persona, por lo que hay que consultar WhatsApp antes de mostrar el LID.
    try {
      const contact = await client.getContactById(chatId);
      const contactName = getContactDisplayName(contact);
      if (contactName) return contactName;
    } catch (err) {
      console.debug(`[whatsapp] No se pudo consultar el contacto ${chatId}:`, err?.message || err);
    }

    // Si WhatsApp no puede devolver el contacto en este instante, conservar el
    // nombre de agenda/perfil que ya conocemos antes de caer a un teléfono.
    if (existing?.username && existing.name_priority >= CONTACT_NAME_PRIORITY.PROFILE_NAME) {
      return { name: existing.username, priority: existing.name_priority };
    }

    // Para los LID, getContactLidAndPhone devuelve el teléfono personal (pn)
    // asociado. Es preferible a enseñar el identificador/número empresarial.
    const personalPhone = await resolveContactPhone(chatId);
    if (personalPhone) {
      return { name: personalPhone, priority: CONTACT_NAME_PRIORITY.PERSONAL_PHONE };
    }

    if (existing?.username) {
      return { name: existing.username, priority: existing.name_priority || 0 };
    }
    const baseDigits = String(chatId).split('@')[0];
    if (baseDigits) {
      const byDigits = stmts.getUserByPhonePattern.get(`${baseDigits}@%`);
      if (byDigits?.username) return { name: byDigits.username, priority: 0 };
    }
    return {
      name: formatWhatsappIdentifier(chatId),
      priority: CONTACT_NAME_PRIORITY.BUSINESS_NUMBER,
    };
  }

  // senderChatId/senderName: a quién se le atribuye la fila para la FK de
  // group_participants (no se ve en el render, is_system la oculta) — pasar siempre a la
  // persona real relacionada con el evento (quien entra/sale/asciende, o quien hizo el
  // cambio) para no crear usuarios fantasma; solo cae al placeholder "Sistema" si de verdad
  // no hay ningún JID real disponible para ese evento.
  async function logGroupSystemMessage(groupId, text, dedupKey, senderChatId, sender) {
    try {
      const groupName = (await resolveGroupNameFromWhatsapp(groupId))
        || stmts.getGroupById.get(groupId)?.group_name
        || 'Grupo sin nombre';
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const timeStr = `${dateStr} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

      const fakeReq = {
        body: {
          title: groupName,
          message: text,
          date: dateStr,
          time: timeStr,
          chat_id: groupId,
          sender_chat_id: senderChatId || `${groupId}_system`,
          whatsapp_msg_id: dedupKey,
          from_me: 0,
          chat_type: 'group',
          is_group: 1,
          group_name: groupName,
          sender_name: sender?.name || 'Sistema',
          sender_name_priority: sender?.priority || 0,
          is_system: 1,
        },
      };
      const mockRes = {
        statusCode: 200,
        _json: null,
        status(code) { this.statusCode = code; return this; },
        json(data) { this._json = data; },
      };
      await saveInteraction(fakeReq, mockRes, () => {}, null);
    } catch (err) {
      console.error('[whatsapp] Error registrando cambio de grupo:', err.message);
    }
  }

  client.on('group_join', async (notification) => {
    try {
      const groupId = notification.chatId;
      if (!groupId) return;
      for (const participantId of notification.recipientIds || []) {
        const participant = await resolveDisplayNameForChatId(participantId);
        await logGroupSystemMessage(
          groupId,
          `${participant.name} ha entrado al grupo`,
          `groupevent_join_${groupId}_${notification.timestamp}_${participantId}`,
          participantId,
          participant
        );
      }
    } catch (err) {
      console.error('[whatsapp] Error en group_join:', err.message);
    }
  });

  client.on('group_leave', async (notification) => {
    try {
      const groupId = notification.chatId;
      if (!groupId) return;
      const wasRemoved = notification.type === 'remove';
      for (const participantId of notification.recipientIds || []) {
        const participant = await resolveDisplayNameForChatId(participantId);
        const text = wasRemoved ? `${participant.name} ha sido eliminado del grupo` : `${participant.name} ha salido del grupo`;
        await logGroupSystemMessage(
          groupId,
          text,
          `groupevent_leave_${groupId}_${notification.timestamp}_${participantId}`,
          participantId,
          participant
        );
      }
    } catch (err) {
      console.error('[whatsapp] Error en group_leave:', err.message);
    }
  });

  client.on('group_admin_changed', async (notification) => {
    try {
      const groupId = notification.chatId;
      if (!groupId) return;
      const promoted = notification.type === 'promote';
      for (const participantId of notification.recipientIds || []) {
        const participant = await resolveDisplayNameForChatId(participantId);
        const text = promoted ? `${participant.name} ahora es admin` : `${participant.name} ya no es admin`;
        await logGroupSystemMessage(
          groupId,
          text,
          `groupevent_admin_${groupId}_${notification.timestamp}_${participantId}`,
          participantId,
          participant
        );
      }
    } catch (err) {
      console.error('[whatsapp] Error en group_admin_changed:', err.message);
    }
  });

  client.on('group_update', async (notification) => {
    try {
      const groupId = notification.chatId;
      if (!groupId) return;
      const dedupKey = `groupevent_update_${groupId}_${notification.type}_${notification.timestamp}`;
      const authorId = notification.author || null;
      const author = authorId ? await resolveDisplayNameForChatId(authorId) : null;
      if (notification.type === 'subject') {
        const newName = (await resolveGroupNameFromWhatsapp(groupId)) || null;
        if (newName) stmts.upsertGroup.run(groupId, newName);
        await logGroupSystemMessage(groupId, `El grupo ahora se llama "${newName || '?'}"`, dedupKey, authorId, author);
      } else if (notification.type === 'picture') {
        await logGroupSystemMessage(groupId, 'El grupo ha cambiado la foto', dedupKey, authorId, author);
      }
      // description/announce/restrict: se dejan fuera por ahora, poco relevantes para avisar.
    } catch (err) {
      console.error('[whatsapp] Error en group_update:', err.message);
    }
  });

  // ── Mensajes propios escritos desde otros dispositivos ────────────────────────────
  // Fila de usuario a la que pertenece un chat privado. WhatsApp puede identificar el mismo
  // chat como @lid en un sitio y como @c.us en otro (ver applyChatUnreadCount): se busca por
  // id exacto, luego por los mismos dígitos y luego por el teléfono real del contacto, antes
  // de crear una fila nueva (que partiría la conversación en dos).
  async function resolveOwnChatUserId(chatId) {
    const exact = stmts.getUserByChatId.get(chatId);
    if (exact) return exact.chat_id;
    const digits = chatId.split('@')[0];
    const sameDigits = digits ? stmts.getUserByPhonePattern.get(`${digits}@%`) : null;
    if (sameDigits) return sameDigits.chat_id;
    const phone = await resolveContactPhone(chatId).catch(() => null);
    const phoneDigits = phone ? phone.replace(/[^0-9]/g, '') : '';
    if (phoneDigits && phoneDigits !== digits) {
      const byPhone = stmts.getUserByPhonePattern.get(`${phoneDigits}@%`);
      if (byPhone) return byPhone.chat_id;
    }
    const { name, priority } = await resolveDisplayNameForChatId(chatId);
    stmts.upsertUserNameIfPreferred.run(chatId, name, priority);
    return chatId;
  }

  // Guarda un mensaje propio enviado desde el móvil / WhatsApp Web / etc. Igual que lo que
  // guarda el Nokia al enviar (from_me = 1, user_chat_id del destinatario o group_id sin
  // autor), con media, citas y tipo de mensaje como los entrantes. No toca no leídos ni SMS:
  // de eso se encarga WhatsApp (al escribir desde el móvil, el chat queda leído y llega por
  // el listener de unreadCount). Devuelve el id de la fila nueva, o null si no se insertó.
  async function saveOwnMessage(body, mediaInfo, msg) {
    const chatId = body.chat_id;
    const whatsappMsgId = body.whatsapp_msg_id;
    const isGroup = Number(body.is_group) === 1;
    const text = String(body.message ?? '').trim().slice(0, 65535);
    if (!chatId || !whatsappMsgId || !text) return null;

    let userChatId = null;
    let groupId = null;
    if (isGroup) {
      groupId = chatId;
      if (!stmts.getGroupById.get(chatId)) {
        const name = (await resolveGroupNameFromWhatsapp(chatId).catch(() => null)) || 'Grupo sin nombre';
        stmts.upsertGroup.run(chatId, name);
      }
    } else {
      userChatId = await resolveOwnChatUserId(chatId);
    }

    const hourSend = String(body.time || '');
    const daySend = String(body.date || hourSend.slice(0, 10));
    const ack = Number(msg?.ack ?? msg?._data?.ack);

    // ¿Es en realidad un envío del Nokia que perdió su enlace? Mismo chat, mismo texto,
    // reciente y sin whatsapp_msg_id: se adopta esa fila en vez de duplicarla. Ventana de 10
    // minutos en vivo; 24 h en la recuperación tras reconexión (tras un reinicio se pierden
    // los enlaces pendientes en memoria de los envíos de antes).
    // (hour_send es hora local «AAAA-MM-DD HH:MM:SS»: se resta en UTC solo para la aritmética.)
    const sendMs = Date.parse(`${hourSend.replace(' ', 'T')}Z`);
    const since = Number.isFinite(sendMs)
      ? new Date(sendMs - (msg?.isNokiaBackfill ? 24 * 3600_000 : 10 * 60_000)).toISOString().slice(0, 19).replace('T', ' ')
      : null;
    const orphan = since
      ? stmts.findUnlinkedOwnMessage.get({ text, since, user_chat_id: userChatId, group_id: groupId })
      : null;
    if (orphan) {
      stmts.setMessageWhatsappId.run(whatsappMsgId, orphan.id);
      syncOutgoingMessageAck(whatsappMsgId, ack);
      console.log(`[whatsapp] Mensaje propio enlazado a una fila del Nokia sin id (#${orphan.id}) en vez de duplicarlo.`);
      return null;
    }

    const hasMedia = Boolean(mediaInfo?.hasMedia);
    const insert = db.transaction(() => {
      const result = stmts.insertOwnMessage.run({
        text,
        day_send: daySend,
        hour_send: hourSend,
        user_chat_id: userChatId,
        group_id: groupId,
        has_media: hasMedia ? 1 : 0,
        is_sticker: Number(body.is_sticker) === 1 ? 1 : 0,
        media_key: mediaInfo?.mediaKey ?? null,
        whatsapp_msg_id: whatsappMsgId,
        quoted_text: body.quoted_text || null,
        quoted_sender: body.quoted_sender || null,
        media_type: body.media_type || null,
      });
      if (result.changes === 0) return null;
      const messageId = result.lastInsertRowid;
      if (hasMedia) {
        stmts.insertAttachment.run(
          messageId,
          mediaInfo.mediaKey ?? null,
          mediaInfo.mimeType,
          mediaInfo.filename,
          mediaInfo.bufferLength,
          mediaInfo.filePathFull || mediaInfo.originalPath,
          mediaInfo.filePathView || null,
          mediaInfo.filePathThumb || null,
          mediaInfo.durationSec ?? null,
          0,
          Math.floor(Date.now() / 1000)
        );
      }
      return messageId;
    });

    const messageId = insert();
    if (!messageId) {
      console.log(`[whatsapp] Mensaje propio ya guardado (duplicado descartado): ${whatsappMsgId}`);
      return null;
    }
    syncOutgoingMessageAck(whatsappMsgId, ack);
    console.log(`[whatsapp] 📲 Mensaje propio de otro dispositivo guardado (#${messageId}) en ${isGroup ? 'el grupo' : 'el chat'} ${groupId || userChatId}.`);
    return messageId;
  }

  client.on('message_create', async (msg) => {
    // msg._data.id a veces llega sin ._serialized poblado (mismo entorno inestable de
    // siempre) pero SÍ trae el id ya serializado bajo la clave interna '$1' — nunca usar el
    // objeto crudo tal cual (rompería el INSERT en SQLite, que solo admite texto/números).
    const whatsappMsgId = getWhatsappMessageId(msg);
    if (!whatsappMsgId) {
      console.warn(`[whatsapp] No se pudo determinar whatsapp_msg_id para un mensaje de ${msg.from} (tipo ${msg.type}) — el voto/edición en vivo no funcionará para este mensaje si es una encuesta.`);
    }

    // saveInteraction() llama a next(error) si falla el guardado — antes se le pasaba
    // () => {} (un no-op), así que cualquier error real (p.ej. un bind inválido en SQLite)
    // quedaba completamente invisible, sin log ni rastro. Con esto queda registrado.
    const logSaveInteractionError = (err) => {
      if (err) console.error('[whatsapp] Error en saveInteraction:', err.message || err);
    };

    // Registro de llamada que WhatsApp mete en el chat: se trata como llamada, no como
    // mensaje (si no, se descartaba por no tener texto).
    if (msg.type === 'call_log') {
      await handleCallLogMessage(msg, whatsappMsgId);
      return;
    }

    // Mensajes propios. Pueden venir de tres sitios:
    //   1. Del propio Nokia (web o J2ME): la fila ya la insertó el controlador al enviar, pero
    //      sin whatsapp_msg_id, porque client.sendMessage() no lo devuelve fiablemente en este
    //      entorno. Este evento sí trae el ID real (msg.id.remote ya viene como string plano)
    //      y se usa para enlazarlo a posteriori con la fila pendiente de ese chat.
    //   2. Del Nokia, pero con el envío aún en curso (el evento llega antes de que exista la
    //      fila): se deja en la cola de «observados» y el controlador lo recoge al insertar.
    //   3. De otro dispositivo (móvil, WhatsApp Web…): no hay fila ni envío en curso, así que
    //      se guarda como mensaje propio más abajo, con la misma lógica de media/citas que los
    //      entrantes, pero sin SMS, sin contador de no leídos y sin aviso sonoro en el Nokia.
    let ownFromOtherDevice = false;
    let ownChatId = null;
    if (msg.fromMe) {
      const chatId = getSerializedId(msg.id?.remote)
        || getSerializedId(msg._data?.id?.remote)
        || getSerializedId(msg.to)
        || getSerializedId(msg._data?.to);
      if (!whatsappMsgId) {
        // Sin id no hay forma segura de evitar duplicados: se omite.
        console.log(`[whatsapp] Mensaje saliente sin whatsapp_msg_id omitido (chat ${chatId || '?'}).`);
        return;
      }
      let linkedRow = false;
      if (chatId) {
        // Solo la fila pendiente de ESTE mensaje (mismo texto, o media sin pie de foto).
        const rowId = takePendingOutgoing(chatId, (id) => isSameOutgoingMessage(
          stmts.getMessageById.get(id), { body: msg.body, hasMedia: msg.hasMedia }
        ));
        if (rowId) {
          try {
            stmts.setMessageWhatsappId.run(whatsappMsgId, rowId);
            linkedRow = true;
            console.log(`[whatsapp] whatsapp_msg_id asignado a posteriori: fila local #${rowId} -> ${whatsappMsgId}`);
          } catch (err) {
            console.warn('[whatsapp] No se pudo enlazar whatsapp_msg_id:', err?.message);
          }
        }
      }
      const currentAck = Number(msg.ack ?? msg._data?.ack);
      if (linkedRow || stmts.findMessageByWhatsappId.get(whatsappMsgId)) {
        syncOutgoingMessageAck(whatsappMsgId, currentAck);
        return;
      }
      if (!chatId) return;
      if (matchesNokiaSendInFlight(chatId, { body: msg.body, hasMedia: msg.hasMedia })) {
        registerObservedOutgoing(chatId, whatsappMsgId);
        rememberPendingOutgoingAck(whatsappMsgId, currentAck);
        console.log(`[whatsapp] Mensaje saliente del Nokia aún en curso: ${whatsappMsgId} (se enlazará a su fila).`);
        return;
      }
      if (matchesNokiaSendInFlight(chatId, { anyText: true })) {
        // Diagnóstico: hay un envío del Nokia en curso a este chat pero el texto no coincide.
        // Lo normal es que sea un mensaje escrito a la vez desde otro dispositivo; si alguna
        // vez apareciera duplicado un envío del Nokia, esta línea lo explicaría.
        console.log(`[whatsapp] Envío del Nokia en curso a ${chatId} con otro texto: este se trata como de otro dispositivo.`);
      }
      if (!isSyncableOwnChat(chatId)) {
        console.log(`[whatsapp] Mensaje propio en ${chatId} (estado/difusión/canal): no se sincroniza.`);
        return;
      }
      // El mismo mensaje puede llegar también por el listener directo: solo lo guarda uno.
      if (!claimOwnMessage(whatsappMsgId)) return;
      // Los ticks que lleguen mientras se descarga la media se aplican al insertar.
      rememberPendingOutgoingAck(whatsappMsgId, currentAck);
      ownFromOtherDevice = true;
      ownChatId = chatId;
      console.log(`[whatsapp] 📲 Mensaje propio enviado desde otro dispositivo a ${chatId}: ${whatsappMsgId}`);
    }

    // IGNORAR BACKLOG: Omitimos mensajes con más de 5 minutos (300s) de antigüedad
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const messageAge = nowInSeconds - msg.timestamp;
    if (!msg.isNokiaBackfill && messageAge > 300) {
      console.log(`[whatsapp] ⏳ Mensaje omitido por antigüedad (backlog tras reconexión). Edad: ${messageAge}s, De: ${msg.from}`);
      return;
    }
    if (msg.isNokiaBackfill && messageAge > 24 * 60 * 60) {
      console.log(`[whatsapp] ⏳ Mensaje de recuperación omitido por antigüedad. Edad: ${messageAge}s, De: ${msg.from}`);
      return;
    }

    const esSticker = msg.hasMedia && msg.type === 'sticker';
    const esImagenReal = msg.hasMedia && msg.type === 'image';
    const esFotoUnaVista = esImagenReal && isViewOnceMessage(msg);
    const esPtt = msg.hasMedia && msg.type === 'ptt';
    const esAudio = msg.hasMedia && msg.type === 'audio';
    const esVideo = msg.hasMedia && msg.type === 'video';
    const esDocument = msg.hasMedia && msg.type === 'document';
    const esOtroMedia = esPtt || esAudio || esVideo || esDocument;
    // Los mensajes de ubicación no traen directPath, así que msg.hasMedia es false para
    // ellos — no se descargan con downloadMedia(), se leen directamente de msg.location.
    const esLocation = msg.type === 'location';
    const esPoll = msg.type === 'poll_creation';
    // esPoll se suma a esMediaReal aunque no tenga media real (msg.hasMedia es false para
    // encuestas, igual que en location): si no, la guarda de "sin texto y sin media" de más
    // abajo descartaría toda encuesta entrante antes de llegar al bloque que le pone body.
    const esMediaReal = esImagenReal || esSticker || esOtroMedia || esLocation || esPoll;

    const mediaType = esPoll ? 'poll'
      : esPtt ? 'ptt'
      : esAudio ? 'audio'
      : esVideo ? 'video'
      : esDocument ? 'document'
      : esLocation ? 'location'
      : null;

    if (!msg.body && !esMediaReal) {
      console.log(`[whatsapp] Mensaje sin texto de ${msg.from} (${msg.type}/${msg.mediaKey ? 'media' : 'no-media'}) — ignorado.`);
      return;
    }

    let mediaInfo = null;

    if (esFotoUnaVista) {
      const caption = typeof msg.body === 'string' ? msg.body.trim() : '';
      msg.body = caption
        ? `[Foto de visualización única] ${caption}`
        : '[Foto de visualización única]';
      console.log(`[whatsapp] Foto de visualización única recibida de ${msg.from}; no se descargará.`);
    } else if (msg.hasMedia && esImagenReal) {
      console.log(`[whatsapp] 📸 Detectado mensaje multimedia de ${msg.from}. Descargando...`);
      mediaInfo = await downloadAndProcessMedia(msg);
      if (!msg.body) {
        msg.body = '[Imagen]';
      }
    }

    if (esSticker && !msg.body) {
      msg.body = '[Sticker]';
    }

    if (msg.hasMedia && esOtroMedia) {
      console.log(`[whatsapp] 📎 Detectado mensaje de tipo "${mediaType}" de ${msg.from}. Descargando...`);
      mediaInfo = await downloadAndProcessOtherMedia(msg, mediaType);
      if (!msg.body) {
        const dur = msg.duration ? ` (${formatDuration(msg.duration)})` : '';
        msg.body = mediaType === 'document'
          ? `[Documento] ${mediaInfo?.filename || ''}`.trim()
          : `[${MEDIA_TYPE_LABELS[mediaType]}${dur}]`;
      }
    }

    if (esLocation) {
      mediaInfo = buildLocationMediaInfo(msg);
      if (!msg.body) {
        msg.body = `[Ubicación] ${mediaInfo.filename}`;
      }
    }

    if (esPoll && !msg.body) {
      msg.body = `[Encuesta] ${msg.pollName || ''}`.trim();
    }

    try {
      // Entrante: el chat es quien lo manda. Propio desde otro dispositivo: el destinatario.
      const chatId = ownFromOtherDevice ? ownChatId : (msg.from || null);
      let chat = null;
      let isGroup = Boolean(chatId && chatId.endsWith('@g.us'));

      try {
        // Para un mensaje propio basta con el sufijo del id (@g.us): getChat() pasa por la
        // misma familia de llamadas inestables («r: r») y no aporta nada más.
        if (!ownFromOtherDevice) chat = await msg.getChat();
        if (typeof chat?.isGroup === 'boolean') {
          isGroup = chat.isGroup;
        }
      } catch (chatErr) {
        console.debug(
          `[whatsapp] No se pudo resolver el chat de ${chatId || 'desconocido'}, usando fallback:`,
          chatErr?.message || chatErr
        );
      }

      // Resolver menciones en mensajes de grupo (solo mensajes nuevos)
      let resolvedBody = msg.body;
      if (isGroup && Array.isArray(msg.mentionedIds) && msg.mentionedIds.length > 0 && client) {
        resolvedBody = await resolveMentions(msg.body, msg.mentionedIds, client);
      }

      const d = new Date(msg.timestamp * 1000);
      const localDate = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
      const pad = (n) => String(n).padStart(2, '0');

      const dateStr = `${localDate.getFullYear()}-${pad(localDate.getMonth() + 1)}-${pad(localDate.getDate())}`;
      const timeStr = `${dateStr} ${pad(localDate.getHours())}:${pad(localDate.getMinutes())}:${pad(localDate.getSeconds())}`;

      let title, senderName, groupName;
      let senderNamePriority = 0;

      if (ownFromOtherDevice) {
        // El remitente soy yo: no se resuelve como contacto (msg.getContact() me devolvería a
        // mí y acabaría guardándome como el interlocutor del chat).
        title = 'Yo';
        senderName = 'Yo';
        groupName = null;
      } else if (isGroup) {
        // chat?.name viene de msg.getChat(), que puede toparse con el mismo bug de
        // "r: r" ya documentado (groupMetadata.update()) — probamos primero la vía
        // segura ya usada en el resto de la app antes de caer al ID en crudo.
        groupName = (await resolveGroupNameFromWhatsapp(chatId)) || chat?.name || chatId?.replace(/@.*$/, '') || 'Grupo sin nombre';
        try {
          const contact = await msg.getContact();
          const resolvedName = getContactDisplayName(contact);
          const personalPhone = resolvedName ? null : await resolveContactPhone(msg.author);
          senderName = resolvedName?.name || personalPhone || formatWhatsappIdentifier(msg.author);
          senderNamePriority = resolvedName?.priority || (personalPhone
            ? CONTACT_NAME_PRIORITY.PERSONAL_PHONE
            : CONTACT_NAME_PRIORITY.BUSINESS_NUMBER);
        } catch {
          const fallback = await resolveDisplayNameForChatId(msg.author);
          senderName = fallback.name;
          senderNamePriority = fallback.priority;
        }
        title = `${groupName}:${senderName}`;
      } else {
        groupName = null;
        try {
          const contact = await msg.getContact();
          const resolvedName = getContactDisplayName(contact);
          const personalPhone = resolvedName ? null : await resolveContactPhone(msg.from);
          senderName = resolvedName?.name || personalPhone || formatWhatsappIdentifier(msg.from);
          senderNamePriority = resolvedName?.priority || (personalPhone
            ? CONTACT_NAME_PRIORITY.PERSONAL_PHONE
            : CONTACT_NAME_PRIORITY.BUSINESS_NUMBER);
        } catch {
          const fallback = await resolveDisplayNameForChatId(msg.from);
          senderName = fallback.name;
          senderNamePriority = fallback.priority;
        }
        title = senderName;
      }

      // Para grupos: msg.from = ID del grupo, msg.author = ID del emisor real
      // Para chats privados: msg.from = ID del usuario, msg.author = undefined
      const senderChatId = isGroup ? (msg.author || null) : msg.from;

      // Detectar si es una respuesta (reply nativo) a otro mensaje. msg.hasQuotedMsg es el
      // único campo público de la librería para esto — msg.getQuotedMessage() hace una
      // llamada extra en vivo a Puppeteer (misma familia de bug "r: r" ya conocida en este
      // entorno para getChatById/fetchMessages), así que se evita y se lee directamente
      // msg._data.quotedMsg, que ya viene con el propio evento, sin llamada adicional.
      let quotedText = null;
      let quotedSender = null;
      if (msg.hasQuotedMsg) {
        try {
          const rawQuoted = msg._data?.quotedMsg || null;
          if (rawQuoted) {
            quotedText = getMessageQuotePreview({
              type: rawQuoted.type,
              caption: rawQuoted.caption,
              body: rawQuoted.body,
              isMedia: rawQuoted.isMedia,
              mimetype: rawQuoted.mimetype,
            });

            // Quien cita puede ser cualquiera del grupo, y a quien cita (el autor original
            // del mensaje citado) también — no tiene por qué ser ni "yo" ni quien responde
            // ahora. quotedParticipant es siempre el autor original.
            const quotedParticipant = msg._data?.quotedParticipant || rawQuoted.author || rawQuoted.from || null;
            if (quotedParticipant) {
              const quotedId = String(quotedParticipant);
              const myId = client?.info?.wid?._serialized;
              if (myId && quotedId.includes(myId)) {
                quotedSender = 'Yo';
              } else {
                quotedSender = stmts.getUserByChatId.get(quotedId)?.username || null;
                if (!quotedSender) {
                  // Mismo caso ya conocido de @lid vs @c.us para el mismo chat (ver
                  // applyChatUnreadCount) — si no hay match exacto, probar por dígitos.
                  const baseDigits = quotedId.split('@')[0];
                  if (baseDigits) {
                    quotedSender = stmts.getUserByPhonePattern.get(`${baseDigits}@%`)?.username || null;
                  }
                }
              }
            }
          }
        } catch (err) {
          console.warn('[whatsapp] No se pudo leer el mensaje citado:', err?.message);
        }
      }

      const fakeReq = {
        body: {
          title,
          message: resolvedBody,
          date: dateStr,
          time: timeStr,
          chat_id: chatId,
          sender_chat_id: senderChatId,
          whatsapp_msg_id: whatsappMsgId,
          from_me: msg.fromMe ? 1 : 0,
          chat_type: isGroup ? 'group' : 'user',
          is_group: isGroup ? 1 : 0,
          // Evita depender de partir "title" por ":" (frágil si el nombre del
          // grupo o del remitente contiene ese carácter).
          group_name: isGroup ? groupName : undefined,
          sender_name: senderName,
          sender_name_priority: senderNamePriority,
          quoted_text: quotedText,
          quoted_sender: quotedSender,
          media_type: mediaType,
        },
      };

      const mockRes = {
        statusCode: 200,
        _json: null,
        status(code) { this.statusCode = code; return this; },
        json(data) { this._json = data; },
      };

      // Guardado: entrantes por saveInteraction (contacto, no leídos, SMS); propios de otro
      // dispositivo por saveOwnMessage (from_me = 1, sin nada de eso). El resto (sticker,
      // encuesta, adjuntos) es igual para los dos.
      const persist = (request, info) => (ownFromOtherDevice
        ? saveOwnMessage(request.body, info, msg)
        : saveInteraction(request, mockRes, logSaveInteractionError, info));

      if (esPoll) {
        // Igual que el sticker: mediaInfo=null para que saveInteraction NO pase por el alta
        // genérica de attachments — una encuesta no tiene fichero, tiene opciones.
        const messageId = await persist(fakeReq, null);

        if (messageId && Array.isArray(msg.pollOptions)) {
          try {
            msg.pollOptions.forEach((opt, idx) => {
              // opt es {name, localId} en runtime (el .d.ts empaquetado dice string[], pero
              // ya está confirmado por inspección directa que es un objeto).
              const localId = typeof opt?.localId === 'number' ? opt.localId : idx;
              const name = typeof opt?.name === 'string' ? opt.name : String(opt ?? '');
              stmts.insertPollOption.run(messageId, localId, name.trim().slice(0, 200), idx);
            });
            console.log(`[whatsapp] Encuesta "${msg.pollName}" guardada con ${msg.pollOptions.length} opciones (mensaje #${messageId}).`);
          } catch (pollErr) {
            console.error('[whatsapp] Error guardando opciones de encuesta:', pollErr.message);
          }
        }
      } else if (esSticker) {
        // Guardar mensaje de sticker primero (sin media), luego procesar y adjuntar
        const stickerReq = {
          body: {
            ...fakeReq.body,
            is_sticker: 1,
          },
        };
        const messageId = await persist(stickerReq, null);

        if (messageId) {
          try {
            // Mismo sticker ya guardado: se enlaza a sus archivos sin descargar ni convertir.
            const knownKey = getStickerKey({ filehash: msg._data?.filehash || msg.rawData?.filehash });
            if (knownKey && attachExistingSticker(messageId, knownKey)) {
              stmts.markMessageHasMedia.run(messageId);
              console.log(`[whatsapp] Sticker reutilizado (${knownKey}) para el mensaje ${messageId}`);
            } else {
              const stickerMedia = await downloadMediaWithFallback(msg);
              if (stickerMedia && stickerMedia.data) {
                const buffer = Buffer.from(stickerMedia.data, 'base64');
                const stickerKey = getStickerKey({ buffer });
                if (stickerKey && attachExistingSticker(messageId, stickerKey)) {
                  console.log(`[whatsapp] Sticker reutilizado (${stickerKey}) para el mensaje ${messageId}`);
                } else {
                  await processSticker(messageId, buffer, {
                    mediaKey: stickerKey || msg.mediaKey || `sticker_${msg.id?.id || Date.now()}`,
                  });
                }
                stmts.markMessageHasMedia.run(messageId);
              }
            }
          } catch (stickerErr) {
            console.error('[whatsapp] Error procesando sticker:', stickerErr?.stack || stickerErr?.message || stickerErr);
          }
        }
      } else {
        const messageId = await persist(fakeReq, mediaInfo);
        if (
          messageId &&
          !ownFromOtherDevice &&   // tus propias notas de voz no se transcriben
          (mediaType === 'ptt' || mediaType === 'audio') &&
          mediaInfo?.originalPath
        ) {
          queueAudioTranscription(messageId, mediaInfo.originalPath);
        }
      }

      // Aviso sonoro en el Nokia solo para lo que llega de otros: lo que escribes tú desde
      // otro dispositivo aparece en la conversación sin hacer sonar la alerta.
      if (!ownFromOtherDevice) marcarNovedad(resolvedBody);

    } catch (err) {
      console.error('[whatsapp] Error en message_create:', err?.stack || err?.message || err);
    }
  });

  try {
    await client.initialize();
    console.log('[whatsapp] Cliente inicializado.');
  } catch (err) {
    console.error('[whatsapp] Error al inicializar cliente:', err.message);
    client = null;
    lastStatusChange = new Date().toISOString();

    if (hasEverAuthenticated) {
      scheduleReconnect();
    } else {
      connectionStatus = 'waiting_qr';
    }
    throw err;
  }

  setTimeout(async () => {
    if (!gotQrOrAuth && client) {
      console.log('[whatsapp] Sin QR ni autenticacion en 15s. Limpiando sesion corrupta...');
      try {
        await client.destroy();
      } catch { }
      client = null;
      hasEverAuthenticated = false;
      connectionStatus = 'waiting_qr';
      lastStatusChange = new Date().toISOString();
      try {
        const sessionDir = join(AUTH_DATA_PATH, 'session');
        if (existsSync(sessionDir)) {
          rmSync(sessionDir, { recursive: true, force: true });
          console.log('[whatsapp] Sesion corrupta eliminada.');
        }
      } catch { }
      try {
        await startWhatsappClient(storedProcessMessageFn);
      } catch { }
    }
  }, 15000);
}

export async function stopWhatsappClient() {
  if (authReadyTimer) { clearTimeout(authReadyTimer); authReadyTimer = null; }
  if (readyPollInterval) { clearInterval(readyPollInterval); readyPollInterval = null; }
  if (disconnectAlertTimer) { clearInterval(disconnectAlertTimer); disconnectAlertTimer = null; }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (!client) return;

  try {
    console.log('[whatsapp] Cerrando cliente...');
    await client.destroy();
    console.log('[whatsapp] Cliente cerrado.');
  } catch (err) {
    console.error('[whatsapp] Error al cerrar cliente:', err.message);
  } finally {
    client = null;
    currentQr = null;
    connectionStatus = 'disconnected';
    lastStatusChange = new Date().toISOString();
  }
}

export async function logoutWhatsapp() {
  if (authReadyTimer) { clearTimeout(authReadyTimer); authReadyTimer = null; }
  if (readyPollInterval) { clearInterval(readyPollInterval); readyPollInterval = null; }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (client) {
    try {
      console.log('[whatsapp] Cerrando sesion de WhatsApp...');
      await client.logout();
      await client.destroy();
    } catch (err) {
      console.error('[whatsapp] Error al cerrar sesion:', err.message);
    }
  }

  client = null;
  currentQr = null;
  hasEverAuthenticated = false;
  connectionStatus = 'waiting_qr';
  lastStatusChange = new Date().toISOString();
  reconnectAttempts = 0;

  try {
    const sessionDir = join(AUTH_DATA_PATH, 'session');
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true, force: true });
      console.log('[whatsapp] Sesion eliminada del disco.');
    }
  } catch { }

  console.log('[whatsapp] Sesion de WhatsApp cerrada. QR disponible en /whatsapp/qr');
}

async function downloadAndProcessMedia(msg) {
  try {
    const media = await downloadMediaWithFallback(msg);
    if (!media || !media.data) {
      console.log('[whatsapp] Media no disponible para msg:', msg.id);
      return null;
    }

    const { data, mimetype, filename } = media;
    const buffer = Buffer.from(data, 'base64');

    const mediaKey = msg.mediaKey || `msg_${msg.id?.id || Date.now()}`;

    const saved = await saveImageVersions(mediaKey, buffer);

    console.log(`[whatsapp] Media descargada: mediaKey=${saved.mediaKey}, orig=${buffer.length}, full=${saved.fullSize}, view=${saved.viewSize}, thumb=${saved.thumbSize}`);

    return {
      hasMedia: true,
      mediaKey: saved.mediaKey,
      mimeType: mimetype || 'image/jpeg',
      filename: filename || `media_${Date.now()}.jpg`,
      bufferLength: buffer.length,
      originalPath: saved.fullPath,
      filePathFull: saved.fullRel,
      filePathView: saved.viewRel,
      filePathThumb: saved.thumbRel,
    };
  } catch (err) {
    console.error('[whatsapp] Error downloadAndProcessMedia:', err?.stack || err?.message || err);
    return null;
  }
}

async function downloadMediaWithFallback(msg) {
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      try {
        await msg.reload();
      } catch (reloadError) {
        console.warn(`[whatsapp] No se pudieron refrescar los datos del media (intento ${attempt}):`, reloadError?.stack || reloadError);
      }
    }

    const raw = msg.rawData || msg._data || {};
    const expectedSize = Number(raw.size || msg.size);
    const isCompleteMedia = (media) => {
      if (!media?.data) return false;
      return !Number.isFinite(expectedSize)
        || expectedSize <= 0
        || Buffer.byteLength(media.data, 'base64') >= expectedSize * 0.9;
    };

    let primaryError = null;
    try {
      const media = await msg.downloadMedia();
      if (isCompleteMedia(media)) return media;
      if (media?.data && expectedSize > 0) {
        primaryError = new Error(`descarga incompleta (${Buffer.byteLength(media.data, 'base64')}/${expectedSize} bytes)`);
      }
    } catch (error) {
      primaryError = error;
    }

    const descriptor = {
      directPath: raw.directPath,
      encFilehash: raw.encFilehash,
      filehash: raw.filehash,
      mediaKey: raw.mediaKey || msg.mediaKey,
      mediaKeyTimestamp: raw.mediaKeyTimestamp,
      type: raw.type || msg.type,
      mimetype: raw.mimetype || msg.mimetype,
      filename: raw.filename || msg.filename,
      filesize: expectedSize || undefined,
    };

    if (!descriptor.directPath || !descriptor.mediaKey) {
      if (primaryError) lastError = primaryError;
      else {
        console.warn(`[whatsapp] Descarga de media vacía y faltan datos para el respaldo directo (tipo ${msg.type}).`);
        return null;
      }
    } else if (!client?.pupPage) {
      lastError = new Error('No hay una página de WhatsApp activa para la descarga directa.');
    } else {
      try {
        const media = await client.pupPage.evaluate(async (details) => {
          const downloadQpl = {
            addAnnotations() { return this; },
            addPoint() { return this; },
          };
          const data = await window
            .require('WAWebDownloadManager')
            .downloadManager.downloadAndMaybeDecrypt({
              directPath: details.directPath,
              encFilehash: details.encFilehash,
              filehash: details.filehash,
              mediaKey: details.mediaKey,
              mediaKeyTimestamp: details.mediaKeyTimestamp,
              type: details.type,
              signal: new AbortController().signal,
              downloadQpl,
            });
          return {
            data: await window.WWebJS.arrayBufferToBase64Async(data),
            mimetype: details.mimetype,
            filename: details.filename,
            filesize: details.filesize,
          };
        }, descriptor);
        if (!isCompleteMedia(media)) {
          const actualSize = media?.data ? Buffer.byteLength(media.data, 'base64') : 0;
          throw new Error(`La descarga directa devolvió un archivo incompleto (${actualSize}/${expectedSize || '?'} bytes).`);
        }
        if (primaryError) {
          console.warn(`[whatsapp] msg.downloadMedia falló (${primaryError.message}); se recuperó con descarga directa.`);
        }
        return media;
      } catch (fallbackError) {
        lastError = new Error(
          primaryError
            ? `msg.downloadMedia: ${primaryError.message}; descarga directa: ${fallbackError.message}`
            : fallbackError.message,
          { cause: fallbackError }
        );
        lastError.primaryError = primaryError;
      }
    }

    if (attempt < maxAttempts) {
      console.warn(`[whatsapp] Falló la descarga de media (${msg.type}, intento ${attempt}/${maxAttempts}); se reintentará:`, {
        message: lastError?.message,
        primaryError: lastError?.primaryError?.stack || lastError?.primaryError?.message,
        cause: lastError?.cause?.stack || lastError?.cause?.message,
      });
    }
  }

  throw new Error(`No se pudo descargar media (${msg.type}) tras ${maxAttempts} intentos: ${lastError?.message || 'error desconocido'}`, { cause: lastError });
}

const MEDIA_TYPE_LABELS = { ptt: 'Nota de voz', audio: 'Audio', video: 'Video' };

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function downloadAndProcessOtherMedia(msg, mediaType) {
  try {
    const media = await downloadMediaWithFallback(msg);
    if (!media || !media.data) {
      console.log('[whatsapp] Media no disponible para msg:', msg.id);
      return null;
    }

    const { data, mimetype, filename } = media;
    const buffer = Buffer.from(data, 'base64');
    const mediaKey = msg.mediaKey || `msg_${msg.id?.id || Date.now()}`;

    const saved = saveRawMediaFile(mediaKey, buffer, { mimeType: mimetype, filename });

    console.log(`[whatsapp] Media (${mediaType}) descargada: mediaKey=${saved.mediaKey}, size=${buffer.length}`);

    return {
      hasMedia: true,
      mediaKey: saved.mediaKey,
      mimeType: mimetype || 'application/octet-stream',
      filename: filename || `${mediaType}_${Date.now()}`,
      bufferLength: buffer.length,
      originalPath: saved.fullPath,
      filePathFull: saved.fullRel,
      filePathView: null,
      filePathThumb: null,
      durationSec: msg.duration ? Math.round(Number(msg.duration)) : null,
    };
  } catch (err) {
    console.error(`[whatsapp] Error downloadAndProcessOtherMedia (${mediaType}):`, {
      message: err?.message,
      stack: err?.stack,
      primaryError: err?.primaryError?.stack || err?.primaryError?.message,
      cause: err?.cause?.stack || err?.cause?.message,
    });
    return null;
  }
}

function buildLocationMediaInfo(msg) {
  const loc = msg.location || {};
  const label = (loc.name || loc.address || loc.description || 'Ubicación compartida').slice(0, 200);
  const mapsUrl = loc.url
    || (loc.latitude != null && loc.longitude != null ? `https://maps.google.com/?q=${loc.latitude},${loc.longitude}` : null);

  return {
    hasMedia: true,
    mediaKey: `loc_${msg.id?.id || Date.now()}`,
    mimeType: 'text/x-location',
    filename: label,
    bufferLength: 0,
    filePathFull: mapsUrl,
    filePathView: null,
    filePathThumb: null,
    durationSec: null,
  };
}

export function getQrText() {
  return currentQr;
}

export function getQrVersion() {
  return qrVersion;
}

export function getPairingPhone() {
  return String(process.env.WHATSAPP_PAIRING_PHONE || '').replace(/\D/g, '');
}

export function getPairingState() {
  const active = Boolean(client) && pairingClient === client;
  return {
    active,
    code: active ? pairingCode : null,
    error: active ? pairingError : null,
  };
}

// Cambia este cliente a vinculación por código. WhatsApp Web deja de aceptar el QR
// y emite un código nuevo cada 3 min (evento 'code') hasta que se vincula.
export function requestWhatsappPairingCode() {
  const phone = getPairingPhone();
  if (!phone) return Promise.reject(new Error('Falta WHATSAPP_PAIRING_PHONE'));
  if (!client || connectionStatus !== 'waiting_qr') {
    return Promise.reject(new Error('WhatsApp no esta esperando vinculacion'));
  }
  if (pairingClient === client && (pairingPromise || pairingCode)) {
    return pairingPromise || Promise.resolve(pairingCode);
  }

  const target = client;
  pairingClient = target;
  pairingCode = null;
  pairingError = null;
  currentQr = null;
  qrVersion += 1;
  console.log('[whatsapp] Pidiendo codigo de vinculacion...');

  pairingPromise = target.requestPairingCode(phone, true)
    .then((code) => {
      if (pairingClient === target) {
        pairingCode = code;
        qrVersion += 1;
      }
      return code;
    })
    .catch((err) => {
      console.error('[whatsapp] Error pidiendo codigo de vinculacion:', err?.message || err);
      if (pairingClient === target) {
        pairingError = 'No se pudo obtener el codigo';
        qrVersion += 1;
      }
      throw err;
    })
    .finally(() => {
      if (pairingClient === target) pairingPromise = null;
    });
  return pairingPromise;
}

export function getConnectionStatus() {
  return {
    status: connectionStatus,
    lastChange: lastStatusChange,
    hasQr: currentQr !== null,
    reconnectAttempts,
    maxReconnectAttempts: RECONNECT_MAX_ATTEMPTS,
  };
}

export function isWhatsappConnected() {
  return connectionStatus === 'connected';
}

export async function getUsersPresence(chatIds) {
  if (!client || connectionStatus !== 'connected') {
    return new Map();
  }

  const results = new Map();

  const tasks = chatIds.map(async (chatId) => {
    if (!chatId) return;
    try {
      const chat = await client.getChatById(chatId);
      const contact = await chat.getContact();
      const lastSeen = await contact.getLastSeen();
      const isOnline = lastSeen === null;
      const lastSeenTs = lastSeen ? Math.floor(lastSeen.getTime() / 1000) : null;
      results.set(chatId, { isOnline, lastSeen: lastSeenTs });
    } catch {
      results.set(chatId, { isOnline: false, lastSeen: null });
    }
  });

  await Promise.allSettled(tasks);
  return results;
}

// Sin caché: se pide todo en fresco en cada carga de la página de detalles, igual que
// getUsersPresence de arriba. La URL de la foto no se expone aquí (caduca enseguida) — solo
// si hay foto o no; para servir la imagen en sí se usa getProfilePicUrlFresh, que la vuelve a
// pedir en el momento exacto de la petición.
export async function getContactProfileInfo(chatId) {
  if (!client || connectionStatus !== 'connected' || !chatId) {
    return { hasPhoto: false, about: null, commonGroupIds: [] };
  }

  try {
    const contact = await client.getContactById(chatId);
    if (!contact) {
      return { hasPhoto: false, about: null, commonGroupIds: [] };
    }

    const [photoResult, aboutResult, groupsResult] = await Promise.allSettled([
      contact.getProfilePicUrl(),
      contact.getAbout(),
      contact.getCommonGroups(),
    ]);

    const hasPhoto = photoResult.status === 'fulfilled' && Boolean(photoResult.value);
    const about = aboutResult.status === 'fulfilled' && aboutResult.value ? aboutResult.value : null;
    const commonGroupIds = groupsResult.status === 'fulfilled' && Array.isArray(groupsResult.value)
      ? groupsResult.value.map((g) => g?._serialized || g?.id?._serialized || (typeof g === 'string' ? g : null)).filter(Boolean)
      : [];

    return { hasPhoto, about, commonGroupIds };
  } catch {
    return { hasPhoto: false, about: null, commonGroupIds: [] };
  }
}

export async function getProfilePicUrlFresh(chatId) {
  if (!client || connectionStatus !== 'connected' || !chatId) return null;
  try {
    const contact = await client.getContactById(chatId);
    if (!contact) return null;
    const url = await contact.getProfilePicUrl();
    return url || null;
  } catch {
    return null;
  }
}

export async function sendWhatsappMessage(chatId, messageText) {
  if (!client || connectionStatus !== 'connected') {
    return {
      success: false,
      error: 'WhatsApp no conectado',
      code: 'NOT_CONNECTED',
    };
  }

  if (!chatId || !messageText || typeof messageText !== 'string' || messageText.trim() === '') {
    return {
      success: false,
      error: 'ChatId o mensaje vacío',
      code: 'INVALID_INPUT',
    };
  }

  try {
    const chat = await client.getChatById(chatId);
    if (!chat) {
      return {
        success: false,
        error: 'Chat no encontrado en WhatsApp',
        code: 'CHAT_NOT_FOUND',
      };
    }

    const result = await chat.sendMessage(messageText.trim());
    console.log(`[whatsapp] ✓ Mensaje enviado a ${chatId}: ${result.id._serialized}`);

    return {
      success: true,
      messageId: result.id?._serialized || null,
      timestamp: result.timestamp,
    };
  } catch (err) {
    console.error(`[whatsapp] Error enviando mensaje a ${chatId}:`, err.message);
    return {
      success: false,
      error: err.message || 'Error desconocido al enviar',
      code: 'SEND_ERROR',
    };
  }
}

export async function sendWhatsappSeen(chatId) {
  if (!client || connectionStatus !== 'connected' || !chatId) {
    return { success: false, code: 'NOT_CONNECTED' };
  }

  try {
    const result = await sendSeenWithFallback(chatId);
    console.debug(`[whatsapp] ✓ Visto enviado a ${chatId}.`);
    return { success: true, result };
  } catch (err) {
    console.warn(`[whatsapp] No se pudo enviar visto a ${chatId}:`, err?.message || err);
    return { success: false, error: err.message || 'Error desconocido', code: 'SEND_ERROR' };
  }
}

// Aplica la selección COMPLETA y actual de un votante en una encuesta: borra su estado
// anterior en esa encuesta y reinserta desde cero lo que indique `selectedOptions`. Usado
// tanto por el evento en vivo `vote_update` como por el refresco/confirmación manual, para
// que ambos caminos mantengan el mismo invariante (nunca aplican un delta).
function applyPollVoteSelection(messageId, voterChatId, selectedOptions, votedAtTs) {
  stmts.deleteVotesForVoterInPoll.run(voterChatId, messageId);
  for (const opt of Array.isArray(selectedOptions) ? selectedOptions : []) {
    const localId = opt?.localId ?? opt?.id;
    if (localId === undefined || localId === null) continue;
    const optionRow = stmts.getPollOptionByMessageAndLocalId.get(messageId, localId);
    if (optionRow) stmts.insertPollVote.run(optionRow.id, voterChatId, votedAtTs);
  }
}

// Reimplementación de Client.prototype.getPollVotes() de whatsapp-web.js@1.34.7. La versión
// original pasa la instancia completa de Message a pupPage.evaluate() y hace
// `msg.id._serialized` ya DENTRO del navegador — pero Puppeteer no serializa esa instancia de
// clase igual que el resto de la librería (que siempre pasa `msg.id._serialized` ya como
// string), y `_serialized` llega vacío al otro lado, lo que hace fallar a
// `WAWebMsgKey.fromString()` con "str is not null or not a string". Aquí se pasa directamente
// el id como string, igual que en el resto de la librería, evitando el bug.
async function fetchPollVotesFromWhatsapp(whatsappMsgId) {
  if (!client?.pupPage) return [];
  const result = await client.pupPage.evaluate(async (msgId) => {
    try {
      const msgKey = window.require('WAWebMsgKey').fromString(msgId);
      const keyStr = msgKey.toString();
      const table = window.require('WAWebPollsVotesSchema').getTable();

      let rows = await table.equals(['parentMsgKey'], keyStr);
      let matchMode = 'exact';
      let availableMethods = null;

      if (!rows || rows.length === 0) {
        // La consulta indexada por parentMsgKey no encontró nada. En vez de adivinar un
        // método de escaneo completo (ya falló toArray en un intento previo), se listan los
        // métodos reales que expone el objeto devuelto por getTable() en ESTA versión de
        // WhatsApp Web, para saber con qué API real se puede hacer un escaneo de respaldo.
        matchMode = 'exact_empty';
        const methodSet = new Set();
        let proto = table;
        while (proto && proto !== Object.prototype) {
          Object.getOwnPropertyNames(proto).forEach((k) => {
            try {
              if (typeof table[k] === 'function') methodSet.add(k);
            } catch {
              // Algunas propiedades son getters que pueden lanzar; se ignoran.
            }
          });
          proto = Object.getPrototypeOf(proto);
        }
        availableMethods = [...methodSet];
      }

      return {
        keyStr,
        matchMode,
        availableMethods,
        votes: (rows || []).map((item) => ({
          sender: item.sender,
          senderTimestampMs: item.senderTimestampMs,
          selectedOptionLocalIds: Array.from(new Uint8Array(item.selectedOptionLocalIds)),
        })),
      };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  }, whatsappMsgId);

  if (result?.error) {
    console.error(`[whatsapp] fetchPollVotesFromWhatsapp: error evaluando en la página para ${whatsappMsgId}:`, result.error);
    return [];
  }

  console.debug(
    `[whatsapp] fetchPollVotesFromWhatsapp ${whatsappMsgId}: keyStr=${result.keyStr} matchMode=${result.matchMode} votos=${result.votes.length}`
    + (result.availableMethods ? ` métodosDisponiblesEnTable=${JSON.stringify(result.availableMethods)}` : ''),
  );

  return result.votes.map((v) => ({
    voter: getSerializedId(v.sender),
    interractedAtTs: v.senderTimestampMs,
    selectedOptions: v.selectedOptionLocalIds.map((localId) => ({ localId })),
  }));
}

// La propia cuenta puede aparecer como "sender" de un voto en formato @lid o en formato
// PN (@c.us / @s.whatsapp.net) según la migración de identidad de WhatsApp, y no siempre
// coincide con client.info.wid._serialized (mismo caso ya conocido en este archivo para
// unread counts y autor de mensajes citados — ver applyChatUnreadCount). Se resuelven ambas
// variantes de la identidad propia para no comparar solo contra una.
export async function resolveMyVoterIds(myId) {
  const ids = new Set([myId]);
  try {
    if (typeof client?.getContactLidAndPhone === 'function') {
      const [result] = await client.getContactLidAndPhone([myId]);
      const lid = getSerializedId(result?.lid);
      const pn = getSerializedId(result?.pn);
      if (lid) ids.add(lid);
      if (pn) ids.add(pn);
    }
  } catch {
    // Seguir solo con myId si no se puede resolver lid/pn.
  }
  return ids;
}

// Reimplementación de Message.prototype.vote() de whatsapp-web.js@1.34.7. La versión original
// busca el mensaje dentro del navegador vía WAWebCollections.Msg.get()/getMessagesById(), y si
// no lo encuentra retorna en silencio sin enviar nada ni avisar — y además empareja la opción
// por NOMBRE (msg.pollOptions.find(a => a.name === option)), que puede fallar si dos opciones
// comparten texto. Aquí se hace la misma llamada a WAWebPollsSendVoteMsgAction pero emparejando
// por optionLocalId (ya conocido desde nuestra BD) y devolviendo diagnóstico de cada paso en
// vez de fallar en silencio.
async function castPollVoteOnWhatsapp(whatsappMsgId, optionLocalId) {
  if (!client?.pupPage) return { error: 'pupPage no disponible' };
  return client.pupPage.evaluate(async (msgId, localId) => {
    try {
      const collections = window.require('WAWebCollections');
      let msg = collections.Msg.get(msgId);
      if (!msg) {
        const fetched = await collections.Msg.getMessagesById([msgId]);
        msg = fetched?.messages?.[0] || null;
      }
      if (!msg) return { found: false };

      const pollOptions = (msg.pollOptions || []).map((o) => ({ localId: o.localId, name: o.name }));
      if (!pollOptions.some((o) => o.localId === localId)) {
        return { found: true, pollOptions, matchExists: false };
      }

      // Msg.get()/getMessagesById() pueden devolver un mensaje "suelto", sin vincular a su
      // Chat (msg.chat vacío) — y sendVote() lo necesita para saber a quién cifrar/enviar el
      // voto, fallando con el genérico "Vote send error" si falta. Se reconstruye el mismo
      // camino de bajo nivel que usa la propia librería en getChat() (WWebJS.getChat), sin
      // pasar por getChatModel()/metadata de grupo (esa parte sí es la que falla con el bug
      // "r: r" ya conocido en este entorno).
      const hadChatBefore = !!msg.chat;
      let chatAttachError = null;
      if (!msg.chat) {
        try {
          const remoteId = msg.id?.remote;
          const remote = typeof remoteId === 'string'
            ? remoteId
            : remoteId?._serialized || remoteId?.$1 || msgId.split('_')[1];
          if (remote) {
            const chatWid = window.require('WAWebWidFactory').createWid(remote);
            const chat =
              window.require('WAWebCollections').Chat.get(chatWid) ||
              (await window.require('WAWebFindChatAction').findOrCreateLatestChat(chatWid))?.chat;
            if (chat) msg.chat = chat;
          }
        } catch (err) {
          chatAttachError = err?.message || String(err);
        }
      }

      const msgDiagnostics = {
        type: msg.type,
        hasMessageSecret: !!(msg.messageSecret && msg.messageSecret.length),
        hasPollAdditionalData: !!msg.pollAdditionalData,
        pollInvalidated: !!msg.pollInvalidated,
        hadChatBefore,
        hasChat: !!msg.chat,
        chatAttachError,
        isNewMsg: !!msg.isNewMsg,
        ack: msg.ack,
      };

      try {
        await window.require('WAWebPollsSendVoteMsgAction').sendVote(msg, new Set([localId]));
      } catch (sendErr) {
        return { found: true, pollOptions, matchExists: true, msgDiagnostics, sendError: sendErr?.message || String(sendErr) };
      }
      return { found: true, pollOptions, matchExists: true, msgDiagnostics, sent: true };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  }, whatsappMsgId, optionLocalId);
}

export async function castPollVote(whatsappMsgId, messageId, optionLocalId, optionName) {
  if (!client || connectionStatus !== 'connected' || !whatsappMsgId || !messageId || !optionName) {
    return { success: false, code: 'NOT_CONNECTED' };
  }
  try {
    const voteResult = await castPollVoteOnWhatsapp(whatsappMsgId, optionLocalId);
    if (!voteResult || voteResult.error) {
      console.error(`[whatsapp] Error enviando voto a WhatsApp para ${whatsappMsgId}:`, voteResult?.error);
      return { success: false, code: 'VOTE_ERROR', error: voteResult?.error || 'Error desconocido enviando el voto' };
    }
    if (!voteResult.found || !voteResult.matchExists) {
      console.warn(
        `[whatsapp] No se pudo enviar el voto a WhatsApp para ${whatsappMsgId}: found=${voteResult.found} matchExists=${voteResult.matchExists} optionLocalId=${optionLocalId} pollOptions=${JSON.stringify(voteResult.pollOptions)}`,
      );
      return {
        success: false,
        code: voteResult.found ? 'OPTION_NOT_FOUND' : 'MESSAGE_NOT_IN_COLLECTION',
        error: 'WhatsApp no encontró la encuesta o la opción para enviar el voto',
      };
    }
    if (voteResult.sendError) {
      console.warn(
        `[whatsapp] sendVote() falló para ${whatsappMsgId}: ${voteResult.sendError} — diagnóstico del mensaje: ${JSON.stringify(voteResult.msgDiagnostics)}`,
      );
      return { success: false, code: 'VOTE_SEND_ERROR', error: voteResult.sendError };
    }
    console.debug(`[whatsapp] sendVote() OK para ${whatsappMsgId} — diagnóstico del mensaje: ${JSON.stringify(voteResult.msgDiagnostics)}`);

    // sendVote() no confirma nada por sí mismo. Se relee la encuesta y solo se da el voto por
    // bueno (y se persiste) si aparece confirmado desde WhatsApp. La escritura del voto en la
    // tabla interna de WhatsApp Web puede tardar un instante en aparecer tras que sendVote()
    // resuelve, así que se reintenta unas pocas veces antes de darlo por no confirmado.
    const myId = getSerializedId(client?.info?.wid);
    if (!myId) return { success: false, code: 'VOTE_NOT_CONFIRMED', error: 'WhatsApp no confirmó el voto' };
    const myIds = await resolveMyVoterIds(myId);

    let myVote = null;
    let lastVotes = null;
    for (let attempt = 0; attempt < 4 && !myVote; attempt++) {
      if (attempt > 0) await delay(400);
      lastVotes = await fetchPollVotesFromWhatsapp(whatsappMsgId);
        const candidate = Array.isArray(lastVotes)
          ? lastVotes.find((v) => myIds.has(getSerializedId(v.voter)))
          : null;
      const confirmed = candidate?.selectedOptions?.some((opt) => (opt?.localId ?? opt?.id) === optionLocalId);
      if (confirmed) myVote = candidate;
    }
    if (!myVote) {
      console.warn(
        `[whatsapp] Voto no confirmado en encuesta ${whatsappMsgId}. myIds=${JSON.stringify([...myIds])} optionLocalId=${optionLocalId} votosVistos=${JSON.stringify(lastVotes)}`,
      );
      return { success: false, code: 'VOTE_NOT_CONFIRMED', error: 'WhatsApp no confirmó el voto' };
    }

    const votedAtTs = Number.isFinite(myVote.interractedAtTs)
      ? Math.floor(myVote.interractedAtTs / 1000)
      : Math.floor(Date.now() / 1000);
    // Se persiste bajo el mismo identificador con el que WhatsApp reportó el voto
    // (myVote.voter), no bajo myId — así los eventos vote_update/refresh que lleguen luego
    // para este mismo votante (que también usan el valor "en crudo" reportado por WhatsApp)
    // encuentran y sobrescriben la fila correcta en vez de crear una fila duplicada bajo
    // otra variante (@lid vs @c.us) de la misma identidad.
    applyPollVoteSelection(messageId, myVote.voter, myVote.selectedOptions, votedAtTs);
    return { success: true };
  } catch (err) {
    console.error(`[whatsapp] Error votando en encuesta ${whatsappMsgId}:`, err.message);
    return { success: false, error: err.message || 'Error desconocido', code: 'VOTE_ERROR' };
  }
}

export async function refreshPollVotesFromWhatsapp(whatsappMsgId, messageId) {
  if (!client || connectionStatus !== 'connected' || !whatsappMsgId || !messageId) {
    return { success: false, code: 'NOT_CONNECTED' };
  }
  try {
    const votes = await fetchPollVotesFromWhatsapp(whatsappMsgId);
    for (const vote of Array.isArray(votes) ? votes : []) {
      const voterChatId = getSerializedId(vote?.voter);
      if (!voterChatId) continue;
      const votedAtTs = Number.isFinite(vote.interractedAtTs)
        ? Math.floor(vote.interractedAtTs / 1000)
        : Math.floor(Date.now() / 1000);
      applyPollVoteSelection(messageId, voterChatId, vote.selectedOptions, votedAtTs);
    }
    return { success: true };
  } catch (err) {
    console.error(`[whatsapp] Error refrescando votos de encuesta ${whatsappMsgId}:`, err.message);
    return { success: false, error: err.message || 'Error desconocido', code: 'REFRESH_ERROR' };
  }
}
