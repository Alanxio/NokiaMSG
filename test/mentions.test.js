// Menciones: escribir «@ana» desde el Nokia y mostrar «@Nombre Apellido» sin comerse la frase.
import assert from "node:assert/strict";
import test from "node:test";
import {
  findComposeMentions,
  mentionsEveryone,
  normalizeName,
  splitMentions,
  stripBidiIsolates,
} from "../src/utils/mention-text.js";

const people = [
  { id: "34600111222@c.us", name: "Ana García" },
  { id: "34600333444@c.us", name: "Anabel" },
  { id: "218734001@lid", name: "José Luis Pérez 🎸" },
  { id: "34600555666@c.us", name: "Paula" },
  { id: "34600777888@c.us", name: "Paula Martín" },
];

test("normaliza nombres sin tildes, mayúsculas ni emojis", () => {
  assert.equal(normalizeName("José Luis Pérez 🎸"), "jose luis perez");
  assert.equal(normalizeName("  ANA   García! "), "ana garcia");
});

test("«@ana» se completa con Ana García (Anabel no se llama Ana de primer nombre)", () => {
  const r = findComposeMentions("hola @ana qué tal", people);
  assert.equal(r.sendText, "hola @34600111222 qué tal");
  assert.deepEqual(r.mentionedIds, ["34600111222@c.us"]);
  assert.deepEqual(r.ambiguous, []);
});

test("vale el apellido, varias palabras y sin tildes", () => {
  assert.equal(findComposeMentions("@garcia mira", people).sendText, "@34600111222 mira");
  assert.equal(findComposeMentions("@jose luis ven", people).sendText, "@218734001 ven");
  assert.equal(findComposeMentions("@perez", people).sendText, "@218734001");
});

test("no se traga palabras cortas ni la puntuación", () => {
  // «a» tiene una letra: no forma parte del nombre aunque «Ana A…» existiera.
  assert.equal(findComposeMentions("@ana a las 5", people).sendText, "@34600111222 a las 5");
  assert.equal(findComposeMentions("@anabel, ven!", people).sendText, "@34600333444, ven!");
});

test("si encaja más de una persona, pregunta; con la elección, la usa", () => {
  // «@paula» es exactamente «Paula» → sin duda.
  assert.equal(findComposeMentions("@paula hola", people).sendText, "@34600555666 hola");
  // «@pau» encaja con las dos y ninguna es exacta → hay que preguntar.
  const r = findComposeMentions("@pau hola", people);
  assert.equal(r.ambiguous.length, 1);
  assert.equal(r.ambiguous[0].query, "@pau");
  assert.deepEqual(r.ambiguous[0].candidates.map((c) => c.name), ["Paula", "Paula Martín"]);
  assert.equal(r.sendText, "@pau hola");
  const picked = findComposeMentions("@pau hola", people, { 0: "34600777888@c.us" });
  assert.equal(picked.sendText, "@34600777888 hola");
  assert.deepEqual(picked.ambiguous, []);
});

test("varias menciones, correos y «@» sueltas", () => {
  const r = findComposeMentions("@ana y @jose: escribid a info@ejemplo.com @ nada @zzz", people);
  assert.equal(r.sendText, "@34600111222 y @218734001: escribid a info@ejemplo.com @ nada @zzz");
  assert.deepEqual(r.mentionedIds, ["34600111222@c.us", "218734001@lid"]);
});

test("la misma persona por número y por LID no cuenta como dos", () => {
  const dup = [{ id: "111@lid", name: "Ana García" }, { id: "34600111222@c.us", name: "Ana García" }];
  const r = findComposeMentions("@ana", dup);
  assert.equal(r.sendText, "@111");
  assert.deepEqual(r.ambiguous, []);
});

test("al mostrar: el nombre conocido entero, y nunca el resto de la frase", () => {
  const names = ["Alanxio 07", "Nahuel Upv", "Ana"];
  // Caso real: antes salía toda la frase resaltada.
  const parts = splitMentions("@Alanxio 07 @Nahuel Upv\u2069 on esteu?", names);
  assert.deepEqual(parts, [
    { mention: true, name: "Alanxio 07" },
    { text: " " },
    { mention: true, name: "Nahuel Upv" },
    { text: " on esteu?" },
  ]);
  // Lo que no es un nombre conocido ni un número no se resalta (usuarios de redes, etc.).
  assert.deepEqual(splitMentions("sígueme en @pepito_92 y @Desconocido", names), [
    { text: "sígueme en @pepito_92 y @Desconocido" },
  ]);
  // «Ana» conocido no se confunde con «Anabel» (que no lo es).
  assert.deepEqual(splitMentions("@Anabel", names), [{ text: "@Anabel" }]);
  // Número / LID: sí es mención (así viajan las del Nokia y las no resueltas).
  assert.deepEqual(splitMentions("ven @34600111222, @218734001", names), [
    { text: "ven " }, { mention: true, name: "34600111222" }, { text: ", " }, { mention: true, name: "218734001" },
  ]);
  // Un número corto (una hora, un precio) no.
  assert.deepEqual(splitMentions("a las @17 o @1700", names), [{ text: "a las @17 o @1700" }]);
  // Correos y arrobas sueltas no son menciones.
  assert.deepEqual(splitMentions("a@b.com @ x", names), [{ text: "a@b.com @ x" }]);
  // Un dominio suelto tampoco, aunque vaya tras un espacio; pero un punto final sí cierra
  // una mención normal.
  assert.deepEqual(splitMentions("el dominio es @gmail.com", names), [{ text: "el dominio es @gmail.com" }]);
  assert.deepEqual(splitMentions("gracias @Nahuel Upv.", names), [{ text: "gracias " }, { mention: true, name: "Nahuel Upv" }, { text: "." }]);
});

test("casos reales: nombres con emojis, nombre pegado y «@all»", () => {
  const names = ["💞GirlEmø💞", "Juliana🏹", "Marijuana🌿", "Alanxio 07", "Mario"];
  // WhatsApp quita los emojis al mencionar.
  assert.deepEqual(splitMentions("@GirlEmø estate listo", names), [{ mention: true, name: "GirlEmø" }, { text: " estate listo" }]);
  assert.deepEqual(splitMentions("@Juliana", names), [{ mention: true, name: "Juliana" }]);
  assert.deepEqual(splitMentions("@Marijuana ten vens ?", names), [{ mention: true, name: "Marijuana" }, { text: " ten vens ?" }]);
  assert.deepEqual(splitMentions("@Marijuana🌿 vota", names), [{ mention: true, name: "Marijuana🌿" }, { text: " vota" }]);
  // Nombre acabado en número con la palabra siguiente pegada.
  assert.deepEqual(splitMentions("@Alanxio 07tu estaras", names), [{ mention: true, name: "Alanxio 07" }, { text: "tu estaras" }]);
  // Mención a todo el grupo.
  assert.deepEqual(splitMentions("cómo vais??? @all", names), [{ text: "cómo vais??? " }, { mention: true, name: "all", everyone: true }]);
  assert.equal(mentionsEveryone("en mi @all"), true);
  assert.equal(mentionsEveryone("@todos a las 5"), true);
  assert.equal(mentionsEveryone("ball@all.com, @allison"), false);
});

test("quita los caracteres invisibles que el 6111 pinta como cuadros", () => {
  assert.equal(stripBidiIsolates("\u2068@Ana\u2069 hola"), "@Ana hola");
});

test("avisa de las «@algo» que no encajan con nadie (para buscar más nombres)", () => {
  const r = findComposeMentions("@zzz y @ana", people);
  assert.deepEqual(r.unmatched, ["@zzz"]);
  assert.equal(r.sendText, "@zzz y @34600111222");
});

test("render en el Nokia: nombre exacto, «@Tú» propio y número resuelto a nombre", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "nokiamsn-mentions-"));
  process.env.DB_PATH = join(dir, "test.db");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { stmts, default: db } = await import("../db/db.js");
  const { setMyIdentity } = await import("../src/utils/my-identity.js");
  const { renderMentions } = await import("../src/controller/page.controller.js");

  stmts.upsertUser.run("999888777@lid", "Alanxio 07");      // yo
  stmts.upsertUser.run("34600111222@c.us", "Nahuel Upv");
  stmts.upsertUser.run("218734001@lid", "José Luis");
  setMyIdentity(["34611222333@c.us", "999888777@lid"], ["Alanxio"]);

  assert.equal(
    renderMentions("@Alanxio 07 @Nahuel Upv\u2069 on esteu?"),
    '<font color="#cc0000"><b>@Tú</b></font> <font color="#000099"><b>@Nahuel Upv</b></font> on esteu?'
  );
  // Lo que envía el Nokia viaja con el número / LID: se muestra con el nombre.
  assert.equal(renderMentions("@218734001 ven"), '<font color="#000099"><b>@José Luis</b></font> ven');
  // Mi número también es «@Tú».
  assert.equal(renderMentions("@34611222333"), '<font color="#cc0000"><b>@Tú</b></font>');
  // Escapado y saltos de línea intactos.
  assert.equal(renderMentions("a<b>\n@Nahuel Upv"), 'a&lt;b&gt;<br/><font color="#000099"><b>@Nahuel Upv</b></font>');

  // «@» en la bandeja: solo si la mención está entre los no leídos.
  stmts.upsertGroup.run("1203630@g.us", "Familia");
  const insert = db.prepare("INSERT INTO messages (text, day_send, hour_send, group_id, mentions_me) VALUES (?, '2026-11-11', '2026-11-11 10:00:00', '1203630@g.us', ?)");
  insert.run("@Tú mira", 1);
  insert.run("otro", 0);
  insert.run("y otro", 0);
  assert.ok(stmts.groupHasUnreadMention.get("1203630@g.us", 3), "3 sin leer: incluye la mención");
  assert.equal(stmts.groupHasUnreadMention.get("1203630@g.us", 2), undefined, "2 sin leer: la mención ya se leyó");
  db.close();
});
