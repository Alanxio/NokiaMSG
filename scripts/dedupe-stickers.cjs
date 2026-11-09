// Une los stickers repetidos que ya hay guardados: los adjuntos con el mismo contenido
// pasan a apuntar a un único juego de archivos (full/view/thumb) y se borran las copias.
//
// Uso (dentro del contenedor, que es dueño de los archivos):
//   docker exec -i nokia-msn node - --dry-run < scripts/dedupe-stickers.cjs
//   docker exec -i nokia-msn node -           < scripts/dedupe-stickers.cjs
//
// Seguridad: un archivo solo se borra si, tras actualizar la BD, ningún adjunto lo usa.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DRY_RUN = process.argv.includes('--dry-run');
const DB_PATH = process.env.DB_PATH || '/data/nokia.db';
const MEDIA_DIR = path.join(process.cwd(), 'public', 'media');
const fsPath = (rel) => (rel ? path.join(MEDIA_DIR, rel.split('/').pop()) : null);
const exists = (rel) => Boolean(rel) && fs.existsSync(fsPath(rel));
const sizeOf = (rel) => (exists(rel) ? fs.statSync(fsPath(rel)).size : 0);

const db = new Database(DB_PATH);
const rows = db.prepare(`
  SELECT a.id, a.media_key, a.file_path_full, a.file_path_view, a.file_path_thumb
  FROM attachments a JOIN messages m ON m.id = a.message_id
  WHERE m.is_sticker = 1
  ORDER BY a.id
`).all();

// Agrupar por contenido del archivo full (solo adjuntos con sus 3 archivos en disco).
const groups = new Map();
let incomplete = 0;
for (const row of rows) {
  if (![row.file_path_full, row.file_path_view, row.file_path_thumb].every(exists)) {
    incomplete += 1;
    continue;
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(fsPath(row.file_path_full))).digest('hex');
  if (!groups.has(hash)) groups.set(hash, []);
  groups.get(hash).push(row);
}

const updates = [];
for (const list of groups.values()) {
  if (list.length < 2) continue;
  const canonical = list[0]; // el más antiguo se queda como original
  for (const dup of list.slice(1)) {
    if (dup.file_path_full === canonical.file_path_full) continue; // ya compartido
    updates.push({ dup, canonical });
  }
}

const candidateFiles = new Set();
for (const { dup } of updates) {
  [dup.file_path_full, dup.file_path_view, dup.file_path_thumb].forEach((rel) => candidateFiles.add(rel));
}
const bytes = [...candidateFiles].reduce((sum, rel) => sum + sizeOf(rel), 0);

console.log(`Stickers en BD: ${rows.length} (sin archivos completos: ${incomplete})`);
console.log(`Contenidos distintos: ${groups.size}`);
console.log(`Adjuntos a reenlazar: ${updates.length}`);
console.log(`Archivos a borrar: ${candidateFiles.size} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);

if (DRY_RUN) {
  console.log('\n--dry-run: no se ha cambiado nada.');
  process.exit(0);
}

const relink = db.prepare(`
  UPDATE attachments
  SET media_key = @media_key, file_path_full = @full, file_path_view = @view, file_path_thumb = @thumb
  WHERE id = @id
`);
db.transaction(() => {
  for (const { dup, canonical } of updates) {
    relink.run({
      id: dup.id,
      media_key: canonical.media_key,
      full: canonical.file_path_full,
      view: canonical.file_path_view,
      thumb: canonical.file_path_thumb,
    });
  }
})();

const isReferenced = db.prepare(`
  SELECT 1 FROM attachments
  WHERE file_path_full = @path OR file_path_view = @path OR file_path_thumb = @path
  LIMIT 1
`);
let deleted = 0;
let freed = 0;
for (const rel of candidateFiles) {
  if (isReferenced.get({ path: rel })) continue;
  const size = sizeOf(rel);
  fs.unlinkSync(fsPath(rel));
  deleted += 1;
  freed += size;
}
console.log(`\nHecho: ${updates.length} adjuntos reenlazados, ${deleted} archivos borrados, ${(freed / 1024 / 1024).toFixed(1)} MB liberados.`);
