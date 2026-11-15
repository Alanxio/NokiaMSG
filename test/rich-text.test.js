// Formato de WhatsApp en los mensajes: negrita, cursiva, tachado, código, citas, viñetas y enlaces.
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRichText, stripRichText } from '../src/utils/rich-text.js';

const fmt = (text) => formatRichText([{ text }]);

test('negrita, cursiva y tachado, también anidados', () => {
  assert.equal(fmt('hola *mundo* y _cursiva_'), 'hola <b>mundo</b> y <i>cursiva</i>');
  assert.equal(fmt('~no~'), '<span style="text-decoration:line-through">no</span>');
  assert.equal(fmt('*_ambas_*'), '<b><i>ambas</i></b>');
});

test('no formatea marcadores dentro de palabras ni sueltos', () => {
  assert.equal(fmt('mi_archivo_v2.txt 2*3*4'), 'mi_archivo_v2.txt 2*3*4');
  assert.equal(fmt('** vacio * no *'), '** vacio * no *');
});

test('escapa HTML del texto', () => {
  assert.equal(fmt('<b>"x" & y</b>'), '&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
});

test('enlaza URLs sin formatear su contenido y sin la puntuación final', () => {
  assert.equal(
    fmt('mira https://example.com/a_b_c?x=1&y=2. vale'),
    'mira <a href="https://example.com/a_b_c?x=1&amp;y=2">example.com/a_b_c?x=1&amp;y=2</a>. vale',
  );
  assert.equal(fmt('www.google.es'), '<a href="http://www.google.es">www.google.es</a>');
});

test('recorta el texto de URLs largas', () => {
  assert.match(fmt('https://es.wikipedia.org/wiki/Nokia_6111_largo'), />es\.wikipedia\.org\/wiki\/Nok\.\.\.<\/a>$/);
});

test('enlaza emails y teléfonos', () => {
  assert.equal(fmt('a pepe@gmail.com'), 'a <a href="mailto:pepe@gmail.com">pepe@gmail.com</a>');
  assert.equal(fmt('+34 612 34 56 78'), '<a href="wtai://wp/mc;+34612345678">+34 612 34 56 78</a>');
  assert.equal(fmt('a las 12:30 del 2026-11-15'), 'a las 12:30 del 2026-11-15');
});

test('citas, viñetas y código', () => {
  assert.equal(fmt('> cita'), '<font color="#666666">| <i>cita</i></font>');
  assert.equal(fmt('- uno\n* dos'), '&#8226; uno<br/>&#8226; dos');
  assert.equal(fmt('`*no*`'), '<font color="#555555"><tt>*no*</tt></font>');
});

test('el HTML de una mención se conserva y puede ir en negrita', () => {
  assert.equal(
    formatRichText([{ text: '*' }, { html: '<b>@Ana</b>' }, { text: '* hola' }]),
    '<b><b>@Ana</b></b> hola',
  );
});

test('stripRichText quita los marcadores para vistas previas', () => {
  assert.equal(stripRichText('*hola* _que_ `tal`\n> ok'), 'hola que tal ok');
});
