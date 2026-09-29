// egor's wallpapers — client. No framework; the build writes the manifest.
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const body = document.body;
  const ROOT = new URL(body.dataset.root || './', location.href);
  const url = (p) => new URL(p, ROOT).href;
  const pageUrl = (id) => url(id ? `w/${encodeURIComponent(id)}/` : '');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

  const grid = $('#grid'), bar = $('#bar'), chipsEl = $('#chips'), pill = $('#pill');
  const lb = $('#lb'), stage = $('#stage');

  let data, items = [], byId = new Map();
  let view = [];          // currently filtered + sorted items
  const SORTS = ['random', 'newest', 'oldest', 'popular'];
  let cat = null, sort = 'random', color = null, favOnly = false;
  let counts = null;      // downloads per wallpaper hash, once /api/stats answers
  let shuffled = [];      // random order, fixed until the visitor picks random again
  let tiles = new Map();  // id -> { el, card, img, col, x, y, w, h }
  let cols = 0, colW = 0;

  // ---------- utils ----------
  const mb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');
  const pad = (n) => String(n).padStart(3, '0');
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  };
  // Favorites live in this browser only, keyed by file hash so renames keep them.
  const favs = new Set((() => { try { return JSON.parse(localStorage.getItem('wp-favs') || '[]'); } catch { return []; } })());
  const saveFavs = () => { try { localStorage.setItem('wp-favs', JSON.stringify([...favs])); } catch {} };
  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>';
  const SWATCH = { red: '#e5484d', orange: '#f76b15', yellow: '#ffc53d', green: '#46a758', teal: '#12a594', blue: '#3e63dd', purple: '#8e4ec6', pink: '#d6409f', light: '#e8e6e1', gray: '#8b8d98', dark: '#1a1a1d' };
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); body.append(t); }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('on'), 1600);
  }
  const srcset = (it, ext) => data.widths.map((w) => `${url(`${it.t}-${w}.${ext}`)} ${Math.min(w, it.w)}w`).join(', ');

  // ---------- boot ----------
  fetch(url('__MANIFEST__'))
    .then((r) => r.json())
    .then(init)
    .catch((e) => { console.error(e); $('#empty').hidden = false; });

  function init(m) {
    data = m;
    items = m.items;
    items.forEach((it, i) => { it.i = i; byId.set(it.id, it); });

    const q = new URLSearchParams(location.search);
    if (q.get('c') && m.categories.some((c) => c.id === q.get('c'))) cat = q.get('c');
    if (SORTS.includes(q.get('sort'))) sort = q.get('sort');
    if (q.get('color') && m.colors?.some((c) => c.id === q.get('color'))) color = q.get('color');
    for (const h of [...favs]) if (!items.some((it) => it.hash === h)) favs.delete(h);
    reshuffle();
    loadStats();

    buildChips();
    buildSwatches();
    updateFavButton();
    buildTiles();
    buildFooter();
    applyView(false);

    $('#empty').hidden = items.length > 0;
    $('#shuffle').addEventListener('click', shuffle);
    $('#favs').addEventListener('click', () => { favOnly = !favOnly; toGridTop(); applyView(true); });
    $('#clearFilters').addEventListener('click', () => { cat = null; color = null; favOnly = false; applyView(true); syncQuery(); });
    $('#sort').addEventListener('click', () => {
      do sort = SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length]; while (sort === 'popular' && !counts);
      if (sort === 'random') reshuffle();
      toGridTop(); applyView(true); syncQuery();
    });

    let rt;
    addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { layout(false); movePill(false); refit(); }, 120); });
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('popstate', onRoute);
    addEventListener('keydown', onKey);
    onScroll();

    const initial = body.dataset.initial;
    if (initial && byId.has(initial)) {
      revealAll(true);
      openLightbox(byId.get(initial), { fromTile: false, push: false });
    } else if (!reduced && items.length && !store.get('intro')) {
      store.set('intro', '1');
      intro();
    } else {
      revealObserve();
    }
  }

  // A new filter/sort starts at the top; otherwise a short result list can
  // leave you scrolled past the end, looking at an empty page.
  function toGridTop() {
    // Far down: jump (a smooth scroll gets cut off when the page shrinks). Close: glide.
    if (scrollY > 0) scrollTo({ top: 0, behavior: reduced || scrollY > innerHeight ? 'instant' : 'smooth' });
  }

  function loadStats() {
    fetch(url('api/stats')).then((r) => (r.ok ? r.json() : null)).then((c) => {
      if (!c) return;
      counts = c;
      if (sort === 'popular') applyView(false);
      if (cur) setInfo(cur, false);
    }).catch(() => {});
  }
  function countLabel(it) {
    const n = counts?.[it.hash] || 0;
    return n ? `${n} download${n === 1 ? '' : 's'}` : '';
  }

  function buildSwatches() {
    const row = $('#swatches');
    if (!data.colors?.length) { row.hidden = true; return; }
    for (const c of data.colors) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'swatch'; b.dataset.color = c.id;
      b.style.setProperty('--sw', SWATCH[c.id] || '#888');
      b.title = `${c.id} · ${c.count}`;
      b.setAttribute('aria-label', `${c.id} wallpapers (${c.count})`);
      b.addEventListener('click', () => { color = color === c.id ? null : c.id; toGridTop(); applyView(true); syncQuery(); });
      row.append(b);
    }
  }

  function updateFavButton() {
    const b = $('#favs');
    b.hidden = favs.size === 0 && !favOnly;
    b.querySelector('span').textContent = favs.size;
    b.setAttribute('aria-pressed', String(favOnly));
  }
  function toggleFav(it) {
    const on = !favs.has(it.hash);
    on ? favs.add(it.hash) : favs.delete(it.hash);
    saveFavs();
    const t = tiles.get(it.id);
    t?.el.classList.toggle('faved', on);
    if (on) for (const el of [t?.el.querySelector('.heart'), cur === it ? $('#fav') : null]) {
      if (el) { el.classList.remove('pop'); el.offsetWidth; el.classList.add('pop'); }
    }
    if (cur === it) setFavState(it);
    if (favOnly && !favs.size) favOnly = false;
    updateFavButton();
    if (favOnly) applyView(true);
  }
  function setFavState(it) {
    const b = $('#fav');
    b.setAttribute('aria-pressed', String(favs.has(it.hash)));
    b.setAttribute('aria-label', favs.has(it.hash) ? 'Remove from favorites (F)' : 'Add to favorites (F)');
  }

  function reshuffle() {
    shuffled = items.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
  }

  // ---------- chips / sort / footer ----------
  function buildChips() {
    const mk = (id, name, count) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.dataset.cat = id ?? '';
      b.innerHTML = `${name}<sup>${count}</sup>`;
      b.addEventListener('click', () => {
        if (cat === id) return;
        cat = id; toGridTop(); applyView(true); syncQuery();
        b.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
      });
      chipsEl.append(b);
    };
    if (data.categories.length > 1 || items.some((i) => !i.cat)) {
      mk(null, 'all', items.length);
      data.categories.forEach((c) => mk(c.id, c.name, c.count));
    } else {
      chipsEl.style.visibility = 'hidden';
    }
  }
  function movePill(animate = true) {
    const active = chipsEl.querySelector('.chip[aria-pressed="true"]');
    if (!active) return;
    if (!animate) pill.style.transition = 'none';
    pill.style.width = active.offsetWidth + 'px';
    pill.style.transform = `translateX(${active.offsetLeft}px)`;
    if (!animate) { pill.offsetWidth; pill.style.transition = ''; }
  }
  function syncQuery() {
    const q = new URLSearchParams();
    if (cat) q.set('c', cat);
    if (color) q.set('color', color);
    if (sort !== 'random') q.set('sort', sort);
    const s = q.toString();
    history.replaceState(history.state, '', location.pathname + (s ? '?' + s : ''));
  }
  function buildFooter() {
    const d = new Date(data.generated);
    const fmt = d.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
    $('#foot').innerHTML = `<span>${pad(items.length)} wallpapers · updated ${fmt}</span><span>free to download · <a href="https://egorz.com">egorz.com</a></span>`;
  }

  // ---------- tiles ----------
  function buildTiles() {
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const a = document.createElement('a');
      a.className = 'tile';
      a.href = pageUrl(it.id);
      a.dataset.id = it.id;
      a.setAttribute('aria-label', `${it.title}, ${it.w} by ${it.h}`);
      a.innerHTML =
        `<div class="par"><div class="card"><div class="tilt" style="--c:${it.color}">` +
        `<div class="lq" style="background-image:url(${it.lqip});background-color:${it.color}"></div>` +
        `<picture><source type="image/avif" srcset="${srcset(it, 'avif')}"><img alt="" loading="lazy" decoding="async" width="${it.w}" height="${it.h}" srcset="${srcset(it, 'webp')}"></picture>` +
        `<div class="lit"></div>` +
        `<div class="meta"><b>${escapeHtml(it.title)}</b><span class="mono">${it.w}×${it.h}</span></div>` +
        (it.new ? `<span class="new">new</span>` : '') +
        `<span class="heart" role="button" aria-label="Favorite">${HEART}</span>` +
        `</div></div></div>`;
      if (favs.has(it.hash)) a.classList.add('faved');
      const img = a.querySelector('img');
      const done = () => img.classList.add('ok');
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      a.addEventListener('click', (e) => {
        if (e.target.closest('.heart')) { e.preventDefault(); e.stopPropagation(); toggleFav(it); return; }
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        openLightbox(it, { fromTile: true, push: true });
      });
      if (finePointer && !reduced) bindTilt(a);
      tiles.set(it.id, { el: a, card: a.querySelector('.card'), tilt: a.querySelector('.tilt'), img, src: a.querySelector('source') });
      frag.append(a);
    }
    grid.append(frag);
  }
  function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  function bindTilt(a) {
    const t = a.querySelector('.tilt');
    let r = null, frame = 0;
    a.addEventListener('pointerenter', () => { r = t.getBoundingClientRect(); });
    a.addEventListener('pointermove', (e) => {
      if (!r) r = t.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        t.style.setProperty('--ry', ((x - 0.5) * 9).toFixed(2) + 'deg');
        t.style.setProperty('--rx', ((0.5 - y) * 7).toFixed(2) + 'deg');
        t.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
        t.style.setProperty('--my', (y * 100).toFixed(1) + '%');
      });
    });
    a.addEventListener('pointerleave', () => {
      cancelAnimationFrame(frame); r = null;
      t.style.setProperty('--rx', '0deg'); t.style.setProperty('--ry', '0deg');
    });
  }

  // ---------- view: filter + sort + masonry ----------
  function applyView(animate) {
    view = items.filter((it) => (!cat || it.cat === cat) && (!color || it.colors?.includes(color)) && (!favOnly || favs.has(it.hash)));
    const rank = new Map(shuffled.map((it, i) => [it, i]));
    if (sort === 'oldest') view.reverse();
    else if (sort === 'random') view.sort((a, b) => rank.get(a) - rank.get(b));
    else if (sort === 'popular') view.sort((a, b) => (counts?.[b.hash] || 0) - (counts?.[a.hash] || 0) || rank.get(a) - rank.get(b));
    const visible = new Set(view.map((v) => v.id));

    chipsEl.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String((c.dataset.cat || null) === cat)));
    $('#sort').textContent = sort;
    $('#sort').dataset.mode = sort;
    $('#sort').setAttribute('aria-label', `Sort: ${sort}. Change sort order`);
    $('#count').textContent = `${pad(view.length)} ${view.length === 1 ? 'wallpaper' : 'wallpapers'}`;
    $('#swatches').querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === color)));
    $('#swatches').classList.toggle('picking', !!color);
    updateFavButton();
    $('#none').hidden = view.length > 0 || items.length === 0;
    movePill(animate);

    if (!animate || reduced) {
      for (const [id, t] of tiles) t.el.classList.toggle('gone', !visible.has(id));
      layout(false);
      return;
    }

    // Leaving tiles fold away; staying tiles glide to their new slots; entering tiles rise in.
    const entering = [];
    for (const [id, t] of tiles) {
      const on = visible.has(id), was = !t.el.classList.contains('gone');
      if (was && !on) {
        t.card.classList.add('out');
        setTimeout(() => { if (!view.includes(byId.get(id))) t.el.classList.add('gone'); t.card.classList.remove('out'); }, 420);
      } else if (!was && on) {
        entering.push(t);
      }
    }
    grid.classList.add('animating');
    // Entering tiles jump straight to their slot, then reveal.
    for (const t of entering) { t.el.style.transition = 'none'; t.card.classList.remove('in'); t.el.classList.remove('gone'); }
    layout(true);
    grid.offsetWidth;
    for (const t of entering) t.el.style.transition = '';
    clearTimeout(applyView.t);
    applyView.t = setTimeout(() => grid.classList.remove('animating'), 950);
    requestAnimationFrame(() => {
      entering.forEach((t, i) => { t.card.style.setProperty('--d', `${120 + Math.min(i, 14) * 45}ms`); t.card.classList.add('in'); });
    });
  }

  function layout() {
    const W = grid.clientWidth;
    cols = W < 560 ? 2 : W < 1000 ? 3 : W < 1600 ? 4 : 5;
    const gap = W < 560 ? 8 : W < 1000 ? 12 : 16;
    colW = (W - gap * (cols - 1)) / cols;
    const heights = new Array(cols).fill(0);
    const sizes = `${Math.ceil(colW)}px`;
    for (const it of view) {
      const t = tiles.get(it.id);
      let c = 0;
      for (let k = 1; k < cols; k++) if (heights[k] < heights[c] - 1) c = k;
      const h = Math.round(colW * (it.h / it.w));
      const x = c * (colW + gap), y = heights[c];
      heights[c] += h + gap;
      Object.assign(t, { col: c, x, y, w: colW, h });
      t.el.style.width = colW + 'px';
      t.el.style.height = h + 'px';
      t.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      t.el.style.setProperty('--py', `var(--p${c}, 0px)`);
      if (t.img.sizes !== sizes) { t.img.sizes = sizes; t.src.sizes = sizes; }
    }
    grid.style.height = (view.length ? Math.max(...heights) - gap : 0) + 'px';
    parallax();
  }

  // ---------- scroll: header + column parallax ----------
  let lastY = 0, ticking = false;
  const AMP = [0, 70, 25, 95, 45];
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y = scrollY;
      bar.classList.toggle('scrolled', y > 8);
      if (!lb.hidden) return;
      const down = y > lastY + 4, up = y < lastY - 4;
      if (down && y > 260) bar.classList.add('hide');
      else if (up || y < 260) bar.classList.remove('hide');
      if (down || up) lastY = y;
      parallax();
    });
  }
  function parallax() {
    if (reduced) return;
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const p = Math.min(1, Math.max(0, scrollY / max));
    const scale = cols <= 2 ? 0.5 : 1;
    for (let c = 0; c < 5; c++) grid.style.setProperty(`--p${c}`, `${(-p * AMP[c] * scale).toFixed(1)}px`);
  }

  // ---------- scroll reveal ----------
  let io;
  function revealObserve() {
    if (reduced || !('IntersectionObserver' in window)) return revealAll(true);
    let queue = [];
    io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { queue.push(e.target); io.unobserve(e.target); }
      if (!queue.length) return;
      queue.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      queue.forEach((el, i) => {
        const card = tiles.get(el.dataset.id).card;
        card.style.setProperty('--d', `${Math.min(i, 12) * 70}ms`);
        card.classList.add('in');
      });
      queue = [];
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.01 });
    for (const [, t] of tiles) io.observe(t.el);
  }
  function revealAll(instant) {
    for (const [, t] of tiles) {
      if (instant) t.card.style.transition = 'none';
      t.card.classList.add('in');
    }
    if (instant) requestAnimationFrame(() => { for (const [, t] of tiles) t.card.style.transition = ''; });
  }

  // ---------- intro ----------
  async function intro() {
    const hero = view[0] || items[0];
    const el = document.createElement('div');
    el.className = 'intro';
    el.innerHTML =
      `<div class="intro-img" style="background-image:url(${url(`${hero.t}-1440.webp`)}),url(${hero.lqip});background-color:${hero.color}"></div>` +
      `<div class="intro-word"><h1 class="intro-title"><span class="w"><span>egor's</span></span> <span class="w"><span>wallpapers</span></span></h1>` +
      `<div class="intro-meta mono"><span class="n">000</span><span>wallpapers</span><span>·</span><span>${data.categories.length || 1} ${data.categories.length === 1 ? 'category' : 'categories'}</span></div></div>` +
      `<div class="intro-line"></div>`;
    body.append(el);
    document.documentElement.classList.add('locked');

    let skipped = false;
    const anims = [];
    const run = (target, kf, opts) => { const a = target.animate(kf, { fill: 'forwards', easing: EASE, ...opts }); anims.push(a); return a; };
    const skip = () => { skipped = true; anims.forEach((a) => a.finish()); };
    el.addEventListener('click', skip);
    addEventListener('keydown', skip, { once: true });
    addEventListener('wheel', skip, { once: true, passive: true });

    const heroLoad = new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = url(`${hero.t}-1440.webp`); });

    const words = el.querySelectorAll('.intro-word .w > span');
    words.forEach((w, i) => run(w, [{ transform: 'translateY(110%)' }, { transform: 'translateY(0)' }], { duration: 1100, delay: 150 + i * 120 }));
    run(el.querySelector('.intro-meta'), [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 800, delay: 650 });
    const line = run(el.querySelector('.intro-line'), [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 1500, delay: 300, easing: 'cubic-bezier(0.65,0,0.35,1)' });

    // counter 000 → N
    const n = el.querySelector('.n'), start = performance.now() + 500;
    const tick = (now) => {
      const p = Math.min(1, Math.max(0, (now - start) / 1100));
      n.textContent = pad(Math.round(items.length * (1 - Math.pow(1 - p, 3))));
      if (p < 1 && !skipped) requestAnimationFrame(tick); else n.textContent = pad(items.length);
    };
    requestAnimationFrame(tick);

    await Promise.race([Promise.all([line.finished, heroLoad]), wait(2600)]);
    if (!skipped) {
      const img = el.querySelector('.intro-img');
      run(img, [{ clipPath: 'inset(50% 50% 50% 50%)', transform: 'scale(1.25)' }, { clipPath: 'inset(0% 0% 0% 0%)', transform: 'scale(1)' }], { duration: 1300 });
      run(el.querySelector('.intro-line'), [{ opacity: 0.5 }, { opacity: 0 }], { duration: 400 });
      await wait(skipped ? 0 : 1050);
    }
    // Curtain lifts; grid rises underneath.
    const lift = el.animate([{ clipPath: 'inset(0 0 0% 0)' }, { clipPath: 'inset(0 0 100% 0)' }], { duration: skipped ? 500 : 1100, easing: 'cubic-bezier(0.76,0,0.24,1)', fill: 'forwards' });
    el.querySelector('.intro-word').animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(-12vh)', opacity: 0 }], { duration: 900, easing: 'cubic-bezier(0.76,0,0.24,1)', fill: 'forwards' });
    document.documentElement.classList.remove('locked');
    setTimeout(() => revealObserve(), skipped ? 150 : 380);
    await lift.finished;
    el.remove();
    removeEventListener('keydown', skip);
  }

  // ---------- lightbox ----------
  let cur = null, fig = null, busy = false, ambIdx = 0, idleT = 0;
  const lbIdx = $('#lbIdx'), lbTitle = $('#lbTitle'), lbSpec = $('#lbSpec'), dl = $('#dl'), dlSize = $('#dlSize');
  [$('#close'), $('#prev'), $('#next'), $('#info')].forEach((e) => e.classList.add('lb-chrome'));

  function fitRect(it) {
    const small = innerWidth < 641;
    const top = small ? 64 : 72, bottom = small ? 150 : 110, side = small ? 12 : 88;
    const aw = innerWidth - side * 2, ah = innerHeight - top - bottom;
    const s = Math.min(aw / it.w, ah / it.h);
    const w = Math.round(it.w * s), h = Math.round(it.h * s);
    return { x: Math.round((innerWidth - w) / 2), y: Math.round(top + (ah - h) / 2), w, h };
  }

  function refit() {
    if (!fig || !cur) return;
    resetZoom(false);
    const r = fitRect(cur);
    Object.assign(fig.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    fig._rect = r;
  }

  function makeFig(it) {
    const r = fitRect(it);
    const f = document.createElement('figure');
    f.className = 'fig';
    Object.assign(f.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', background: it.color });
    const t = tiles.get(it.id);
    const lo = t?.img.currentSrc || url(`${it.t}-960.webp`);
    f.innerHTML = `<div class="zm"><img class="lo" src="${it.lqip}" alt=""><img class="lo2" src="${lo}" alt=""><img class="hi" alt="${escapeHtml(it.title)}" decoding="async"></div><span class="spin"></span>`;
    const hi = f.querySelector('.hi');
    hi.onload = () => { hi.classList.add('ok'); f.classList.add('sharp'); };
    hi.src = url(it.p);
    f.style.transformOrigin = '50% 50%';
    f._rect = r;
    return f;
  }

  function setAmbient(it) {
    const ambs = lb.querySelectorAll('.amb');
    const next = ambs[ambIdx ^ 1], prev = ambs[ambIdx];
    it.pal.forEach((c, i) => next.style.setProperty(`--a${i}`, c));
    next.classList.add('on'); prev.classList.remove('on');
    ambIdx ^= 1;
  }

  function setInfo(it, animate) {
    const idx = view.indexOf(it);
    const n = view.length;
    lbIdx.textContent = idx >= 0 ? `${pad(idx + 1)} / ${pad(n)}` : '';
    lbTitle.innerHTML = it.cat ? `<span class="lb-cat">${escapeHtml(it.cat)}/</span>${escapeHtml(it.name)}` : escapeHtml(it.title);
    const dls = countLabel(it);
    lbSpec.innerHTML = `${it.w} × ${it.h}<i>/</i>${it.ratio}<i>/</i>${mb(it.size)}<i>/</i>${it.file.split('.').pop().toUpperCase()}${dls ? `<i>/</i>${dls}` : ''}`;
    setFavState(it);
    dl.href = url(it.o);
    dl.setAttribute('download', it.file);
    dlSize.textContent = mb(it.size);
    if (animate) for (const e of [lbIdx, lbTitle, lbSpec]) { e.classList.remove('swap'); e.offsetWidth; e.classList.add('swap'); }
    document.title = `${it.title} — egor's wallpapers`;
    $('#copy span').textContent = 'copy link';
  }

  function holdTile(it, on) {
    const t = tiles.get(it.id);
    if (t) t.el.classList.toggle('held', on);
  }

  function tileRect(it) {
    const t = tiles.get(it.id);
    if (!t || t.el.classList.contains('gone')) return null;
    const r = t.tilt.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.width === 0) return null;
    return r;
  }

  async function openLightbox(it, { fromTile, push }) {
    if (busy) return;
    busy = true;
    cur = it;
    if (push) history.pushState({ id: it.id }, '', pageUrl(it.id) + location.search);
    const sbw = innerWidth - document.documentElement.clientWidth;
    document.documentElement.classList.add('locked');
    body.style.paddingRight = sbw ? sbw + 'px' : '';
    lb.hidden = false;
    lb.classList.remove('ready', 'leaving', 'idle');
    setInfo(it, false);
    setAmbient(it);

    stage.textContent = '';
    z = { s: 1, x: 0, y: 0 };
    lb.classList.remove('zoomed');
    fig = makeFig(it);
    stage.append(fig);
    const from = fromTile ? tileRect(it) : null;
    const r = fig._rect;
    const dur = reduced ? 1 : 750;

    lb.querySelector('.lb-amb').animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduced ? 1 : 600, easing: 'ease-out', fill: 'forwards' });
    if (from) {
      holdTile(it, true);
      fig.style.transformOrigin = '0 0';
      const s = from.width / r.w;
      fig.animate([
        { transform: `translate(${from.left - r.x}px, ${from.top - r.y}px) scale(${s})`, borderRadius: `${4 / s}px` },
        { transform: 'none', borderRadius: '2px' },
      ], { duration: dur, easing: EASE });
    } else {
      fig.animate([{ opacity: 0, transform: 'translateY(24px) scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: reduced ? 1 : 900, easing: EASE });
    }
    requestAnimationFrame(() => lb.classList.add('ready'));
    preloadNeighbors(it);
    $('#close').focus({ preventScroll: true });
    await wait(dur * 0.6);
    busy = false;
  }

  async function closeLightbox({ push } = { push: true }) {
    if (!cur || busy) return;
    busy = true;
    const it = cur;
    resetZoom(false);
    if (push) history.pushState({}, '', pageUrl('') + location.search);
    document.title = "egor's wallpapers";
    lb.classList.add('leaving');
    lb.classList.remove('ready');

    // If the tile is off-screen (after navigating), bring it into view behind the veil.
    const t = tiles.get(it.id);
    if (t && !t.el.classList.contains('gone') && !tileRect(it)) {
      const top = t.el.getBoundingClientRect().top + scrollY;
      scrollTo({ top: Math.max(0, top - innerHeight / 2 + t.h / 2), behavior: 'instant' });
      t.card.classList.add('in');
      parallax();
    }
    const to = tileRect(it);
    const r = fig._rect;
    const dur = reduced ? 1 : 650;
    lb.querySelector('.lb-amb').animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur, easing: 'ease-in-out', fill: 'forwards' });
    let a;
    if (to) {
      const s = to.width / r.w;
      fig.style.transformOrigin = '0 0';
      a = fig.animate([{ transform: 'none' }, { transform: `translate(${to.left - r.x}px, ${to.top - r.y}px) scale(${s})`, borderRadius: `${4 / s}px` }], { duration: dur, easing: EASE, fill: 'forwards' });
    } else {
      a = fig.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.95)' }], { duration: dur * 0.6, easing: 'ease-in', fill: 'forwards' });
    }
    await a.finished;
    holdTile(it, false);
    lb.hidden = true;
    stage.textContent = '';
    document.documentElement.classList.remove('locked');
    body.style.paddingRight = '';
    lb.querySelectorAll('.amb').forEach((e) => e.classList.remove('on'));
    t?.el.focus({ preventScroll: true });
    cur = null; fig = null; busy = false;
  }

  async function go(dir, target) {
    if (!cur || busy) return;
    const list = view.includes(cur) ? view : items;
    const idx = list.indexOf(cur);
    const next = target || list[(idx + dir + list.length) % list.length];
    if (!next || next === cur) return;
    busy = true;
    resetZoom(false);
    const old = fig, prev = cur;
    cur = next;
    history.replaceState({ id: next.id }, '', pageUrl(next.id) + location.search);
    holdTile(prev, false);
    holdTile(next, true);
    setInfo(next, true);
    setAmbient(next);
    fig = makeFig(next);
    stage.append(fig);
    const dx = dir * Math.min(140, innerWidth * 0.08);
    const dur = reduced ? 1 : 700;
    old.animate([{ opacity: 1, transform: old.style.transform || 'none' }, { opacity: 0, transform: `translateX(${-dx}px) scale(0.97)` }], { duration: dur * 0.7, easing: EASE, fill: 'forwards' })
      .finished.then(() => old.remove());
    fig.animate([{ opacity: 0, transform: `translateX(${dx}px) scale(1.02)` }, { opacity: 1, transform: 'none' }], { duration: dur, easing: EASE });
    preloadNeighbors(next);
    await wait(dur * 0.45);
    busy = false;
  }

  function preloadNeighbors(it) {
    const list = view.includes(it) ? view : items;
    const i = list.indexOf(it);
    for (const d of [1, -1]) {
      const n = list[(i + d + list.length) % list.length];
      if (n && n !== it) { const im = new Image(); im.decoding = 'async'; im.src = url(n.p); }
    }
  }

  function shuffle() {
    const pool = view.length ? view : items;
    if (!pool.length) return;
    let pick;
    do { pick = pool[Math.floor(Math.random() * pool.length)]; } while (pool.length > 1 && pick === cur);
    if (cur) return go(1, pick);
    openLightbox(pick, { fromTile: true, push: true });
  }

  // lightbox controls
  $('#close').addEventListener('click', () => closeLightbox());
  $('#fav').addEventListener('click', () => cur && toggleFav(cur));
  dl.addEventListener('click', () => {
    if (!cur) return;
    try { navigator.sendBeacon(url('api/dl'), cur.hash); } catch {}
    if (counts) { counts[cur.hash] = (counts[cur.hash] || 0) + 1; }
  });
  $('#prev').addEventListener('click', () => go(-1));
  $('#next').addEventListener('click', () => go(1));
  stage.addEventListener('click', (e) => { if (e.target === stage) closeLightbox(); });
  $('#copy').addEventListener('click', async () => {
    const link = pageUrl(cur.id);
    try { await navigator.clipboard.writeText(link); }
    catch {
      const ta = document.createElement('textarea'); ta.value = link; body.append(ta); ta.select();
      try { document.execCommand('copy'); } catch {} ta.remove();
    }
    $('#copy span').textContent = 'copied';
    toast('Link copied');
  });

  // Chrome fades away while idle on desktop so the wallpaper is alone.
  lb.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    lb.classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(() => { if (!lb.hidden && !lb.querySelector('.lb-chrome:hover')) lb.classList.add('idle'); }, 2600);
  });

  // ---------- zoom ----------
  // Desktop: click to zoom, the mouse pans, the wheel adjusts. Touch: pinch,
  // drag to pan, double-tap to toggle. Zooming loads the full original.
  const ZOOMABLE = /\.(jpe?g|png|webp|avif)$/i;
  let z = { s: 1, x: 0, y: 0 }, lastPointer = 'mouse';
  const zmEl = () => fig?.querySelector('.zm');
  const maxZoom = () => Math.min(6, Math.max(2, cur.w / fig._rect.w));

  function applyZoom(mode = 'smooth') {
    const el = zmEl();
    if (!el) return;
    el.style.transition = mode === 'none' || reduced ? 'none' : mode === 'follow' ? 'transform 0.3s cubic-bezier(0.16,1,0.3,1)' : 'transform 0.5s cubic-bezier(0.16,1,0.3,1)';
    el.style.transform = z.s === 1 ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
    lb.classList.toggle('zoomed', z.s > 1);
  }
  function clampPan() {
    const r = fig._rect, W = r.w * z.s, H = r.h * z.s;
    const cl = (v, vp, off, size) => (size <= vp ? (vp - size) / 2 - off : Math.min(-off, Math.max(vp - off - size, v)));
    z.x = cl(z.x, innerWidth, r.x, W);
    z.y = cl(z.y, innerHeight, r.y, H);
  }
  // Scale to s, keeping the viewport point (cx, cy) under the finger/cursor.
  function zoomAt(s, cx, cy) {
    const r = fig._rect, px = cx - r.x, py = cy - r.y, k = s / z.s;
    z = { s, x: px - (px - z.x) * k, y: py - (py - z.y) * k };
    if (s <= 1.01) z = { s: 1, x: 0, y: 0 }; else { clampPan(); loadFull(); }
  }
  // Mouse: the image slides so the cursor's edge of the screen shows that edge of the image.
  function followPan(cx, cy) {
    const r = fig._rect, W = r.w * z.s, H = r.h * z.s;
    if (W > innerWidth) z.x = -r.x - (cx / innerWidth) * (W - innerWidth);
    if (H > innerHeight) z.y = -r.y - (cy / innerHeight) * (H - innerHeight);
    clampPan();
  }
  function resetZoom(animate = true) {
    if (z.s === 1) return;
    z = { s: 1, x: 0, y: 0 };
    applyZoom(animate ? 'smooth' : 'none');
  }
  function loadFull() {
    const f = fig, it = cur;
    if (!f || f._full || !ZOOMABLE.test(it.o)) return;
    f._full = true;
    f.classList.add('loading');
    const im = new Image();
    im.className = 'full'; im.alt = ''; im.decoding = 'async';
    im.onload = () => { f.querySelector('.zm')?.append(im); requestAnimationFrame(() => im.classList.add('ok')); f.classList.remove('loading'); };
    im.onerror = () => f.classList.remove('loading');
    im.src = url(it.o);
  }

  stage.addEventListener('click', (e) => {
    if (!fig || lastPointer !== 'mouse' || !e.target.closest('.fig') || busy) return;
    if (z.s > 1) resetZoom();
    else { zoomAt(maxZoom(), e.clientX, e.clientY); followPan(e.clientX, e.clientY); applyZoom(); }
  });
  lb.addEventListener('mousemove', (e) => {
    if (z.s > 1 && fig && lastPointer === 'mouse') { followPan(e.clientX, e.clientY); applyZoom('follow'); }
  });
  lb.addEventListener('wheel', (e) => {
    if (!fig || busy) return;
    e.preventDefault();
    const s = Math.min(maxZoom() * 1.5, Math.max(1, z.s * Math.exp(-e.deltaY * 0.0015)));
    zoomAt(s, e.clientX, e.clientY);
    if (z.s > 1) followPan(e.clientX, e.clientY);
    applyZoom('follow');
  }, { passive: false });

  // Touch: swipe (not zoomed) navigates / closes; pinch and pan when zoomed.
  const pts = new Map();
  let sw = null, pinch = null, pan = null, lastTap = 0;
  const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };

  stage.addEventListener('pointerdown', (e) => {
    lastPointer = e.pointerType;
    if (e.pointerType === 'mouse' || !fig || busy) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      if (sw) { fig.style.transform = ''; lb.querySelector('.lb-amb').style.opacity = ''; sw = null; }
      pan = null;
      const m = mid();
      pinch = { d: m.d, s: z.s, cx: (m.x - fig._rect.x - z.x) / z.s, cy: (m.y - fig._rect.y - z.y) / z.s };
      loadFull();
      return;
    }
    if (pts.size !== 1) return;
    const now = Date.now();
    if (now - lastTap < 300) {
      lastTap = 0; sw = null;
      if (z.s > 1) resetZoom(); else { zoomAt(Math.min(maxZoom(), 3), e.clientX, e.clientY); applyZoom(); }
      return;
    }
    lastTap = now;
    if (z.s > 1) pan = { x: e.clientX, y: e.clientY, zx: z.x, zy: z.y };
    else sw = { x: e.clientX, y: e.clientY, dx: 0, dy: 0, axis: null, id: e.pointerId };
  });
  addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !fig) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const m = mid(), r = fig._rect;
      const s = Math.min(maxZoom() * 1.5, Math.max(0.8, pinch.s * (m.d / pinch.d)));
      z = { s, x: m.x - r.x - pinch.cx * s, y: m.y - r.y - pinch.cy * s };
      applyZoom('none');
      return;
    }
    if (pan) {
      z.x = pan.zx + (e.clientX - pan.x); z.y = pan.zy + (e.clientY - pan.y);
      applyZoom('none');
      return;
    }
    if (!sw || e.pointerId !== sw.id) return;
    sw.dx = e.clientX - sw.x; sw.dy = e.clientY - sw.y;
    if (!sw.axis && Math.hypot(sw.dx, sw.dy) > 8) sw.axis = Math.abs(sw.dx) > Math.abs(sw.dy) ? 'x' : 'y';
    if (sw.axis === 'x') fig.style.transform = `translateX(${sw.dx}px)`;
    if (sw.axis === 'y' && sw.dy > 0) {
      const k = Math.min(1, sw.dy / 400);
      fig.style.transform = `translateY(${sw.dy}px) scale(${1 - k * 0.15})`;
      lb.querySelector('.lb-amb').style.opacity = String(1 - k * 0.8);
    }
  });
  const endPointer = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (pinch) {
      if (pts.size < 2) {
        pinch = null;
        if (z.s < 1.05) z = { s: 1, x: 0, y: 0 }; else clampPan();
        applyZoom();
        const [p] = [...pts.values()];
        if (p && z.s > 1) pan = { x: p.x, y: p.y, zx: z.x, zy: z.y };
      }
      return;
    }
    if (pan) { if (!pts.size) { pan = null; clampPan(); applyZoom(); } return; }
    if (!sw || !fig) return (sw = null);
    const { dx, dy, axis } = sw; sw = null;
    const reset = () => {
      const from = fig.style.transform; fig.style.transform = '';
      if (from) fig.animate([{ transform: from }, { transform: 'none' }], { duration: 450, easing: EASE });
      lb.querySelector('.lb-amb').style.opacity = '';
    };
    if (axis === 'x' && Math.abs(dx) > 60) { fig.style.transform = ''; go(dx < 0 ? 1 : -1); }
    else if (axis === 'y' && dy > 110) { lb.querySelector('.lb-amb').style.opacity = ''; fig.style.transform = ''; closeLightbox(); }
    else reset();
  };
  addEventListener('pointerup', endPointer);
  addEventListener('pointercancel', endPointer);

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || $('.intro')) return;
    if (!lb.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); z.s > 1 ? resetZoom() : closeLightbox(); }
      else if (e.key === 'f' || e.key === 'F') toggleFav(cur);
      else if (e.key === 'z' || e.key === 'Z') { if (z.s > 1) resetZoom(); else if (fig) { zoomAt(maxZoom(), innerWidth / 2, innerHeight / 2); applyZoom(); } }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'r' || e.key === 'R') shuffle();
      else if (e.key === 'Tab') trapFocus(e);
    } else if ((e.key === 'r' || e.key === 'R') && !/input|textarea/i.test(document.activeElement?.tagName)) {
      shuffle();
    }
  }
  function trapFocus(e) {
    const f = [...lb.querySelectorAll('button, a[href]')].filter((el) => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function onRoute() {
    if (busy) { clearTimeout(onRoute.t); onRoute.t = setTimeout(onRoute, 120); return; }
    const m = location.href.startsWith(ROOT.href) && location.href.slice(ROOT.href.length).match(/^w\/([^/?#]+)\/?/);
    const id = m ? decodeURIComponent(m[1]) : null;
    if (id && byId.has(id)) {
      if (!cur) openLightbox(byId.get(id), { fromTile: true, push: false });
      else if (cur.id !== id) go(1, byId.get(id));
    } else if (cur) {
      closeLightbox({ push: false });
    }
  }
})();
