import { stmts } from '../../db/db.js';

export const DIRECTORY_PAGE_SIZE = 20;
export const MESSAGE_PAGE_SIZE = 12;

const WAP_CONTENT_TYPE = 'application/vnd.wap.xhtml+xml; charset=UTF-8';
const HTML_CONTENT_TYPE = 'text/html; charset=UTF-8';
const XHTML_DOCTYPE = '<!DOCTYPE html PUBLIC "-//WAPFORUM//DTD XHTML Mobile 1.0//EN" "http://www.wapforum.org/DTD/xhtml-mobile10.dtd">';

export function escapeXml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function nl2br(value = '') {
  return escapeXml(value).replace(/\r?\n/g, '<br/>');
}

export function formatPhoneNumber(chatId = '', username = '') {
  if (!chatId && !username) return null;
  const digitsFromChatId = chatId ? String(chatId).split('@')[0].replace(/[^0-9]/g, '') : '';
  const digitsFromUsername = username ? String(username).replace(/[^0-9]/g, '') : '';

  const digits = digitsFromChatId.length >= 8 ? digitsFromChatId : digitsFromUsername;
  if (digits.length >= 8) {
    return `+${digits}`;
  }
  return null;
}

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

export function renderPhoneLink(phone) {
  if (!phone) return '';
  const cleanNumber = phone.replace(/[^0-9+]/g, '');
  return `<font size="1" color="#666666">(<a href="wtai://wp/mc;${escapeXml(cleanNumber)}"><font color="#666666">${escapeXml(phone)}</font></a>)</font>`;
}

// Dominios comunes en España: si un @termina en uno de estos, lo tratamos como correo, no mención.
const EMAIL_DOMAIN_RE = /\.(com|es|org|net|info|eu)$/i;

export function renderMentions(value = '') {
  if (!value) return '';
  const escaped = escapeXml(value).replace(/\r?\n/g, '<br/>');

  return escaped.replace(
    /(@[A-Za-z0-9ÁÉÍÓÚáéíóúÑñÜü+\-:.]{2,}(?: [A-Za-z0-9ÁÉÍÓÚáéíóúÑñÜü+\-:.]{2,})*)/g,
    (match) => {
      if (EMAIL_DOMAIN_RE.test(match)) {
        return match;
      }

      let display = match;
      // Si la mención contiene un número de teléfono (ej. @34612345678 o @521...), buscar nombre en BD
      const phoneCandidate = match.slice(1).replace(/[^0-9]/g, '');
      if (phoneCandidate.length >= 8) {
        try {
          const row = stmts.getUserByPhonePattern ? stmts.getUserByPhonePattern.get(`${phoneCandidate}%`) : null;
          if (row && row.username && row.username !== phoneCandidate && !row.username.startsWith('+')) {
            display = `@${escapeXml(row.username)}`;
          }
        } catch (e) { }
      }

      return `<font color="#000099"><b>${display}</b></font>`;
    }
  );
}

export function toPositiveInt(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed < 1 ? fallback : parsed;
}

export function buildHref(path, params = {}) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  });

  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export function isOperaMini(req) {
  const ua = req.headers['user-agent'] || '';
  return ua.includes('Opera Mini');
}

function pickContentType(req) {
  if (isOperaMini(req)) {
    return HTML_CONTENT_TYPE;
  }

  const accept = req.headers.accept ?? '';
  if (
    accept.includes('application/vnd.wap.xhtml+xml') ||
    accept.includes('application/xhtml+xml')
  ) {
    return WAP_CONTENT_TYPE;
  }

  return HTML_CONTENT_TYPE;
}

export function sendPage(req, res, statusCode, title, body, extraHead = '') {
  const contentType = pickContentType(req);
  const page = `${XHTML_DOCTYPE}<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(title)}</title><meta http-equiv="Content-Type" content="${escapeXml(contentType)}"/>${extraHead}</head><body>${body}</body></html>`;

  res.status(statusCode);
  res.set({
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.send(page);
}

export function renderPager(path, page, totalPages, params = {}) {
  const links = [];

  if (page > 1) {
    links.push(
      `<a href="${escapeXml(buildHref(path, { ...params, p: page - 1 }))}">Ant</a>`
    );
  }

  if (page < totalPages) {
    links.push(
      `<a href="${escapeXml(buildHref(path, { ...params, p: page + 1 }))}">Sig</a>`
    );
  }

  if (!links.length) {
    return `<p>${page}/${totalPages}</p>`;
  }

  return `<p>${page}/${totalPages} ${links.join(' | ')}</p>`;
}

export function renderIndexPager(path, pageKey, page, totalPages, params = {}) {
  const links = [];

  if (page > 1) {
    links.push(
      `<a href="${escapeXml(buildHref(path, { ...params, [pageKey]: page - 1 }))}">Ant</a>`
    );
  }

  if (page < totalPages) {
    links.push(
      `<a href="${escapeXml(buildHref(path, { ...params, [pageKey]: page + 1 }))}">Sig</a>`
    );
  }

  if (!links.length) {
    return `<p>${page}/${totalPages}</p>`;
  }

  return `<p>${page}/${totalPages} ${links.join(' | ')}</p>`;
}

export function renderList(items, hrefFor, textFor, emptyText) {
  if (!items.length) {
    return `<p>${escapeXml(emptyText)}</p>`;
  }

  const rows = items
    .map(
      (item) =>
        `<li><a href="${escapeXml(hrefFor(item))}">${escapeXml(textFor(item))}</a></li>`
    )
    .join('');

  return `<ul>${rows}</ul>`;
}

export function renderMessageRows(items, metaFor, emptyText, detailHrefFor = null) {
  if (!items.length) {
    return `<p>${escapeXml(emptyText)}</p>`;
  }

  const rows = items
    .map((item) => {
      const meta = metaFor(item);
      const detailLink = detailHrefFor
        ? `<a href="${escapeXml(detailHrefFor(item))}">Ver</a><br/>`
        : '';
      const metaLine = meta ? `${escapeXml(meta)}<br/>` : '';
      return `<li>${detailLink}${metaLine}${nl2br(item.text)}</li>`;
    })
    .join('');

  return `<ol>${rows}</ol>`;
}

export function renderMessageTextBlock(value) {
  return `${nl2br(value)}<br/>`;
}

export function getTotal(stmt, ...args) {
  const row = stmt.get(...args);
  return row?.total ?? 0;
}

export function sendInvalidEntity(req, res, label) {
  sendPage(
    req,
    res,
    404,
    'No encontrado',
    `<p>${escapeXml(label)} invalido.</p><p><a href="/">Inicio</a></p>`
  );
}

export function sendMissingEntity(req, res, label) {
  sendPage(
    req,
    res,
    404,
    'No encontrado',
    `<p>${escapeXml(label)} no existe.</p><p><a href="/">Inicio</a></p>`
  );
}

export function sendXhtmlFrame(res, refreshSeconds, redirectUrl = null, audioUrl = null) {
  const contentType = 'application/vnd.wap.xhtml+xml; charset=UTF-8';
  let meta;

  if (redirectUrl) {
    meta = `<meta http-equiv="refresh" content="${refreshSeconds};url=${redirectUrl}" target="_parent"/>`;
  } else {
    meta = `<meta http-equiv="refresh" content="${refreshSeconds}"/>`;
  }

  const bodyContent = audioUrl
    ? `<object data="${audioUrl}" type="audio/amr" width="0" height="0"><param name="autostart" value="true"/><param name="loop" value="false"/></object>`
    : '';
  const page = `${XHTML_DOCTYPE}<html xmlns="http://www.w3.org/1999/xhtml"><head>${meta}</head><body>${bodyContent}</body></html>`;

  res.set({
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.send(page);
}

export function notFound(req, res) {
  sendPage(req, res, 404, 'No encontrado', '<p>Ruta no existe.</p><p><a href="/">Inicio</a></p>');
}

export function serverError(error, req, res, next) {
  console.error(error);
  if (res.headersSent) {
    next(error);
    return;
  }

  sendPage(req, res, 500, 'Error', '<p>Error interno.</p><p><a href="/">Inicio</a></p>');
}