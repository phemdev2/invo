'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const fsp = fs.promises;
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

const STATUSES = ['draft', 'sent', 'approved', 'rejected'];
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// Whitelist the fields we store and clamp their values; anything else in the body is dropped.
function clean(input) {
  const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const items = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
  const date = isDate(b.meta?.date) ? b.meta.date : '';
  const status = STATUSES.includes(b.status) ? b.status : 'draft';

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
    // VAT is on unless explicitly switched off, so quotations saved before this option existed keep their VAT.
    vatEnabled: b.vatEnabled !== false,
    status,
    approvedDate: status === 'approved' && isDate(b.approvedDate) ? b.approvedDate : '',
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
  const vat = q.vatEnabled === false ? 0 : round2((subtotal * q.vatRate) / 100);
  return { subtotal, vat, grand: round2(subtotal + vat) };
}

// What the list (and the revenue report) needs, without sending every line item.
const summary = q => {
  const t = totals(q);
  return {
    id: q.id,
    no: q.meta.no,
    client: q.client.name,
    date: q.meta.date,
    status: q.status,
    approvedDate: q.approvedDate,
    subtotal: t.subtotal,
    vat: t.vat,
    grand: t.grand,
    updatedAt: q.updatedAt
  };
};

/* ======================================================================
   Storage
   A store has: name, init(), list(), get(id), create(data), update(id, data), remove(id).
   get/update/remove throw a 404 HttpError when the id does not exist.
   ====================================================================== */

const notFound = () => new HttpError(404, 'Quotation not found');

/* ----- JSON file (default, no setup) ----- */

function createFileStore(dataDir) {
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

  // Changes run one at a time. The change is applied to a copy and only becomes
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

  return {
    name: `JSON file (${file})`,
    init,
    async list() { return quotations; },
    async get(id) {
      const q = quotations.find(x => x.id === id);
      if (!q) throw notFound();
      return q;
    },
    create(data) {
      const now = new Date().toISOString();
      return mutate(draft => {
        const q = { id: crypto.randomUUID(), ...data, createdAt: now, updatedAt: now };
        draft.push(q);
        return q;
      });
    },
    update(id, data) {
      return mutate(draft => {
        const i = draft.findIndex(x => x.id === id);
        if (i < 0) throw notFound();
        const q = { ...draft[i], ...data, id: draft[i].id, updatedAt: new Date().toISOString() };
        draft[i] = q;
        return q;
      });
    },
    remove(id) {
      return mutate(draft => {
        const i = draft.findIndex(x => x.id === id);
        if (i < 0) throw notFound();
        draft.splice(i, 1);
      });
    }
  };
}

/* ----- Supabase (Postgres through its REST API; no packages needed) ----- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createSupabaseStore({ url, key, table = 'quotations', timeoutMs = 10000 }) {
  // Accept the project URL with or without a trailing slash or "/rest/v1".
  const base = String(url).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const endpoint = `${base}/rest/v1/${table}`;
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  // Legacy keys are JWTs and are also sent as a Bearer token; the newer sb_secret_ keys only use "apikey".
  if (/^eyJ/.test(key)) headers.Authorization = `Bearer ${key}`;

  async function request(method, query, body, prefer) {
    let res;
    try {
      res = await fetch(endpoint + query, {
        method,
        headers: prefer ? { ...headers, Prefer: prefer } : headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      console.error(`Supabase ${method} failed: ${err.message}`);
      throw new HttpError(502, 'Database unreachable');
    }
    const text = await res.text();
    if (!res.ok) {
      console.error(`Supabase ${method} ${query} -> ${res.status}: ${text.slice(0, 300)}`);
      throw new HttpError(502, 'Database error');
    }
    return text ? JSON.parse(text) : null;
  }

  // Rows hold the quotation in a jsonb column. Re-clean what we read so a hand-edited row can't break the UI.
  const fromRow = row => ({
    id: row.id,
    ...clean(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });

  const SELECT = 'select=id,data,created_at,updated_at';
  const REPR = 'return=representation';

  return {
    name: `Supabase (${base})`,

    async init() {
      // Fail at startup, with a useful hint, rather than on the first request.
      let res;
      try {
        res = await fetch(`${endpoint}?select=id&limit=1`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new Error(`Could not reach Supabase at ${base}: ${err.message}`);
      }
      if (res.ok) return;
      const text = (await res.text()).slice(0, 300);
      let hint = '';
      if (res.status === 401 || res.status === 403) hint = ' Check SUPABASE_SERVICE_KEY (use the secret / service_role key, not the publishable / anon key).';
      else if (res.status === 404) hint = ` Does the "${table}" table exist? Run supabase/schema.sql in the Supabase SQL editor.`;
      throw new Error(`Supabase answered ${res.status}: ${text}.${hint}`);
    },

    async list() {
      const rows = await request('GET', `?${SELECT}&order=updated_at.desc`);
      return rows.map(fromRow);
    },

    async get(id) {
      if (!UUID_RE.test(id)) throw notFound();
      const rows = await request('GET', `?${SELECT}&id=eq.${id}`);
      if (!rows.length) throw notFound();
      return fromRow(rows[0]);
    },

    async create(data) {
      const now = new Date().toISOString();
      const rows = await request('POST', `?${SELECT}`, { id: crypto.randomUUID(), data, created_at: now, updated_at: now }, REPR);
      return fromRow(rows[0]);
    },

    async update(id, data) {
      if (!UUID_RE.test(id)) throw notFound();
      const rows = await request('PATCH', `?${SELECT}&id=eq.${id}`, { data, updated_at: new Date().toISOString() }, REPR);
      if (!rows.length) throw notFound();
      return fromRow(rows[0]);
    },

    async remove(id) {
      if (!UUID_RE.test(id)) throw notFound();
      const rows = await request('DELETE', `?select=id&id=eq.${id}`, undefined, REPR);
      if (!rows.length) throw notFound();
    }
  };
}

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

function createServer({ store, enforceLocalHost = false } = {}) {
  if (!store) throw new Error('createServer needs a store');

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
        const list = (await store.list()).map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return sendJson(res, 200, list);
      }
      if (method === 'POST') {
        requireJson(req);
        const body = await readJson(req);
        return sendJson(res, 201, await store.create(clean(body)));
      }
      throw new HttpError(405, 'Method not allowed');
    }

    // /api/quotations/:id
    if (method === 'GET') return sendJson(res, 200, await store.get(id));
    if (method === 'PUT') {
      requireJson(req);
      const body = await readJson(req);
      return sendJson(res, 200, await store.update(id, clean(body)));
    }
    if (method === 'DELETE') {
      await store.remove(id);
      res.writeHead(204);
      return res.end();
    }
    throw new HttpError(405, 'Method not allowed');
  }

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

  return { server, init: () => store.init() };
}

/* ---------- Configuration ---------- */

// Minimal .env reader (KEY=value lines). Real environment variables win over the file.
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

function storeFromEnv(env = process.env) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = (env.SUPABASE_SERVICE_KEY || '').trim();
  if (url && key) return createSupabaseStore({ url, key });
  if (url || key) {
    throw new Error('Set both SUPABASE_URL and SUPABASE_SERVICE_KEY to use Supabase, or neither to use the JSON file.');
  }
  return createFileStore(env.DATA_DIR || path.join(__dirname, 'data'));
}

module.exports = { createServer, createFileStore, createSupabaseStore, storeFromEnv, clean, totals };

/* ---------- Start ---------- */

if (require.main === module) {
  loadEnvFile(path.join(__dirname, '.env'));

  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '127.0.0.1';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);

  let store;
  try {
    store = storeFromEnv();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const { server, init } = createServer({ store, enforceLocalHost: loopback });

  server.on('error', err => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set PORT to use another one.` : err.message);
    process.exit(1);
  });

  init()
    .then(() => {
      server.listen(PORT, HOST, () => {
        console.log(`Storage: ${store.name}`);
        console.log(`Quotation app running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
      });
    })
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}