// Admin: upload, name, sort into collections, delete. Files go to R2; every save
// is one commit to wallpapers.json / collections.json, and Cloudflare rebuilds the site from it.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const API = new URL('../api/', location.href).href;
  const SITE = new URL('../', location.href).href;
  const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff'];
  const MAX = 50 * 1024 * 1024;

  const state = {
    files: [],        // wallpapers.json, from GitHub (source of truth)
    collections: [],  // collections.json
    thumbs: new Map(),// hash -> thumbnail url, from the live manifest
    queue: [],        // pending uploads
    newColls: [],     // collections created here, saved with the next commit
    libFilter: null,  // null = all, '' = one-offs, else a collection id
    sel: new Set(),   // selected hashes
    draft: null,      // collections section edits
    busy: false,
  };

  // ---------- helpers ----------
  const mb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const extOf = (n) => (n.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  const slug = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  // "fractal_glass-blue" → "Fractal Glass Blue"
  const niceName = (file) => file.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());
  const allColls = () => [...state.collections, ...state.newColls];
  const collName = (id) => allColls().find((c) => c.id === id)?.name || 'no collection';

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

  // A <select> of collections. extra: leading options like [['__keep__', 'collection…']].
  function collOptions(selected, extra = []) {
    return [...extra, ['', 'no collection'], ...allColls().map((c) => [c.id, c.name]), ['__new__', 'new collection…']]
      .map(([v, l]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(l)}</option>`).join('');
  }
  // Handles the "new collection…" choice; returns the chosen id ('' for none) or null if cancelled.
  function pickCollection(select) {
    if (select.value !== '__new__') return select.value;
    const name = prompt('New collection name:')?.trim();
    if (!name) { select.value = ''; return null; }
    // Names without Latin letters (e.g. "Горы") still need a URL-safe id.
    const id = slug(name) || `c-${Date.now().toString(36)}`;
    if (!allColls().some((c) => c.id === id)) state.newColls.push({ id, name: name.slice(0, 40) });
    select.innerHTML = collOptions(id, [...select.options].filter((o) => o.value === '__keep__').map((o) => [o.value, o.text]));
    return id;
  }
  // Collections list to send when this save puts something into a collection created here;
  // a "new collection…" that was picked and then abandoned is dropped.
  function withNewColls(body) {
    const used = new Set([...(body.add || []), ...(body.update || [])].map((x) => x.collection).filter(Boolean));
    state.newColls = state.newColls.filter((c) => used.has(c.id));
    return state.newColls.length ? { ...body, collections: allColls() } : body;
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
  // The live site's manifest says what is deployed; anything in the repo but
  // not in it yet is still building. Poll until everything is live.
  const fetchManifest = () => fetch(SITE + 'manifest.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { items: [] })).catch(() => ({ items: [] }));
  const thumbsFrom = (m) => new Map(m.items.map((i) => [i.hash, SITE + i.t + '-480.webp']));
  let pollT = 0;
  function renderStatus() {
    const building = state.files.filter((f) => !state.thumbs.has(f.hash)).length;
    const el = $('#status');
    el.className = 'status mono ' + (building ? 'busy' : 'live');
    el.textContent = !state.files.length ? '' : building ? `${building} building…` : 'all live ✓';
    clearTimeout(pollT);
    if (building) pollT = setTimeout(async () => { state.thumbs = thumbsFrom(await fetchManifest()); renderLib(); renderStatus(); }, 20000);
  }

  async function load() {
    $('#lib').innerHTML = '<li class="empty mono">loading…</li>';
    try {
      const [list, manifest] = await Promise.all([api('list'), fetchManifest()]);
      state.files = list.files;
      state.collections = list.collections;
      state.newColls = state.newColls.filter((c) => !state.collections.some((x) => x.id === c.id));
      state.thumbs = thumbsFrom(manifest);
      state.draft = null;
      for (const h of [...state.sel]) if (!state.files.some((f) => f.hash === h)) state.sel.delete(h);
      renderLibCats(); renderLib(); renderSel(); renderStatus(); renderColls(); renderUpColl();
    } catch (err) {
      if (err.message !== 'Logged out') $('#lib').innerHTML = `<li class="empty mono">${esc(err.message)}</li>`;
    }
  }
  $('#refresh').addEventListener('click', load);

  async function save(body, label) {
    if (state.busy) return false;
    state.busy = true;
    document.querySelectorAll('.dock .btn, .dock select, #saveColls').forEach((b) => (b.disabled = true));
    try {
      const r = await api('commit', { method: 'POST', body: JSON.stringify(withNewColls(body)) });
      state.newColls = [];
      state.sel.clear();
      if (!r.noop) liveBanner(label);
      await load();
      return true;
    } catch (err) {
      if (err.message !== 'Logged out') banner(`Couldn't save: ${esc(err.message)}`, true);
      return false;
    } finally {
      state.busy = false;
      document.querySelectorAll('.dock .btn, .dock select').forEach((b) => (b.disabled = false));
      renderSel(); renderColls();
    }
  }
  function liveBanner(label) {
    banner(`<b>${esc(label)}.</b> Saved to the repo — the site rebuilds and shows it in about 2–3 minutes.`);
    toast('Saved');
  }

  // ---------- library ----------
  function chip(label, pressed, onClick, count) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cat'; b.setAttribute('aria-pressed', String(pressed));
    b.innerHTML = esc(label) + (count != null ? `<sup>${count}</sup>` : '');
    b.addEventListener('click', onClick);
    return b;
  }
  function renderLibCats() {
    const el = $('#libCats');
    el.innerHTML = '';
    const count = (id) => state.files.filter((f) => (f.collection || '') === id).length;
    const pick = (v) => () => { state.libFilter = v; renderLibCats(); renderLib(); };
    el.append(chip('all', state.libFilter === null, pick(null), state.files.length));
    for (const c of state.collections) el.append(chip(c.name, state.libFilter === c.id, pick(c.id), count(c.id)));
    el.append(chip('one-offs', state.libFilter === '', pick(''), count('')));
  }
  function renderLib() {
    const list = state.files.filter((f) => state.libFilter === null || (f.collection || '') === state.libFilter)
      .sort((a, b) => b.added - a.added);
    $('#libCount').textContent = String(state.files.length);
    const ul = $('#lib');
    if (!list.length) { ul.innerHTML = '<li class="empty mono">nothing here yet — add some above</li>'; return; }
    ul.innerHTML = list.map((f) => {
      const thumb = state.thumbs.get(f.hash);
      return `<li class="l${state.sel.has(f.hash) ? ' sel' : ''}" data-hash="${f.hash}" tabindex="0" role="checkbox" aria-checked="${state.sel.has(f.hash)}">
        <div class="l-img" ${thumb ? `style="background-image:url('${esc(thumb)}')"` : ''}>${thumb ? '' : '<span class="mono">building…</span>'}</div>
        <span class="l-check">✓</span>
        <div class="l-cap"><b>${esc(f.name)}</b><span class="mono dim">${esc(f.collection ? collName(f.collection) : 'one-off')} · ${mb(f.size)}</span></div>
      </li>`;
    }).join('');
  }
  function toggleSel(li) {
    const h = li.dataset.hash;
    state.sel.has(h) ? state.sel.delete(h) : state.sel.add(h);
    li.classList.toggle('sel', state.sel.has(h));
    li.setAttribute('aria-checked', String(state.sel.has(h)));
    renderSel();
  }
  $('#lib').addEventListener('click', (e) => { const li = e.target.closest('.l'); if (li) toggleSel(li); });
  $('#lib').addEventListener('keydown', (e) => { const li = e.target.closest('.l'); if (li && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggleSel(li); } });

  // ---------- edit selection (dock) ----------
  function renderSel() {
    const n = state.sel.size, one = n === 1;
    $('#selDock').hidden = n === 0 || state.queue.length > 0;
    if (!n) return;
    const f = one && state.files.find((x) => x.hash === [...state.sel][0]);
    $('#selSummary').textContent = one ? '' : `${n} selected`;
    for (const id of ['#editName', '#editCredit', '#editLink']) $(id).hidden = !one;
    $('#editColl').innerHTML = one ? collOptions(f.collection || '') : collOptions('__keep__', [['__keep__', 'move to…']]);
    if (one) {
      $('#editName').value = f.name;
      $('#editCredit').value = f.credit?.name || '';
      $('#editLink').value = f.credit?.link || '';
    }
  }
  $('#editColl').addEventListener('change', (e) => pickCollection(e.target));
  $('#selDock').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hashes = [...state.sel];
    const coll = $('#editColl').value;
    if (coll === '__new__') return;
    if (hashes.length === 1) {
      const name = $('#editName').value.trim();
      if (!name) return toast('Every wallpaper needs a name');
      const credit = $('#editCredit').value.trim();
      await save({ update: [{ hash: hashes[0], name, collection: coll || null, credit: credit ? { name: credit, link: $('#editLink').value.trim() } : null }] }, `Saved ${name}`);
    } else {
      if (coll === '__keep__') return toast('Pick a collection to move them to');
      await save({ update: hashes.map((hash) => ({ hash, collection: coll || null })) }, `Moved ${hashes.length} to ${collName(coll)}`);
    }
  });
  $('#clearSel').addEventListener('click', () => { state.sel.clear(); renderLib(); renderSel(); });
  $('#delete').addEventListener('click', async () => {
    const n = state.sel.size;
    if (!confirm(`Delete ${n} wallpaper${n === 1 ? '' : 's'} from the site?\n\nThe files stay in storage, so reverting the commit on GitHub brings them back.`)) return;
    await save({ delete: [...state.sel] }, `Deleted ${n}`);
  });

  // ---------- collections section ----------
  function renderColls() {
    const draft = state.draft || (state.draft = state.collections.map((c) => ({ ...c })));
    $('#collCount').textContent = String(state.collections.length);
    $('#saveColls').disabled = state.busy || JSON.stringify(draft) === JSON.stringify(state.collections);
    $('#colls').innerHTML = draft.map((c, i) => {
      const members = state.files.filter((f) => f.collection === c.id).sort((a, b) => b.added - a.added);
      const covers = `<option value="">cover: newest</option>` + members.map((f) => `<option value="${f.hash}"${f.hash === c.cover ? ' selected' : ''}>cover: ${esc(f.name)}</option>`).join('');
      return `<li class="coll" data-i="${i}">
        <input type="text" class="c-name" value="${esc(c.name)}" maxlength="40" aria-label="Collection name">
        <span class="mono dim">${members.length}</span>
        <select class="c-cover" aria-label="Cover">${covers}</select>
      </li>`;
    }).join('') || '<li class="empty mono">no collections yet — pick "new collection…" when uploading</li>';
  }
  $('#colls').addEventListener('input', (e) => {
    const c = state.draft[+e.target.closest('.coll').dataset.i];
    if (e.target.classList.contains('c-name')) c.name = e.target.value;
    if (e.target.classList.contains('c-cover')) { if (e.target.value) c.cover = e.target.value; else delete c.cover; }
    $('#saveColls').disabled = JSON.stringify(state.draft) === JSON.stringify(state.collections);
  });
  $('#saveColls').addEventListener('click', async () => {
    if (state.draft.some((c) => !c.name.trim())) return toast('Every collection needs a name');
    await save({ collections: state.draft.map((c) => ({ ...c, name: c.name.trim() })) }, 'Saved collections');
  });

  // ---------- upload queue ----------
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
  $('#files').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  // Dropping anywhere on the page works too.
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { if (!drop.contains(e.target)) { e.preventDefault(); addFiles(e.dataTransfer.files); } });

  function renderUpColl() { $('#upColl').innerHTML = collOptions($('#upColl').value || ''); }
  $('#upColl').addEventListener('change', (e) => pickCollection(e.target));

  function addFiles(list) {
    const skipped = [];
    for (const file of list) {
      const ext = extOf(file.name);
      if (!IMAGE_EXT.includes(ext)) { skipped.push(`${file.name} (not an image)`); continue; }
      if (file.size > MAX) { skipped.push(`${file.name} (over 50 MB)`); continue; }
      const q = { id: Math.random().toString(36).slice(2), file, ext, name: niceName(file.name), url: URL.createObjectURL(file), status: 'ready' };
      state.queue.push(q);
      const img = new Image();
      img.onload = () => {
        // Desktop wallpapers only: vertical images leave the queue.
        if (img.naturalHeight > img.naturalWidth) {
          state.queue = state.queue.filter((x) => x !== q);
          URL.revokeObjectURL(q.url);
          toast(`Skipped ${file.name}: vertical — the site is desktop wallpapers only`);
          return renderQueue();
        }
        q.res = `${img.naturalWidth}×${img.naturalHeight}`; const m = document.querySelector(`[data-q="${q.id}"] .q-res`); if (m) m.textContent = q.res;
      };
      img.src = q.url;
    }
    if (skipped.length) toast(`Skipped: ${skipped.join(', ')}`);
    renderUpColl();
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
          <input type="text" value="${esc(q.name)}" aria-label="Name" maxlength="100">
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

  const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff' };
  const sha1Of = async (blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', await blob.arrayBuffer()))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');

  // Streams the file into R2; resolves to its hash (the site's id for the file).
  async function putOriginal(blob, ext, onProgress) {
    const sha1 = await sha1Of(blob);
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', API + 'upload?sha1=' + sha1);
      x.setRequestHeader('X-WP-Admin', '1');
      x.setRequestHeader('Content-Type', blob.type || TYPES[ext] || 'application/octet-stream');
      if (onProgress) x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 95)); };
      x.onload = () => {
        let data = {};
        try { data = JSON.parse(x.responseText); } catch {}
        if (x.status === 401) { showLogin(); reject(new Error('Logged out')); }
        else if (x.status >= 200 && x.status < 300 && data.hash) resolve(data.hash);
        else reject(new Error(data.error || `Upload failed (${x.status})`));
      };
      x.onerror = () => reject(new Error('Network error'));
      x.send(blob);
    });
  }
  function setProgress(q, p) {
    q.progress = p;
    const bar = document.querySelector(`[data-q="${q.id}"] .q-bar i`);
    if (bar) bar.style.width = p + '%';
  }

  $('#upload').addEventListener('click', async () => {
    if (state.busy || !state.queue.length) return;
    for (const q of state.queue) if (!q.name.trim()) { toast('Every wallpaper needs a name'); return; }
    const coll = $('#upColl').value;
    if (coll === '__new__') return;
    state.busy = true;
    banner('');
    renderQueue();
    // Upload one at a time (steady progress, gentle on mobile data), then one commit.
    for (const q of state.queue) {
      if (q.hash) continue;
      q.error = null; q.status = 'uploading';
      try {
        q.hash = await putOriginal(q.file, q.ext, (p) => setProgress(q, p));
        q.status = 'done'; setProgress(q, 100);
      } catch (err) {
        q.status = 'failed'; q.error = err.message;
        if (err.message === 'Logged out') break;
      }
      renderQueue();
    }
    const ok = state.queue.filter((q) => q.hash);
    const failed = state.queue.filter((q) => !q.hash);
    if (ok.length) {
      try {
        await api('commit', { method: 'POST', body: JSON.stringify(withNewColls({ add: ok.map((q) => ({ hash: q.hash, name: q.name.trim(), ext: q.ext, ...(coll ? { collection: coll } : {}) })) })) });
        state.newColls = [];
        ok.forEach((q) => URL.revokeObjectURL(q.url));
        state.queue = failed;
        liveBanner(`Added ${ok.length} wallpaper${ok.length === 1 ? '' : 's'}${coll ? ` to ${collName(coll)}` : ''}`);
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
