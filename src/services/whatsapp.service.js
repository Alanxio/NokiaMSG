import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { existsSync, writeFileSync, unlinkSync, statSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { stmts } from '../../db/db.js';
import { saveInteraction } from '../controller/notification.controller.js';
import { marcarNovedad } from './polling.service.js';
import { resolveMentions } from '../utils/mentions.js';
import { saveImageVersions, processSticker } from '../utils/media.js';
import { resolvePendingGroupNames } from '../controller/group.controller.js';

const { Client, LocalAuth } = pkg;

const AUTH_DATA_PATH = '.wwebjs_auth';
const RECONNECT_BASE_DELAY = 5000;
const RECONNECT_MAX_DELAY = 30000;
const RECONNECT_MAX_ATTEMPTS = 3;
const AUTH_READY_TIMEOUT = 25000;
const SEND_SEEN_RETRY_DELAY_MS = 250;

export let client = null;
let currentQr = null;
let connectionStatus = 'waiting_qr';
let lastStatusChange = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let authReadyTimer = null;
let storedProcessMessageFn = null;
let hasEverAuthenticated = false;
let readyPollInterval = null;

const activeChatsSinceStart = new Set();

export async function resolveContactPhone(chatId) {
  if (!client || !chatId || typeof chatId !== 'string') return null;
  const cleanChatId = chatId.trim();

  try {
    if (cleanChatId.endsWith('@lid') && typeof client.getContactLidAndPhone === 'function') {
      const [result] = await client.getContactLidAndPhone([cleanChatId]);
      const rawPhone = result?.pn && typeof result.pn === 'string'
        ? result.pn
        : result?.pn?._serialized;
      if (rawPhone) {
        const digits = String(rawPhone).replace(/[^0-9]/g, '');
        if (digits.length >= 8) {
          return `+${digits}`;
        }
      }
    }

    if (typeof client.getContactById === 'function') {
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
            // Ignorar error de formato
          }
        }
        if (typeof contact.id === 'object' && contact.id?._serialized) {
          candidateNumbers.push(contact.id._serialized);
        }

        for (const candidate of candidateNumbers) {
          if (!candidate) continue;
          const digits = String(candidate).replace(/[^0-9]/g, '');
          if (digits.length >= 8) {
            return `+${digits}`;
          }
        }
      }
    }
  } catch {
    // Ignorar cualquier error de resolución del contacto.
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
    stmts.updateGroupUnseen.run(unreadCount, chatId);
    return;
  }

  const baseDigits = chatId.split('@')[0];
  const result = stmts.updateUserUnseen.run(unreadCount, chatId, `${baseDigits}@%`);

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
        stmts.updateUserUnseen.run(unreadCount, `${altDigits}@c.us`, `${altDigits}@%`);
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

export async function syncUnreadCountsFromWhatsapp() {
  if (!client || connectionStatus !== 'connected') return;
  try {
    const chats = await getChatUnreadSummariesDirectly();
    for (const chat of chats) {
      if (chat.id) await applyChatUnreadCount(chat);
    }
    console.log(`[whatsapp] 🔄 Sincronizados contadores de no leídos con WhatsApp (${chats.length} chats).`);
  } catch (err) {
    console.warn('[whatsapp] Error sincronizando unread counts:', err.message);
  }
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

  let gotQrOrAuth = false;

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DATA_PATH }),
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

  client.on('qr', async (qr) => {
    gotQrOrAuth = true;
    console.log('\n[whatsapp] ═══════════════════════════════════════');
    console.log('[whatsapp] ESCANEA EL QR PARA VINCULAR WHATSAPP');
    console.log('[whatsapp] ═══════════════════════════════════════\n');
    qrcodeTerminal.generate(qr, { small: true });

    currentQr = qr;
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
      const whatsappMsgId = message?.id?._serialized || null;
      if (!whatsappMsgId) return;
      stmts.updateMessageAckByWhatsappId.run(ack, whatsappMsgId, ack);
    } catch (e) {
      console.error('[whatsapp] Error actualizando estado de mensaje (ack):', e.message);
    }
  });

  // Las llamadas de WhatsApp no se pueden "reenviar" a una llamada real (son audio/vídeo
  // en directo por WebRTC) — lo único posible es dejar constancia en el chat de que han
  // llamado, igual que ya se hace con los stickers.
  client.on('call', async (call) => {
    try {
      // Solo llamadas entrantes 1:1 — las salientes no necesitan aviso, y las de grupo se
      // dejan fuera porque no está claro si call.from es el JID del grupo o del que llama.
      if (call.fromMe || call.isGroup || !call.from) return;

      const callerChatId = call.from;
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const timeStr = `${dateStr} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

      const existingUser = stmts.getUserByChatId.get(callerChatId);
      const callerName = existingUser?.username || callerChatId;

      const fakeReq = {
        body: {
          title: callerName,
          message: call.isVideo ? '[Videollamada]' : '[Llamada]',
          date: dateStr,
          time: timeStr,
          chat_id: callerChatId,
          sender_chat_id: callerChatId,
          whatsapp_msg_id: `call_${call.id}`,
          from_me: 0,
          chat_type: 'user',
          is_group: 0,
          sender_name: callerName,
        },
      };
      const mockRes = {
        statusCode: 200,
        _json: null,
        status(code) { this.statusCode = code; return this; },
        json(data) { this._json = data; },
      };

      await saveInteraction(fakeReq, mockRes, () => {}, null);
      console.log(`[whatsapp] 📞 Llamada${call.isVideo ? ' de video' : ''} registrada de ${callerChatId}`);
    } catch (err) {
      console.error('[whatsapp] Error registrando llamada:', err.message);
    }
  });

  client.on('message_create', async (msg) => {
    const whatsappMsgId = msg.id?._serialized || null;

    if (msg.fromMe) {
      console.log(`[whatsapp] Mensaje saliente omitido (ya guardado por sendComposedMessage): ${whatsappMsgId}`);
      return;
    }

    // IGNORAR BACKLOG: Omitimos mensajes con más de 5 minutos (300s) de antigüedad
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const messageAge = nowInSeconds - msg.timestamp;
    if (messageAge > 300) {
      console.log(`[whatsapp] ⏳ Mensaje omitido por antigüedad (backlog tras reconexión). Edad: ${messageAge}s, De: ${msg.from}`);
      return;
    }

    const esSticker = msg.hasMedia && msg.type === 'sticker';
    const esImagenReal = msg.hasMedia && msg.type === 'image';
    const esMediaReal = esImagenReal || esSticker;

    if (!msg.body && !esMediaReal) {
      console.log(`[whatsapp] Mensaje sin texto de ${msg.from} (${msg.type}/${msg.mediaKey ? 'media' : 'no-media'}) — ignorado.`);
      return;
    }

    let mediaInfo = null;

    if (msg.hasMedia && esImagenReal) {
      console.log(`[whatsapp] 📸 Detectado mensaje multimedia de ${msg.from}. Descargando...`);
      mediaInfo = await downloadAndProcessMedia(msg);
      if (!msg.body) {
        msg.body = '[Imagen]';
      }
    }

    if (esSticker && !msg.body) {
      msg.body = '[Sticker]';
    }

    try {
      const chatId = msg.from || null;
      let chat = null;
      let isGroup = Boolean(chatId && chatId.endsWith('@g.us'));

      try {
        chat = await msg.getChat();
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

      if (isGroup) {
        groupName = chat?.name || chatId?.replace(/@.*$/, '') || 'Grupo sin nombre';
        try {
          const contact = await msg.getContact();
          senderName = contact.name || contact.pushname || contact.shortName || contact.verifiedName || msg.author?.replace(/@.*$/, '') || 'Desconocido';
        } catch {
          senderName = msg.author?.replace(/@.*$/, '') || 'Desconocido';
        }
        title = `${groupName}:${senderName}`;
      } else {
        groupName = null;
        try {
          const contact = await msg.getContact();
          senderName = contact.name || contact.pushname || contact.shortName || contact.verifiedName || msg.from.replace(/@.*$/, '') || 'Desconocido';
        } catch {
          senderName = msg.from.replace(/@.*$/, '') || 'Desconocido';
        }
        title = senderName;
      }

      // Para grupos: msg.from = ID del grupo, msg.author = ID del emisor real
      // Para chats privados: msg.from = ID del usuario, msg.author = undefined
      const senderChatId = isGroup ? (msg.author || null) : msg.from;

      const fakeReq = {
        body: {
          title,
          message: resolvedBody,
          date: dateStr,
          time: timeStr,
          chat_id: msg.from,
          sender_chat_id: senderChatId,
          whatsapp_msg_id: whatsappMsgId,
          from_me: msg.fromMe ? 1 : 0,
          chat_type: isGroup ? 'group' : 'user',
          is_group: isGroup ? 1 : 0,
          // Evita depender de partir "title" por ":" (frágil si el nombre del
          // grupo o del remitente contiene ese carácter).
          group_name: isGroup ? groupName : undefined,
          sender_name: senderName,
        },
      };

      const mockRes = {
        statusCode: 200,
        _json: null,
        status(code) { this.statusCode = code; return this; },
        json(data) { this._json = data; },
      };

      if (esSticker) {
        // Guardar mensaje de sticker primero (sin media), luego procesar y adjuntar
        const stickerReq = {
          body: {
            ...fakeReq.body,
            is_sticker: 1,
          },
        };
        const messageId = await saveInteraction(stickerReq, mockRes, () => { }, null);

        if (messageId) {
          try {
            const stickerMedia = await msg.downloadMedia();
            if (stickerMedia && stickerMedia.data) {
              const buffer = Buffer.from(stickerMedia.data, 'base64');
              await processSticker(messageId, buffer, {
                mediaKey: msg.mediaKey || `sticker_${msg.id?.id || Date.now()}`,
                filename: 'sticker.png',
              });
              stmts.markMessageHasMedia.run(messageId);
            }
          } catch (stickerErr) {
            console.error('[whatsapp] Error procesando sticker:', stickerErr.message);
          }
        }
      } else {
        await saveInteraction(fakeReq, mockRes, () => { }, mediaInfo);
      }

      marcarNovedad(resolvedBody);

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
    const media = await msg.downloadMedia();
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
    console.error('[whatsapp] Error downloadAndProcessMedia:', err.message);
    return null;
  }
}

export function getQrText() {
  return currentQr;
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
