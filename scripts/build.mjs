// Scans wallpapers/, generates thumbnails / previews / OG images with sharp,
// writes a manifest, and renders index + one permalink page per wallpaper into dist/.
// Nothing here needs editing when wallpapers are added: drop files, push.

import { readdir, stat, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const WALLS = process.env.WALLPAPERS_DIR ? path.resolve(process.env.WALLPAPERS_DIR) : path.join(ROOT, 'wallpapers');
const OUT = path.join(ROOT, 'dist');

const SITE_URL = (process.env.SITE_URL || 'https://wp.egorz.com').replace(/\/+$/, '') + '/';
const SITE_NAME = "egor's wallpapers";
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff']);
const NEW_DAYS = 14;
const THUMB_WIDTHS = [480, 960, 1440];
const PREVIEW_EDGE = 2880;
const MAX_ASSET_BYTES = 24.5 * 1024 * 1024; // Cloudflare's per-file limit is 25 MiB
// Bump when image outputs or analysis change: forces a full reprocess instead of
// reusing the previous deploy's files.
const PIPELINE = 2;
// Where the previous deploy lives, to reuse already-processed images from it.
const CACHE_URL = process.env.NO_CACHE ? null : (process.env.CACHE_URL || SITE_URL).replace(/\/+$/, '') + '/';

sharp.cache(false);

const t0 = Date.now();
const log = (...a) => console.log('[build]', ...a);

// ---------- helpers ----------

const slugify = (s) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'wallpaper';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

const hashOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);

const RATIOS = [
  [32, 9], [21, 9], [2, 1], [16, 9], [16, 10], [3, 2], [4, 3], [5, 4], [1, 1],
  [4, 5], [3, 4], [2, 3], [10, 16], [9, 16], [9, 19.5], [9, 20], [9, 21],
];
function ratioLabel(w, h) {
  const r = w / h;
  for (const [a, b] of RATIOS) if (Math.abs(r - a / b) / (a / b) < 0.012) return `${a}:${b}`;
  return r >= 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`;
}

async function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (IMAGE_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

// When each file was first added, from git history. Cloudflare clones shallowly,
// so deepen the clone first; fall back to file mtime for anything git doesn't know.
function gitAddedDates({ deepen }) {
  const map = new Map();
  const git = (args, opts = {}) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: ROOT, maxBuffer: 64 << 20, ...opts }).toString();
  try {
    if (deepen && git(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
      log('shallow clone detected, fetching full history for dates…');
      try { git(['fetch', '--unshallow', '--quiet'], { stdio: 'ignore', timeout: 120000 }); }
      catch { log('warning: could not unshallow; some dates may fall back to file time'); }
    }
    const out = git(['log', '--no-renames', '--diff-filter=A', '--format=@%ct', '--name-only', '--', 'wallpapers']);
    let ts = 0;
    for (const line of out.split('\n')) {
      if (!line) continue;
      if (line.startsWith('@')) { ts = Number(line.slice(1)) * 1000; continue; }
      if (!map.has(line)) map.set(line, ts); // newest-first log: keep the latest add
    }
  } catch { log('warning: git history unavailable; using file times'); }
  return map;
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; results[n] = await fn(items[n], n); }
  }));
  return results;
}

// ---------- color families ----------
// Every wallpaper is tagged with up to two hue families plus dark/light, from
// its own pixels — nobody has to tag colors by hand.

const HUES = [[15, 'red'], [40, 'orange'], [65, 'yellow'], [160, 'green'], [195, 'teal'], [250, 'blue'], [290, 'purple'], [345, 'pink'], [360, 'red']];
const hueFamily = (h) => HUES.find(([max]) => h < max)[1];

function colorFamilies(px) {
  const n = px.length / 3;
  const weight = new Map();
  let vivid = 0, chroma = 0, dark = 0, light = 0, vSum = 0;
  for (let i = 0; i < px.length; i += 3) {
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const v = max, sat = max ? d / max : 0;
    vSum += v;
    if (v < 0.2) dark++;
    else if (v > 0.82 && sat < 0.18) light++;
    if (sat < 0.25 || v < 0.25) continue;
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    const w = sat * v;
    const fam = hueFamily(h);
    weight.set(fam, (weight.get(fam) || 0) + w);
    chroma += w; vivid++;
  }
  const out = [];
  if (vivid / n >= 0.06) {
    for (const [fam, w] of [...weight].sort((a, b) => b[1] - a[1]).slice(0, 2)) if (w >= chroma * 0.24) out.push(fam);
  }
  if (dark / n > 0.5) out.push('dark');
  else if (light / n > 0.45) out.push('light');
  if (!out.length) out.push(vSum / n < 0.35 ? 'dark' : vSum / n > 0.7 ? 'light' : 'gray');
  return out;
}

// ---------- image processing ----------

async function processImage(buf, hash, file, slug, downloadStem) {
  const input = sharp(buf, { failOn: 'none', limitInputPixels: false });
  const meta = await input.metadata();
  let { width, height } = meta;
  if (meta.orientation >= 5) [width, height] = [height, width];

  // Decode + orient + downscale once; every derivative comes from this raw buffer.
  const { data, info } = await sharp(buf, { failOn: 'none', limitInputPixels: false })
    .rotate()
    .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const base = () => sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });

  const tBase = `t/${slug}.${hash}`;
  const jobs = [];
  for (const w of THUMB_WIDTHS) {
    const r = () => base().resize({ width: Math.min(w, info.width) });
    jobs.push(r().avif({ quality: 56, effort: 4 }).toFile(path.join(OUT, `${tBase}-${w}.avif`)));
    jobs.push(r().webp({ quality: 80, effort: 4 }).toFile(path.join(OUT, `${tBase}-${w}.webp`)));
  }
  const preview = `p/${slug}.${hash}.webp`;
  jobs.push(base().webp({ quality: 84, effort: 4 }).toFile(path.join(OUT, preview)));
  const og = `og/${slug}.${hash}.jpg`;
  jobs.push(base().resize(1200, 630, { fit: 'cover', position: sharp.strategy.attention })
    .jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(OUT, og)));
  const lqipBuf = base().resize(20).webp({ quality: 45 }).toBuffer();
  const grid = base().resize(3, 3, { fit: 'fill' }).raw().toBuffer();
  const stats = base().stats();
  const sample = base().resize(48, 48, { fit: 'fill' }).raw().toBuffer();
  const [lqipData, gridData, st, samplePx] = await Promise.all([lqipBuf, grid, stats, sample, ...jobs]);

  const px = (i) => [gridData[i * 3], gridData[i * 3 + 1], gridData[i * 3 + 2]];
  // Corners + center for the ambient lightbox backdrop.
  const palette = [0, 2, 6, 8, 4].map((i) => hex(px(i)));
  const dom = st.dominant ? hex([st.dominant.r, st.dominant.g, st.dominant.b]) : palette[4];

  // Original download: served untouched unless it breaks the host's size limit.
  const fname = downloadStem + path.extname(file).toLowerCase();
  let orig = `o/${hash}/${fname}`;
  let size = buf.length;
  await mkdir(path.join(OUT, 'o', hash), { recursive: true });
  if (buf.length <= MAX_ASSET_BYTES) {
    await copyFile(file, path.join(OUT, orig));
  } else {
    const jpgName = fname.replace(/\.[^.]+$/, '') + '.jpg';
    orig = `o/${hash}/${jpgName}`;
    let q = 95, out;
    do {
      out = await sharp(buf, { limitInputPixels: false }).rotate().jpeg({ quality: q, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
      q -= 4;
    } while (out.length > MAX_ASSET_BYTES && q > 70);
    // Still too big at q70 (gigantic images): shrink until it fits the host limit.
    for (let scale = 0.9; out.length > MAX_ASSET_BYTES && scale > 0.3; scale -= 0.1) {
      out = await sharp(buf, { limitInputPixels: false }).rotate()
        .resize({ width: Math.round(width * scale), withoutEnlargement: true })
        .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    }
    await writeFile(path.join(OUT, orig), out);
    size = out.length;
    log(`note: ${fname} is ${(buf.length / 1048576).toFixed(1)} MB (over 25 MB) — download re-encoded to JPEG q${q + 4}`);
  }

  return {
    w: width, h: height, hash, tBase, preview, og, orig, size,
    color: dom, palette, colors: colorFamilies(samplePx),
    lqip: `data:image/webp;base64,${lqipData.toString('base64')}`,
  };
}

// ---------- reuse from the previous deploy ----------
// Same file content (hash) as a wallpaper already live: download its finished
// thumbnails/preview instead of decoding a huge original again. Seconds, not minutes.

async function fetchTo(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function loadPrevious() {
  if (!CACHE_URL) return new Map();
  try {
    const res = await fetch(CACHE_URL + 'manifest.json', { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const prev = await res.json();
    if (prev.pipeline !== PIPELINE) { log(`previous deploy used pipeline ${prev.pipeline ?? 1}, reprocessing everything once`); return new Map(); }
    log(`reusing processed images from ${CACHE_URL}`);
    return new Map(prev.items.filter((i) => i.hash).map((i) => [i.hash, i]));
  } catch (err) {
    log(`no previous deploy to reuse (${err.message}); processing everything`);
    return new Map();
  }
}

async function reuseImage(buf, hash, file, slug, downloadStem, old) {
  const tBase = `t/${slug}.${hash}`, preview = `p/${slug}.${hash}.webp`, og = `og/${slug}.${hash}.jpg`;
  const jobs = [];
  for (const w of THUMB_WIDTHS) for (const ext of ['avif', 'webp']) {
    jobs.push(fetchTo(`${CACHE_URL}${old.t}-${w}.${ext}`, path.join(OUT, `${tBase}-${w}.${ext}`)));
  }
  jobs.push(fetchTo(CACHE_URL + old.p, path.join(OUT, preview)));
  jobs.push(fetchTo(CACHE_URL + old.og, path.join(OUT, og)));
  await mkdir(path.join(OUT, 'o', hash), { recursive: true });
  let orig = `o/${hash}/${downloadStem}${path.extname(file).toLowerCase()}`;
  if (buf.length <= MAX_ASSET_BYTES) jobs.push(copyFile(file, path.join(OUT, orig)));
  else { orig = `o/${hash}/${downloadStem}.jpg`; jobs.push(fetchTo(CACHE_URL + old.o, path.join(OUT, orig))); }
  await Promise.all(jobs);
  return {
    w: old.w, h: old.h, hash, tBase, preview, og, orig, size: buf.length <= MAX_ASSET_BYTES ? buf.length : old.size,
    color: old.color, palette: old.pal, colors: old.colors, lqip: old.lqip, added: old.added,
  };
}

// ---------- pages ----------

function renderPage(tpl, { root, title, description, url, image, color, initial }) {
  return tpl
    .replaceAll('{{root}}', root)
    .replaceAll('{{title}}', esc(title))
    .replaceAll('{{description}}', esc(description))
    .replaceAll('{{url}}', esc(url))
    .replaceAll('{{image}}', esc(image || ''))
    .replaceAll('{{color}}', esc(color || '#0a0a0b'))
    .replaceAll('{{initial}}', esc(initial || ''))
    .replaceAll('{{css}}', assets.css)
    .replaceAll('{{js}}', assets.js);
}

const assets = {};

// ---------- main ----------

await rm(OUT, { recursive: true, force: true });
for (const d of ['t', 'p', 'og', 'o', 'a', 'w']) await mkdir(path.join(OUT, d), { recursive: true });

const files = (await walk(WALLS)).sort();
const previous = await loadPrevious();
// Reused wallpapers keep their dates from the previous deploy, so the (slow)
// full git history is only needed when there is nothing to reuse.
const dates = gitAddedDates({ deepen: previous.size === 0 });
log(`found ${files.length} wallpaper${files.length === 1 ? '' : 's'}`);

// Names repeat across categories (1.jpg, 2.jpg…), so the category is part of
// every title, permalink slug and download filename.
const used = new Set();
const entries = files.map((abs) => {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const parts = path.relative(WALLS, abs).split(path.sep);
  const category = parts.length > 1 ? parts[0] : null;
  const stem = path.basename(abs, path.extname(abs));
  const base = slugify(category ? `${category}-${stem}` : stem);
  let slug = base;
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
  used.add(slug);
  return { abs, rel, category, stem, slug };
});

const concurrency = Math.max(1, Math.min(3, (os.availableParallelism?.() ?? os.cpus().length) - 1));
let done = 0, reused = 0;
const items = (await pool(entries, concurrency, async (e) => {
  let r;
  const downloadStem = e.category ? `${e.category}-${e.stem}` : e.stem;
  try {
    const buf = await readFile(e.abs);
    const hash = hashOf(buf);
    const old = previous.get(hash);
    if (old) {
      try { r = await reuseImage(buf, hash, e.abs, e.slug, downloadStem, old); reused++; }
      catch (err) { log(`note: could not reuse ${e.rel} (${err.message}); processing it`); }
    }
    if (!r) r = await processImage(buf, hash, e.abs, e.slug, downloadStem);
  } catch (err) { log(`warning: skipping ${e.rel} — not a readable image (${err.message})`); return null; }
  const added = r.added ?? dates.get(e.rel) ?? (await stat(e.abs)).mtimeMs;
  done++;
  if (done % 10 === 0 || done === entries.length) log(`processed ${done}/${entries.length}`);
  return {
    id: e.slug,
    title: e.category ? `${e.category}/${e.stem}` : e.stem,
    name: e.stem,
    cat: e.category,
    w: r.w, h: r.h,
    ratio: ratioLabel(r.w, r.h),
    size: r.size,
    added: Math.round(added),
    color: r.color,
    pal: r.palette,
    colors: r.colors,
    lqip: r.lqip,
    hash: r.hash,
    t: r.tBase,
    p: r.preview,
    og: r.og,
    o: r.orig,
    file: path.basename(r.orig),
    src: e.rel,
  };
})).filter(Boolean);

const now = Date.now();
items.sort((a, b) => b.added - a.added || a.title.localeCompare(b.title, 'en', { numeric: true }));
// "new" = recent, but never the first batch: when everything is new, nothing is.
const firstBatch = items.reduce((m, i) => Math.min(m, i.added), Infinity) + 864e5;
for (const it of items) it.new = now - it.added < NEW_DAYS * 864e5 && it.added > firstBatch;

const catCounts = new Map();
for (const it of items) if (it.cat) catCounts.set(it.cat, (catCounts.get(it.cat) || 0) + 1);
const categories = [...catCounts].sort((a, b) => a[0].localeCompare(b[0]))
  .map(([id, count]) => ({ id, name: id.replace(/[_-]+/g, ' ').toLowerCase(), count }));

const colorCounts = new Map();
for (const it of items) for (const c of it.colors) colorCounts.set(c, (colorCounts.get(c) || 0) + 1);
const COLOR_ORDER = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'light', 'gray', 'dark'];
const colors = COLOR_ORDER.filter((c) => colorCounts.has(c)).map((id) => ({ id, count: colorCounts.get(id) }));

const manifest = { name: SITE_NAME, generated: now, pipeline: PIPELINE, widths: THUMB_WIDTHS, categories, colors, items };
const manifestJson = JSON.stringify(manifest);
const mHash = hashOf(manifestJson);
await writeFile(path.join(OUT, `a/manifest.${mHash}.json`), manifestJson);
await writeFile(path.join(OUT, 'manifest.json'), manifestJson); // unhashed copy for the admin page

// Static assets, content-hashed for immutable caching.
for (const [key, file] of [['css', 'styles.css'], ['js', 'app.js']]) {
  let src = await readFile(path.join(SRC, file), 'utf8');
  if (key === 'js') src = src.replace('__MANIFEST__', `a/manifest.${mHash}.json`);
  const name = `a/${file.replace(/\.(\w+)$/, `.${hashOf(src)}.$1`)}`;
  await writeFile(path.join(OUT, name), src);
  assets[key] = name;
}
await copyFile(path.join(SRC, 'favicon.svg'), path.join(OUT, 'favicon.svg'));
await copyFile(path.join(SRC, '_headers'), path.join(OUT, '_headers'));
await mkdir(path.join(OUT, 'admin'), { recursive: true });
for (const f of await readdir(path.join(SRC, 'admin'))) await copyFile(path.join(SRC, 'admin', f), path.join(OUT, 'admin', f));

const tpl = await readFile(path.join(SRC, 'template.html'), 'utf8');
const n = items.length;
const homeDesc = n
  ? `${n} high-resolution wallpaper${n === 1 ? '' : 's'}${categories.length ? ` — ${categories.map((c) => c.name).join(', ')}` : ''}. Free to download.`
  : 'A collection of high-resolution wallpapers.';

await writeFile(path.join(OUT, 'index.html'), renderPage(tpl, {
  root: './', title: SITE_NAME, description: homeDesc, url: SITE_URL,
  image: items[0] ? SITE_URL + items[0].og : '', color: '#0a0a0b',
}));

const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
for (const it of items) {
  const dir = path.join(OUT, 'w', it.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), renderPage(tpl, {
    root: '../../',
    title: `${it.title} — ${SITE_NAME}`,
    description: `${it.w} × ${it.h} · ${it.ratio} · ${mb(it.size)}${it.cat ? ` · ${it.cat}` : ''}. From ${SITE_NAME}.`,
    url: `${SITE_URL}w/${it.id}/`,
    image: SITE_URL + it.og, color: it.color, initial: it.id,
  }));
}

// Search engines: every wallpaper page, and keep them out of admin/API.
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
await writeFile(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}</loc><lastmod>${day(now)}</lastmod></url>
${items.map((it) => `  <url><loc>${SITE_URL}w/${it.id}/</loc><lastmod>${day(it.added)}</lastmod></url>`).join('\n')}
</urlset>
`);
await writeFile(path.join(OUT, 'robots.txt'), `User-agent: *\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${SITE_URL}sitemap.xml\n`);

// Standalone 404 page.
await writeFile(path.join(OUT, '404.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found — ${esc(SITE_NAME)}</title><meta name="robots" content="noindex"><style>html{background:#0a0a0b;color:#ecebe8;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}body{min-height:100vh;margin:0;display:grid;place-items:center;text-align:center}em{font:italic 44px/1 Georgia,serif;display:block;margin-bottom:14px}a{color:#8b8a86}</style></head><body><div><em>Nothing here.</em><a href="/">back to the wallpapers →</a></div></body></html>`);

log(`done: ${n} wallpapers (${reused} reused, ${n - reused} processed), ${categories.length} categories in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
