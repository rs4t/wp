// Admin: upload / move / delete wallpapers. Every save is one commit to the
// repo; Cloudflare rebuilds the site from it.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const API = new URL('../api/', location.href).href;
  const SITE = new URL('../', location.href).href;
  const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff'];
  const MAX = 50 * 1024 * 1024;

  const state = {
    files: [],        // library, from GitHub (source of truth)
    thumbs: new Map(),// repo path -> thumbnail url, from the live manifest
    queue: [],        // pending uploads
    upCat: '',        // category for uploads ('' = none)
    libCat: null,     // library filter
    sel: new Set(),   // selected repo paths
    busy: false,
  };

  // ---------- helpers ----------
  const mb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const extOf = (n) => (n.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  const catName = (c) => c || 'no category';

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('on'), 2200);
  }
  function banner(html, bad = false) {
    const b = $('#banner');
    b.innerHTML = html;
    b.classList.toggle('bad', bad);
    b.hidden = !html;
    if (html) b.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      credentials: 'same-origin',
      ...opts,
      headers: { 'X-WP-Admin': '1', ...(opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== 'login') { showLogin(); throw new Error('Logged out'); }
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  // ---------- auth ----------
  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#pw').focus(); }
  function showApp() { $('#login').hidden = true; $('#app').hidden = false; }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true; $('#loginErr').textContent = '';
    try {
      await api('login', { method: 'POST', body: JSON.stringify({ password: $('#pw').value }) });
      $('#pw').value = '';
      showApp(); load();
    } catch (err) {
      $('#loginErr').textContent = err.message;
      e.target.classList.remove('shake'); e.target.offsetWidth; e.target.classList.add('shake');
    } finally { btn.disabled = false; }
  });
  $('#logout').addEventListener('click', async () => { await api('logout', { method: 'POST' }).catch(() => {}); showLogin(); });

  // ---------- data ----------
  async function load() {
    $('#lib').innerHTML = '<li class="empty mono">loading…</li>';
    try {
      const [list, manifest] = await Promise.all([
        api('list'),
        fetch(SITE + 'manifest.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { items: [] })).catch(() => ({ items: [] })),
      ]);
      state.files = list.files;
      state.thumbs = new Map(manifest.items.filter((i) => i.src).map((i) => [i.src, SITE + i.t + '-480.webp']));
      for (const p of [...state.sel]) if (!state.files.some((f) => f.path === p)) state.sel.delete(p);
      renderCats(); renderLib(); renderSel();
    } catch (err) {
      if (err.message !== 'Logged out') $('#lib').innerHTML = `<li class="empty mono">${esc(err.message)}</li>`;
    }
  }
  $('#refresh').addEventListener('click', load);

  const categories = () => [...new Set(state.files.map((f) => f.category).filter(Boolean))].sort();

  // ---------- category chips ----------
  function renderCats() {
    const cats = categories();
    if (state.upCat && !cats.includes(state.upCat) && !state.newCat) state.upCat = '';

    // upload picker: existing + none + new
    const up = $('#upCats');
    up.innerHTML = '';
    const chip = (label, value, pressed, onClick, count) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cat'; b.setAttribute('aria-pressed', String(pressed));
      b.innerHTML = esc(label) + (count != null ? `<sup>${count}</sup>` : '');
      b.addEventListener('click', onClick);
      return b;
    };
    for (const c of cats) up.append(chip(c, c, state.upCat === c && !state.newCat, () => { state.newCat = false; state.upCat = c; renderCats(); }));
    const newIn = document.createElement('input');
    newIn.type = 'text'; newIn.className = 'cat-new'; newIn.placeholder = '+ new category'; newIn.maxLength = 40;
    if (state.newCat) { newIn.value = state.upCat; newIn.style.borderColor = 'var(--fg)'; }
    newIn.addEventListener('input', () => {
      state.newCat = !!newIn.value.trim();
      state.upCat = newIn.value.trim().toLowerCase();
      up.querySelectorAll('.cat').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      newIn.style.borderColor = state.newCat ? 'var(--fg)' : '';
      if (!state.newCat) renderCats();
    });
    up.append(newIn);
    up.append(chip('none', '', !state.upCat && !state.newCat, () => { state.newCat = false; state.upCat = ''; renderCats(); }));

    // library filter
    const lib = $('#libCats');
    lib.innerHTML = '';
    const count = (c) => state.files.filter((f) => f.category === c).length;
    lib.append(chip('all', null, state.libCat === null, () => { state.libCat = null; renderCats(); renderLib(); }, state.files.length));
    for (const c of cats) lib.append(chip(c, c, state.libCat === c, () => { state.libCat = c; renderCats(); renderLib(); }, count(c)));
    if (state.files.some((f) => !f.category)) lib.append(chip('no category', '', state.libCat === '', () => { state.libCat = ''; renderCats(); renderLib(); }, count('')));

    // move-to select
    const sel = $('#moveTo');
    sel.innerHTML = '<option value="" disabled selected>move to…</option>' +
      cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('') +
      '<option value="__none__">no category</option><option value="__new__">new category…</option>';
  }

  // ---------- library ----------
  function renderLib() {
    const list = state.files.filter((f) => state.libCat === null || f.category === state.libCat);
    $('#libCount').textContent = String(state.files.length);
    const ul = $('#lib');
    if (!list.length) { ul.innerHTML = '<li class="empty mono">no wallpapers yet — add some above</li>'; return; }
    ul.innerHTML = list.map((f) => {
      const thumb = state.thumbs.get(f.path);
      return `<li class="l${state.sel.has(f.path) ? ' sel' : ''}" data-path="${esc(f.path)}" tabindex="0" role="checkbox" aria-checked="${state.sel.has(f.path)}">
        <div class="l-img" ${thumb ? `style="background-image:url('${esc(thumb)}')"` : ''}>${thumb ? '' : '<span class="mono">building…</span>'}</div>
        <span class="l-check">✓</span>
        <div class="l-cap"><b>${esc(f.name.replace(/\.[^.]+$/, ''))}</b><span class="mono dim">${esc(catName(f.category))} · ${mb(f.size)}</span></div>
      </li>`;
    }).join('');
  }
  function toggleSel(li) {
    const p = li.dataset.path;
    state.sel.has(p) ? state.sel.delete(p) : state.sel.add(p);
    li.classList.toggle('sel', state.sel.has(p));
    li.setAttribute('aria-checked', String(state.sel.has(p)));
    renderSel();
  }
  $('#lib').addEventListener('click', (e) => { const li = e.target.closest('.l'); if (li) toggleSel(li); });
  $('#lib').addEventListener('keydown', (e) => { const li = e.target.closest('.l'); if (li && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggleSel(li); } });

  function renderSel() {
    const n = state.sel.size;
    $('#selDock').hidden = n === 0 || state.queue.length > 0;
    $('#selSummary').textContent = `${n} selected`;
  }
  $('#clearSel').addEventListener('click', () => { state.sel.clear(); renderLib(); renderSel(); });

  $('#moveTo').addEventListener('change', async (e) => {
    let cat = e.target.value;
    e.target.selectedIndex = 0;
    if (cat === '__new__') { cat = prompt('New category name:')?.trim().toLowerCase(); if (!cat) return; }
    if (cat === '__none__') cat = '';
    const move = [...state.sel].map((from) => ({ from, category: cat }));
    await save({ move }, `Moved ${move.length} to ${catName(cat)}`);
  });
  $('#delete').addEventListener('click', async () => {
    const n = state.sel.size;
    if (!confirm(`Delete ${n} wallpaper${n === 1 ? '' : 's'} from the site?\n\nThey stay in the repo's git history, so this can be undone on GitHub.`)) return;
    await save({ delete: [...state.sel] }, `Deleted ${n}`);
  });

  async function save(body, label) {
    if (state.busy) return;
    state.busy = true;
    document.querySelectorAll('.dock .btn, .dock select').forEach((b) => (b.disabled = true));
    try {
      const r = await api('commit', { method: 'POST', body: JSON.stringify(body) });
      state.sel.clear();
      if (!r.noop) liveBanner(label);
      await load();
    } catch (err) {
      if (err.message !== 'Logged out') banner(`Couldn't save: ${esc(err.message)}`, true);
    } finally {
      state.busy = false;
      document.querySelectorAll('.dock .btn, .dock select').forEach((b) => (b.disabled = false));
      renderSel();
    }
  }
  function liveBanner(label) {
    banner(`<b>${esc(label)}.</b> Saved to the repo — the site rebuilds and shows it in about 2–3 minutes.`);
    toast('Saved');
  }

  // ---------- upload queue ----------
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
  $('#files').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  // Dropping anywhere on the page works too.
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { if (!drop.contains(e.target)) { e.preventDefault(); addFiles(e.dataTransfer.files); } });

  function addFiles(list) {
    const skipped = [];
    for (const file of list) {
      const ext = extOf(file.name);
      if (!IMAGE_EXT.includes(ext)) { skipped.push(`${file.name} (not an image)`); continue; }
      if (file.size > MAX) { skipped.push(`${file.name} (over 50 MB)`); continue; }
      const q = { id: Math.random().toString(36).slice(2), file, ext, name: file.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(file), status: 'ready' };
      state.queue.push(q);
      const img = new Image();
      img.onload = () => { q.res = `${img.naturalWidth}×${img.naturalHeight}`; const m = document.querySelector(`[data-q="${q.id}"] .q-res`); if (m) m.textContent = q.res; };
      img.src = q.url;
    }
    if (skipped.length) toast(`Skipped: ${skipped.join(', ')}`);
    renderQueue();
  }

  function renderQueue() {
    const ul = $('#queue');
    $('#queueWrap').hidden = state.queue.length === 0;
    $('#upDock').hidden = state.queue.length === 0;
    renderSel();
    ul.innerHTML = state.queue.map((q) => `
      <li class="q ${q.status === 'done' ? 'done' : ''} ${q.status === 'failed' ? 'failed' : ''} ${state.busy ? 'busy' : ''}" data-q="${q.id}">
        <div class="q-img" style="background-image:url('${q.url}')"></div>
        <button class="q-x" type="button" aria-label="Remove">✕</button>
        <div class="q-bar"><i style="width:${q.progress || 0}%"></i></div>
        <div class="q-body">
          <input type="text" value="${esc(q.name)}" aria-label="Title" maxlength="100">
          <div class="q-meta mono"><span class="q-res">${q.res || ''}</span><span>${mb(q.file.size)} · ${q.ext}</span></div>
          <span class="q-status mono">${q.error ? esc(q.error) : q.status === 'done' ? 'uploaded' : ''}</span>
        </div>
      </li>`).join('');
    const total = state.queue.reduce((s, q) => s + q.file.size, 0);
    const n = state.queue.length;
    $('#upSummary').textContent = `${n} wallpaper${n === 1 ? '' : 's'} · ${mb(total)}`;
    $('#upload').textContent = state.busy ? 'uploading…' : `upload ${n}`;
    $('#upload').disabled = $('#clearQueue').disabled = state.busy;
  }
  $('#queue').addEventListener('input', (e) => {
    const li = e.target.closest('.q');
    const q = state.queue.find((x) => x.id === li?.dataset.q);
    if (q) q.name = e.target.value;
  });
  $('#queue').addEventListener('click', (e) => {
    if (!e.target.closest('.q-x') || state.busy) return;
    const id = e.target.closest('.q').dataset.q;
    const i = state.queue.findIndex((q) => q.id === id);
    URL.revokeObjectURL(state.queue[i].url);
    state.queue.splice(i, 1);
    renderQueue();
  });
  $('#clearQueue').addEventListener('click', () => { state.queue.forEach((q) => URL.revokeObjectURL(q.url)); state.queue = []; renderQueue(); });

  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.slice(r.result.indexOf(',') + 1));
      r.onerror = () => reject(new Error('Could not read file'));
      r.readAsDataURL(file);
    });
  }

  function uploadBlob(q) {
    return toBase64(q.file).then((b64) => new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', API + 'blob');
      x.setRequestHeader('X-WP-Admin', '1');
      x.setRequestHeader('Content-Type', 'text/plain');
      x.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(q, Math.round((e.loaded / e.total) * 95)); };
      x.onload = () => {
        let data = {};
        try { data = JSON.parse(x.responseText); } catch {}
        if (x.status === 401) { showLogin(); reject(new Error('Logged out')); }
        else if (x.status >= 200 && x.status < 300 && data.sha) resolve(data.sha);
        else reject(new Error(data.error || `Upload failed (${x.status})`));
      };
      x.onerror = () => reject(new Error('Network error'));
      x.send(b64);
    }));
  }
  function setProgress(q, p) {
    q.progress = p;
    const bar = document.querySelector(`[data-q="${q.id}"] .q-bar i`);
    if (bar) bar.style.width = p + '%';
  }

  $('#upload').addEventListener('click', async () => {
    if (state.busy || !state.queue.length) return;
    for (const q of state.queue) if (!q.name.trim()) { toast('Every wallpaper needs a title'); return; }
    state.busy = true;
    banner('');
    renderQueue();
    const cat = state.upCat;
    // Upload one at a time (steady progress, gentle on mobile data), then one commit.
    for (const q of state.queue) {
      if (q.sha) continue;
      q.error = null; q.status = 'uploading';
      try {
        q.sha = await uploadBlob(q);
        q.status = 'done'; setProgress(q, 100);
      } catch (err) {
        q.status = 'failed'; q.error = err.message;
        if (err.message === 'Logged out') break;
      }
      renderQueue();
    }
    const ok = state.queue.filter((q) => q.sha);
    const failed = state.queue.filter((q) => !q.sha);
    if (ok.length) {
      try {
        await api('commit', { method: 'POST', body: JSON.stringify({ add: ok.map((q) => ({ sha: q.sha, name: q.name.trim(), ext: q.ext, category: cat })) }) });
        ok.forEach((q) => URL.revokeObjectURL(q.url));
        state.queue = failed;
        state.newCat = false;
        liveBanner(`Added ${ok.length} wallpaper${ok.length === 1 ? '' : 's'}${cat ? ` to ${cat}` : ''}`);
        if (failed.length) banner($('#banner').innerHTML + `<br>${failed.length} failed — they're still in the queue, press upload to retry.`, true);
        await load();
      } catch (err) {
        if (err.message !== 'Logged out') banner(`Uploaded, but couldn't save: ${esc(err.message)}. Press upload to retry.`, true);
      }
    } else if (failed.length) {
      banner(`Upload failed: ${esc(failed[0].error || 'unknown error')}`, true);
    }
    state.busy = false;
    renderQueue();
  });

  addEventListener('beforeunload', (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- boot ----------
  api('session').then(() => { showApp(); load(); }).catch((err) => {
    if (err.message !== 'Logged out') { showLogin(); $('#loginErr').textContent = err.message; }
  });
})();
