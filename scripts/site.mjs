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

// Cloudflare static-assets _redirects file.
export const redirectsFile = (redirects) =>
  Object.entries(redirects).flatMap(([a, b]) => [`/w/${a} /w/${b}/ 301`, `/w/${a}/ /w/${b}/ 301`])
    .concat(['/community / 301', '/community/* / 301']).join('\n') + '\n';
