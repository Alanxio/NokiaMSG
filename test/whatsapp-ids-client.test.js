// src/whatsapp/ids.js (ids de WhatsApp) y src/whatsapp/client-ref.js (referencia viva al
// cliente), extraídos de whatsapp.service.js sin cambiar su comportamiento.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSerializedId, getWhatsappMessageId } from '../src/whatsapp/ids.js';

test('getSerializedId: string, _serialized, $1 y valores no válidos', () => {
  assert.equal(getSerializedId('34600@c.us'), '34600@c.us');
  assert.equal(getSerializedId({ _serialized: 'true_x@c.us_A' }), 'true_x@c.us_A');
  assert.equal(getSerializedId({ $1: 'false_y@g.us_B' }), 'false_y@g.us_B');
  assert.equal(getSerializedId({ _serialized: 'gana', $1: 'pierde' }), 'gana');
  assert.equal(getSerializedId({ _serialized: '', $1: 'respaldo' }), 'respaldo');
  assert.equal(getSerializedId({ _serialized: 123 }), null);
  assert.equal(getSerializedId({}), null);
  assert.equal(getSerializedId(null), null);
  assert.equal(getSerializedId(undefined), null);
  assert.equal(getSerializedId(42), null);
  assert.equal(getSerializedId(''), '', 'un string se devuelve tal cual, aunque esté vacío');
});

test('getWhatsappMessageId: id → _data.id → rawData.id', () => {
  assert.equal(getWhatsappMessageId({ id: { _serialized: 'A' }, _data: { id: 'B' } }), 'A');
  assert.equal(getWhatsappMessageId({ id: {}, _data: { id: { $1: 'B' } } }), 'B');
  assert.equal(getWhatsappMessageId({ rawData: { id: 'C' } }), 'C');
  assert.equal(getWhatsappMessageId({}), null);
  assert.equal(getWhatsappMessageId(null), null);
});

test('client: setClient se ve a través de client-ref y de la fachada whatsapp.service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nokiamsn-client-ref-'));
  process.env.DB_PATH = join(dir, 'test.db');
  const ref = await import('../src/whatsapp/client-ref.js');
  const facade = await import('../src/services/whatsapp.service.js');
  const { default: db } = await import('../db/db.js');
  try {
    assert.equal(ref.client, null);
    assert.equal(facade.client, null);

    const fake = { soy: 'cliente' };
    ref.setClient(fake);
    assert.equal(ref.client, fake);
    assert.equal(facade.client, fake, 'la fachada reexporta el enlace vivo, no una copia');

    ref.setClient(null);
    assert.equal(facade.client, null);
    assert.equal(facade.isWhatsappConnected(), false);

    // Los importadores no pueden reasignarlo (solo setClient): así nadie lo pisa por error.
    assert.throws(() => { facade.client = {}; }, TypeError);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
