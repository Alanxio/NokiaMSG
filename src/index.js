import express from 'express';
import { basename, join } from 'path';
import { existsSync } from 'fs';
import dotenv from 'dotenv';
import router from './routes/index.js';
import { notFound, serverError } from './controller/page.controller.js';
import { startDailyCleanup, stopDailyCleanup } from './services/cleanup.service.js';
import { startWhatsappClient, stopWhatsappClient, getConnectionStatus } from './services/whatsapp.service.js';
import { saveInteraction } from './controller/notification.controller.js';
import { requireAuth } from './middlewares/auth.middleware.js';
import { cleanupOrphanMediaFiles, migrateAttachmentsToView } from './utils/media.js';

dotenv.config();

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use('/assets', requireAuth, express.static('assets'));
app.use('/media', requireAuth, express.static(join(process.cwd(), 'public/media')));

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
async function main() {
  // 0. Migrar attachments antiguos y luego limpiar archivos huérfanos
  await migrateAttachmentsToView();
  cleanupOrphanMediaFiles();

  // 1. Planificador de limpieza diaria (02:00 Europe/Madrid)
  startDailyCleanup();

  // 2. Iniciar cliente WhatsApp Web
  try {
    // FUNCIÓN ADAPTADORA: Permite que el cliente de WhatsApp mande los datos directamente a saveInteraction
    const handleIncomingMessage = async (payload) => {
      const mockReq = { body: payload };
      const mockRes = {
        status: () => mockRes,
        json: () => mockRes
      };
      const mockNext = (err) => { if (err) console.error('[main] Error en saveInteraction:', err); };
      await saveInteraction(mockReq, mockRes, mockNext);
    };

    await startWhatsappClient(handleIncomingMessage);
    console.log('[main] Cliente WhatsApp Web iniciado correctamente.');
  } catch (err) {
    console.error('[main] Error al iniciar WhatsApp Web:', err.message);
    console.log('[main] El servidor continuara. Escanea el QR en /whatsapp/qr para vincular.');
  }

  // 3. Iniciar servidor HTTP Express
  const httpServer = app.listen(PORT, () => {
    console.log(`[http] Servidor Express escuchando en puerto ${PORT}`);
  });

  // 4. Shutdown graceful al recibir señales del SO / Docker
  async function shutdown(signal) {
    console.log(`\n[main] Señal ${signal} recibida, cerrando...`);
    stopDailyCleanup();
    await stopWhatsappClient();
    httpServer.close(() => {
      console.log('[main] Servidor HTTP cerrado. Saliendo.');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[main] Error fatal al arrancar:', err);
  process.exit(1);
});
