// Envío unificado (src/domain/messaging.service.js), compartido por la web y la API J2ME.
// Usa un cliente de WhatsApp falso, una BD temporal y un directorio de trabajo temporal
// (los adjuntos se escriben en <cwd>/public/media), así que no toca nada real.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalCwd = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), 'nokiamsn-send-test-'));
process.chdir(tempDir);
process.env.DB_PATH = join(tempDir, 'test.db');

const { default: db, stmts } = await import('../db/db.js');
const {
  resolveTargetJid, sendOutgoingMessages, SendMessageError, isGroupTarget,
} = await import('../src/domain/messaging.service.js');
const {
  matchesNokiaSendInFlight, registerObservedOutgoing, takePendingOutgoing, rememberPendingOutgoingAck,
} = await import('../src/services/pending-outgoing.service.js');
const { Jimp, JimpMime } = await import('jimp');

test.after(() => {
  db.close();
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

// Cliente falso: registra cada sendMessage y devuelve lo que diga `reply` (o lanza).
function fakeClient({ reply = () => ({}), contacts = {}, chats = {}, numbers = {} } = {}) {
  const calls = [];
  return {
    calls,
    async sendMessage(to, content, options) {
      const inFlight = matchesNokiaSendInFlight(to, {
        body: typeof content === 'string' ? content : options?.caption,
        hasMedia: typeof content !== 'string',
      });
      calls.push({ to, content, options, inFlight });
      return reply(calls.length, { to, content, options });
    },
    async getContactById(id) { return contacts[id] ?? null; },
    async getChatById(id) {
      if (!(id in chats)) throw new Error('chat no encontrado');
      return chats[id];
    },
    async getNumberId(number) { return numbers[number] ? { _serialized: numbers[number] } : null; },
  };
}

const row = (id) => db.prepare('SELECT * FROM messages WHERE id = ?').get(id);

test('resolveTargetJid: JID tal cual, número → JID, número sin WhatsApp → null', async () => {
  const waClient = fakeClient({ numbers: { 34600111222: '34600111222@c.us' } });
  assert.equal(await resolveTargetJid(' 123@g.us ', { waClient }), '123@g.us');
  assert.equal(await resolveTargetJid('34600111222', { waClient }), '34600111222@c.us');
  assert.equal(await resolveTargetJid(34600111222, { waClient }), '34600111222@c.us');
  assert.equal(await resolveTargetJid('34999', { waClient }), null);
  assert.equal(isGroupTarget('1@g.us', undefined), true);
  assert.equal(isGroupTarget('1@c.us', 'group'), true);
  assert.equal(isGroupTarget('1@c.us', 'user'), false);
});

test('texto a un contacto nuevo: alta con su nombre, fila propia y id enlazado', async () => {
  const jid = '34600000001@c.us';
  const waClient = fakeClient({
    contacts: { [jid]: { pushname: 'Ana' } },
    reply: () => ({ id: { _serialized: 'true_34600000001@c.us_A1' }, ack: 1 }),
  });
  const [sent] = await sendOutgoingMessages({ targetJid: jid, isGroup: false, text: 'Hola', waClient });

  assert.equal(waClient.calls.length, 1);
  assert.equal(waClient.calls[0].content, 'Hola');
  assert.deepEqual(waClient.calls[0].options, { waitUntilMsgSent: true });
  assert.equal(waClient.calls[0].inFlight, true, 'el envío está marcado «en curso» mientras se envía');
  assert.equal(matchesNokiaSendInFlight(jid, { body: 'Hola' }), false, 'y se desmarca al terminar');

  assert.equal(stmts.getUserByChatId.get(jid).username, 'Ana');
  const saved = row(sent.messageId);
  assert.equal(saved.text, 'Hola');
  assert.equal(saved.from_me, 1);
  assert.equal(saved.user_chat_id, jid);
  assert.equal(saved.group_id, null);
  assert.equal(saved.has_media, 0);
  assert.equal(saved.whatsapp_msg_id, 'true_34600000001@c.us_A1');
  assert.equal(saved.ack_status, 1, 'el ack devuelto por sendMessage se aplica');
  assert.equal(sent.whatsappMsgId, 'true_34600000001@c.us_A1');
  assert.equal(sent.text, 'Hola');
  assert.match(sent.hourSend, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(saved.hour_send, sent.hourSend);
});

test('contacto sin nombre conocido: se guarda como +número; uno ya guardado no se renombra', async () => {
  const jid = '34600000002@c.us';
  await sendOutgoingMessages({ targetJid: jid, isGroup: false, text: 'x', waClient: fakeClient() });
  assert.equal(stmts.getUserByChatId.get(jid).username, '+34600000002');

  const named = fakeClient({ contacts: { [jid]: { name: 'Luis' } } });
  await sendOutgoingMessages({ targetJid: jid, isGroup: false, text: 'y', waClient: named });
  assert.equal(stmts.getUserByChatId.get(jid).username, '+34600000002');
});

test('id con $1 en vez de _serialized también se acepta', async () => {
  const waClient = fakeClient({ reply: () => ({ id: { $1: 'true_x@c.us_B1' } }) });
  const [sent] = await sendOutgoingMessages({ targetJid: '34600000003@c.us', isGroup: false, text: 'z', waClient });
  assert.equal(row(sent.messageId).whatsapp_msg_id, 'true_x@c.us_B1');
});

test('sin id devuelto: toma el «observado» por message_create, con su ack pendiente', async () => {
  const jid = '34600000004@c.us';
  registerObservedOutgoing(jid, 'true_obs_C1');
  rememberPendingOutgoingAck('true_obs_C1', 2);
  const [sent] = await sendOutgoingMessages({ targetJid: jid, isGroup: false, text: 'obs', waClient: fakeClient() });
  assert.equal(sent.whatsappMsgId, 'true_obs_C1');
  assert.equal(row(sent.messageId).whatsapp_msg_id, 'true_obs_C1');
  assert.equal(row(sent.messageId).ack_status, 2);
});

test('sin id ni observado: la fila queda pendiente de enlazar', async () => {
  const jid = '34600000005@c.us';
  const [sent] = await sendOutgoingMessages({ targetJid: jid, isGroup: false, text: 'pend', waClient: fakeClient() });
  assert.equal(sent.whatsappMsgId, null);
  assert.equal(row(sent.messageId).whatsapp_msg_id, null);
  assert.equal(takePendingOutgoing(jid), sent.messageId);
});

test('grupo nuevo: alta con el nombre de WhatsApp; nombre en bruto se mejora; uno bueno se respeta', async () => {
  const gid = '120363000001@g.us';
  const waClient = fakeClient({ chats: { [gid]: { name: 'Familia' } } });
  const [sent] = await sendOutgoingMessages({ targetJid: gid, isGroup: true, text: 'hola grupo', waClient });
  assert.equal(stmts.getGroupById.get(gid).group_name, 'Familia');
  const saved = row(sent.messageId);
  assert.equal(saved.group_id, gid);
  assert.equal(saved.user_chat_id, null);

  const rawGid = '120363000002@g.us';
  stmts.upsertGroup.run(rawGid, '120363000002');
  await sendOutgoingMessages({
    targetJid: rawGid, isGroup: true, text: 'a', waClient: fakeClient({ chats: { [rawGid]: { name: 'Trabajo' } } }),
  });
  assert.equal(stmts.getGroupById.get(rawGid).group_name, 'Trabajo');

  await sendOutgoingMessages({
    targetJid: rawGid, isGroup: true, text: 'b', waClient: fakeClient({ chats: { [rawGid]: { name: 'Otro' } } }),
  });
  assert.equal(stmts.getGroupById.get(rawGid).group_name, 'Trabajo');

  const unknownGid = '120363000003@g.us';
  await sendOutgoingMessages({ targetJid: unknownGid, isGroup: true, text: 'c', waClient: fakeClient() });
  assert.equal(stmts.getGroupById.get(unknownGid).group_name, 'Grupo sin nombre');
});

test('respuesta citada y menciones: opciones de WhatsApp y cita guardada', async () => {
  const gid = '120363000004@g.us';
  const waClient = fakeClient({ chats: { [gid]: { name: 'Amigos' } } });
  const replyMessage = { whatsapp_msg_id: 'false_orig_D1', from_me: 0, username: 'Marta', text: 'Quedamos?' };
  const [sent] = await sendOutgoingMessages({
    targetJid: gid, isGroup: true, text: '@34600111222 vale', replyMessage, mentions: ['34600111222@c.us'], waClient,
  });
  assert.deepEqual(waClient.calls[0].options, {
    mentions: ['34600111222@c.us'],
    quotedMessageId: 'false_orig_D1',
    ignoreQuoteErrors: false,
    waitUntilMsgSent: true,
  });
  const saved = row(sent.messageId);
  assert.equal(saved.quoted_sender, 'Marta');
  assert.equal(saved.quoted_text, 'Quedamos?');

  const [own] = await sendOutgoingMessages({
    targetJid: gid, isGroup: true, text: 'yo', replyMessage: { ...replyMessage, from_me: 1 }, waClient,
  });
  assert.equal(row(own.messageId).quoted_sender, 'Yo');
});

test('dos fotos: el texto va de pie en la primera; la segunda sin pie ni menciones; adjuntos guardados', async () => {
  const jid = '34600000006@c.us';
  const jpeg = await new Jimp({ width: 8, height: 8, color: 0xff0000ff }).getBuffer(JimpMime.jpeg);
  const file = (name) => ({ buffer: jpeg, mimetype: 'image/jpeg', originalname: name });
  const waClient = fakeClient();
  const results = await sendOutgoingMessages({
    targetJid: jid,
    isGroup: false,
    text: 'mira',
    mentions: ['x@c.us'],
    mediaFiles: [{ file: file('a.jpg'), mediaType: 'image' }, { file: file('b.jpg'), mediaType: 'image' }],
    waClient,
  });

  assert.equal(waClient.calls.length, 2);
  assert.equal(waClient.calls[0].options.caption, 'mira');
  assert.deepEqual(waClient.calls[0].options.mentions, ['x@c.us']);
  assert.equal(waClient.calls[1].options.caption, '');
  assert.equal('mentions' in waClient.calls[1].options, false);
  assert.equal(waClient.calls[0].content.mimetype, 'image/jpeg');
  assert.equal(waClient.calls[0].inFlight, true);

  assert.deepEqual(results.map((r) => row(r.messageId).text), ['mira', '[Imagen]']);
  for (const r of results) {
    assert.equal(row(r.messageId).has_media, 1);
    assert.equal(stmts.getAttachmentsByMessageId.all(r.messageId).length, 1, 'adjunto guardado');
  }
});

test('video 3GP: se envía como video/3gpp y queda marcado como video', async () => {
  const waClient = fakeClient();
  const [sent] = await sendOutgoingMessages({
    targetJid: '34600000007@c.us',
    isGroup: false,
    mediaFiles: [{ file: { buffer: Buffer.from('no-es-un-video'), mimetype: 'application/octet-stream', originalname: 'v.3gp' }, mediaType: 'video' }],
    waClient,
  });
  assert.equal(waClient.calls[0].content.mimetype, 'video/3gpp');
  const saved = row(sent.messageId);
  assert.equal(saved.text, '[Video]');
  assert.equal(saved.media_type, 'video');
  assert.equal(saved.has_media, 1);
});

test('fallo de WhatsApp: SendMessageError con la causa, sin fila y sin envío «en curso» colgado', async () => {
  const jid = '34600000008@c.us';
  const cause = new Error('boom');
  const waClient = fakeClient({ reply: () => { throw cause; } });
  const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  await assert.rejects(
    sendOutgoingMessages({ targetJid: jid, isGroup: false, text: 'falla', waClient }),
    (err) => err instanceof SendMessageError && err.code === 'SEND_FAILED' && err.cause === cause,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, before);
  assert.equal(matchesNokiaSendInFlight(jid, { anyText: true }), false);
});
