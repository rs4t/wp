// Community submissions: "share your setup" and "send a wallpaper".
// Any element with [data-submit] opens the form (data-submit="setup" preselects).
// The buttons only appear once /api/submit/config says submitting is set up.
(() => {
  'use strict';
  const ROOT = new URL(document.body.dataset.root || './', location.href);
  const api = (p) => new URL(`api/submit/${p}`, ROOT).href;
  const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/tiff'];
  const MAX = 50 * 1024 * 1024;
  const LIMIT = { setup: 3, wallpaper: 5 };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const mb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

  let cfg = null, modal = null, widgetId = null, token = '';
  const st = { type: null, files: [], picks: [], busy: false };

  fetch(api('config')).then((r) => r.json()).then((c) => {
    if (!c.enabled) return;
    cfg = c;
    document.body.classList.add('can-submit');
  }).catch(() => {});

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-submit]');
    if (!t || !cfg) return;
    e.preventDefault();
    open(t.dataset.submit || null);
  });

  // ---------- modal ----------
  function build() {
    modal = document.createElement('div');
    modal.className = 'sub-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Share with the community');
    modal.innerHTML = `
      <div class="sub-back" data-close></div>
      <div class="sub-sheet">
        <button class="sub-x" type="button" data-close aria-label="Close">✕</button>
        <section class="sub-step" data-step="pick">
          <h2>Share with the community</h2>
          <p class="mono dim">Everything is reviewed before it appears on the site.</p>
          <div class="sub-pick">
            <button type="button" data-type="setup"><b>My setup</b><span>A photo or screenshot of your desk, screen or phone using a wallpaper from here.</span></button>
            <button type="button" data-type="wallpaper"><b>A wallpaper I made</b><span>Send your own work to be added to the collection, credited to you.</span></button>
          </div>
        </section>
        <form class="sub-step" data-step="form" novalidate hidden>
          <button class="linkish back" type="button" data-back>← back</button>
          <h2 data-title></h2>
          <label class="sub-drop">
            <input type="file" multiple accept="${TYPES.join(',')}">
            <span data-drop-label></span>
            <span class="mono dim">jpg · png · webp · avif · tiff — up to 50 MB each</span>
          </label>
          <ul class="sub-files"></ul>

          <div class="sub-field" data-for="setup">
            <span class="label mono">which wallpaper is it? <i>optional</i></span>
            <div class="sub-picked"></div>
            <input type="search" class="sub-search" placeholder="search wallpapers…" autocomplete="off">
            <div class="sub-results"></div>
          </div>
          <label class="sub-field" data-for="setup"><span class="label mono">caption <i>optional</i></span>
            <input name="caption" maxlength="200" placeholder="e.g. my desk at night"></label>
          <label class="sub-field" data-for="wallpaper"><span class="label mono">category</span>
            <select name="category"></select></label>

          <label class="sub-field"><span class="label mono">name or handle <i>shown as credit</i></span>
            <input name="name" maxlength="60" required placeholder="@you"></label>
          <label class="sub-field"><span class="label mono">email <i>optional, never shown — only so I can reply</i></span>
            <input name="email" type="email" maxlength="120" placeholder="you@example.com"></label>
          <label class="sub-field"><span class="label mono">message <i>optional</i></span>
            <textarea name="message" maxlength="2000" rows="3"></textarea></label>

          <label class="sub-check"><input type="checkbox" name="consent"> <span data-consent></span></label>
          <div class="sub-turnstile"></div>
          <p class="sub-err" role="alert"></p>
          <button class="btn solid sub-send" type="submit">send</button>
        </form>
        <section class="sub-step sub-done" data-step="done" hidden>
          <em>Thank you!</em>
          <p>It'll show up on the site once it's been reviewed.</p>
          <button class="btn ghost" type="button" data-close>close</button>
        </section>
      </div>`;
    document.body.append(modal);

    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) close();
      const typeBtn = e.target.closest('[data-type]');
      if (typeBtn) show(typeBtn.dataset.type);
      if (e.target.closest('[data-back]') && !st.busy) step('pick');
      const rm = e.target.closest('[data-rm]');
      if (rm && !st.busy) { URL.revokeObjectURL(st.files[+rm.dataset.rm].url); st.files.splice(+rm.dataset.rm, 1); renderFiles(); }
      const pick = e.target.closest('[data-pick]');
      if (pick) togglePick(pick.dataset.pick);
    });
    modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    const input = modal.querySelector('.sub-drop input');
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
    const drop = modal.querySelector('.sub-drop');
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
    modal.querySelector('.sub-search').addEventListener('input', renderResults);
    modal.querySelector('form').addEventListener('submit', send);
  }

  function open(type) {
    if (!modal) build();
    modal.classList.add('open');
    document.documentElement.classList.add('locked');
    if (type === 'setup' || type === 'wallpaper') show(type); else step('pick');
    loadTurnstile();
  }
  function close() {
    if (st.busy) return;
    modal.classList.remove('open');
    document.documentElement.classList.remove('locked');
    if (modal.querySelector('[data-step="done"]').hidden === false) reset();
  }
  function reset() {
    st.files.forEach((f) => URL.revokeObjectURL(f.url));
    Object.assign(st, { type: null, files: [], picks: [] });
    modal.querySelector('form').reset();
    renderFiles(); renderPicks();
    if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
    token = '';
  }
  function step(name) {
    modal.querySelectorAll('.sub-step').forEach((s) => (s.hidden = s.dataset.step !== name));
    modal.querySelector('.sub-sheet').scrollTop = 0;
  }
  function show(type) {
    st.type = type;
    const setup = type === 'setup';
    modal.querySelector('[data-title]').textContent = setup ? 'Share your setup' : 'Send a wallpaper you made';
    modal.querySelector('[data-drop-label]').innerHTML = `<b>Drop ${setup ? 'photos or screenshots' : 'your wallpapers'}</b> or tap to choose — up to ${LIMIT[type]}`;
    modal.querySelector('[data-consent]').textContent = setup
      ? "It's my own photo or screenshot, and nothing personal is visible (names, messages, notifications, faces)."
      : 'I made this, or I have permission to share it here.';
    modal.querySelectorAll('[data-for]').forEach((el) => (el.hidden = el.dataset.for !== type));
    const sel = modal.querySelector('select[name=category]');
    const cats = window.WP?.data.categories || [];
    sel.innerHTML = '<option value="">not sure</option>' + cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    if (st.files.length > LIMIT[type]) st.files.splice(LIMIT[type]).forEach((f) => URL.revokeObjectURL(f.url));
    renderFiles(); renderResults();
    step('form');
  }

  // ---------- files ----------
  function addFiles(list) {
    const err = [];
    for (const file of list) {
      if (st.files.length >= LIMIT[st.type]) { err.push(`up to ${LIMIT[st.type]} images`); break; }
      if (!TYPES.includes(file.type)) { err.push(`${file.name}: not a supported image`); continue; }
      if (file.size > MAX) { err.push(`${file.name}: over 50 MB`); continue; }
      const f = { file, url: URL.createObjectURL(file), progress: 0 };
      st.files.push(f);
      const img = new Image();
      img.onload = () => { f.res = `${img.naturalWidth}×${img.naturalHeight}`; renderFiles(); };
      img.src = f.url;
    }
    setError(err.join(' · '));
    renderFiles();
  }
  function renderFiles() {
    if (!modal) return;
    modal.querySelector('.sub-files').innerHTML = st.files.map((f, i) => `
      <li><span class="thumb" style="background-image:url('${f.url}')"></span>
        <span class="mono">${esc(f.file.name)}<br><i>${f.res ? f.res + ' · ' : ''}${mb(f.file.size)}</i></span>
        <span class="bar"><i style="width:${f.progress}%"></i></span>
        <button type="button" data-rm="${i}" aria-label="Remove">✕</button></li>`).join('');
  }

  // ---------- wallpaper picker (setups) ----------
  // Forgiving search: ignores separators and leading zeros ("fractal maze 4" →
  // fractal-maze/04), splits "maze04", matches word starts and parts, tolerates
  // a typo per word, and knows color words. Best matches first.
  const norm = (s) => String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
    .split(/[^a-z0-9]+/).filter(Boolean).map((t) => (/^\d+$/.test(t) ? String(+t) : t));
  function close1(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length === b.length && a[i] === b[j + 1] && a[i + 1] === b[j]) { i += 2; j += 2; continue; } // swapped letters
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }
  function tokenScore(q, hay) {
    let best = 0;
    for (const h of hay) {
      if (h === q) return 4;
      if (h.startsWith(q)) best = Math.max(best, 3);
      else if (q.length >= 3 && h.includes(q)) best = Math.max(best, 2);
      else if (q.length >= 4 && (close1(q, h) || close1(q, h.slice(0, q.length)))) best = Math.max(best, 1);
    }
    return best;
  }
  const hayCache = new Map();
  function searchScore(it, qTokens, qJoined) {
    let hay = hayCache.get(it);
    if (!hay) {
      const tokens = [...norm(it.title), ...norm(it.cat || ''), ...(it.colors || [])];
      hay = { tokens, joined: tokens.join('') };
      hayCache.set(it, hay);
    }
    let total = 0;
    for (const q of qTokens) {
      const sc = tokenScore(q, hay.tokens);
      if (!sc) return hay.joined.includes(qJoined) && qJoined.length >= 3 ? 1 : 0;
      total += sc;
    }
    return total + (hay.joined.startsWith(qJoined) ? 2 : 0);
  }

  function renderResults() {
    if (!modal || st.type !== 'setup') return;
    const qTokens = norm(modal.querySelector('.sub-search').value);
    const qJoined = qTokens.join('');
    const all = window.WP?.data.items || [];
    const hits = (qTokens.length
      ? all.map((it) => [it, searchScore(it, qTokens, qJoined)]).filter(([, sc]) => sc > 0)
        .sort((a, b) => b[1] - a[1] || a[0].title.localeCompare(b[0].title, 'en', { numeric: true })).map(([it]) => it)
      : all).slice(0, 36);
    modal.querySelector('.sub-results').innerHTML = hits.map((it) =>
      `<button type="button" data-pick="${it.hash}" class="${st.picks.includes(it.hash) ? 'on' : ''}" title="${esc(it.title)}">
        <img src="${new URL(`${it.t}-480.webp`, ROOT).href}" alt="" loading="lazy"><span>${esc(it.title)}</span></button>`).join('') ||
      '<p class="mono dim">no matches</p>';
  }
  function togglePick(hash) {
    const i = st.picks.indexOf(hash);
    if (i >= 0) st.picks.splice(i, 1);
    else if (st.picks.length < 3) st.picks.push(hash);
    renderPicks(); renderResults();
  }
  function renderPicks() {
    if (!modal) return;
    const all = window.WP?.data.items || [];
    modal.querySelector('.sub-picked').innerHTML = st.picks.map((h) => {
      const it = all.find((x) => x.hash === h);
      return it ? `<button type="button" class="chipish" data-pick="${h}">${esc(it.title)} ✕</button>` : '';
    }).join('');
  }

  // ---------- spam check ----------
  function loadTurnstile() {
    if (cfg.sitekey === 'dev') { token = 'dev'; return; } // local testing
    const mount = () => {
      if (widgetId !== null) return;
      widgetId = window.turnstile.render(modal.querySelector('.sub-turnstile'), {
        sitekey: cfg.sitekey, theme: 'dark', appearance: 'interaction-only',
        callback: (t) => { token = t; }, 'expired-callback': () => { token = ''; }, 'error-callback': () => { token = ''; },
      });
    };
    if (window.turnstile) return mount();
    if (document.querySelector('script[data-turnstile]')) return;
    window.onTurnstileLoad = mount;
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad';
    s.async = true; s.dataset.turnstile = '1';
    document.head.append(s);
  }
  const waitToken = async () => { for (let i = 0; i < 60 && !token; i++) await new Promise((r) => setTimeout(r, 250)); return token; };

  // ---------- send ----------
  function setError(msg) { if (modal) modal.querySelector('.sub-err').textContent = msg || ''; }

  async function send(e) {
    e.preventDefault();
    if (st.busy) return;
    const form = e.target, v = (n) => form.elements[n].value.trim();
    if (!st.files.length) return setError(st.type === 'setup' ? 'Add a photo of your setup.' : 'Add at least one wallpaper.');
    if (!v('name')) return setError('Add a name or handle so you can be credited.');
    if (!form.elements.consent.checked) return setError('Please confirm the checkbox.');
    setError('');
    const btn = form.querySelector('.sub-send');
    st.busy = true; btn.disabled = true; btn.textContent = 'checking…';
    try {
      if (!(await waitToken())) throw new Error('The spam check did not finish — please try again.');
      const res = await fetch(api('start'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: st.type, token, consent: true,
          name: v('name'), email: v('email'), message: v('message'),
          caption: st.type === 'setup' ? v('caption') : '', category: st.type === 'wallpaper' ? v('category') : '',
          wallpapers: st.type === 'setup' ? st.picks : [],
          files: st.files.map((f) => ({ name: f.file.name, size: f.file.size, type: f.file.type })),
        }),
      });
      const start = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(start.error || 'Something went wrong');
      btn.textContent = 'uploading…';
      for (let n = 0; n < st.files.length; n++) await put(start, n);
      const fin = await fetch(api('finish'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: start.id, ticket: start.ticket }) });
      if (!fin.ok) throw new Error((await fin.json().catch(() => ({}))).error || 'Upload did not finish');
      st.busy = false;
      step('done');
    } catch (err) {
      setError(err.message);
      if (widgetId !== null && window.turnstile) { window.turnstile.reset(widgetId); token = ''; }
    } finally {
      st.busy = false; btn.disabled = false; btn.textContent = 'send';
    }
  }

  function put(start, n) {
    const f = st.files[n];
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', api(`file?id=${start.id}&n=${n}&ticket=${encodeURIComponent(start.ticket)}`));
      x.setRequestHeader('Content-Type', f.file.type);
      x.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        f.progress = Math.round((e.loaded / e.total) * 100);
        const bar = modal.querySelectorAll('.sub-files .bar i')[n];
        if (bar) bar.style.width = f.progress + '%';
      };
      x.onload = () => (x.status < 300 ? resolve() : reject(new Error((() => { try { return JSON.parse(x.responseText).error; } catch { return ''; } })() || `Upload failed (${x.status})`)));
      x.onerror = () => reject(new Error('Network error while uploading'));
      x.send(f.file);
    });
  }
})();
