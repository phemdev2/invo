'use strict';

const http = require('http');
const path = require('path');
const fsp = require('fs').promises;
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ---------- Validation / sanitising ---------- */

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const num = (v, { min = 0, max = 1e12 } = {}) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : 0;
};

const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// Whitelist the fields we store and clamp their values; anything else in the body is dropped.
function clean(input) {
  const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const items = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
  const date = typeof b.meta?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.meta.date) ? b.meta.date : '';

  return {
    company: {
      name: str(b.company?.name),
      address: str(b.company?.address, 300),
      phone: str(b.company?.phone, 60),
      email: str(b.company?.email, 120)
    },
    client: {
      name: str(b.client?.name),
      address: str(b.client?.address, 300)
    },
    meta: {
      no: str(b.meta?.no, 40),
      date,
      validity: Math.round(num(b.meta?.validity, { max: 3650 })),
      delivery: str(b.meta?.delivery, 300)
    },
    items: items.map(i => ({
      id: str(i?.id, 40) || crypto.randomUUID().slice(0, 8),
      desc: str(i?.desc, 500),
      price: num(i?.price),
      qty: num(i?.qty)
    })),
    vatRate: num(b.vatRate, { max: 100 }),
    payment: {
      acct: str(b.payment?.acct, 60),
      bank: str(b.payment?.bank, 120),
      name: str(b.payment?.name, 200),
      tin: str(b.payment?.tin, 60)
    },
    signer: str(b.signer, 80)
  };
}

function totals(q) {
  const subtotal = round2(q.items.reduce((s, i) => s + i.price * i.qty, 0));
  const vat = round2((subtotal * q.vatRate) / 100);
  return { subtotal, vat, grand: round2(subtotal + vat) };
}

const summary = q => ({
  id: q.id,
  no: q.meta.no,
  client: q.client.name,
  date: q.meta.date,
  grand: totals(q).grand,
  updatedAt: q.updatedAt
});

/* ---------- HTTP helpers ---------- */

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 200 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

// Requiring application/json means a web page on another site cannot write to this API
// with a "simple" cross-site request; browsers would have to ask permission first.
function requireJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { tooLarge = true; return; } // keep draining, reject at the end
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'Request too large'));
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (_) { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/* ---------- Server factory ---------- */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function createServer(
  dataDir = process.env.DATA_DIR || path.join(__dirname, 'data'),
  { enforceLocalHost = false } = {}
) {
  const file = path.join(dataDir, 'quotations.json');
  let quotations = [];
  let queue = Promise.resolve();

  async function init() {
    let raw;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return; // first run: start empty
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      quotations = Array.isArray(parsed.quotations) ? parsed.quotations : [];
    } catch (err) {
      throw new Error(`Could not parse ${file}: ${err.message}`);
    }
  }

  // Write to a temp file then rename, so a crash mid-write can't corrupt the data file.
  async function write(data) {
    await fsp.mkdir(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ quotations: data }, null, 2));
    await fsp.rename(tmp, file);
  }

  // All changes run one at a time. The change is applied to a copy and only becomes
  // the live data once it has been written to disk.
  function mutate(fn) {
    const run = queue.then(async () => {
      const draft = quotations.slice();
      const result = fn(draft);
      await write(draft);
      quotations = draft;
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  /* ----- API ----- */

  async function api(req, res, pathname) {
    const match = /^\/api\/quotations(?:\/([^/]+))?$/.exec(pathname);
    if (!match) throw new HttpError(404, 'Not found');

    let id = match[1];
    if (id !== undefined) {
      try { id = decodeURIComponent(id); } catch (_) { throw new HttpError(400, 'Bad id'); }
    }
    const { method } = req;

    // /api/quotations
    if (id === undefined) {
      if (method === 'GET') {
        const list = quotations.map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return sendJson(res, 200, list);
      }
      if (method === 'POST') {
        requireJson(req);
        const body = await readJson(req);
        const now = new Date().toISOString();
        const created = await mutate(draft => {
          const q = { id: crypto.randomUUID(), ...clean(body), createdAt: now, updatedAt: now };
          draft.push(q);
          return q;
        });
        return sendJson(res, 201, created);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    // /api/quotations/:id
    if (method === 'GET') {
      const q = quotations.find(x => x.id === id);
      if (!q) throw new HttpError(404, 'Quotation not found');
      return sendJson(res, 200, q);
    }
    if (method === 'PUT') {
      requireJson(req);
      const body = await readJson(req);
      const updated = await mutate(draft => {
        const i = draft.findIndex(x => x.id === id);
        if (i < 0) throw new HttpError(404, 'Quotation not found');
        const q = { ...draft[i], ...clean(body), id: draft[i].id, updatedAt: new Date().toISOString() };
        draft[i] = q;
        return q;
      });
      return sendJson(res, 200, updated);
    }
    if (method === 'DELETE') {
      await mutate(draft => {
        const i = draft.findIndex(x => x.id === id);
        if (i < 0) throw new HttpError(404, 'Quotation not found');
        draft.splice(i, 1);
      });
      res.writeHead(204);
      return res.end();
    }
    throw new HttpError(405, 'Method not allowed');
  }

  /* ----- Static files ----- */

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');

    let rel;
    try { rel = decodeURIComponent(pathname); } catch (_) { throw new HttpError(400, 'Bad request'); }
    if (rel.includes('\0')) throw new HttpError(400, 'Bad request');
    if (rel.endsWith('/')) rel += 'index.html';

    const full = path.join(PUBLIC_DIR, path.normalize(rel));
    if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden');

    let data;
    try {
      data = await fsp.readFile(full);
    } catch (err) {
      if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(err.code)) throw new HttpError(404, 'Not found');
      throw err;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  /* ----- Server ----- */

  const server = http.createServer(async (req, res) => {
    try {
      // When bound to this machine only, refuse requests addressed to any other hostname.
      // This blocks "DNS rebinding" attacks from web pages on other sites.
      if (enforceLocalHost) {
        const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
        if (!LOCAL_HOSTS.has(host)) throw new HttpError(403, 'Forbidden host');
      }

      let pathname;
      try { ({ pathname } = new URL(req.url, 'http://localhost')); } catch (_) { throw new HttpError(400, 'Bad request'); }

      if (pathname === '/api' || pathname.startsWith('/api/')) await api(req, res, pathname);
      else await serveStatic(req, res, pathname);
    } catch (err) {
      const known = err instanceof HttpError;
      if (!known) console.error(err);
      if (res.headersSent) return res.end();
      sendJson(res, known ? err.status : 500, { error: known ? err.message : 'Server error' });
    }
  });

  return { server, init };
}

module.exports = { createServer, clean, totals };

/* ---------- Start ---------- */

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '127.0.0.1';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
  const { server, init } = createServer(undefined, { enforceLocalHost: loopback });

  server.on('error', err => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set PORT to use another one.` : err.message);
    process.exit(1);
  });

  init()
    .then(() => {
      server.listen(PORT, HOST, () => {
        console.log(`Quotation app running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
      });
    })
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}
