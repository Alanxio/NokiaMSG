// Ubicación aproximada de una IP para los SMS de seguridad («Gandia, España»).
//
// Usa ip-api.com (gratis, sin cuenta; su endpoint gratuito solo va por HTTP). Solo se le
// envían IPs públicas: las privadas (Docker, red de casa, CGNAT) no se consultan.
// En datos móviles la ciudad es aproximada (suele ser donde la operadora sale a internet);
// el nombre de la operadora sí suele ser fiable.
// Si tarda o falla, devuelve null y el SMS sale igualmente sin ubicación.
const LOOKUP_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map(); // ip -> { at, value }

export function isPublicIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const v4 = ip.replace(/^::ffff:/, '');
  const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;   // Docker / privadas
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;   // CGNAT
    return a < 224;
  }
  // IPv6: descartar loopback, link-local y únicas locales
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return false;
  return lower.includes(':');
}

// Devuelve { place: 'Gandia, Comunidad Valenciana, España', city, region, country, isp } o null.
export async function lookupIpLocation(ip) {
  if (!isPublicIp(ip)) return null;
  const key = ip.replace(/^::ffff:/, '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const url = `http://ip-api.com/json/${encodeURIComponent(key)}?fields=status,country,regionName,city,isp&lang=es`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.status !== 'success') return null;
    const place = [data.city, data.regionName, data.country]
      .filter((part, i, all) => part && all.indexOf(part) === i) // sin repetir «Madrid, Madrid»
      .join(', ');
    const value = {
      place: place || null,
      city: data.city || null,
      region: data.regionName || null,
      country: data.country || null,
      isp: data.isp || null,
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.warn(`[geoip] No se pudo ubicar ${key}: ${err?.name === 'AbortError' ? 'tiempo agotado' : err?.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
