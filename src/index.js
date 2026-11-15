import express from 'express';
import { basename, join } from 'path';
import { existsSync } from 'fs';
import dotenv from 'dotenv';
import router from './routes/index.js';
import { notFound, serverError } from './controller/page.controller.js';
import { startDailyCleanup, stopDailyCleanup } from './services/cleanup.service.js';
import { startWhatsappClient, stopWhatsappClient, getConnectionStatus } from './services/whatsapp.service.js';
import { requireAuth } from './middlewares/auth.middleware.js';
import { streamSignedAudio } from './controller/message.controller.js';
import { cleanupOrphanMediaFiles, migrateAttachmentsToView } from './utils/media.js';
import { loadPersistedSettings } from './utils/settings-env.js';
import { closeDb } from '../db/db.js';

dotenv.config();
loadPersistedSettings();

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use('/assets', requireAuth, express.static('assets'));
app.use('/media', requireAuth, express.static(join(process.cwd(), 'public/media')));

// Audio de un descriptor OMA (.dd): sin cookie, protegido por URL firmada.
app.get('/audio/:id/:token/:fileName', streamSignedAudio);

// Descarga de imágenes con Content-Disposition: attachment
app.get('/descargar/:file', requireAuth, (req, res, next) => {
  try {
    const fileName = basename(req.params.file);
    const filePath = join(process.cwd(), 'public', 'media', fileName);
    if (!existsSync(filePath)) {
      return res.status(404).send('Archivo no encontrado');
    }
    res.download(filePath, fileName);
  } catch (err) {
    next(err);
  }
});

// Sin requireAuth a propósito: lo consulta el healthcheck de Docker desde dentro del
// contenedor, que no puede autenticarse con cookies. "Sano" = Express vivo y WhatsApp
// conectado, o desconectado hace poco (una reconexión normal tarda segundos, no minutos).
app.get('/healthz', (req, res) => {
  const status = getConnectionStatus();
  const msSinceChange = status.lastChange ? Date.now() - new Date(status.lastChange).getTime() : 0;
  const isHealthy = status.status === 'connected' || msSinceChange < 5 * 60 * 1000;
  res.status(isHealthy ? 200 : 503).json({ healthy: isHealthy, ...status });
});

app.use('/sounds', express.static(join(process.cwd(), 'public/sounds'), {
  maxAge: 0,
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set({
      'Cache-Control': 'no-store, no-cache',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
  },
}));

app.use(router);

app.use(notFound);
app.use(serverError);

// ──────────────────────────────────────────────────────────────────────────────
// Arranque principal
// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────
// Apagado ordenado — ÚNICO manejador de SIGTERM/SIGINT del proceso.
// Orden: dejar de aceptar HTTP → cerrar WhatsApp (Chromium) → cerrar SQLite → salir.
// Plazos pensados para el stop_grace_period de 20 s del contenedor (después Docker manda
// SIGKILL): si un paso se cuelga se sigue con el siguiente, y a los 17 s se sale sí o sí.
// ──────────────────────────────────────────────────────────────────────────────
const HTTP_DRAIN_MS = 5_000;
const WHATSAPP_STOP_MS = 8_000;
const SHUTDOWN_HARD_LIMIT_MS = 17_000;

let httpServer = null;
let shuttingDown = false;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[main] ${label}: sin terminar tras ${ms / 1000}s, se continúa.`);
      resolve();
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function closeHttpServer() {
  if (!httpServer) return Promise.resolve();
  return new Promise((resolve) => {
    // Las peticiones en curso (p. ej. un envío esperando a WhatsApp) tienen HTTP_DRAIN_MS
    // para terminar; las conexiones que sigan abiertas (long-polling del QR) se cortan.
    const forceTimer = setTimeout(() => {
      console.warn(`[http] Conexiones abiertas tras ${HTTP_DRAIN_MS / 1000}s: se cierran a la fuerza.`);
      httpServer.closeAllConnections();
    }, HTTP_DRAIN_MS);
    httpServer.close(() => {
      clearTimeout(forceTimer);
      console.log('[http] Servidor HTTP cerrado.');
      resolve();
    });
    httpServer.closeIdleConnections();
  });
}

async function shutdown(signal) {
  if (shuttingDown) {
    // npm reenvía la señal al hijo y la terminal también la manda: es normal recibirla dos
    // veces. No se fuerza la salida (el límite duro ya cubre un apagado colgado).
    console.log(`[main] Señal ${signal} recibida de nuevo; el apagado ya está en curso.`);
    return;
  }
  shuttingDown = true;
  console.log(`\n[main] Señal ${signal} recibida, cerrando...`);

  const hardLimit = setTimeout(() => {
    console.error(`[main] El apagado superó ${SHUTDOWN_HARD_LIMIT_MS / 1000}s: salida forzada.`);
    process.exit(1);
  }, SHUTDOWN_HARD_LIMIT_MS);
  hardLimit.unref();

  try {
    stopDailyCleanup();
    await closeHttpServer();
    await withTimeout(stopWhatsappClient(), WHATSAPP_STOP_MS, 'Cierre de WhatsApp');
  } catch (err) {
    console.error('[main] Error durante el apagado:', err);
  } finally {
    closeDb();
  }
  console.log('[main] Apagado completado. Saliendo.');
  process.exit(0);
}

// Se registran antes de arrancar nada: una señal durante el arranque (Chromium puede tardar
// bastante) también pasa por el apagado ordenado.
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });

async function main() {
  // 0. Migrar attachments antiguos y luego limpiar archivos huérfanos
  await migrateAttachmentsToView();
  cleanupOrphanMediaFiles();

  // 1. Planificador de limpieza diaria (02:00 Europe/Madrid)
  startDailyCleanup();

  // 2. Iniciar cliente WhatsApp Web
  try {
    await startWhatsappClient();
    console.log('[main] Cliente WhatsApp Web iniciado correctamente.');
  } catch (err) {
    console.error('[main] Error al iniciar WhatsApp Web:', err.message);
    console.log('[main] El servidor continuara. Escanea el QR en /whatsapp/qr para vincular.');
  }

  // Si llegó una señal mientras arrancaba WhatsApp, no abrir el puerto: el apagado sigue solo.
  if (shuttingDown) return;

  // 3. Iniciar servidor HTTP Express
  httpServer = app.listen(PORT, () => {
    console.log(`[http] Servidor Express escuchando en puerto ${PORT}`);
  });
}

main().catch((err) => {
  // Durante el apagado, un fallo del arranque a medias (p. ej. SQLite ya cerrada) es
  // esperable: lo termina shutdown(), no se sale aquí con código de error.
  if (shuttingDown) {
    console.warn('[main] Arranque interrumpido por el apagado:', err?.message || err);
    return;
  }
  console.error('[main] Error fatal al arrancar:', err);
  process.exit(1);
});
