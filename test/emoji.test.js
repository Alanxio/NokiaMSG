// Tabla de emojis (src/utils/emoji.js): iconos del pack, ASCII de respaldo y tamaño grande.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync } from 'node:fs';
import { convertEmojisToAscii, renderEmojisHtml, listEmojiIconFiles } from '../src/utils/emoji.js';

const DIR = new URL('../assets/outline_emojis/', import.meta.url);

test('se usan los 127 iconos del pack y todos los corazones, y existen a 16 y a 32 px', () => {
  const used = new Set(listEmojiIconFiles());
  const pack = readdirSync(DIR).filter((f) => f.endsWith('.png'));
  for (const file of pack) assert.ok(used.has(file), `${file} sin usar`);
  for (const file of used) {
    assert.ok(existsSync(new URL(file, DIR)), `falta ${file}`);
    assert.ok(existsSync(new URL(`x2/${file}`, DIR)), `falta x2/${file}`);
  }
});

test('ASCII: selector de variación, secuencias ZWJ, tonos de piel y desconocidos', () => {
  assert.equal(convertEmojisToAscii('hola ❤️ y ❤'), 'hola <3 y <3');
  assert.equal(convertEmojisToAscii('uf 😮‍💨'), 'uf :3');
  assert.equal(convertEmojisToAscii('ok 👍🏽'), 'ok (Y)');
  assert.equal(convertEmojisToAscii('🤦‍♂️ vaya'), '-_- vaya');
  assert.equal(convertEmojisToAscii('bandera 🇪🇸 fin'), 'bandera fin');
});

test('HTML: icono centrado con el texto, ASCII escapado, desconocido fuera', () => {
  const html = renderEmojisHtml('hola 😂 te quiero ❤️ 👍 🦩');
  assert.match(html, /^hola <img src="\/assets\/outline_emojis\/em_outline_40\.png" width="16" height="16" alt="XD" style="vertical-align:middle;"\/>/);
  assert.match(html, /em_heart_red\.png" width="16" height="16" alt="&lt;3"/);
  assert.match(html, /\(Y\)$/);
  assert.doesNotMatch(html, /🦩/);
});

test('solo 1–3 emojis con icono: a 32 px; con texto o con más, a 16', () => {
  assert.match(renderEmojisHtml('😂'), /x2\/em_outline_40\.png" width="32" height="32"/);
  assert.match(renderEmojisHtml('😂 ❤️'), /width="32"/);
  assert.doesNotMatch(renderEmojisHtml('😂😂😂😂'), /width="32"/);
  assert.doesNotMatch(renderEmojisHtml('jaja 😂'), /width="32"/);
  assert.doesNotMatch(renderEmojisHtml('😂 👍'), /width="32"/, '👍 no tiene icono');
});

test('variantes: el mismo mensaje sale siempre igual, y se reparten entre mensajes', () => {
  assert.equal(renderEmojisHtml('😎 qué tal'), renderEmojisHtml('😎 qué tal'));
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(renderEmojisHtml(`😎 ${i}`).match(/em_outline_(\d+)/)[1]);
  assert.equal(seen.size, 15);
});
