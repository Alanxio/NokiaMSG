// Arreglos de la BD (12-11-2026), probados con el código real sobre una BD y un directorio
// de trabajo temporales (la limpieza y los borrados tocan archivos relativos al cwd):
//   1. la limpieza diaria ya no infla los contadores de no leídos,
//   2. se pueden borrar chats y grupos que contienen encuestas,
//   3. un error después del COMMIT de saveInteraction no queda tapado por el ROLLBACK.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalCwd = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), 'nokiamsn-db-fixes-'));
process.chdir(tempDir);
process.env.DB_PATH = join(tempDir, 'test.db');
process.env.DAILY_CLEANUP_ENABLED = 'true';
process.env.MESSAGE_RETENTION_DAYS = '3';
// Sin Twilio: los avisos SMS que dispare saveInteraction se quedan en «desactivado».
process.env.SMS_NOTIFICATIONS_ENABLED = 'false';

const { default: db, stmts } = await import('../db/db.js');
const { runCleanup } = await import('../src/services/cleanup.service.js');
const { deleteUser } = await import('../src/controller/user.controller.js');
const { deleteGroup } = await import('../src/controller/group.controller.js');
const { saveInteraction } = await import('../src/controller/notification.controller.js');

test.after(() => {
  db.close();
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const OLD_DAY = '2020-01-01';

let seq = 0;
function addMessage({ user = null, group = null, fromMe = 0, day = TODAY }) {
  seq += 1;
  return Number(stmts.insertMessage.run(
    `m${seq}`, day, `${day} 12:00:${String(seq % 60).padStart(2, '0')}`, fromMe, user, group, `id_${seq}`
  ).lastInsertRowid);
}
function addPoll(messageId, voter) {
  const option = stmts.insertPollOption.run(messageId, 1, 'Sí', 0);
  stmts.insertPollVote.run(option.lastInsertRowid, voter, 1);
}
const setUserUnseen = (id, n) => db.prepare('UPDATE users SET unseen_count = ? WHERE chat_id = ?').run(n, id);
const setGroupUnseen = (id, n) => db.prepare('UPDATE wgroups SET unseen_count = ? WHERE group_id = ?').run(n, id);
const userUnseen = (id) => stmts.getUserByChatId.get(id)?.unseen_count;
const groupUnseen = (id) => stmts.getGroupById.get(id)?.unseen_count;
const count = (sql, ...args) => db.prepare(sql).get(...args).n;

function fakeReqRes(params) {
  const req = { params, headers: {} };
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    send(body) { this.body = body; return this; },
  };
  return { req, res };
}
async function callController(fn, params) {
  const { req, res } = fakeReqRes(params);
  let nextError = null;
  await fn(req, res, (err) => { nextError = err; });
  return { res, nextError };
}

test('1. limpieza diaria: los no leídos solo bajan hasta los recibidos que quedan', async () => {
  // A: 2 recibidos antiguos sin leer + 2 recientes sin leer → quedan 2.
  stmts.upsertUser.run('A@lid', 'A');
  addMessage({ user: 'A@lid', day: OLD_DAY });
  addMessage({ user: 'A@lid', day: OLD_DAY });
  addMessage({ user: 'A@lid' });
  addMessage({ user: 'A@lid' });
  addMessage({ user: 'A@lid', fromMe: 1 });
  setUserUnseen('A@lid', 4);
  // B: todo leído → sigue en 0 (antes pasaba a 5: el total del chat, propios incluidos).
  stmts.upsertUser.run('B@lid', 'B');
  for (let i = 0; i < 3; i++) addMessage({ user: 'B@lid' });
  for (let i = 0; i < 2; i++) addMessage({ user: 'B@lid', fromMe: 1 });
  setUserUnseen('B@lid', 0);
  // C: 1 sin leer entre 5 recientes → sigue en 1.
  stmts.upsertUser.run('C@lid', 'C');
  for (let i = 0; i < 5; i++) addMessage({ user: 'C@lid' });
  setUserUnseen('C@lid', 1);
  // Grupos: G leído (sigue en 0); H con 3 sin leer de los que 1 era antiguo → 2.
  stmts.upsertGroup.run('G@g.us', 'G');
  stmts.upsertGroup.run('H@g.us', 'H');
  addMessage({ user: 'A@lid', group: 'G@g.us', day: OLD_DAY });
  addMessage({ user: 'A@lid', group: 'G@g.us' });
  addMessage({ group: 'G@g.us', fromMe: 1 });
  setGroupUnseen('G@g.us', 0);
  const oldPoll = addMessage({ user: 'B@lid', group: 'H@g.us', day: OLD_DAY });
  addPoll(oldPoll, 'B@lid');
  addMessage({ user: 'B@lid', group: 'H@g.us' });
  addMessage({ user: 'C@lid', group: 'H@g.us' });
  setGroupUnseen('H@g.us', 3);

  await runCleanup();

  assert.equal(count(`SELECT COUNT(*) n FROM messages WHERE day_send = ?`, OLD_DAY), 0, 'antiguos borrados');
  assert.equal(count('SELECT COUNT(*) n FROM poll_options'), 0, 'encuesta antigua borrada');
  assert.equal(userUnseen('A@lid'), 2);
  assert.equal(userUnseen('B@lid'), 0);
  assert.equal(userUnseen('C@lid'), 1);
  assert.equal(groupUnseen('G@g.us'), 0);
  assert.equal(groupUnseen('H@g.us'), 2);
});

test('2a. borrar un grupo con encuesta (y voto) funciona y no deja restos', async () => {
  stmts.upsertUser.run('P@lid', 'P');
  stmts.upsertGroup.run('POLL@g.us', 'Con encuesta');
  stmts.insertParticipant.run('P@lid', 'POLL@g.us');
  const pollMsg = addMessage({ user: 'P@lid', group: 'POLL@g.us' });
  addPoll(pollMsg, 'P@lid');
  addMessage({ user: 'P@lid', group: 'POLL@g.us' });

  const { res, nextError } = await callController(deleteGroup, { id: 'POLL@g.us' });

  assert.equal(nextError, null);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Eliminado/);
  assert.equal(stmts.getGroupById.get('POLL@g.us'), undefined);
  assert.equal(count('SELECT COUNT(*) n FROM messages WHERE group_id = ?', 'POLL@g.us'), 0);
  assert.equal(count('SELECT COUNT(*) n FROM poll_options WHERE message_id = ?', pollMsg), 0);
  assert.equal(count('SELECT COUNT(*) n FROM poll_votes'), 0);
  assert.equal(db.inTransaction, false);
});

test('2b. borrar un chat individual con encuesta funciona; su encuesta de grupo se conserva', async () => {
  stmts.upsertUser.run('Q@lid', 'Q');
  stmts.upsertGroup.run('KEEP@g.us', 'Se queda');
  const dmPoll = addMessage({ user: 'Q@lid' });
  addPoll(dmPoll, 'Q@lid');
  const groupPoll = addMessage({ user: 'Q@lid', group: 'KEEP@g.us' });
  addPoll(groupPoll, 'Q@lid');

  const { res, nextError } = await callController(deleteUser, { id: 'Q@lid' });

  assert.equal(nextError, null);
  assert.equal(res.statusCode, 200);
  assert.equal(count('SELECT COUNT(*) n FROM messages WHERE user_chat_id = ? AND group_id IS NULL', 'Q@lid'), 0);
  assert.equal(count('SELECT COUNT(*) n FROM poll_options WHERE message_id = ?', dmPoll), 0);
  // Solo se borra el chat individual: el mensaje y la encuesta del grupo siguen, y el
  // contacto también (aún tiene mensajes en ese grupo).
  assert.equal(count('SELECT COUNT(*) n FROM poll_options WHERE message_id = ?', groupPoll), 1);
  assert.equal(count('SELECT COUNT(*) n FROM poll_votes'), 1);
  assert.ok(stmts.getUserByChatId.get('Q@lid'));
  assert.equal(db.inTransaction, false);
});

test('3. error tras el COMMIT de saveInteraction: llega el error real y el mensaje queda guardado', async () => {
  const realError = new Error('fallo al responder');
  const res = {
    status(code) { this.code = code; return this; },
    json() { if (this.code === 201) throw realError; return this; },
  };
  let nextError = null;
  await saveInteraction(
    {
      body: {
        title: 'Remitente', message: 'hola tras commit', chat_id: 'R@lid', sender_chat_id: 'R@lid',
        whatsapp_msg_id: 'false_R@lid_Z1', is_group: false,
      },
    },
    res,
    (err) => { nextError = err; }
  );

  assert.equal(nextError, realError, 'el error que llega es el real, no «no transaction is active»');
  assert.ok(stmts.findMessageByWhatsappId.get('false_R@lid_Z1'), 'el mensaje se guardó (COMMIT hecho)');
  assert.equal(userUnseen('R@lid'), 1);
  assert.equal(db.inTransaction, false);
});
