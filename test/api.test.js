'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createServer } = require('../server');

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

async function start(dir, options) {
  const { server, init } = createServer(dir, options);
  await init();
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { server, port: server.address().port };
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

test('quotation API', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotes-'));
  const { server, port } = await start(dir);
  const base = `http://127.0.0.1:${port}`;
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
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
    assert.ok(r.body.items.every(i => i.id));
    id = r.body.id;

    const list = await call('GET', '/api/quotations');
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].no, '#00588Q');
    assert.equal(list.body[0].grand, 455800);
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
    assert.equal((await call('GET', '/api/quotations/nope')).status, 404);
    assert.equal((await call('PUT', '/api/quotations/nope', sampleBody())).status, 404);
    assert.equal((await call('DELETE', '/api/quotations/nope')).status, 404);
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

  await t.test('persists to disk', async () => {
    const again = await start(dir);
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

test('local-host check', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotes-'));
  const { server, port } = await start(dir, { enforceLocalHost: true });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ok = await rawRequest(port, { path: '/api/quotations', headers: { Host: `localhost:${port}` } });
  assert.equal(ok.status, 200);

  const bad = await rawRequest(port, { path: '/api/quotations', headers: { Host: 'evil.example' } });
  assert.equal(bad.status, 403);
});
