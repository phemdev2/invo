(() => {
  'use strict';

  /* ---------- Sample data (from quotation #00588Q) ---------- */
  const uid = () => Math.random().toString(36).slice(2, 10);

  const STATUSES = ['draft', 'sent', 'approved', 'rejected'];
  const STATUS_LABEL = { draft: 'Draft', sent: 'Sent', approved: 'Approved', rejected: 'Rejected' };
  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

  const sample = () => ({
    company: {
      name: 'PRINTZION TECHNOLOGY',
      address: 'No 2, Golden Water Estate, Isheri Olofin.',
      phone: '+234 7062774479',
      email: 'infoprintzion@gmail.com'
    },
    client: { name: 'MONTEROSA | EQUINIX LG04', address: 'Lagos, Nigeria.' },
    meta: {
      no: '#00588Q',
      date: '2026-09-10',
      validity: 7,
      delivery: '3-4 working days after approval'
    },
    items: [
      { id: uid(), desc: 'WayBill Booklet',          price: 7100, qty: 30 },
      { id: uid(), desc: 'Requisition Booklet (A5)', price: 5300, qty: 20 },
      { id: uid(), desc: 'wages card (Pink)',        price: 35,   qty: 500 },
      { id: uid(), desc: 'Wage Card (Green)',        price: 35,   qty: 500 },
      { id: uid(), desc: 'Wage Card (white)',        price: 35,   qty: 500 },
      { id: uid(), desc: 'Wage Card ( Blue)',        price: 35,   qty: 500 },
      { id: uid(), desc: 'Stock Card',               price: 35,   qty: 1000 }
    ],
    vatRate: 7.5,
    vatEnabled: true,
    status: 'draft',
    approvedDate: '',
    payment: {
      acct: '1019664793',
      bank: 'Zenith Bank',
      name: 'Printzion Technology',
      tin: '1052137914'
    },
    signer: 'Osamuel'
  });

  // A new quotation keeps company, payment and terms, with a fresh number, date, client and items.
  const blankFrom = base => ({
    company: { ...base.company },
    client: { name: '', address: '' },
    meta: {
      no: nextNumber(base.meta.no),
      date: todayISO(),
      validity: base.meta.validity,
      delivery: base.meta.delivery
    },
    items: [{ id: uid(), desc: '', price: 0, qty: 1 }],
    vatRate: base.vatRate,
    vatEnabled: base.vatEnabled !== false,
    status: 'draft',
    approvedDate: '',
    payment: { ...base.payment },
    signer: base.signer
  });

  /* ---------- State ---------- */
  let state = sample();   // the quotation being edited (has an id once it exists on the server)
  let list = [];          // summaries of saved quotations, newest first

  // Merge unknown/partial data onto the sample shape so missing fields never break the UI.
  function normalise(data) {
    const base = sample();
    const out = {
      id: typeof data.id === 'string' ? data.id : null,
      updatedAt: data.updatedAt,
      company: { ...base.company, ...(data.company || {}) },
      client: { ...base.client, ...(data.client || {}) },
      meta: { ...base.meta, ...(data.meta || {}) },
      payment: { ...base.payment, ...(data.payment || {}) },
      vatRate: Number.isFinite(+data.vatRate) ? +data.vatRate : base.vatRate,
      vatEnabled: data.vatEnabled !== false,
      status: STATUSES.includes(data.status) ? data.status : 'draft',
      signer: typeof data.signer === 'string' ? data.signer : base.signer,
      items: Array.isArray(data.items)
        ? data.items.map(i => ({
            id: i.id || uid(),
            desc: String(i.desc ?? ''),
            price: Number(i.price) || 0,
            qty: Number(i.qty) || 0
          }))
        : base.items
    };
    out.meta.validity = Number(out.meta.validity) || 0;
    out.approvedDate = out.status === 'approved' && isDate(data.approvedDate) ? data.approvedDate : '';
    return out;
  }

  /* ---------- Helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const getPath = (obj, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
  const setPath = (obj, path, value) => {
    const keys = path.split('.');
    const last = keys.pop();
    keys.reduce((a, k) => a[k], obj)[last] = value;
  };

  const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

  const money = n =>
    '₦ ' + round2(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  const esc = s => String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const fmtDate = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  // Matches the printed quotation style: "10, September, 2026"
  const fmtPrintDate = d =>
    `${d.getDate()}, ${d.toLocaleString('en-GB', { month: 'long' })}, ${d.getFullYear()}`;

  function nextNumber(no) {
    return String(no).replace(/\d+/, m => String(+m + 1).padStart(m.length, '0'));
  }

  function todayISO() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function totalsOf(q) {
    const subtotal = round2(q.items.reduce((s, i) => s + i.price * i.qty, 0));
    const vat = q.vatEnabled === false ? 0 : round2(subtotal * (q.vatRate || 0) / 100);
    return { subtotal, vat, grand: round2(subtotal + vat) };
  }

  const summaryOf = q => {
    const t = totalsOf(q);
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
      updatedAt: q.updatedAt || new Date().toISOString()
    };
  };

  /* ---------- API ---------- */
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      let msg = res.statusText || `Request failed (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch (_) { /* keep default */ }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  /* ---------- Save status + autosave ---------- */
  const statusEl = $('#saveStatus');
  const listBtn = $('#listBtn');
  const listCount = $('#listCount');
  const listDialog = $('#listDialog');
  const listBody = $('#listBody');
  const listSearch = $('#listSearch');

  function setStatus(text, kind = '') {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
  }

  let saveTimer = null;
  let dirty = false;
  let saving = null;

  function scheduleSave() {
    if (!state.id) {
      setStatus('Not saved – server unreachable', 'error');
      return;
    }
    dirty = true;
    setStatus('Unsaved changes…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 600);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (saving) return saving.then(() => (dirty ? saveNow() : undefined));
    if (!dirty || !state.id) return undefined;

    const id = state.id;
    const payload = JSON.parse(JSON.stringify(state));
    dirty = false;
    setStatus('Saving…');

    saving = api('PUT', `/api/quotations/${encodeURIComponent(id)}`, payload)
      .then(saved => {
        if (state.id === id) state.updatedAt = saved.updatedAt;
        updateListEntry(normalise(saved));
        if (!dirty) setStatus('All changes saved', 'ok');
      })
      .catch(err => {
        if (err.status === 404) {
          // Deleted from another tab or device: retrying would never work.
          dirty = false;
          setStatus('This quotation was deleted elsewhere and can no longer be saved', 'error');
          return;
        }
        dirty = true;
        setStatus('Save failed – retrying…', 'error');
        saveTimer = setTimeout(saveNow, 3000);
      })
      .finally(() => { saving = null; });

    return saving;
  }

  // Resolves true when nothing is left unsaved.
  async function flush() {
    clearTimeout(saveTimer);
    await saveNow();
    return !dirty;
  }

  // Best-effort save when the tab is closed or hidden.
  window.addEventListener('pagehide', () => {
    if (!dirty || !state.id) return;
    try {
      fetch(`/api/quotations/${encodeURIComponent(state.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
        keepalive: true
      });
    } catch (_) { /* nothing more we can do */ }
  });

  /* ---------- Saved quotations list ---------- */
  const fmtShort = iso => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  function sortList() {
    list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function updateCount() {
    listCount.textContent = String(list.length);
  }

  function renderList() {
    sortList();
    const q = listSearch.value.trim().toLowerCase();
    const rows = list.filter(s => !q || `${s.no} ${s.client}`.toLowerCase().includes(q));

    if (!rows.length) {
      listBody.innerHTML = `<p class="list-empty">${list.length ? 'No quotations match your search.' : 'No saved quotations yet.'}</p>`;
      return;
    }

    listBody.innerHTML = rows.map(s => `
      <div class="list-row${s.id === state.id ? ' current' : ''}" data-id="${esc(s.id)}">
        <div class="list-main">
          <span class="list-title"><strong>${esc(s.no || '(no number)')}</strong><span class="chip chip-${esc(s.status || 'draft')}">${esc(STATUS_LABEL[s.status] || 'Draft')}</span></span>
          <span>${esc(s.client || 'No client')}</span>
        </div>
        <div class="list-meta">
          <span>${esc(fmtShort(s.date))}</span>
          <strong>${money(s.grand)}</strong>
        </div>
        <div class="list-actions">
          <button type="button" data-open>${s.id === state.id ? 'Current' : 'Open'}</button>
          <button type="button" class="danger" data-remove>Delete</button>
        </div>
      </div>`).join('');
  }

  // Keep the list in step with what was just saved, including while the dialog is open.
  function updateListEntry(q) {
    const entry = summaryOf(q);
    const i = list.findIndex(s => s.id === entry.id);
    if (i >= 0) list[i] = entry; else list.push(entry);
    updateCount();
    if (listDialog.open) renderList();
    if (revDialog.open) renderRevenue();
  }

  /* ---------- Rendering ---------- */
  const body = $('#itemsBody');

  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = (el.scrollHeight + el.offsetHeight - el.clientHeight) + 'px';
  }
  const autosizeAll = () => $$('textarea[data-f="desc"]', body).forEach(autosize);

  function rowHTML(it) {
    return `
      <tr data-id="${esc(it.id)}">
        <td data-label="Description">
          <textarea class="screen-only" data-f="desc" rows="1" placeholder="Item description" aria-label="Description">${esc(it.desc)}</textarea>
          <div class="print-only desc-text">${esc(it.desc)}</div>
        </td>
        <td data-label="Unit price" class="price">
          <input class="screen-only" data-f="price" type="number" min="0" step="any" inputmode="decimal" value="${it.price}" aria-label="Unit price">
          <span class="print-only price-text">${money(it.price)}</span>
        </td>
        <td data-label="Qty" class="qty">
          <input data-f="qty" type="number" min="0" step="any" inputmode="decimal" value="${it.qty}" aria-label="Quantity">
        </td>
        <td data-label="Total" class="total-cell">${money(it.price * it.qty)}</td>
        <td class="no-print act">
          <button type="button" class="icon-btn" data-del aria-label="Remove item" title="Remove item">&#10005;</button>
        </td>
      </tr>`;
  }

  function renderItems() {
    body.innerHTML = state.items.map(rowHTML).join('');
    autosizeAll();
  }

  function hydrateFields() {
    $$('[data-bind]').forEach(el => {
      const v = getPath(state, el.dataset.bind);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v == null ? '' : v;
    });
  }

  function updateTotals() {
    const { subtotal, vat, grand } = totalsOf(state);
    $('#subtotal').textContent = money(subtotal);
    const vatOn = state.vatEnabled !== false;
    $('#vatRow').classList.toggle('off', !vatOn);
    $('[data-bind="vatRate"]').disabled = !vatOn;
    $('#vat').textContent = vatOn ? money(vat) : '\u2014';
    $('#grand').textContent = money(grand);
  }

  function updateStatus() {
    const { date, validity } = state.meta;
    const badge = $('#statusBadge');
    const until = $('#validUntil');

    // The approval date row only makes sense once a quotation is approved
    $('#approvedRow').hidden = state.status !== 'approved';

    if (state.status === 'approved' || state.status === 'rejected') {
      const approved = state.status === 'approved';
      badge.textContent = approved ? 'Approved' : 'Rejected';
      badge.className = 'badge no-print ' + (approved ? 'ok' : 'expired');
      until.textContent = approved && isDate(state.approvedDate)
        ? 'Approved on ' + fmtDate(new Date(+state.approvedDate.slice(0, 4), +state.approvedDate.slice(5, 7) - 1, +state.approvedDate.slice(8, 10)))
        : '';
      return;
    }

    if (!date) {
      badge.textContent = '';
      badge.className = 'badge no-print';
      until.textContent = '';
      return;
    }

    const [y, m, d] = date.split('-').map(Number);
    const expiry = new Date(y, m - 1, d + (Number(validity) || 0));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expired = today > expiry;

    until.textContent = (expired ? 'Expired on ' : 'Valid until ') + fmtDate(expiry);
    badge.textContent = expired ? 'Expired' : 'Valid';
    badge.className = 'badge no-print ' + (expired ? 'expired' : 'ok');
  }

  function updateText() {
    $$('[data-text]').forEach(el => { el.textContent = getPath(state, el.dataset.text) || ''; });
    const { company, payment, meta } = state;

    // Print-only renderings of fields that are inputs on screen
    if (meta.date) {
      const [y, m, d] = meta.date.split('-').map(Number);
      $('#dateText').textContent = fmtPrintDate(new Date(y, m - 1, d));
    } else {
      $('#dateText').textContent = '';
    }
    $('#validityText').textContent = `${meta.validity} ${Number(meta.validity) === 1 ? 'Day' : 'Days'}`;
    $('#vatLabel').textContent = `VAT (${state.vatRate}%)`;

    $('#fineprint').textContent =
      `Quotation valid for ${meta.validity} days • ${company.name}` +
      (payment.tin ? ` • TIN: ${payment.tin}` : '') +
      (payment.acct ? ` • Acct: ${payment.acct} ${payment.bank}` : '');
    document.title = `Quotation ${meta.no || ''} – ${company.name || ''}`.trim();
  }

  function refresh() {
    updateTotals();
    updateStatus();
    updateText();
  }

  function renderAll() {
    hydrateFields();
    renderItems();
    refresh();
  }

  /* ---------- Opening / creating / deleting ---------- */
  function showQuote(q) {
    state = normalise(q);
    dirty = false;
    clearTimeout(saveTimer);
    if (state.id) history.replaceState(null, '', '#' + state.id);
    renderAll();
    updateCount();
    setStatus(state.id ? 'All changes saved' : '', state.id ? 'ok' : '');
  }

  async function openQuote(id) {
    showQuote(await api('GET', `/api/quotations/${encodeURIComponent(id)}`));
  }

  async function createQuote(data) {
    const created = await api('POST', '/api/quotations', data);
    list.push(summaryOf(normalise(created)));
    showQuote(created);
  }

  // Run a UI action and show any error in the status area instead of throwing.
  const run = async fn => {
    try { await fn(); } catch (err) { setStatus(err.message || 'Something went wrong', 'error'); }
  };

  /* ---------- Events ---------- */
  // Header / meta / payment fields
  document.addEventListener('input', e => {
    const el = e.target.closest('[data-bind]');
    if (!el) return;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.type === 'number') v = v === '' ? 0 : parseFloat(v) || 0;
    setPath(state, el.dataset.bind, v);

    if (el.dataset.bind === 'status') {
      // Approving stamps today's date (editable); leaving "approved" clears it.
      if (v === 'approved' && !state.approvedDate) state.approvedDate = todayISO();
      if (v !== 'approved') state.approvedDate = '';
      $('[data-bind="approvedDate"]').value = state.approvedDate;
    }

    refresh();
    scheduleSave();
  });

  // Line items: update just the changed row so inputs keep focus
  body.addEventListener('input', e => {
    const input = e.target.closest('[data-f]');
    if (!input) return;
    const tr = input.closest('tr');
    const item = state.items.find(i => i.id === tr.dataset.id);
    if (!item) return;
    const f = input.dataset.f;
    item[f] = f === 'desc' ? input.value : Math.max(0, parseFloat(input.value) || 0);
    if (f === 'desc') {
      autosize(input);
      $('.desc-text', tr).textContent = input.value;
    }
    if (f === 'price') $('.price-text', tr).textContent = money(item.price);
    $('.total-cell', tr).textContent = money(item.price * item.qty);
    updateTotals();
    scheduleSave();
  });

  // Descriptions are single paragraphs; Enter should not add a line break
  body.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('textarea')) e.preventDefault();
  });

  body.addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    const id = del.closest('tr').dataset.id;
    state.items = state.items.filter(i => i.id !== id);
    renderItems();
    updateTotals();
    scheduleSave();
  });

  $('#addRowBtn').addEventListener('click', () => {
    state.items.push({ id: uid(), desc: '', price: 0, qty: 1 });
    renderItems();
    updateTotals();
    scheduleSave();
    const last = $('tr:last-child [data-f="desc"]', body);
    if (last) last.focus();
  });

  $('#printBtn').addEventListener('click', () => window.print());
  window.addEventListener('beforeprint', autosizeAll);
  window.addEventListener('resize', autosizeAll);

  // Open the saved-quotations list. Unsaved edits are saved first so the list is accurate.
  async function showList() {
    await flush();
    listSearch.value = '';
    renderList();
    if (!listDialog.open) listDialog.showModal();
    try {
      list = await api('GET', '/api/quotations');
      updateCount();
      renderList();
    } catch (_) { /* keep showing what we already have */ }
  }

  async function deleteQuote(id) {
    const entry = list.find(s => s.id === id);
    const label = (entry && entry.no) || 'this quotation';
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return;

    const isCurrent = id === state.id;
    const template = state;
    if (isCurrent) {
      clearTimeout(saveTimer);
      if (saving) await saving; // let an in-flight save finish so it can't land after the delete
      dirty = false;
    }

    try {
      await api('DELETE', `/api/quotations/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err.status !== 404) throw err; // already gone elsewhere: treat as deleted
    }
    list = list.filter(s => s.id !== id);
    updateCount();

    if (isCurrent) {
      sortList();
      if (list.length) await openQuote(list[0].id);
      else await createQuote(blankFrom(template));
    }
    if (listDialog.open) renderList();
    setStatus(`Deleted ${label}`, 'ok');
  }

  async function manualSave() {
    if (!state.id) { setStatus('Not saved – server unreachable', 'error'); return; }
    dirty = true; // force a write even when nothing changed since the last autosave
    if (await flush()) {
      const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      setStatus(`Saved at ${t}`, 'ok');
    }
  }

  listBtn.addEventListener('click', () => run(showList));
  $('#listClose').addEventListener('click', () => listDialog.close());
  listDialog.addEventListener('click', e => { if (e.target === listDialog) listDialog.close(); }); // backdrop
  listSearch.addEventListener('input', renderList);

  listBody.addEventListener('click', e => run(async () => {
    const row = e.target.closest('.list-row');
    if (!row) return;
    const id = row.dataset.id;

    if (e.target.closest('[data-open]')) {
      if (id !== state.id) {
        if (!(await flush())) { setStatus('Could not save the current quotation yet', 'error'); return; }
        await openQuote(id);
      }
      listDialog.close();
    } else if (e.target.closest('[data-remove]')) {
      await deleteQuote(id);
    }
  }));

  $('#saveBtn').addEventListener('click', () => run(manualSave));

  // Ctrl+S / Cmd+S saves instead of opening the browser's "save page" dialog
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      run(manualSave);
    }
  });

  $('#newBtn').addEventListener('click', () => run(async () => {
    if (!(await flush())) { setStatus('Could not save the current quotation yet', 'error'); return; }
    await createQuote(blankFrom(state));
  }));

  $('#deleteBtn').addEventListener('click', () => run(async () => {
    if (!state.id) { setStatus('This quotation has not been saved yet', 'error'); return; }
    await deleteQuote(state.id);
  }));

  /* ---------- Revenue (approved quotations only) ---------- */
  const revDialog = $('#revenueDialog');
  const revPeriod = $('#revPeriod');
  const revFrom = $('#revFrom');
  const revTo = $('#revTo');
  const revCustom = $('#revCustom');
  const revBody = $('#revBody');

  const monthLabel = ym => {
    const m = /^(\d{4})-(\d{2})$/.exec(ym);
    if (!m) return 'No date';
    return new Date(+m[1], +m[2] - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  };

  // Returns [from, to] as YYYY-MM-DD strings; an empty string means "no limit".
  function periodRange(kind) {
    const t = todayISO();
    const y = +t.slice(0, 4);
    const m = +t.slice(5, 7);
    const pad = n => String(n).padStart(2, '0');
    const lastDay = (yy, mm) => new Date(yy, mm, 0).getDate();
    if (kind === 'month') return [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(lastDay(y, m))}`];
    if (kind === 'lastmonth') {
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      return [`${ly}-${pad(lm)}-01`, `${ly}-${pad(lm)}-${pad(lastDay(ly, lm))}`];
    }
    if (kind === 'year') return [`${y}-01-01`, `${y}-12-31`];
    if (kind === 'custom') return [revFrom.value || '', revTo.value || ''];
    return ['', ''];
  }

  // A quotation counts in the month it was approved (falling back to its own date if that is missing).
  const revenueDate = s => s.approvedDate || s.date || '';

  function revenueReport() {
    const [from, to] = periodRange(revPeriod.value);
    const approved = list
      .filter(s => s.status === 'approved')
      .filter(s => {
        const d = revenueDate(s);
        if (!d) return !from && !to;
        return (!from || d >= from) && (!to || d <= to);
      })
      .sort((a, b) => revenueDate(b).localeCompare(revenueDate(a)));

    const sum = key => round2(approved.reduce((n, s) => n + (Number(s[key]) || 0), 0));

    const months = new Map();
    for (const s of approved) {
      const key = revenueDate(s).slice(0, 7);
      const m = months.get(key) || { count: 0, revenue: 0, vat: 0, total: 0 };
      m.count += 1;
      m.revenue += Number(s.subtotal) || 0;
      m.vat += Number(s.vat) || 0;
      m.total += Number(s.grand) || 0;
      months.set(key, m);
    }

    const sent = list.filter(s => s.status === 'sent');
    return {
      approved,
      revenue: sum('subtotal'),
      vat: sum('vat'),
      total: sum('grand'),
      months: [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])),
      sentCount: sent.length,
      sentValue: round2(sent.reduce((n, s) => n + (Number(s.subtotal) || 0), 0))
    };
  }

  function renderRevenue() {
    revCustom.hidden = revPeriod.value !== 'custom';
    const r = revenueReport();

    $('#revRevenue').textContent = money(r.revenue);
    $('#revVat').textContent = money(r.vat);
    $('#revTotal').textContent = money(r.total);
    $('#revCount').textContent = String(r.approved.length);
    $('#revPending').textContent = r.sentCount
      ? `Still awaiting a decision: ${r.sentCount} sent ${r.sentCount === 1 ? 'quotation' : 'quotations'} worth ${money(r.sentValue)} (excl. VAT). Not counted above.`
      : 'No sent quotations are waiting for a decision.';

    if (!r.approved.length) {
      revBody.innerHTML = '<p class="list-empty">No approved quotations in this period. Set a quotation’s status to Approved to count it.</p>';
      return;
    }

    const monthRows = r.months.map(([key, m]) => `
      <tr>
        <td>${esc(monthLabel(key))}</td>
        <td class="num">${m.count}</td>
        <td class="num">${money(round2(m.revenue))}</td>
        <td class="num">${money(round2(m.vat))}</td>
        <td class="num">${money(round2(m.total))}</td>
      </tr>`).join('');

    const quoteRows = r.approved.map(s => `
      <div class="list-row" data-id="${esc(s.id)}">
        <div class="list-main">
          <strong>${esc(s.no || '(no number)')}</strong>
          <span>${esc(s.client || 'No client')}</span>
        </div>
        <div class="list-meta">
          <span>${esc(fmtShort(revenueDate(s)) || 'No date')}</span>
          <strong>${money(s.subtotal)}</strong>
        </div>
        <div class="list-actions"><button type="button" data-open>Open</button></div>
      </div>`).join('');

    revBody.innerHTML = `
      <div class="rev-body">
        <h3>By month</h3>
        <div class="rev-scroll">
          <table class="rev-table">
            <thead><tr><th>Month</th><th class="num">Quotes</th><th class="num">Revenue</th><th class="num">VAT</th><th class="num">Total</th></tr></thead>
            <tbody>${monthRows}</tbody>
            <tfoot><tr><td>Total</td><td class="num">${r.approved.length}</td><td class="num">${money(r.revenue)}</td><td class="num">${money(r.vat)}</td><td class="num">${money(r.total)}</td></tr></tfoot>
          </table>
        </div>
        <h3>Approved quotations</h3>
      </div>
      ${quoteRows}`;
  }

  async function showRevenue() {
    await flush(); // include edits that are not saved yet
    renderRevenue();
    if (!revDialog.open) revDialog.showModal();
    try {
      list = await api('GET', '/api/quotations');
      updateCount();
      renderRevenue();
    } catch (_) { /* keep showing what we already have */ }
  }

  $('#revenueBtn').addEventListener('click', () => run(showRevenue));
  $('#revClose').addEventListener('click', () => revDialog.close());
  revDialog.addEventListener('click', e => { if (e.target === revDialog) revDialog.close(); }); // backdrop
  revPeriod.addEventListener('change', renderRevenue);
  revFrom.addEventListener('input', renderRevenue);
  revTo.addEventListener('input', renderRevenue);

  revBody.addEventListener('click', e => run(async () => {
    const row = e.target.closest('.list-row');
    if (!row || !e.target.closest('[data-open]')) return;
    const id = row.dataset.id;
    if (id !== state.id) {
      if (!(await flush())) { setStatus('Could not save the current quotation yet', 'error'); return; }
      await openQuote(id);
    }
    revDialog.close();
  }));

  $('#exportBtn').addEventListener('click', () => {
    const { id, updatedAt, ...data } = state;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const safeNo = String(state.meta.no || 'quotation').replace(/[^\w-]+/g, '');
    a.href = URL.createObjectURL(blob);
    a.download = `quotation-${safeNo}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // Import saves the file as a new quotation, so nothing already saved is overwritten.
  $('#importFile').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => run(async () => {
      let data;
      try {
        data = normalise(JSON.parse(reader.result));
      } catch (_) {
        setStatus('That file is not a valid quotation export', 'error');
        return;
      }
      if (!(await flush())) { setStatus('Could not save the current quotation yet', 'error'); return; }
      delete data.id;
      await createQuote(data);
    });
    reader.readAsText(file);
  });

  /* ---------- Init ---------- */
  async function init() {
    try {
      list = await api('GET', '/api/quotations');
      updateCount();
      const wanted = location.hash.slice(1);
      let target = list.find(s => s.id === wanted) || list[0];
      if (!target) {
        // First run: seed the sample quotation
        await createQuote(sample());
        return;
      }
      await openQuote(target.id);
    } catch (err) {
      // Server not reachable (e.g. the page was opened as a plain file). Keep the UI usable.
      state = sample();
      renderAll();
      updateCount();
      $('#offlineBanner').hidden = false;
      setStatus('Offline – changes are not saved', 'error');
    }
  }

  init();
})();