// ¿Parece un identificador en bruto (JID «...@c.us/@g.us» o un número de 8+ cifras) en vez
// de un nombre legible? Se usa para no guardar/mostrar números como nombre de contacto o grupo.
export function isNumericOrJid(value = '') {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;

  if (trimmed.includes('@')) {
    return true;
  }

  const digits = trimmed.replace(/[^0-9]/g, '');
  return digits.length >= 8;
}
