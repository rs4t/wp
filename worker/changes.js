// Applies one admin save to wallpapers.json + collections.json. Pure: no
// Cloudflare or GitHub calls, so it runs (and is tested) anywhere.
//
// body: add      [{ hash, ext, name, collection?, credit? }]   new wallpapers (already uploaded to R2)
//       update   [{ hash, name?, collection?, credit? }]        null clears collection / credit
//       delete   [hash]                                         originals stay in R2
//       collections [{ id, name, cover? }]                      full ordered replacement

export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff']);
const HASH = /^[0-9a-f]{10}$/;
const COLLECTION_ID = /^[a-z0-9-]{1,40}$/;

export function cleanName(n) {
  return String(n || '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 100);
}

export function cleanCredit(c) {
  if (!c) return null;
  const name = String(c.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60);
  if (!name) return null;
  let link = String(c.link || '').trim().slice(0, 300);
  if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
  try { if (link) link = new URL(link).href; } catch { link = ''; }
  return link ? { name, link } : { name };
}

// uploads: Map<hash, size> of R2 objects found for the hashes in body.add.
export function applyChanges({ walls, collections, body, uploads, now }) {
  const list = (k) => (Array.isArray(body?.[k]) ? body[k] : []);
  const add = list('add'), update = list('update'), del = list('delete');
  const newCollections = Array.isArray(body?.collections) ? body.collections : null;
  const total = add.length + update.length + del.length + (newCollections ? 1 : 0);
  if (!total) return { error: 'Nothing to do' };
  if (total > 300) return { error: 'Too many changes at once' };

  let out = walls.map((w) => ({ ...w }));
  const byHash = new Map(out.map((w) => [w.hash, w]));

  // Collections first, so a save can create a collection and fill it.
  let cols = collections.map((c) => ({ ...c }));
  if (newCollections) {
    const seen = new Set();
    cols = [];
    for (const c of newCollections) {
      const id = String(c?.id || '');
      const name = cleanName(c?.name).slice(0, 40);
      if (!COLLECTION_ID.test(id)) return { error: `Bad collection id: ${id || '(empty)'}` };
      if (seen.has(id)) return { error: `Collection listed twice: ${id}` };
      if (!name) return { error: `Collection ${id} needs a name` };
      seen.add(id);
      cols.push({ id, name, ...(c.cover ? { cover: String(c.cover) } : {}) });
    }
  }
  const colIds = new Set(cols.map((c) => c.id));
  const checkCollection = (c) => (c === undefined || c === null || colIds.has(c) ? null : `Unknown collection: ${c}`);

  for (const h of del) {
    if (!byHash.has(h)) return { error: `Not found: ${h}` };
    byHash.delete(h);
  }
  out = out.filter((w) => byHash.has(w.hash));

  for (const u of update) {
    const w = byHash.get(u?.hash);
    if (!w) return { error: `Not found: ${u?.hash}` };
    if (u.name !== undefined) {
      const name = cleanName(u.name);
      if (!name) return { error: 'Every wallpaper needs a name' };
      w.name = name;
    }
    if (u.collection !== undefined) {
      const err = checkCollection(u.collection);
      if (err) return { error: err };
      if (u.collection === null) delete w.collection; else w.collection = u.collection;
    }
    if (u.credit !== undefined) {
      const c = cleanCredit(u.credit);
      if (c) w.credit = c; else delete w.credit;
    }
  }

  for (const a of add) {
    const hash = String(a?.hash || '');
    if (!HASH.test(hash) || !uploads.has(hash)) return { error: 'Upload not found — please upload again' };
    if (byHash.has(hash)) return { error: `Already on the site: ${byHash.get(hash).name}` };
    const ext = String(a.ext || '').toLowerCase();
    if (!IMAGE_EXT.has(ext)) return { error: `Unsupported file type: .${ext}` };
    const name = cleanName(a.name);
    if (!name) return { error: 'Every wallpaper needs a name' };
    const err = checkCollection(a.collection || undefined);
    if (err) return { error: err };
    const credit = cleanCredit(a.credit);
    const w = { hash, ext, name, ...(a.collection ? { collection: a.collection } : {}), size: uploads.get(hash), added: now, ...(credit ? { credit } : {}) };
    out.push(w);
    byHash.set(hash, w);
  }

  for (const w of out) if (w.collection && !colIds.has(w.collection)) return { error: `Collection ${w.collection} still has wallpapers` };
  // A cover set in this save must be valid; one left behind by a delete or move just falls back to the default.
  for (const c of cols) {
    if (!c.cover || byHash.get(c.cover)?.collection === c.id) continue;
    if (newCollections) return { error: `The cover of ${c.name} must be one of its wallpapers` };
    delete c.cover;
  }

  const parts = [['add', add], ['update', update], ['delete', del]].filter(([, a]) => a.length).map(([k, a]) => `${k} ${a.length}`);
  const message = 'Admin: ' + [parts.length && `${parts.join(', ')} wallpapers`, newCollections && 'collections'].filter(Boolean).join('; ');
  return { walls: out, collections: cols, message };
}
