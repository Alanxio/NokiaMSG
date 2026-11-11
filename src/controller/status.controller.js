// /estado — estado del servidor para el Nokia (XHTML Mobile, muy ligero).
// Los datos los da el watchdog de GateWayNK por la red interna de Docker
// (http://watchdog:8090/api/status); esta página solo los resume. Sin tildes ni símbolos
// fuera de ASCII, como el resto de páginas, para que se vean bien en el 6111.
import { sendPage, escapeXml } from './page.controller.js';

const WATCHDOG_URL = process.env.WATCHDOG_URL || 'http://watchdog:8090/api/status';
const TZ = 'Europe/Madrid';

function ascii(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '');
}

function hhmm(ms) {
  return new Date(ms).toLocaleTimeString('es-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} dias`;
}

function bytes(n) {
  if (n == null) return '?';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function mark(ok) {
  if (ok === null || ok === undefined) return '[?]';
  return ok ? '[OK]' : '<b>[!!]</b>';
}

function line(text) {
  return `${text}<br/>`;
}

function render(st) {
  const parts = [];
  const services = st.services || [];
  const bad = services.filter((s) => s.state !== 'running' || s.health === 'unhealthy');
  const problems = bad.length + (st.problems || []).length;
  parts.push(`<p><b>${problems ? `${problems} problema(s)` : 'Todo funciona'}</b><br/>`
    + `<small>${hhmm(st.now)} - vigilando desde hace ${ascii(ago(st.startedAt))}</small></p>`);

  // Servicios
  parts.push('<p><b>Servicios</b><br/>');
  for (const s of services) {
    const ok = s.state === 'running' && s.health !== 'unhealthy';
    const extra = s.state !== 'running' ? ` (${ascii(s.state)})`
      : s.health === 'starting' ? ' (arrancando)'
      : s.memBytes != null ? ` <small>${bytes(s.memBytes)}</small>` : '';
    parts.push(line(`${mark(ok)} ${escapeXml(s.name)}${extra}`));
  }
  parts.push('</p>');

  // Entradas, WhatsApp, copias, disco
  parts.push('<p><b>Conexiones</b><br/>');
  if (st.whatsapp) {
    parts.push(line(`${mark(st.whatsapp.ok)} WhatsApp: ${escapeXml(ascii(st.whatsapp.status))}`));
  }
  for (const [name, c] of Object.entries(st.publicChecks || {})) {
    parts.push(line(`${mark(c.ok)} ${escapeXml(ascii(name))} <small>(${ascii(ago(c.checkedAt))})</small>`));
  }
  if (st.backup && st.backup.ok !== null) {
    parts.push(line(`${mark(st.backup.ok)} Copia: hace ${ascii(ago(st.backup.atMs))}${st.backup.ok ? ` <small>${bytes(st.backup.bytes)}</small>` : ''}`));
  }
  if (st.disk) {
    parts.push(line(`Disco libre: ${bytes(st.disk.freeBytes)}`));
  }
  parts.push('</p>');

  // Peticiones de la última hora
  const minutes = st.gateway?.minutes || [];
  if (minutes.length) {
    const sum = (k) => minutes.reduce((a, m) => a + (m[k] || 0), 0);
    parts.push('<p><b>Ultima hora</b><br/>'
      + line(`${sum('count')} peticiones (${sum('tls')} HTTPS, ${sum('http')} HTTP)`)
      + line(`Errores: ${sum('s5')}`)
      + '</p>');
  }

  // Últimos avisos
  const events = (st.events || []).filter((e) => e.level !== 'INFO').slice(-5).reverse();
  if (events.length) {
    parts.push('<p><b>Ultimos avisos</b><br/>');
    for (const e of events) {
      const text = ascii(e.message);
      parts.push(line(`<small>${hhmm(e.at)} ${e.level === 'OK' ? 'OK' : '!!'} ${escapeXml(text.length > 70 ? `${text.slice(0, 67)}...` : text)}</small>`));
    }
    parts.push('</p>');
  }
  return parts.join('');
}

export async function showStatus(req, res) {
  let body;
  try {
    const response = await fetch(WATCHDOG_URL, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = render(await response.json());
  } catch (err) {
    body = `<p><b>[!!] El vigilante no responde</b><br/><small>${escapeXml(ascii(err.message))}</small></p>`
      + '<p>No se puede saber el estado del resto de servicios.</p>';
  }
  sendPage(req, res, 200, 'Estado',
    `<h1>Estado</h1>${body}<p><a href="/estado">Actualizar</a> | <a href="/ajustes">Volver</a></p>`);
}
