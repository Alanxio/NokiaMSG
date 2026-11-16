// Buscador de contactos: la misma persona por @c.us (agenda) y por @lid (perfil/BD) = un resultado.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeContactCandidates } from '../src/utils/contact-search.js';

const agenda = (chatId, name, extra = {}) => ({ chatId, displayName: name, hasRealName: true, isBusiness: false, isMyContact: true, ...extra });
const perfil = (chatId, name, extra = {}) => ({ chatId, displayName: name, hasRealName: false, isBusiness: false, isMyContact: false, ...extra });

test('número de la agenda y su @lid con otro nombre: un solo resultado con el nombre de la agenda', () => {
  const aliases = new Map([
    ['34640283895@c.us', { lid: '24850680832231@lid', pn: '34640283895@c.us' }],
    ['24850680832231@lid', { lid: '24850680832231@lid', pn: '34640283895@c.us' }],
  ]);
  const result = mergeContactCandidates([
    perfil('24850680832231@lid', 'Toni'),
    agenda('34640283895@c.us', 'Antonio Garcia'),
  ], { aliases });
  assert.equal(result.length, 1);
  assert.equal(result[0].displayName, 'Antonio Garcia');
  assert.equal(result[0].pn, '34640283895@c.us');
  assert.equal(result[0].isExistingContact, false);
});

test('si ya tiene chat en el Nokia, el resultado abre ese chat (aunque sea el @lid)', () => {
  const aliases = new Map([['34600000001@c.us', { lid: '999@lid', pn: '34600000001@c.us' }]]);
  const [result] = mergeContactCandidates([agenda('34600000001@c.us', 'Ana')], { aliases, existingIds: new Set(['999@lid']) });
  assert.equal(result.chatId, '999@lid');
  assert.equal(result.isExistingContact, true);
  assert.equal(result.displayName, 'Ana');
});

test('sin respuesta de WhatsApp: se une por nombre solo si uno es de la agenda', () => {
  const result = mergeContactCandidates([
    agenda('34600000002@c.us', 'Luis'),
    perfil('111@lid', 'luis'),
    perfil('222@lid', 'Pablo'),
    perfil('333@lid', 'Pablo'),
  ]);
  assert.deepEqual(result.map((r) => r.displayName), ['Luis', 'Pablo', 'Pablo']);
  assert.deepEqual(result[0].ids.sort(), ['111@lid', '34600000002@c.us']);
});

test('dos candidatos unidos a través de un tercero (cadena de alias) acaban en uno', () => {
  const aliases = new Map([
    ['A@lid', { lid: 'A@lid', pn: null }],
    ['346@c.us', { lid: 'A@lid', pn: '346@c.us' }],
    ['346b@c.us', { lid: null, pn: '346@c.us' }],
  ]);
  const result = mergeContactCandidates([
    perfil('A@lid', 'Eva'), perfil('346b@c.us', 'Eva trabajo', { isBusiness: true }), agenda('346@c.us', 'Eva M'),
  ], { aliases });
  assert.equal(result.length, 1);
  assert.equal(result[0].displayName, 'Eva M');
  assert.equal(result[0].isBusiness, false);
});

test('personas distintas siguen separadas y en su orden', () => {
  const result = mergeContactCandidates([agenda('1@c.us', 'Ana'), agenda('2@c.us', 'Bea'), perfil('3@lid', 'Carla')]);
  assert.deepEqual(result.map((r) => r.chatId), ['1@c.us', '2@c.us', '3@lid']);
});
