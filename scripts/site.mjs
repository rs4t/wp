// Slugs and redirects for wallpaper pages. Pure functions, shared by the build and its tests.

export const slugify = (s) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'wallpaper';

// Oldest wallpaper keeps the plain slug; later ones with the same name get -2, -3…
export function assignSlugs(walls) {
  const out = new Map(), used = new Set();
  for (const w of [...walls].sort((a, b) => a.added - b.added || (a.hash < b.hash ? -1 : 1))) {
    const base = slugify(w.name);
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    out.set(w.hash, slug);
  }
  return out;
}

// Every slug a wallpaper has ever had → its hash. Carried from deploy to deploy in the manifest.
export const collectAliases = ({ legacy = {}, prevAliases = {}, prevItems = [] }) =>
  Object.assign({}, legacy, prevAliases, Object.fromEntries(prevItems.map((i) => [i.id, i.hash])));

// Old slug → current slug, skipping deleted wallpapers, unchanged slugs and slugs a live page now uses.
export function redirectsFor(aliases, slugByHash) {
  const live = new Set(slugByHash.values()), out = {};
  for (const [old, hash] of Object.entries(aliases)) {
    const now = slugByHash.get(hash);
    if (now && old !== now && !live.has(old)) out[old] = now;
  }
  return out;
}

// Runs fn up to `tries` times, waiting longer between tries; rethrows the last error.
export async function withRetry(fn, tries = 3, delayMs = 2000) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (err) { if (i >= tries) throw err; await new Promise((r) => setTimeout(r, delayMs * i)); }
  }
}

// A data file. Missing → fallback (or an error when no fallback is given);
// unreadable JSON always fails, so a bad edit can never build an empty site.
export async function loadJson(file, fallback) {
  const { readFile } = await import('node:fs/promises');
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`${file}: ${err.code === 'ENOENT' ? 'missing' : err.message}`);
  }
  try { return JSON.parse(text); }
  catch (err) { throw new Error(`${file} is not valid JSON (${err.message})`); }
}

// The live site's manifest (images to reuse, slugs to redirect). 404 = no site
// yet; anything else that fails stops the build, so old links are never dropped.
export async function fetchPrevious(url, fetchFn = fetch, delayMs = 2000) {
  return withRetry(async () => {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`previous manifest: HTTP ${res.status}`);
    return res.json();
  }, 3, delayMs);
}

// "new" badge: added in the last `days`, at most the `max` newest, and never the
// first batch (on a brand-new site everything is new, so nothing is).
export function markNew(items, now, { days = 14, max = 12 } = {}) {
  const firstBatch = items.reduce((m, i) => Math.min(m, i.added), Infinity) + 864e5;
  const recent = items.filter((i) => now - i.added < days * 864e5 && i.added > firstBatch)
    .sort((a, b) => b.added - a.added).slice(0, max);
  const pick = new Set(recent);
  for (const it of items) it.new = pick.has(it);
  return items;
}

// Collections whose newest wallpaper is most recent come first.
export function orderCollections(collections, items) {
  const latest = new Map();
  for (const it of items) if (it.coll) latest.set(it.coll, Math.max(latest.get(it.coll) ?? -Infinity, it.added));
  return collections.map((c, i) => [c, latest.get(c.id) ?? -Infinity, i])
    .sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(([c]) => c);
}

// One entry per credited creator (most work first); cover = their newest wallpaper.
export function creatorsOf(items) {
  const by = new Map();
  for (const it of items) {
    if (!it.credit?.name) continue;
    const id = slugify(it.credit.name);
    const c = by.get(id) || { id, name: it.credit.name, count: 0, cover: it.hash, added: -Infinity };
    c.count++;
    if (it.added > c.added) { c.added = it.added; c.cover = it.hash; }
    if (it.credit.link && !c.link) c.link = it.credit.link;
    by.set(id, c);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map(({ added, ...c }) => c);
}

// Template {{key}} → value, inserted literally (a "$" in a name stays a "$").
export const fill = (tpl, vars) => Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, () => v), tpl);

// Cloudflare static-assets _redirects file.
export const redirectsFile = (redirects) =>
  Object.entries(redirects).flatMap(([a, b]) => [`/w/${a} /w/${b}/ 301`, `/w/${a}/ /w/${b}/ 301`])
    .concat(['/community / 301', '/community/* / 301']).join('\n') + '\n';
