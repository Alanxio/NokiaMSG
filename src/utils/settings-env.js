import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Archivo .env que edita la pantalla de Ajustes. En Docker se monta en /.env
// (ENV_FILE_PATH); fuera de Docker es el .env del proyecto.
export const SETTINGS_ENV_PATH = process.env.ENV_FILE_PATH || path.resolve(process.cwd(), '.env');

// Claves que se cambian desde Ajustes. Docker solo lee env_file al CREAR el
// contenedor: tras un restart/stop-start el proceso arrancaría con los valores
// antiguos aunque el .env diga otra cosa. Por eso, al arrancar, estas claves se
// toman siempre del archivo, que es la fuente de verdad.
export const SETTINGS_KEYS = [
  'SMS_NOTIFICATIONS_ENABLED',
  'SEND_READ_RECEIPTS_ENABLED',
  'DAILY_CLEANUP_ENABLED',
  'MESSAGE_RETENTION_DAYS',
];

export function loadPersistedSettings() {
  try {
    const parsed = dotenv.parse(fs.readFileSync(SETTINGS_ENV_PATH, 'utf8'));
    const applied = {};
    for (const key of SETTINGS_KEYS) {
      if (parsed[key] !== undefined) {
        process.env[key] = parsed[key];
        applied[key] = parsed[key];
      }
    }
    console.log(`[ajustes] Cargados desde ${SETTINGS_ENV_PATH}:`, applied);
  } catch (err) {
    console.warn(`[ajustes] No se pudo leer ${SETTINGS_ENV_PATH}:`, err.message);
  }
}
