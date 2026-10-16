// Transcripción de notas de voz de WhatsApp (castellano + valenciano + xurro)
// npm i express multer groq-sdk   ·   necesita ffmpeg y ffprobe instalados
// GROQ_API_KEY=... node transcribir.js

import express from "express";
import multer from "multer";
import Groq from "groq-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";

const run = promisify(execFile);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 25 * 1024 * 1024 } });
const app = express();

// ===== INICIO FUNCIONES =====

// --- Configuración ---------------------------------------------------------
// Modelo completo (no turbo): algo más robusto con ruido y con valenciano/catalán
const MODELO = "whisper-large-v3";

// Prompt en xurro y con formas valencianas: le dice a Whisper que aquí se mezcla
// castellano y valenciano y que escriba "eixir", "este", "hui"... tal cual los oye.
// Lleva una frase en castellano para no sesgar la detección solo hacia valenciano.
const PROMPT_BASE =
  "Oye, que luego te llamo, ¿vale? Bueno, pues hui isc prompte de la faena. " +
  "Este xiquet és molt xicotet, es que no me'n recordava de la palabra. " +
  "Anem a vore, vine ací, que tinc huit coses. " +
  "Yeee bro, entra al Discord i fem unes partides, ok? Que tinc lag.";
// Nombres propios y palabras en inglés que salgan a menudo (juegos, apps, gente, sitios):
// "Alan, Benimaclet, UPV, Vicent, Deadlock, Steam, Twitch"
const VOCAB = process.env.VOCAB || "";
const PROMPT = VOCAB ? `${PROMPT_BASE} ${VOCAB}.` : PROMPT_BASE;

// Pasar formas del catalán central a valenciano en los trozos detectados como catalán
const VALENCIANIZAR = process.env.VALENCIANIZAR !== "0";

// Troceado por pausas
const SILENCIO_DB = Number(process.env.SILENCIO_DB || -35); // más alto (-30) si hay mucho ruido de fondo
const SILENCIO_MIN = 0.5;          // segundos de pausa para considerar un posible corte
const TROZO_MIN = 4;               // trozos más cortos detectan mal el idioma
const NO_TROCEAR_SI_MENOS_DE = 10; // notas cortas: una sola petición
const TROZOS_MAX = 12;             // free tier de Groq: 20 peticiones/minuto
const CONCURRENCIA = 3;

// --- Audio -----------------------------------------------------------------
// Limpieza suave: quita el retumbe del viento (graves) y normaliza volumen.
// Nada agresivo: un denoise fuerte empeora a Whisper en vez de ayudarle.
async function limpiar(entrada) {
  const salida = entrada + ".flac";
  await run("ffmpeg", [
    "-y", "-i", entrada,
    "-af", "highpass=f=120,afftdn=nf=-25,dynaudnorm=f=150",
    "-ac", "1", "-ar", "16000",
    salida,
  ]);
  return salida;
}

async function duracion(ruta) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", ruta,
  ]);
  return parseFloat(stdout) || 0;
}

// Busca pausas en el audio ORIGINAL solo con el paso-alto (sin normalizar,
// porque la normalización "sube" los silencios y ya no se detectan)
async function silencios(ruta) {
  const { stderr } = await run(
    "ffmpeg",
    ["-hide_banner", "-i", ruta, "-af",
      `highpass=f=120,silencedetect=noise=${SILENCIO_DB}dB:d=${SILENCIO_MIN}`,
      "-f", "null", "-"],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  const ini = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
  const fin = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  return ini.map((s, i) => ({ ini: s, fin: fin[i] ?? s }));
}

// Corta en mitad de las pausas, sin dejar trozos de menos de TROZO_MIN segundos
function planificarTrozos(dur, sil, min = TROZO_MIN) {
  if (dur < NO_TROCEAR_SI_MENOS_DE) return [{ desde: 0, hasta: dur }];
  const cortes = sil.filter((s) => s.fin < dur).map((s) => (s.ini + s.fin) / 2);
  const trozos = [];
  let desde = 0;
  for (const c of cortes) {
    if (c - desde >= min && dur - c >= min) {
      trozos.push({ desde, hasta: c });
      desde = c;
    }
  }
  trozos.push({ desde, hasta: dur });
  // Demasiados trozos (nota muy larga): agrupa más
  return trozos.length > TROZOS_MAX ? planificarTrozos(dur, sil, min * 1.5) : trozos;
}

async function cortar(ruta, { desde, hasta }, i) {
  const salida = `${ruta}.${i}.flac`;
  await run("ffmpeg", [
    "-y", "-ss", desde.toFixed(3), "-t", (hasta - desde).toFixed(3), "-i", ruta, salida,
  ]);
  return salida;
}

async function enParalelo(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    })
  );
  return out;
}

// --- Whisper ---------------------------------------------------------------
async function transcribir(ruta, language) {
  return groq.audio.transcriptions.create({
    file: createReadStream(ruta),
    model: MODELO,
    response_format: "verbose_json", // devuelve idioma detectado y confianza por segmento
    temperature: 0,
    prompt: PROMPT,
    ...(language && { language }),
  });
}

function codigoIdioma(l) {
  l = String(l || "").toLowerCase();
  if (["catalan", "ca", "valencian", "valencià"].includes(l)) return "ca";
  if (["spanish", "es", "castilian", "español"].includes(l)) return "es";
  if (["english", "en"].includes(l)) return "en";
  return l;
}

// Confianza media + descarte de "alucinaciones" en silencios / ruido
function procesar(r, forzado) {
  const segs = (r.segments || []).filter(
    (s) => !(s.no_speech_prob > 0.6 && s.avg_logprob < -1)
  );
  const conf = segs.length ? segs.reduce((a, s) => a + s.avg_logprob, 0) / segs.length : -99;
  return {
    whisper: segs.map((s) => s.text.trim()).join(" "),
    idioma: forzado || codigoIdioma(r.language),
    conf,
  };
}

async function transcribirTrozo(ruta) {
  // Autodetección por trozo: si cambias de idioma tras una pausa, cada parte va por su lado
  let r = procesar(await transcribir(ruta));
  if (r.idioma === "en") {
    // Inglés: puede ser un trozo de verdad en inglés... o valenciano/castellano con muchas
    // palabras en inglés ("entra al Deadlock, bro"). Si lo dejáramos como "en", Whisper
    // TRADUCIRÍA el valenciano al inglés. Así que comparamos las tres y gana la más segura.
    const [es, ca] = await Promise.all([transcribir(ruta, "es"), transcribir(ruta, "ca")]);
    r = [r, procesar(es, "es"), procesar(ca, "ca")].sort((a, b) => b.conf - a.conf)[0];
  } else if (r.idioma !== "es" && r.idioma !== "ca") {
    // Idioma raro (portugués, italiano...): prueba castellano y valenciano y quédate con el más seguro
    const [es, ca] = await Promise.all([transcribir(ruta, "es"), transcribir(ruta, "ca")]);
    r = [procesar(es, "es"), procesar(ca, "ca")].sort((a, b) => b.conf - a.conf)[0];
  }
  r.texto = r.idioma === "ca" && VALENCIANIZAR ? valencianizar(r.whisper) : r.whisper;
  return r;
}

// --- Formas valencianas ----------------------------------------------------
// Solo cambios seguros: palabras que en valenciano normativo (AVL) tienen otra forma
// y que no existen igual en castellano (para no tocar las palabras en castellano del xurro).
const VALENCIA = {
  // eixir (las formas "sortir/sortim/sortida..." van por la regla de prefijo de abajo)
  surto: "isc", surts: "ixes", surt: "ix", surten: "ixen",
  surti: "isca", surtis: "isques", surtin: "isquen",
  // demostrativos
  aquest: "este", aquesta: "esta", aquests: "estos", aquestes: "estes",
  // posesivos
  meva: "meua", teva: "teua", seva: "seua", meves: "meues", teves: "teues", seves: "seues",
  // otras
  // ("aquí"→"ací" NO: "aquí" también es castellano y rompería el xurro; "ací" lo cubre el prompt)
  avui: "hui", vuit: "huit", feina: "faena",
  petit: "xicotet", petita: "xicoteta", petits: "xicotets", petites: "xicotetes",
  noi: "xic", noia: "xica", nois: "xics", noies: "xiques",
};

function conservarMayus(orig, nueva) {
  const c = orig[0];
  return c !== c.toLowerCase() ? nueva[0].toUpperCase() + nueva.slice(1) : nueva;
}

function valencianizar(t) {
  return t.replace(/\p{L}+/gu, (w) => {
    const l = w.toLowerCase();
    let v = VALENCIA[l];
    // sortir→eixir, sortim→eixim, sortida→eixida... (lista cerrada para no tocar "sortija", "sorteo")
    if (!v && /^sort(?:i(?:r|m|u|a|es|en|da|des|t|ts|nt|ré|ràs|rà|rem|reu|ran|ria|ries|rien)|íem|íeu|í)$/.test(l))
      v = "eix" + l.slice(4);
    if (!v && /^veur/.test(l)) v = "vor" + l.slice(4);      // veure→vore, veurem→vorem, veuràs→voràs
    return v ? conservarMayus(w, v) : w;
  });
}

// --- Limpieza del texto: muletillas, tartamudeos y palabras repetidas ------
// Conservador a propósito: "em" (em dic...), "ah", "ha", "o sea" se respetan.
const MULETILLAS =
  /(?<!\p{L})(?:e+h+m*|e{2,}m*|e+m{2,}|a{2,}h*|a+h{2,}|m{2,}h*|h+m+|u+h*m+|o{3,})(?!\p{L})(?:\.{3}|…|,)?/giu;
// "pe-pe-perdona" -> "perdona", "n-no" -> "no"
const TARTAMUDEO = /(?<!\p{L})(\p{L}{1,4})(?:-\1)*-(?=\1)/giu;
// "que que que" -> "que", "el, el" -> "el"   (pero "sí sí", "no no", "muy muy", "molt molt" se quedan)
const REPETIDAS = /(?<!\p{L})(\p{L}+)(?:[\s,]+\1)+(?!\p{L})/giu;
const REPETICION_INTENCIONADA = new Set(["sí", "si", "no", "muy", "molt", "ja", "va", "venga", "vale", "bueno", "bye", "ok", "yes"]);

function limpiarTexto(t) {
  t = t
    .replace(MULETILLAS, "")
    .replace(TARTAMUDEO, "")
    .replace(REPETIDAS, (m, w) => (REPETICION_INTENCIONADA.has(w.toLowerCase()) ? m : w))
    .replace(/\s*,\s*(,\s*)+/g, ", ")    // ", ," -> ","
    .replace(/\s+([,.?!…])/g, "$1")      // espacio antes de puntuación
    .replace(/,+\s*([.?!…])/g, "$1")     // ",." -> "."
    .replace(/^[\s,.…]+/, "")            // basura al principio
    .replace(/[\s,]+$/, "")              // coma colgando al final
    .replace(/\s{2,}/g, " ")
    .trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ===== FIN FUNCIONES =====

const cache = new Map(); // hash del audio -> resultado (cámbialo por Redis/SQLite si quieres persistir)

app.post("/transcribir", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Falta el campo 'audio'" });
  const temporales = [req.file.path];
  try {
    const buf = await fs.readFile(req.file.path);
    const hash = crypto.createHash("sha1").update(buf).digest("hex");
    if (cache.has(hash)) return res.json(cache.get(hash));

    const limpio = await limpiar(req.file.path);
    temporales.push(limpio);

    const dur = await duracion(limpio);
    const trozos = planificarTrozos(dur, await silencios(req.file.path));

    const resultados = await enParalelo(trozos, CONCURRENCIA, async (t, i) => {
      const ruta = trozos.length === 1 ? limpio : await cortar(limpio, t, i);
      if (ruta !== limpio) temporales.push(ruta);
      return { ...t, ...(await transcribirTrozo(ruta)) };
    });

    // Idioma principal = el que más segundos ocupa
    const seg = {};
    for (const r of resultados) seg[r.idioma] = (seg[r.idioma] || 0) + (r.hasta - r.desde);
    const idioma = Object.entries(seg).sort((a, b) => b[1] - a[1])[0]?.[0];

    const resultado = {
      texto: limpiarTexto(resultados.map((r) => r.texto).filter(Boolean).join(" ")),
      idioma,
      // Por trozo, para ver dónde has cambiado de idioma
      trozos: resultados.map((r) => ({
        desde: +r.desde.toFixed(1),
        hasta: +r.hasta.toFixed(1),
        idioma: r.idioma,
        texto: limpiarTexto(r.texto),
      })),
      // Lo que devolvió Whisper sin tocar (sin limpiar ni valencianizar)
      bruto: resultados.map((r) => r.whisper).filter(Boolean).join(" "),
    };
    cache.set(hash, resultado);
    res.json(resultado);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo transcribir" });
  } finally {
    for (const f of temporales) fs.unlink(f).catch(() => {});
  }
});

app.listen(3000, () => console.log("Transcriptor en :3000  →  POST /transcribir (campo 'audio')"));
