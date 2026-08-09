#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/nokia.db');

const { default: db, stmts } = await import('../db/db.js');
const {
  client,
  startWhatsappClient,
  stopWhatsappClient,
  isWhatsappConnected,
} = await import('../src/services/whatsapp.service.js');
const { isNumericOrJid } = await import('../src/controller/page.controller.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWhatsappConnection(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isWhatsappConnected()) {
      return true;
    }
    console.log('[migrate] Esperando conexión WhatsApp...');
    await sleep(2000);
  }
  return false;
}

async function resolveGroupName(groupId) {
  if (!client || !groupId) return null;
  try {
    const chat = await client.getChatById(groupId);
    if (chat?.name && !isNumericOrJid(chat.name)) {
      return chat.name;
    }
  } catch (err) {
    console.error(`[migrate] Error resolviendo grupo ${groupId}:`, err.message || err);
  }
  return null;
}

async function main() {
  console.log('[migrate] Usando DB_PATH =', process.env.DB_PATH);
  console.log('[migrate] Iniciando cliente WhatsApp...');

  try {
    await startWhatsappClient(() => {});
  } catch (err) {
    console.error('[migrate] No se pudo iniciar WhatsApp:', err.message || err);
    process.exit(1);
  }

  const connected = await waitForWhatsappConnection(60000);
  if (!connected) {
    console.error('[migrate] WhatsApp no se conectó en el tiempo esperado. Cierra este script y revisa sesión/QR.');
    await stopWhatsappClient();
    process.exit(1);
  }

  console.log('[migrate] WhatsApp conectado. Leyendo grupos de la base de datos...');
  const groups = db.prepare('SELECT group_id, group_name FROM wgroups').all();
  const items = groups.filter((group) => !group.group_name || group.group_name === 'Grupo sin nombre' || isNumericOrJid(group.group_name));

  if (!items.length) {
    console.log('[migrate] No hay grupos pendientes de migrar. Terminado.');
    await stopWhatsappClient();
    process.exit(0);
  }

  const results = [];
  for (const group of items) {
    const original = group.group_name || '<vacío>';
    const resolvedName = await resolveGroupName(group.group_id);
    if (resolvedName) {
      stmts.upsertGroup.run(group.group_id, resolvedName);
      results.push({ groupId: group.group_id, oldName: original, newName: resolvedName, status: 'actualizado' });
      console.log(`[migrate] ${group.group_id} → ${resolvedName}`);
    } else {
      results.push({ groupId: group.group_id, oldName: original, newName: null, status: 'no resuelto' });
      console.log(`[migrate] No se resolvió nombre para ${group.group_id} (${original})`);
    }
  }

  console.log('[migrate] Migración terminada. Actualizados:', results.filter((it) => it.status === 'actualizado').length);
  await stopWhatsappClient();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[migrate] Error inesperado:', err?.stack || err);
  try {
    await stopWhatsappClient();
  } catch (stopErr) {
    console.error('[migrate] Error cerrando WhatsApp:', stopErr?.message || stopErr);
  }
  process.exit(1);
});
