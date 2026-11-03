// Checks the built site in dist/ (run `npm run build` first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const dist = (p) => new URL(`../dist/${p}`, import.meta.url);
const built = existsSync(dist('manifest.json'));
const opts = { skip: built ? false : 'dist/ missing — run npm run build' };
const m = built ? JSON.parse(readFileSync(dist('manifest.json'), 'utf8')) : null;

test('manifest has every wallpaper', opts, () => {
  assert.equal(m.items.length, 145);
  assert.ok(!('setups' in m) && !('categories' in m));
});

test('collection and wallpaper pages exist', opts, () => {
  assert.ok(existsSync(dist('c/mountains/index.html')));
  assert.ok(existsSync(dist('w/everest/index.html')));
  assert.ok(!existsSync(dist('community')));
  assert.match(readFileSync(dist('c/mountains/index.html'), 'utf8'), /data-collection="mountains"/);
});

test('old links redirect', opts, () => {
  const r = readFileSync(dist('_redirects'), 'utf8');
  assert.match(r, /^\/w\/mountains-3\/ \/w\/crimson-ridge\/ 301$/m);
  assert.match(r, /^\/w\/firey-vivid-1\/ \/w\/fiery-vivid-1\/ 301$/m);
});

test('every item points at a real collection', opts, () => {
  const ids = new Set(m.collections.map((c) => c.id));
  for (const it of m.items) assert.ok(it.coll === null || ids.has(it.coll), it.id);
  assert.equal(m.collections.find((c) => c.id === 'mountains').count, m.items.filter((i) => i.coll === 'mountains').length);
});

test('downloads are named after the slug', opts, () => {
  const it = m.items.find((i) => i.id === 'everest');
  assert.equal(it.o, `o/${it.hash}/everest.jpg`);
});
