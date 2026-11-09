import assert from "node:assert/strict";
import test from "node:test";
import { isViewOnceMessage } from "../src/utils/view-once.js";

test("detecta el indicador de visualización única en el mensaje y los datos originales", () => {
  assert.equal(isViewOnceMessage({ isViewOnce: true }), true);
  assert.equal(isViewOnceMessage({ viewOnce: true }), true);
  assert.equal(isViewOnceMessage({ rawData: { isViewOnce: true } }), true);
  assert.equal(isViewOnceMessage({ _data: { viewOnce: true } }), true);
});

test("no confunde los mensajes efímeros normales con fotos de visualización única", () => {
  assert.equal(isViewOnceMessage({ isEphemeral: true }), false);
  assert.equal(isViewOnceMessage({ rawData: { isEphemeral: true } }), false);
  assert.equal(isViewOnceMessage(null), false);
});
