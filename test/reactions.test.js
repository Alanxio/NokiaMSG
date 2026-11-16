// Reacciones: guardado desde message_reaction y línea de mini emojis bajo el mensaje.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'nokiamsn-reactions-test-'));
process.env.DB_PATH = join(tempDir, 'test.db');

const { default: db, stmts } = await import('../db/db.js');
const { applyReaction, getShortMessageId, getReactionsByMessage } = await import('../src/services/reaction.service.js');
const { renderChatMessages } = await import('../src/controller/chat-view.js');
const { renderMiniEmoji } = await import('../src/utils/emoji.js');

test.after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

const GROUP = '120363000000000001@g.us';
const USER = '34600000001@c.us';
stmts.upsertGroup.run(GROUP, 'Grupo');
stmts.upsertUser.run(USER, 'Ana');
const insert = (waId, { group = null, user = null, text = 'hola' } = {}) =>
  Number(stmts.insertMessage.run(text, '2026-11-16', '2026-11-16 10:00:00', 1, user, group, waId).lastInsertRowid);

const reactions = (id) => getReactionsByMessage([id]).get(id) || [];

test('id corto: tramo aleatorio del id serializado', () => {
  assert.equal(getShortMessageId('false_1203@g.us_AC12FF_436@lid'), 'AC12FF');
  assert.equal(getShortMessageId('true_346@c.us_3EB0AB'), '3EB0AB');
  assert.equal(getShortMessageId('raro'), null);
});

test('poner, cambiar y quitar: una por persona y mensaje', () => {
  const id = insert(`true_${GROUP}_3EB0R1_999@lid`, { group: GROUP });
  const msgId = { _serialized: `true_${GROUP}_3EB0R1_999@lid` };
  assert.equal(applyReaction({ msgId, senderId: '111@lid', reaction: '😂', timestamp: 100 }), 'set');
  assert.equal(applyReaction({ msgId, senderId: '222@lid', reaction: '❤️', timestamp: 101 }), 'set');
  assert.equal(applyReaction({ msgId, senderId: '111@lid', reaction: '👍', timestamp: 102 }), 'set');
  assert.deepEqual(reactions(id).map((r) => [r.sender_id, r.reaction]), [['222@lid', '❤️'], ['111@lid', '👍']]);
  assert.equal(applyReaction({ msgId, senderId: '222@lid', reaction: '', timestamp: 103 }), 'removed');
  assert.deepEqual(reactions(id).map((r) => r.reaction), ['👍']);
});

test('chat guardado como @c.us y reacción con @lid: se encuentra por el id corto', () => {
  const id = insert('true_34600000001@c.us_3EB0LID1', { user: USER });
  assert.equal(applyReaction({ msgId: 'true_99900000001@lid_3EB0LID1', senderId: '99900000001@lid', reaction: '😮' }), 'set');
  assert.equal(reactions(id)[0].reaction, '😮');
});

test('mensaje que no está en el Nokia o evento sin autor: se ignora', () => {
  assert.equal(applyReaction({ msgId: 'true_1@c.us_NOEXISTE', senderId: '1@lid', reaction: '😂' }), null);
  assert.equal(applyReaction({ msgId: 'true_1@c.us_NOEXISTE', reaction: '😂' }), null);
});

test('chat: mini emojis bajo el mensaje, agrupados y con número si hay varios', () => {
  const id = insert(`false_${GROUP}_ACVIEW1_111@lid`, { group: GROUP, text: 'mira' });
  for (const [sender, emoji] of [['1@lid', '😂'], ['2@lid', '😂'], ['3@lid', '❤️'], ['4@lid', '🦩']]) {
    applyReaction({ msgId: `false_${GROUP}_ACVIEW1_111@lid`, senderId: sender, reaction: emoji, timestamp: 200 });
  }
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  const html = renderChatMessages([message], { chatId: GROUP, type: 'group' });
  assert.match(html, /mini\/em_outline_40\.png" width="12" height="12" alt="XD" style="vertical-align:middle;"\/>2 /);
  assert.match(html, /mini\/em_heart_red\.png/);
  assert.match(html, / \*<\/font>/, 'emoji fuera de la tabla: «*»');
});

test('mini emoji: tono de piel, sin icono y desconocido', () => {
  assert.equal(renderMiniEmoji('👍🏽'), '(Y)');
  assert.match(renderMiniEmoji('❤'), /em_heart_red/);
  assert.equal(renderMiniEmoji('🦩'), '*');
});

test('borrar mensajes con reacciones (limpieza diaria / borrar chat) no falla y se llevan sus reacciones', () => {
  const id = insert('true_34600000001@c.us_3EB0DEL1', { user: USER });
  applyReaction({ msgId: 'true_34600000001@c.us_3EB0DEL1', senderId: '5@lid', reaction: '😂' });
  stmts.deleteDmMessagesByUserChatId.run(USER);
  assert.equal(reactions(id).length, 0);
});
