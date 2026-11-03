// Reads wallpapers.json + collections.json (originals live in R2, served by the
// Worker at /o/<hash>/), generates thumbnails / previews / OG images with sharp,
// writes a manifest, and renders the home page, one page per collection and per
// wallpaper, plus _redirects for every old wallpaper link, into dist/.
// The admin page edits the two JSON files; nothing here needs editing.

import { readdir, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { assignSlugs, collectAliases, redirectsFor, redirectsFile, withRetry, loadJson, fetchPrevious, markNew, orderCollections, creatorsOf, fill } from './site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'dist');

const SITE_URL = (process.env.SITE_URL || 'https://wp.egorz.com').replace(/\/+$/, '') + '/';
const SITE_NAME = "egor's wallpapers";
const NEW_DAYS = 14;
const NEW_MAX = 12;
const THUMB_WIDTHS = [480, 960, 1440];
const PREVIEW_EDGE = 2880;
// Bump when image outputs or analysis change: forces a full reprocess instead of
// reusing the previous deploy's files.
const PIPELINE = 2;
// Where the previous deploy lives, to reuse already-processed images from it.
const CACHE_URL = process.env.NO_CACHE ? null : (process.env.CACHE_URL || SITE_URL).replace(/\/+$/, '') + '/';

sharp.cache(false);

const t0 = Date.now();
const log = (...a) => console.log('[build]', ...a);

// ---------- helpers ----------

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

async function processImage(buf, hash, ext, slug, downloadStem) {
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

  return {
    w: width, h: height, hash, tBase, preview, og, orig: `o/${hash}/${downloadStem}.${ext}`, size: buf.length,
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

// The previous deploy's manifest: its images are reused (unless NO_CACHE) and its
// slugs always become redirects, so it is loaded even when images are not reused.
const PREV_URL = (process.env.CACHE_URL || SITE_URL).replace(/\/+$/, '') + '/manifest.json';

async function reuseImage(hash, ext, slug, downloadStem, old) {
  const tBase = `t/${slug}.${hash}`, preview = `p/${slug}.${hash}.webp`, og = `og/${slug}.${hash}.jpg`;
  const jobs = [];
  for (const w of THUMB_WIDTHS) for (const ext of ['avif', 'webp']) {
    jobs.push(fetchTo(`${CACHE_URL}${old.t}-${w}.${ext}`, path.join(OUT, `${tBase}-${w}.${ext}`)));
  }
  jobs.push(fetchTo(CACHE_URL + old.p, path.join(OUT, preview)));
  jobs.push(fetchTo(CACHE_URL + old.og, path.join(OUT, og)));
  await Promise.all(jobs);
  return {
    w: old.w, h: old.h, hash, tBase, preview, og, orig: `o/${hash}/${downloadStem}.${ext}`, size: old.size,
    color: old.color, palette: old.pal, colors: old.colors, lqip: old.lqip,
  };
}

// ---------- pages ----------

function renderPage(tpl, { title, description, url, image, color, initial, page = 'gallery', collection = '', creator = '', banner = '' }) {
  return fill(tpl, {
    root: '/', title: esc(title), description: esc(description), url: esc(url), image: esc(image || ''),
    color: esc(color || '#0a0a0b'), initial: esc(initial || ''), page, collection: esc(collection), creator: esc(creator),
    banner, css: assets.css, js: assets.js, search: assets.search,
  });
}
// The wide banner on collection and creator pages.
const bannerHtml = (cover, title, sub) =>
  `<header class="banner" style="--c:${esc(cover.color)}"><img src="/${esc(cover.t)}-1440.webp" alt=""><div class="banner-text"><h1>${esc(title)}</h1><span class="mono">${sub}</span></div></header>`;

const assets = {};

// ---------- main ----------

await rm(OUT, { recursive: true, force: true });
for (const d of ['t', 'p', 'og', 'a', 'w', 'c', 'by']) await mkdir(path.join(OUT, d), { recursive: true });

const readJson = (f, fallback) => loadJson(path.join(ROOT, f), fallback);
// [{ hash, ext, name, collection?, size, added, credit? }]
const list = await readJson('wallpapers.json');
// [{ id, name, cover? }] in display order
const collectionList = await readJson('collections.json', []);
const prev = await fetchPrevious(PREV_URL);
if (!prev) log('no previous deploy; processing everything');
const previous = new Map();
if (prev && !CACHE_URL) log('NO_CACHE: reprocessing every image');
else if (prev?.pipeline === PIPELINE) {
  for (const i of prev.items) if (i.hash) previous.set(i.hash, i);
  log(`reusing processed images from ${CACHE_URL}`);
} else if (prev) log(`previous deploy used pipeline ${prev.pipeline ?? 1}, reprocessing everything once`);
log(`found ${list.length} wallpaper${list.length === 1 ? '' : 's'}`);

const slugByHash = assignSlugs(list);
const collectionIds = new Set(collectionList.map((c) => c.id));

const concurrency = Math.max(1, Math.min(3, (os.availableParallelism?.() ?? os.cpus().length) - 1));
let done = 0, reused = 0;
// Processed files for one image: reused from the previous deploy when possible,
// otherwise the original is downloaded from R2 (through the live Worker) and processed.
// A wallpaper that can't be fetched fails the whole build, so a network blip
// never deploys a site with wallpapers missing; the previous deploy stays live.
async function imageFor(hash, ext, slug, label) {
  const old = previous.get(hash);
  if (old) {
    try { const r = await withRetry(() => reuseImage(hash, ext, slug, slug, old)); reused++; return r; }
    catch (err) { log(`note: could not reuse ${label} (${err.message}); processing it`); }
  }
  const buf = await withRetry(async () => {
    const res = await fetch(`${SITE_URL}o/${hash}/original.${ext}`, { signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }).catch((err) => { throw new Error(`${label}: could not download the original (${err.message})`); });
  if (hashOf(buf) !== hash) throw new Error(`${label}: the original does not match its hash ${hash}`);
  return processImage(buf, hash, ext, slug, slug);
}

const items = (await pool(list, concurrency, async (e) => {
  const slug = slugByHash.get(e.hash);
  const r = await imageFor(e.hash, e.ext, slug, e.name);
  done++;
  if (done % 10 === 0 || done === list.length) log(`processed ${done}/${list.length}`);
  return {
    id: slug,
    name: e.name,
    coll: collectionIds.has(e.collection) ? e.collection : null,
    w: r.w, h: r.h,
    ratio: ratioLabel(r.w, r.h),
    size: e.size,
    added: e.added,
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
    ...(e.credit?.name ? { credit: e.credit } : {}),
  };
})).filter(Boolean);

const now = Date.now();
items.sort((a, b) => b.added - a.added || a.name.localeCompare(b.name, 'en', { numeric: true }));
markNew(items, now, { days: NEW_DAYS, max: NEW_MAX });

// Collections with at least one wallpaper, most recently updated first; cover defaults to the newest member.
const collections = orderCollections(collectionList, items).map((c) => {
  const members = items.filter((i) => i.coll === c.id);
  const cover = members.find((i) => i.hash === c.cover) || members[0];
  return members.length ? { id: c.id, name: c.name, count: members.length, cover: cover.hash } : null;
}).filter(Boolean);

const colorCounts = new Map();
for (const it of items) for (const c of it.colors) colorCounts.set(c, (colorCounts.get(c) || 0) + 1);
const COLOR_ORDER = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'light', 'gray', 'dark'];
const colors = COLOR_ORDER.filter((c) => colorCounts.has(c)).map((id) => ({ id, count: colorCounts.get(id) }));

// Every slug a wallpaper ever had, so old links redirect forever.
const aliases = collectAliases({ legacy: await readJson('legacy-ids.json'), prevAliases: prev?.aliases, prevItems: prev?.items });
const liveSlugs = new Map(items.map((i) => [i.hash, i.id]));
await writeFile(path.join(OUT, '_redirects'), redirectsFile(redirectsFor(aliases, liveSlugs)));

// Creators: everyone credited on at least one wallpaper.
const creators = creatorsOf(items);
const creatorId = new Map(creators.map((c) => [c.name, c.id]));
for (const it of items) if (it.credit?.name) it.by = creatorId.get(it.credit.name);

const manifest = { name: SITE_NAME, generated: now, pipeline: PIPELINE, widths: THUMB_WIDTHS, collections, creators, colors, items, aliases };
const manifestJson = JSON.stringify(manifest);
const mHash = hashOf(manifestJson);
await writeFile(path.join(OUT, `a/manifest.${mHash}.json`), manifestJson);
await writeFile(path.join(OUT, 'manifest.json'), manifestJson); // unhashed copy for the admin page

// Static assets, content-hashed for immutable caching.
for (const [key, file] of [['css', 'styles.css'], ['js', 'app.js'], ['search', 'search.js']]) {
  let src = await readFile(path.join(SRC, file), 'utf8');
  if (key === 'js') src = src.replace('__MANIFEST__', `a/manifest.${mHash}.json`);
  const name = `a/${file.replace(/\.(\w+)$/, `.${hashOf(src)}.$1`)}`;
  await writeFile(path.join(OUT, name), src);
  assets[key] = name;
}
await copyFile(path.join(SRC, 'favicon.svg'), path.join(OUT, 'favicon.svg'));
await mkdir(path.join(OUT, 'fonts'), { recursive: true });
for (const f of await readdir(path.join(SRC, 'fonts'))) await copyFile(path.join(SRC, 'fonts', f), path.join(OUT, 'fonts', f));
await copyFile(path.join(SRC, '_headers'), path.join(OUT, '_headers'));
await mkdir(path.join(OUT, 'admin'), { recursive: true });
for (const f of await readdir(path.join(SRC, 'admin'))) await copyFile(path.join(SRC, 'admin', f), path.join(OUT, 'admin', f));

const tpl = await readFile(path.join(SRC, 'template.html'), 'utf8');
const n = items.length;
const homeDesc = n
  ? `${n} high-resolution wallpaper${n === 1 ? '' : 's'}${collections.length ? ` — ${collections.map((c) => c.name).join(', ')} and more` : ''}. Free to download.`
  : 'A collection of high-resolution wallpapers.';

await writeFile(path.join(OUT, 'index.html'), renderPage(tpl, {
  title: SITE_NAME, description: homeDesc, url: SITE_URL,
  image: items[0] ? SITE_URL + items[0].og : '', color: '#0a0a0b',
}));

const byHash = new Map(items.map((i) => [i.hash, i]));
for (const c of collections) {
  const cover = byHash.get(c.cover);
  const count = `${c.count} wallpaper${c.count === 1 ? '' : 's'}`;
  await mkdir(path.join(OUT, 'c', c.id), { recursive: true });
  await writeFile(path.join(OUT, 'c', c.id, 'index.html'), renderPage(tpl, {
    page: 'collection', collection: c.id,
    title: `${c.name} — ${SITE_NAME}`,
    description: `${c.name}: ${count} from ${SITE_NAME}. Free to download.`,
    url: `${SITE_URL}c/${c.id}/`, image: SITE_URL + cover.og, color: cover.color,
    banner: bannerHtml(cover, c.name, count),
  }));
}
for (const c of creators) {
  const cover = byHash.get(c.cover);
  const count = `${c.count} wallpaper${c.count === 1 ? '' : 's'}`;
  const link = c.link ? ` · <a href="${esc(c.link)}" target="_blank" rel="noopener nofollow">${esc(new URL(c.link).host)} ↗</a>` : '';
  await mkdir(path.join(OUT, 'by', c.id), { recursive: true });
  await writeFile(path.join(OUT, 'by', c.id, 'index.html'), renderPage(tpl, {
    page: 'creator', creator: c.id,
    title: `${c.name} — ${SITE_NAME}`,
    description: `${count} by ${c.name} on ${SITE_NAME}. Free to download.`,
    url: `${SITE_URL}by/${c.id}/`, image: SITE_URL + cover.og, color: cover.color,
    banner: bannerHtml(cover, c.name, `by ${esc(c.name)} · ${count}${link}`),
  }));
}

const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
const collName = new Map(collections.map((c) => [c.id, c.name]));
for (const it of items) {
  const dir = path.join(OUT, 'w', it.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), renderPage(tpl, {
    title: `${it.name} — ${SITE_NAME}`,
    description: `${it.w} × ${it.h} · ${it.ratio} · ${mb(it.size)}${it.coll ? ` · ${collName.get(it.coll)}` : ''}. From ${SITE_NAME}.`,
    url: `${SITE_URL}w/${it.id}/`,
    image: SITE_URL + it.og, color: it.color, initial: it.id,
  }));
}

// Search engines: every page, and keep them out of admin/API.
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
await writeFile(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_URL}</loc><lastmod>${day(now)}</lastmod></url>
${collections.map((c) => `  <url><loc>${SITE_URL}c/${c.id}/</loc><lastmod>${day(now)}</lastmod></url>`).join('\n')}
${creators.map((c) => `  <url><loc>${SITE_URL}by/${c.id}/</loc><lastmod>${day(now)}</lastmod></url>`).join('\n')}
${items.map((it) => `  <url><loc>${SITE_URL}w/${it.id}/</loc><lastmod>${day(it.added)}</lastmod></url>`).join('\n')}
</urlset>
`);
await writeFile(path.join(OUT, 'robots.txt'), `User-agent: *\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${SITE_URL}sitemap.xml\n`);

// Standalone 404 page.
await writeFile(path.join(OUT, '404.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found — ${esc(SITE_NAME)}</title><meta name="robots" content="noindex"><style>html{background:#0a0a0b;color:#ecebe8;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}body{min-height:100vh;margin:0;display:grid;place-items:center;text-align:center}em{font:italic 44px/1 Georgia,serif;display:block;margin-bottom:14px}a{color:#8b8a86}</style></head><body><div><em>Nothing here.</em><a href="/">back to the wallpapers →</a></div></body></html>`);

log(`done: ${n} wallpapers (${reused} reused, ${n - reused} processed), ${collections.length} collections in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
