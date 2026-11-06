'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createServer, createFileStore, createSupabaseStore, storeFromEnv } = require('../server');

const sampleBody = () => ({
  company: { name: 'PRINTZION TECHNOLOGY' },
  client: { name: 'MONTEROSA | EQUINIX LG04' },
  meta: { no: '#00588Q', date: '2026-09-10', validity: 7 },
  items: [
    { desc: 'WayBill Booklet', price: 7100, qty: 30 },
    { desc: 'Requisition Booklet (A5)', price: 5300, qty: 20 },
    { desc: 'Wage Cards', price: 35, qty: 3000 }
  ],
  vatRate: 7.5
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return server.address().port;
}

async function start(store, options = {}) {
  const { server, init } = createServer({ store, ...options });
  await init();
  return { server, port: await listen(server) };
}

// Raw request, so tests can control the Host header and the exact path.
function rawRequest(port, { method = 'GET', path: p = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

/* ----------------------------------------------------------------------
   A tiny stand-in for Supabase's REST service (PostgREST), just enough
   for the calls the app makes: select / insert / update / delete on one table.
   ---------------------------------------------------------------------- */
async function startMockSupabase(expectedKey) {
  const rows = [];
  const seen = []; // { method, url, headers } for assertions

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      const send = (status, body) => {
        const text = body === undefined ? '' : JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(text);
      };

      if (req.headers.apikey !== expectedKey) return send(401, { message: 'Invalid API key' });
      if (url.pathname !== '/rest/v1/quotations') return send(404, { code: 'PGRST205', message: 'table not found' });

      const idParam = url.searchParams.get('id');
      const id = idParam && idParam.startsWith('eq.') ? idParam.slice(3) : null;
      if (id !== null && !/^[0-9a-f-]{36}$/i.test(id)) {
        return send(400, { code: '22P02', message: 'invalid input syntax for type uuid' });
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      const wantsRows = /return=representation/.test(req.headers.prefer || '');
      const match = () => rows.filter(r => id === null || r.id === id);

      if (req.method === 'GET') {
        let out = match().map(r => ({ ...r }));
        if (url.searchParams.get('order') === 'updated_at.desc') out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        const sel = url.searchParams.get('select');
        if (sel && sel !== '*') out = out.map(r => Object.fromEntries(sel.split(',').map(k => [k, r[k]])));
        return send(200, out);
      }
      if (req.method === 'POST') {
        if (rows.some(r => r.id === body.id)) return send(409, { code: '23505', message: 'duplicate key' });
        const row = { created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...body };
        rows.push(row);
        return wantsRows ? send(201, [row]) : send(201);
      }
      if (req.method === 'PATCH') {
        const hit = match();
        hit.forEach(r => Object.assign(r, body));
        return wantsRows ? send(200, hit) : send(204);
      }
      if (req.method === 'DELETE') {
        const hit = match();
        hit.forEach(r => rows.splice(rows.indexOf(r), 1));
        return wantsRows ? send(200, hit.map(r => ({ id: r.id }))) : send(204);
      }
      return send(405, {});
    });
  });

  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, rows, seen, close: () => server.close() };
}

/* ----------------------------------------------------------------------
   The same API tests run against each kind of storage.
   makeStore() must return a NEW store object over the SAME backing data.
   ---------------------------------------------------------------------- */
function runApiSuite(label, setup) {
  test(`quotation API (${label})`, async t => {
    const { makeStore, cleanup } = await setup();
    const { server, port } = await start(makeStore());
    const base = `http://127.0.0.1:${port}`;
    t.after(async () => {
      server.close();
      await cleanup();
    });

    const call = async (method, url, body, { raw, contentType = 'application/json' } = {}) => {
      const hasBody = body !== undefined || raw !== undefined;
      const res = await fetch(base + url, {
        method,
        headers: hasBody ? { 'Content-Type': contentType } : undefined,
        body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    let id;

    await t.test('starts empty', async () => {
      const r = await call('GET', '/api/quotations');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, []);
    });

    await t.test('creates a quotation and lists it with correct totals', async () => {
      const r = await call('POST', '/api/quotations', sampleBody());
      assert.equal(r.status, 201);
      assert.ok(r.body.id);
      assert.ok(r.body.createdAt && r.body.updatedAt);
      assert.ok(r.body.items.every(i => i.id));
      id = r.body.id;

      const list = await call('GET', '/api/quotations');
      assert.equal(list.body.length, 1);
      assert.equal(list.body[0].no, '#00588Q');
      assert.equal(list.body[0].grand, 455800);
    });

    await t.test('gets one quotation', async () => {
      const r = await call('GET', `/api/quotations/${id}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.id, id);
      assert.equal(r.body.client.name, 'MONTEROSA | EQUINIX LG04');
    });

    await t.test('updates a quotation', async () => {
      const body = sampleBody();
      body.items[0].price = 8000;
      const r = await call('PUT', `/api/quotations/${id}`, body);
      assert.equal(r.status, 200);
      assert.equal(r.body.id, id);

      const list = await call('GET', '/api/quotations');
      assert.equal(list.body[0].grand, 484825); // (240000 + 106000 + 105000) * 1.075
    });

    await t.test('lists the most recently edited first', async () => {
      const other = await call('POST', '/api/quotations', { ...sampleBody(), meta: { no: '#00589Q' } });
      assert.equal((await call('GET', '/api/quotations')).body[0].id, other.body.id);
      await call('PUT', `/api/quotations/${id}`, sampleBody());
      assert.equal((await call('GET', '/api/quotations')).body[0].id, id);
      await call('DELETE', `/api/quotations/${other.body.id}`);
    });

    await t.test('sanitises bad input', async () => {
      const r = await call('POST', '/api/quotations', {
        meta: { date: 'not-a-date', validity: -5 },
        items: [{ desc: 123, price: -10, qty: 'abc' }],
        vatRate: 500,
        evil: '<script>'
      });
      assert.equal(r.status, 201);
      assert.equal(r.body.meta.date, '');
      assert.equal(r.body.meta.validity, 0);
      assert.equal(r.body.items[0].price, 0);
      assert.equal(r.body.items[0].qty, 0);
      assert.equal(r.body.items[0].desc, '');
      assert.equal(r.body.vatRate, 100);
      assert.equal('evil' in r.body, false);
      await call('DELETE', `/api/quotations/${r.body.id}`);
    });

    await t.test('returns 404 for unknown ids and routes', async () => {
      const unknownUuid = '00000000-0000-4000-8000-000000000000';
      for (const missing of ['nope', unknownUuid]) {
        assert.equal((await call('GET', `/api/quotations/${missing}`)).status, 404);
        assert.equal((await call('PUT', `/api/quotations/${missing}`, sampleBody())).status, 404);
        assert.equal((await call('DELETE', `/api/quotations/${missing}`)).status, 404);
      }
      assert.equal((await call('GET', '/api/unknown')).status, 404);
    });

    await t.test('rejects invalid JSON and wrong content type', async () => {
      assert.equal((await call('POST', '/api/quotations', undefined, { raw: '{bad json' })).status, 400);
      const r = await call('POST', '/api/quotations', undefined, { raw: JSON.stringify(sampleBody()), contentType: 'text/plain' });
      assert.equal(r.status, 415);
    });

    await t.test('rejects oversized bodies', async () => {
      const r = await call('POST', '/api/quotations', undefined, { raw: JSON.stringify({ client: { name: 'x'.repeat(300 * 1024) } }) });
      assert.equal(r.status, 413);
    });

    await t.test('serves the front end and blocks path traversal', async () => {
      const home = await fetch(base + '/');
      assert.equal(home.status, 200);
      assert.match(home.headers.get('content-type'), /text\/html/);
      assert.match(await home.text(), /<title>Quotation<\/title>/);

      assert.equal((await fetch(base + '/script.js')).status, 200);

      for (const p of ['/..%2fserver.js', '/%2e%2e/server.js', '/..%2f..%2fetc%2fpasswd']) {
        const r = await rawRequest(port, { path: p });
        assert.notEqual(r.status, 200, `${p} must not be served`);
      }
    });

    await t.test('VAT can be switched off, and old quotations keep VAT on', async () => {
      const off = await call('POST', '/api/quotations', { ...sampleBody(), vatEnabled: false });
      assert.equal(off.body.vatEnabled, false);
      const old = await call('POST', '/api/quotations', sampleBody()); // no vatEnabled sent
      assert.equal(old.body.vatEnabled, true);

      const list = (await call('GET', '/api/quotations')).body;
      const offRow = list.find(s => s.id === off.body.id);
      assert.equal(offRow.subtotal, 424000);
      assert.equal(offRow.vat, 0);
      assert.equal(offRow.grand, 424000);
      const onRow = list.find(s => s.id === old.body.id);
      assert.equal(onRow.vat, 31800);
      assert.equal(onRow.grand, 455800);

      await call('DELETE', `/api/quotations/${off.body.id}`);
      await call('DELETE', `/api/quotations/${old.body.id}`);
    });

    await t.test('status and approval date are validated', async () => {
      const ok = await call('POST', '/api/quotations', { ...sampleBody(), status: 'approved', approvedDate: '2026-10-05' });
      assert.equal(ok.body.status, 'approved');
      assert.equal(ok.body.approvedDate, '2026-10-05');

      const bad = await call('POST', '/api/quotations', { ...sampleBody(), status: 'hacked', approvedDate: '2026-10-05' });
      assert.equal(bad.body.status, 'draft');
      assert.equal(bad.body.approvedDate, ''); // only kept while approved

      const badDate = await call('POST', '/api/quotations', { ...sampleBody(), status: 'approved', approvedDate: 'tomorrow' });
      assert.equal(badDate.body.approvedDate, '');

      const row = (await call('GET', '/api/quotations')).body.find(s => s.id === ok.body.id);
      assert.equal(row.status, 'approved');
      assert.equal(row.approvedDate, '2026-10-05');

      // moving back out of "approved" clears the approval date
      const back = await call('PUT', `/api/quotations/${ok.body.id}`, { ...sampleBody(), status: 'sent', approvedDate: '2026-10-05' });
      assert.equal(back.body.status, 'sent');
      assert.equal(back.body.approvedDate, '');

      for (const q of [ok, bad, badDate]) await call('DELETE', `/api/quotations/${q.body.id}`);
    });

    await t.test('data survives a server restart', async () => {
      const again = await start(makeStore());
      const res = await fetch(`http://127.0.0.1:${again.port}/api/quotations/${id}`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).client.name, 'MONTEROSA | EQUINIX LG04');
      again.server.close();
    });

    await t.test('deletes a quotation', async () => {
      assert.equal((await call('DELETE', `/api/quotations/${id}`)).status, 204);
      assert.equal((await call('GET', `/api/quotations/${id}`)).status, 404);
    });
  });
}

runApiSuite('JSON file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotes-'));
  return {
    makeStore: () => createFileStore(dir),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
});

const KEY = 'sb_secret_test_key';

runApiSuite('Supabase', async () => {
  const mock = await startMockSupabase(KEY);
  return {
    makeStore: () => createSupabaseStore({ url: mock.url, key: KEY }),
    cleanup: () => mock.close()
  };
});

/* ---------- Supabase-specific behaviour ---------- */

test('Supabase store: requests and failure handling', async t => {
  const mock = await startMockSupabase(KEY);
  t.after(() => mock.close());

  await t.test('init succeeds with a valid key and sends it as "apikey" only (new-style key)', async () => {
    const store = createSupabaseStore({ url: mock.url, key: KEY });
    await store.init();
    const h = mock.seen.at(-1).headers;
    assert.equal(h.apikey, KEY);
    assert.equal(h.authorization, undefined);
  });

  await t.test('legacy JWT keys are also sent as a Bearer token', async () => {
    const jwt = 'eyJhbGciOi.fake.jwt';
    const m2 = await startMockSupabase(jwt);
    await createSupabaseStore({ url: m2.url, key: jwt }).init();
    assert.equal(m2.seen.at(-1).headers.authorization, `Bearer ${jwt}`);
    m2.close();
  });

  await t.test('accepts a URL with a trailing slash or /rest/v1', async () => {
    await createSupabaseStore({ url: mock.url + '/', key: KEY }).init();
    await createSupabaseStore({ url: mock.url + '/rest/v1/', key: KEY }).init();
  });

  await t.test('init explains a wrong key', async () => {
    await assert.rejects(
      createSupabaseStore({ url: mock.url, key: 'wrong' }).init(),
      /401.*SUPABASE_SERVICE_KEY/s
    );
  });

  await t.test('init explains a missing table', async () => {
    await assert.rejects(
      createSupabaseStore({ url: mock.url, key: KEY, table: 'nope' }).init(),
      /404.*schema\.sql/s
    );
  });

  await t.test('init explains an unreachable project', async () => {
    await assert.rejects(
      createSupabaseStore({ url: 'http://127.0.0.1:1', key: KEY }).init(),
      /Could not reach Supabase/
    );
  });

  await t.test('API answers 502 (not a crash) when the database rejects a request', async () => {
    // Skip the startup check (init) to simulate a key that stops working after the server is already running.
    const { server } = createServer({ store: createSupabaseStore({ url: mock.url, key: 'wrong' }) });
    const port = await listen(server);
    const origError = console.error;
    console.error = () => {}; // expected failures; keep test output clean
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/quotations`);
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: 'Database error' });

      const res2 = await fetch(`http://127.0.0.1:${port}/api/quotations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sampleBody())
      });
      assert.equal(res2.status, 502);
    } finally {
      console.error = origError;
      server.close();
    }
  });

  await t.test('non-UUID ids never reach the database', async () => {
    const store = createSupabaseStore({ url: mock.url, key: KEY });
    const before = mock.seen.length;
    await assert.rejects(store.get('1; drop table quotations'), { status: 404 });
    await assert.rejects(store.update('x', {}), { status: 404 });
    await assert.rejects(store.remove('x'), { status: 404 });
    assert.equal(mock.seen.length, before);
  });

  await t.test('rows edited by hand cannot break the list', async () => {
    const store = createSupabaseStore({ url: mock.url, key: KEY });
    const made = await store.create({ client: { name: 'A' } });
    mock.rows.find(r => r.id === made.id).data = { client: 'not an object' }; // malformed
    const { server, port } = await start(store);
    const res = await fetch(`http://127.0.0.1:${port}/api/quotations`);
    assert.equal(res.status, 200);
    server.close();
    await store.remove(made.id);
  });
});

/* ---------- Choosing the store from settings ---------- */

test('storeFromEnv', () => {
  assert.match(storeFromEnv({ DATA_DIR: '/tmp/x' }).name, /JSON file/);
  assert.match(storeFromEnv({ SUPABASE_URL: 'https://a.supabase.co', SUPABASE_SERVICE_KEY: 'k' }).name, /Supabase/);
  assert.throws(() => storeFromEnv({ SUPABASE_URL: 'https://a.supabase.co' }), /both SUPABASE_URL and SUPABASE_SERVICE_KEY/);
  assert.throws(() => storeFromEnv({ SUPABASE_SERVICE_KEY: 'k' }), /both SUPABASE_URL and SUPABASE_SERVICE_KEY/);
});

/* ---------- Local-host protection ---------- */

test('local-host check', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotes-'));
  const { server, port } = await start(createFileStore(dir), { enforceLocalHost: true });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ok = await rawRequest(port, { path: '/api/quotations', headers: { Host: `localhost:${port}` } });
  assert.equal(ok.status, 200);

  const bad = await rawRequest(port, { path: '/api/quotations', headers: { Host: 'evil.example' } });
  assert.equal(bad.status, 403);
});