import "dotenv/config";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { transcribirAudio } from "../src/utils/transcribir.js";

const audioPath = process.env.AUDIO_TEST_FILE;
const missingRequirements = [
  !process.env.GROQ_API_KEY && "falta GROQ_API_KEY",
  !audioPath && "falta AUDIO_TEST_FILE",
].filter(Boolean);

test(
  "transcribe un audio y devuelve el resultado esperado",
  { skip: missingRequirements.length ? missingRequirements.join(" y ") : false },
  async () => {
    await access(audioPath);

    const result = await transcribirAudio(audioPath);

    assert.equal(typeof result.texto, "string");
    assert.ok(result.texto.trim(), "el audio de prueba debe contener voz reconocible");
    assert.equal(typeof result.idioma, "string");
    assert.ok(result.idioma);
    assert.ok(Array.isArray(result.trozos));
    assert.ok(result.trozos.length > 0);
    assert.equal(typeof result.bruto, "string");

    for (const trozo of result.trozos) {
      assert.equal(typeof trozo.desde, "number");
      assert.equal(typeof trozo.hasta, "number");
      assert.ok(trozo.hasta >= trozo.desde);
      assert.equal(typeof trozo.idioma, "string");
      assert.equal(typeof trozo.texto, "string");
    }
  }
);
