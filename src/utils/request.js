function parseStructuredString(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  try {
    const params = new URLSearchParams(trimmed);
    const entries = [...params.entries()];
    if (!entries.length) {
      return {};
    }

    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

const MAX_RAW_BODY = 100 * 1024; // 100 KB

async function readRawBody(req) {
  if (req.readableEnded || req.complete === true && req.readable === false) {
    return '';
  }

  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > MAX_RAW_BODY) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

export async function getRequestPayload(req) {
  const queryPayload =
    req.query && typeof req.query === 'object' && !Array.isArray(req.query) ? req.query : {};
  const bodyPayload =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};

  let stringPayload = {};
  if (typeof req.body === 'string') {
    stringPayload = parseStructuredString(req.body);
  } else if (!Object.keys(bodyPayload).length) {
    const raw = await readRawBody(req);
    if (raw) {
      stringPayload = parseStructuredString(raw);
    }
  }

  return {
    ...queryPayload,
    ...stringPayload,
    ...bodyPayload,
  };
}
