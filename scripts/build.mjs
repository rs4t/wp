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

sharp.cache(false);

const t0 = Date.now();
const log = (...a) => console.log('[build]', ...a);

// ---------- helpers ----------

const slugify = (s) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'wallpaper';

const titleize = (s) =>
  s.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase());

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
function gitAddedDates() {
  const map = new Map();
  const git = (args, opts = {}) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: ROOT, maxBuffer: 64 << 20, ...opts }).toString();
  try {
    if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
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

// ---------- image processing ----------

async function processImage(file, slug) {
  const buf = await readFile(file);
  const hash = hashOf(buf);
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
  const [lqipData, gridData, st] = await Promise.all([lqipBuf, grid, stats, ...jobs]);

  const px = (i) => [gridData[i * 3], gridData[i * 3 + 1], gridData[i * 3 + 2]];
  // Corners + center for the ambient lightbox backdrop.
  const palette = [0, 2, 6, 8, 4].map((i) => hex(px(i)));
  const dom = st.dominant ? hex([st.dominant.r, st.dominant.g, st.dominant.b]) : palette[4];

  // Original download: served untouched unless it breaks the host's size limit.
  const fname = path.basename(file);
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
    await writeFile(path.join(OUT, orig), out);
    size = out.length;
    log(`note: ${fname} is ${(buf.length / 1048576).toFixed(1)} MB (over 25 MB) — download re-encoded to JPEG q${q + 4}`);
  }

  return {
    w: width, h: height, hash, tBase, preview, og, orig, size,
    color: dom, palette,
    lqip: `data:image/webp;base64,${lqipData.toString('base64')}`,
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
const dates = gitAddedDates();
log(`found ${files.length} wallpaper${files.length === 1 ? '' : 's'}`);

// Slugs: filename first, category-prefixed only when names collide.
const used = new Set();
const entries = files.map((abs) => {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const parts = path.relative(WALLS, abs).split(path.sep);
  const category = parts.length > 1 ? parts[0] : null;
  const stem = path.basename(abs, path.extname(abs));
  let slug = slugify(stem);
  if (used.has(slug) && category) slug = slugify(`${category}-${stem}`);
  for (let n = 2; used.has(slug); n++) slug = `${slugify(stem)}-${n}`;
  used.add(slug);
  return { abs, rel, category, stem, slug };
});

const concurrency = Math.max(1, Math.min(3, (os.availableParallelism?.() ?? os.cpus().length) - 1));
let done = 0;
const items = await pool(entries, concurrency, async (e) => {
  const r = await processImage(e.abs, e.slug);
  const added = dates.get(e.rel) ?? (await stat(e.abs)).mtimeMs;
  done++;
  if (done % 5 === 0 || done === entries.length) log(`processed ${done}/${entries.length}`);
  return {
    id: e.slug,
    title: titleize(e.stem),
    cat: e.category,
    w: r.w, h: r.h,
    ratio: ratioLabel(r.w, r.h),
    size: r.size,
    added: Math.round(added),
    color: r.color,
    pal: r.palette,
    lqip: r.lqip,
    t: r.tBase,
    p: r.preview,
    og: r.og,
    o: r.orig,
    file: path.basename(r.orig),
  };
});

const now = Date.now();
items.sort((a, b) => b.added - a.added || a.title.localeCompare(b.title));
// "new" = recent, but never the first batch: when everything is new, nothing is.
const firstBatch = Math.min(...items.map((i) => i.added)) + 864e5;
for (const it of items) it.new = now - it.added < NEW_DAYS * 864e5 && it.added > firstBatch;

const catCounts = new Map();
for (const it of items) if (it.cat) catCounts.set(it.cat, (catCounts.get(it.cat) || 0) + 1);
const categories = [...catCounts].sort((a, b) => a[0].localeCompare(b[0]))
  .map(([id, count]) => ({ id, name: id.replace(/[_-]+/g, ' ').toLowerCase(), count }));

const manifest = { name: SITE_NAME, generated: now, widths: THUMB_WIDTHS, categories, items };
const manifestJson = JSON.stringify(manifest);
const mHash = hashOf(manifestJson);
await writeFile(path.join(OUT, `a/manifest.${mHash}.json`), manifestJson);

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

// Standalone 404: works under both / and /wp/ without knowing which.
await writeFile(path.join(OUT, '404.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found — ${esc(SITE_NAME)}</title><meta name="robots" content="noindex"><style>html{background:#0a0a0b;color:#ecebe8;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}body{min-height:100vh;margin:0;display:grid;place-items:center;text-align:center}em{font:italic 44px/1 Georgia,serif;display:block;margin-bottom:14px}a{color:#8b8a86}</style></head><body><div><em>Nothing here.</em><a id="h" href="/">back to the wallpapers →</a></div><script>var p=location.pathname;if(p==='/wp'||p.indexOf('/wp/')===0)document.getElementById('h').href='/wp/'</script></body></html>`);

log(`done: ${n} wallpapers, ${categories.length} categories in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
