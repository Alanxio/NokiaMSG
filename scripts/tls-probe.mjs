// Prueba de HTTPS para el Nokia 6111 — independiente de la app, no toca nada de NokiaMSN.
//
// Un solo puerto (pensado para un túnel TCP de ngrok) que atiende dos cosas:
//   http://HOST:PUERTO/ca.cer  → descarga el certificado raíz propio para instalarlo
//   https://HOST:PUERTO/       → intenta la conexión cifrada
// En cada intento HTTPS registra el ClientHello del teléfono (versión TLS/SSL, lista de
// cifrados, SNI…) ANTES de negociar, así sabemos qué ofrece el 6111 aunque falle.
//
// Uso (en el PC, con openssl instalado):
//   PUBLIC_HOST=0.tcp.eu.ngrok.io PORT=8443 node scripts/tls-probe.mjs
//   ngrok tcp 8443
// PUBLIC_HOST debe ser el host que da ngrok (sin el puerto): va en el certificado.
import net from 'node:net';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8443);
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'localhost';
const DIR = process.env.PROBE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data-tls-probe');
const LOG = path.join(DIR, 'probe.log');
fs.mkdirSync(DIR, { recursive: true });

// OpenSSL 3 rechaza al CARGAR un certificado firmado con SHA-1 (ca md too weak) antes de
// que se aplique @SECLEVEL=0 en los cifrados. Hay que arrancar Node con una configuración
// de OpenSSL que ya tenga el nivel 0: el script se relanza a sí mismo con ella.
if (!process.env.TLS_PROBE_CHILD) {
  const conf = path.join(DIR, 'openssl-legacy.cnf');
  fs.writeFileSync(conf, [
    'nodejs_conf = nodejs_init', '',
    '[nodejs_init]', 'ssl_conf = ssl_sect', '',
    '[ssl_sect]', 'system_default = system_default_sect', '',
    '[system_default_sect]', 'CipherString = DEFAULT:@SECLEVEL=0', 'MinProtocol = TLSv1', '',
  ].join('\n'));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: { ...process.env, OPENSSL_CONF: conf, TLS_PROBE_CHILD: '1' },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  await new Promise(() => {});
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  fs.appendFileSync(LOG, `${line}\n`);
}

// ── Certificados al estilo 2005: RSA 2048 + firma SHA-1, extensiones mínimas ─────
function openssl(args) {
  execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}
const caKey = path.join(DIR, 'ca.key');
const caPem = path.join(DIR, 'ca.pem');
const caDer = path.join(DIR, 'ca.cer');
if (!fs.existsSync(caPem)) {
  log('Generando autoridad raíz propia (RSA 2048, SHA-1, 10 años)…');
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-sha1', '-nodes', '-days', '3650',
    '-keyout', caKey, '-out', caPem, '-subj', '/CN=NokiaMSN Root CA/O=NokiaMSN',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  openssl(['x509', '-in', caPem, '-outform', 'DER', '-out', caDer]);
}
const srvKey = path.join(DIR, 'server.key');
const srvCsr = path.join(DIR, 'server.csr');
const srvPem = path.join(DIR, `server-${PUBLIC_HOST}.pem`);
const extFile = path.join(DIR, 'server.ext');
if (!fs.existsSync(srvPem)) {
  log(`Generando certificado de servidor para ${PUBLIC_HOST} firmado por la raíz…`);
  fs.writeFileSync(extFile, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nsubjectAltName=DNS:${PUBLIC_HOST}\n`);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', srvKey, '-out', srvCsr, '-subj', `/CN=${PUBLIC_HOST}`]);
  openssl(['x509', '-req', '-in', srvCsr, '-CA', caPem, '-CAkey', caKey, '-CAcreateserial',
    '-sha1', '-days', '825', '-extfile', extFile, '-out', srvPem]);
}

// ── Lectura del ClientHello ─────────────────────────────────────────────────────
const CIPHER_NAMES = {
  0x0004: 'RC4-MD5', 0x0005: 'RC4-SHA', 0x000a: '3DES-SHA', 0x0009: 'DES-SHA',
  0x0003: 'EXP-RC4-MD5', 0x0006: 'EXP-RC2-MD5', 0x0008: 'EXP-DES-SHA', 0x0001: 'NULL-MD5', 0x0002: 'NULL-SHA',
  0x002f: 'AES128-SHA', 0x0035: 'AES256-SHA', 0x0016: 'EDH-RSA-3DES-SHA', 0x0033: 'DHE-RSA-AES128-SHA',
  0x0039: 'DHE-RSA-AES256-SHA', 0x0013: 'EDH-DSS-3DES-SHA', 0x0012: 'EDH-DSS-DES-SHA', 0x0015: 'EDH-RSA-DES-SHA',
  0x00ff: 'RENEGOTIATION-SCSV',
};
const VERSIONS = { 0x0002: 'SSLv2', 0x0300: 'SSLv3', 0x0301: 'TLS1.0', 0x0302: 'TLS1.1', 0x0303: 'TLS1.2' };
const v = (n) => VERSIONS[n] || `0x${n.toString(16)}`;
const c = (n) => CIPHER_NAMES[n] || `0x${n.toString(16).padStart(4, '0')}`;

function describeClientHello(buf) {
  try {
    if (buf[0] & 0x80) {
      // ClientHello en formato SSLv2 (algunos clientes antiguos lo usan para ofrecer SSLv3/TLS)
      const version = buf.readUInt16BE(3);
      const specLen = buf.readUInt16BE(5);
      const specs = [];
      for (let i = 0; i < specLen; i += 3) {
        const off = 11 + i;
        const kind = buf[off];
        const id = buf.readUInt16BE(off + 1);
        specs.push(kind === 0 ? c(id) : `v2:0x${kind.toString(16)}${id.toString(16).padStart(4, '0')}`);
      }
      return `formato SSLv2, versión máxima ${v(version)}, cifrados: ${specs.join(', ')}`;
    }
    if (buf[0] !== 0x16) return `no es TLS (primer byte 0x${buf[0].toString(16)})`;
    const recordVersion = buf.readUInt16BE(1);
    let p = 5;
    if (buf[p] !== 0x01) return `registro TLS ${v(recordVersion)} sin ClientHello`;
    p += 4;
    const helloVersion = buf.readUInt16BE(p); p += 2 + 32;
    const sidLen = buf[p]; p += 1 + sidLen;
    const csLen = buf.readUInt16BE(p); p += 2;
    const ciphers = [];
    for (let i = 0; i < csLen; i += 2) ciphers.push(c(buf.readUInt16BE(p + i)));
    p += csLen;
    const compLen = buf[p]; p += 1 + compLen;
    let sni = '-';
    const exts = [];
    if (p + 2 <= buf.length) {
      const extEnd = p + 2 + buf.readUInt16BE(p); p += 2;
      while (p + 4 <= extEnd && p + 4 <= buf.length) {
        const type = buf.readUInt16BE(p); const len = buf.readUInt16BE(p + 2);
        exts.push(type);
        if (type === 0 && len > 5) sni = buf.slice(p + 9, p + 4 + len).toString();
        p += 4 + len;
      }
    }
    return `registro ${v(recordVersion)}, versión máxima ${v(helloVersion)}, SNI=${sni}, ` +
      `extensiones=[${exts.join(',') || 'ninguna'}], cifrados: ${ciphers.join(', ')}`;
  } catch (err) {
    return `ClientHello ilegible (${err.message}); bytes: ${buf.slice(0, 48).toString('hex')}`;
  }
}

// ── Servidor TLS: lo más antiguo que permite el OpenSSL de Node 18 (TLS 1.0 + AES) ──
const secureContext = tls.createSecureContext({
  key: fs.readFileSync(srvKey),
  cert: fs.readFileSync(srvPem) + fs.readFileSync(caPem),
  minVersion: 'TLSv1',
  ciphers: 'AES128-SHA:AES256-SHA:DHE-RSA-AES128-SHA:DHE-RSA-AES256-SHA:DEFAULT:@SECLEVEL=0',
});

// Ya hemos leído el primer paquete (el ClientHello) para registrarlo; un TLSSocket sobre
// el socket original leería directamente del descriptor y no lo vería. Se monta encima
// de un puente que primero le entrega ese paquete y después el resto de la conexión.
function bridge(socket, first) {
  const duplex = new Duplex({
    read() {},
    write(chunk, _enc, cb) { socket.write(chunk, cb); },
    final(cb) { socket.end(); cb(); },
  });
  duplex.push(first);
  socket.on('data', (chunk) => duplex.push(chunk));
  socket.on('end', () => duplex.push(null));
  socket.on('close', () => duplex.destroy());
  return duplex;
}

function handleTls(socket, first) {
  const remote = socket.remoteAddress;
  const tlsSocket = new tls.TLSSocket(bridge(socket, first), { isServer: true, secureContext });
  tlsSocket.on('secure', () => {
    const proto = tlsSocket.getProtocol();
    const cipher = tlsSocket.getCipher()?.name;
    log(`✅ HANDSHAKE OK desde ${remote}: ${proto} ${cipher}`);
    tlsSocket.once('data', (req) => {
      log(`   petición: ${req.toString().split('\r\n')[0]}`);
      const body = '<?xml version="1.0"?><!DOCTYPE html PUBLIC "-//WAPFORUM//DTD XHTML Mobile 1.0//EN" ' +
        '"http://www.wapforum.org/DTD/xhtml-mobile10.dtd"><html xmlns="http://www.w3.org/1999/xhtml">' +
        `<head><title>HTTPS OK</title></head><body><p><b>Conectado por HTTPS</b></p><p>${proto}<br/>${cipher}</p></body></html>`;
      tlsSocket.end(`HTTP/1.0 200 OK\r\nContent-Type: application/vnd.wap.xhtml+xml; charset=UTF-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
  tlsSocket.on('error', (err) => {
    log(`❌ HANDSHAKE/TLS FALLIDO desde ${remote}: ${err.code || ''} ${err.message}`);
    socket.destroy();
  });
}

// ── HTTP en claro: solo para descargar la raíz ──────────────────────────────────
function serveHttp(socket, first) {
  const request = first.toString('latin1').split('\r\n')[0];
  log(`HTTP en claro: ${request} (desde ${socket.remoteAddress})`);
  if (/^GET \/ca\.cer[ ?]/.test(request)) {
    const der = fs.readFileSync(caDer);
    socket.end(Buffer.concat([Buffer.from(
      `HTTP/1.0 200 OK\r\nContent-Type: application/x-x509-ca-cert\r\nContent-Length: ${der.length}\r\nConnection: close\r\n\r\n`), der]));
    return;
  }
  const body = '<html><body><p>Prueba TLS NokiaMSN</p><p><a href="/ca.cer">Descargar certificado raíz</a></p></body></html>';
  socket.end(`HTTP/1.0 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
}

net.createServer((socket) => {
  socket.once('data', (first) => {
    if (first[0] === 0x16 || first[0] & 0x80) {
      log(`ClientHello desde ${socket.remoteAddress}: ${describeClientHello(first)}`);
      handleTls(socket, first);
    } else {
      serveHttp(socket, first);
    }
  });
  socket.on('error', (err) => log(`socket: ${err.message}`));
}).listen(PORT, () => {
  log(`Sonda TLS escuchando en :${PORT} — certificado para ${PUBLIC_HOST}. Log: ${LOG}`);
});
