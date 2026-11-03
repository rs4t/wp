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

// Cloudflare static-assets _redirects file.
export const redirectsFile = (redirects) =>
  Object.entries(redirects).flatMap(([a, b]) => [`/w/${a} /w/${b}/ 301`, `/w/${a}/ /w/${b}/ 301`])
    .concat(['/community / 301', '/community/* / 301']).join('\n') + '\n';
