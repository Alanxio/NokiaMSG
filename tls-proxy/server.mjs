// nokia-tls — HTTPS «a la antigua» para el Nokia 6111, delante del Gateway.
//
// El 6111 solo habla TLS 1.0 (sin SNI ni extensiones) y solo se fía de nuestra raíz
// propia (RSA 2048 + SHA-1, instalada en el teléfono). Este servicio:
//   · recibe la conexión cruda del túnel TCP de ngrok. Si llega cabecera PROXY v1 la usa
//     para saber la IP real del teléfono; la cuenta gratuita «legacy» de ngrok NO permite
//     proxy_proto (ERR_NGROK_9014), así que normalmente no llega y la IP es la del agente,
//   · descifra TLS 1.0 con AES (lo único antiguo que permite el OpenSSL 3 de Node 18),
//   · reenvía cada petición HTTP al Gateway añadiendo X-Nokia-TLS, X-Forwarded-Host y
//     X-Forwarded-For (la IP real; la que mande el cliente se descarta).
// En HTTP en claro por el mismo puerto solo sirve /ca.cer (para reinstalar la raíz) y una
// página que remite a https://.
//
// Ficheros en /tls (volumen ../NokiaMSN/data/tls):
//   ca.key, ca.pem, ca.cer   raíz propia (NO regenerar: está instalada en el Nokia)
//   public-address           «host:puerto» público actual, lo escribe expose.sh
//   server-<host>.pem/.key   certificado del servidor para ese host (se genera solo)
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { execFileSync } from 'node:child_process';

const TLS_DIR = process.env.TLS_DIR || '/tls';
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 8443);
const GATEWAY = new URL(process.env.GATEWAY_URL || 'http://gateway:8080');

function log(...parts) {
  console.log(`[nokia-tls] ${parts.join(' ')}`);
}

// ── Dirección pública y certificados ─────────────────────────────────────────────
function readPublicAddress() {
  try {
    const value = fs.readFileSync(path.join(TLS_DIR, 'public-address'), 'utf8').trim();
    if (/^[a-z0-9.-]+:\d{1,5}$/i.test(value)) return value;
    log(`public-address con formato inválido: "${value}"`);
  } catch {
    // aún no lo ha escrito expose.sh
  }
  return null;
}

const caPem = path.join(TLS_DIR, 'ca.pem');
const caKey = path.join(TLS_DIR, 'ca.key');
const caDer = path.join(TLS_DIR, 'ca.cer');
for (const file of [caPem, caKey, caDer]) {
  if (!fs.existsSync(file)) {
    log(`FALTA ${file}: la raíz instalada en el Nokia debe estar en ${TLS_DIR}. No se genera una nueva.`);
    process.exit(1);
  }
}

const publicAddress = readPublicAddress();
const publicHost = publicAddress ? publicAddress.split(':')[0] : 'localhost';

function ensureServerCert(host) {
  const key = path.join(TLS_DIR, `server-${host}.key`);
  const pem = path.join(TLS_DIR, `server-${host}.pem`);
  if (fs.existsSync(key) && fs.existsSync(pem)) return { key, pem };
  log(`Generando certificado de servidor para ${host} (RSA 2048, SHA-1, firmado por la raíz)…`);
  const csr = path.join(TLS_DIR, `server-${host}.csr`);
  const ext = path.join(TLS_DIR, `server-${host}.ext`);
  fs.writeFileSync(ext, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nsubjectAltName=DNS:${host}\n`);
  const run = (args) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${host}`]);
  run(['x509', '-req', '-in', csr, '-CA', caPem, '-CAkey', caKey, '-CAcreateserial',
    '-sha1', '-days', '825', '-extfile', ext, '-out', pem]);
  fs.chmodSync(key, 0o600);
  fs.rmSync(csr, { force: true });
  fs.rmSync(ext, { force: true });
  return { key, pem };
}

const serverCert = ensureServerCert(publicHost);
const secureContext = tls.createSecureContext({
  key: fs.readFileSync(serverCert.key),
  cert: fs.readFileSync(serverCert.pem) + fs.readFileSync(caPem),
  minVersion: 'TLSv1',
  // El 6111 ofrece RC4-MD5, RC4-SHA, 3DES, AES128-SHA y AES256-SHA: se prefiere AES-256.
  ciphers: 'AES256-SHA:AES128-SHA:DHE-RSA-AES256-SHA:DHE-RSA-AES128-SHA:DEFAULT:@SECLEVEL=0',
  honorCipherOrder: true,
});

// ── Reenvío al Gateway ───────────────────────────────────────────────────────────
// Cabeceras que el cliente no puede imponer: las ponemos nosotros.
const STRIP = ['x-nokia-tls', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip'];

const httpServer = http.createServer((req, res) => {
  const clientIp = req.socket.nokiaClientIp || 'unknown';
  const headers = { ...req.headers };
  for (const name of STRIP) delete headers[name];
  headers['x-nokia-tls'] = '1';
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = publicAddress || req.headers.host || publicHost;
  headers['x-forwarded-for'] = clientIp;

  const upstream = http.request({
    host: GATEWAY.hostname,
    port: GATEWAY.port || 80,
    method: req.method,
    path: req.url,
    headers,
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    log(`Gateway no disponible: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Gateway no disponible');
  });
  req.pipe(upstream);
});
httpServer.keepAliveTimeout = 15_000;

// ── Conexiones entrantes ─────────────────────────────────────────────────────────
// Ya se ha leído el primer paquete (cabecera PROXY / ClientHello) y un TLSSocket sobre el
// socket original no lo vería: se monta sobre un puente que primero entrega ese resto.
function bridge(socket, first) {
  const duplex = new Duplex({
    read() {},
    write(chunk, _enc, cb) { socket.write(chunk, cb); },
    final(cb) { socket.end(); cb(); },
  });
  if (first.length) duplex.push(first);
  socket.on('data', (chunk) => duplex.push(chunk));
  socket.on('end', () => duplex.push(null));
  socket.on('close', () => duplex.destroy());
  return duplex;
}

// ngrok (proxy_proto: 1) antepone «PROXY TCP4 <ip cliente> <ip destino> <p> <p>\r\n».
function parseProxyHeader(buf) {
  if (buf.length < 6 || buf.toString('latin1', 0, 6) !== 'PROXY ') return { ip: null, rest: buf };
  const end = buf.indexOf('\r\n');
  if (end === -1) return { ip: null, rest: buf };
  const parts = buf.toString('latin1', 0, end).split(' ');
  return { ip: parts[2] && parts[2] !== 'UNKNOWN' ? parts[2] : null, rest: buf.subarray(end + 2) };
}

function servePlainHttp(socket, first) {
  const requestLine = first.toString('latin1').split('\r\n')[0];
  if (/^GET \/ca\.cer[ ?]/.test(requestLine)) {
    const der = fs.readFileSync(caDer);
    socket.end(Buffer.concat([Buffer.from(
      `HTTP/1.0 200 OK\r\nContent-Type: application/x-x509-ca-cert\r\nContent-Length: ${der.length}\r\nConnection: close\r\n\r\n`), der]));
    return;
  }
  const target = publicAddress ? `https://${publicAddress}/` : '/';
  const body = '<?xml version="1.0"?><!DOCTYPE html PUBLIC "-//WAPFORUM//DTD XHTML Mobile 1.0//EN" ' +
    '"http://www.wapforum.org/DTD/xhtml-mobile10.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>NokiaMSN</title></head>' +
    `<body><p>Usa la conexión segura:</p><p><a href="${target}">${target}</a></p>` +
    '<p><a href="/ca.cer">Instalar certificado raíz</a></p></body></html>';
  socket.end(`HTTP/1.0 200 OK\r\nContent-Type: application/vnd.wap.xhtml+xml; charset=UTF-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

net.createServer((socket) => {
  socket.on('error', () => {});
  socket.setTimeout(60_000, () => socket.destroy());
  socket.once('data', (chunk) => {
    const { ip, rest } = parseProxyHeader(chunk);
    const clientIp = ip || socket.remoteAddress;
    const handle = (first) => {
      if (first[0] === 0x16 || first[0] & 0x80) {
        const tlsSocket = new tls.TLSSocket(bridge(socket, first), { isServer: true, secureContext });
        tlsSocket.nokiaClientIp = clientIp;
        tlsSocket.on('secure', () => {
          log(`HTTPS desde ${clientIp}: ${tlsSocket.getProtocol()} ${tlsSocket.getCipher()?.name}`);
          httpServer.emit('connection', tlsSocket);
        });
        tlsSocket.on('error', (err) => {
          log(`TLS fallido desde ${clientIp}: ${err.code || ''} ${err.message}`);
          socket.destroy();
        });
      } else {
        servePlainHttp(socket, first);
      }
    };
    if (rest.length) {
      handle(rest);
    } else {
      // La cabecera PROXY llegó sola: el ClientHello viene en el siguiente paquete.
      socket.once('data', handle);
    }
  });
}).listen(LISTEN_PORT, () => {
  log(`Escuchando en :${LISTEN_PORT} → ${GATEWAY.origin}. Dirección pública: ${publicAddress || '(aún sin túnel)'}; certificado para ${publicHost}.`);
});
