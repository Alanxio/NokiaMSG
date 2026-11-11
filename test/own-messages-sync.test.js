// Sincronización de mensajes propios enviados desde otros dispositivos (móvil, WhatsApp Web):
// cómo se distinguen de los que envía el propio Nokia y cómo se evitan los duplicados.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginNokiaSend,
  claimOwnMessage,
  endNokiaSend,
  isOwnMessageClaimed,
  isSameOutgoingMessage,
  isSyncableOwnChat,
  matchesNokiaSendInFlight,
  registerObservedOutgoing,
  registerPendingOutgoing,
  takeObservedOutgoing,
  takePendingOutgoing,
} from "../src/services/pending-outgoing.service.js";

test("un mensaje propio que coincide con un envío del Nokia en curso es del Nokia", () => {
  const token = beginNokiaSend("34600111222@c.us", { text: "Hola  que tal\n" });
  try {
    assert.equal(matchesNokiaSendInFlight("34600111222@c.us", { body: "Hola que tal" }), true);
    // Mismo chat, otro texto: lo ha escrito desde el móvil a la vez → otro dispositivo.
    assert.equal(matchesNokiaSendInFlight("34600111222@c.us", { body: "Otro mensaje" }), false);
    // Mismo texto, otro chat.
    assert.equal(matchesNokiaSendInFlight("34600999888@c.us", { body: "Hola que tal" }), false);
  } finally {
    endNokiaSend(token);
  }
  // Terminado el envío, ya no se reconoce como en curso.
  assert.equal(matchesNokiaSendInFlight("34600111222@c.us", { body: "Hola que tal" }), false);
});

test("una foto sin pie enviada por el Nokia se reconoce por llevar media", () => {
  const token = beginNokiaSend("123@g.us", { text: "", hasMedia: true });
  try {
    assert.equal(matchesNokiaSendInFlight("123@g.us", { body: "", hasMedia: true }), true);
    assert.equal(matchesNokiaSendInFlight("123@g.us", { body: "texto", hasMedia: false }), false);
  } finally {
    endNokiaSend(token);
  }
});

test("el mismo id observado dos veces (dos vías de eventos) no se encola dos veces", () => {
  registerObservedOutgoing("555@c.us", "true_555@c.us_AAA");
  registerObservedOutgoing("555@c.us", "true_555@c.us_AAA");
  assert.equal(takeObservedOutgoing("555@c.us"), "true_555@c.us_AAA");
  // Si se hubiera encolado dos veces, el siguiente envío del Nokia se enlazaría a este id.
  assert.equal(takeObservedOutgoing("555@c.us"), null);
});

test("solo la primera vía que reclama un mensaje propio lo guarda", () => {
  assert.equal(claimOwnMessage("true_777@c.us_BBB"), true);
  assert.equal(claimOwnMessage("true_777@c.us_BBB"), false);
  assert.equal(isOwnMessageClaimed("true_777@c.us_BBB"), true);
  assert.equal(claimOwnMessage(null), false);
});

test("un mensaje del móvil no se queda con la fila pendiente de un envío del Nokia", () => {
  // El Nokia envió «Hola» (fila #10) y aún espera su confirmación; entretanto escribes «Voy»
  // desde el móvil en el mismo chat.
  const rows = { 10: { text: "Hola", has_media: 0 } };
  registerPendingOutgoing("888@c.us", 10);
  const accepts = (body, hasMedia = false) => (id) => isSameOutgoingMessage(rows[id], { body, hasMedia });
  assert.equal(takePendingOutgoing("888@c.us", accepts("Voy")), null, "«Voy» no es la fila del Nokia");
  assert.equal(takePendingOutgoing("888@c.us", accepts("Hola")), 10, "«Hola» sí lo es");
  assert.equal(takePendingOutgoing("888@c.us", accepts("Hola")), null, "y ya no queda pendiente");
});

test("la fila del Nokia se reconoce por su texto, o por la media si no llevaba pie", () => {
  assert.equal(isSameOutgoingMessage({ text: "Hola  ", has_media: 0 }, { body: " Hola" }), true);
  assert.equal(isSameOutgoingMessage({ text: "Hola", has_media: 0 }, { body: "Adiós" }), false);
  // Foto sin pie: el Nokia guarda «[Imagen]» y WhatsApp trae body vacío.
  assert.equal(isSameOutgoingMessage({ text: "[Imagen]", has_media: 1 }, { body: "", hasMedia: true }), true);
  assert.equal(isSameOutgoingMessage({ text: "[Imagen]", has_media: 1 }, { body: "", hasMedia: false }), false);
  assert.equal(isSameOutgoingMessage(undefined, { body: "Hola" }), false);
});

test("estados, difusiones y canales no se sincronizan", () => {
  assert.equal(isSyncableOwnChat("34600111222@c.us"), true);
  assert.equal(isSyncableOwnChat("2156789@lid"), true);
  assert.equal(isSyncableOwnChat("1203630@g.us"), true);
  assert.equal(isSyncableOwnChat("status@broadcast"), false);
  assert.equal(isSyncableOwnChat("1700000000@broadcast"), false);
  assert.equal(isSyncableOwnChat("1203630@newsletter"), false);
  assert.equal(isSyncableOwnChat(""), false);
  assert.equal(isSyncableOwnChat(null), false);
});

test("SQL: guardar mensaje propio y adoptar una fila del Nokia sin enlazar", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nokiamsn-test-"));
  process.env.DB_PATH = join(dir, "test.db");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { stmts } = await import("../db/db.js");

  stmts.upsertUser.run("34600111222@c.us", "Ana");
  stmts.upsertGroup.run("1203630@g.us", "Familia");

  // Fila enviada por el Nokia que se quedó sin whatsapp_msg_id.
  const nokiaRow = stmts.insertMessage.run("Llego en 5", "2026-11-11", "2026-11-11 20:00:00", 1, "34600111222@c.us", null, null);
  const find = (overrides) => stmts.findUnlinkedOwnMessage.get({
    text: "Llego en 5", since: "2026-11-11 19:50:00", user_chat_id: "34600111222@c.us", group_id: null, ...overrides,
  });
  assert.equal(find().id, Number(nokiaRow.lastInsertRowid));
  assert.equal(find({ text: "Otro texto" }), undefined);
  assert.equal(find({ since: "2026-11-11 20:00:01" }), undefined, "fuera de la ventana de tiempo");
  assert.equal(find({ user_chat_id: "34600999888@c.us" }), undefined, "otro chat");
  assert.equal(find({ user_chat_id: null, group_id: "1203630@g.us" }), undefined, "no confunde chat y grupo");

  // Una vez enlazada, ya no es adoptable.
  stmts.setMessageWhatsappId.run("true_34600111222@c.us_X1", nokiaRow.lastInsertRowid);
  assert.equal(find(), undefined);

  // Mensaje propio desde otro dispositivo, en un grupo (sin autor, como los del Nokia).
  const row = {
    text: "Ya voy", day_send: "2026-11-11", hour_send: "2026-11-11 20:05:00", user_chat_id: null,
    group_id: "1203630@g.us", has_media: 0, is_sticker: 0, media_key: null,
    whatsapp_msg_id: "true_1203630@g.us_Y2", quoted_text: "¿Dónde estás?", quoted_sender: "Ana", media_type: null,
  };
  const inserted = stmts.insertOwnMessage.run(row);
  assert.equal(inserted.changes, 1);
  const saved = stmts.findMessageByWhatsappId.get("true_1203630@g.us_Y2");
  assert.equal(saved.id, Number(inserted.lastInsertRowid));
  // El mismo mensaje otra vez (otra vía de eventos): se descarta sin error.
  assert.equal(stmts.insertOwnMessage.run(row).changes, 0);

  // Y queda como «yo», sin tocar los no leídos del grupo.
  const { default: db } = await import("../db/db.js");
  const stored = db.prepare("SELECT from_me, user_chat_id, quoted_sender FROM messages WHERE id = ?").get(saved.id);
  assert.deepEqual({ ...stored }, { from_me: 1, user_chat_id: null, quoted_sender: "Ana" });
  assert.equal(stmts.getGroupById.get("1203630@g.us").unseen_count, 0);
  db.close();
});
