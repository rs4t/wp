// The data files the build and admin depend on stay consistent. No counts are
// pinned, so adding or removing wallpapers never breaks these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
const walls = load('wallpapers.json');
const collections = load('collections.json');
const legacy = load('legacy-ids.json');
const EXT = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff'];

test('every wallpaper is well-formed', () => {
  assert.ok(walls.length > 0);
  for (const w of walls) {
    assert.match(w.hash, /^[0-9a-f]{10}$/, JSON.stringify(w));
    assert.ok(EXT.includes(w.ext), `ext of ${w.hash}`);
    assert.ok(typeof w.name === 'string' && w.name.trim(), `name of ${w.hash}`);
    assert.ok(w.size > 0, `size of ${w.hash}`);
    assert.equal(typeof w.added, 'number', `added of ${w.hash}`);
    if (w.credit) assert.ok(w.credit.name?.trim(), `credit of ${w.name}`);
  }
});

test('hashes are unique', () => {
  assert.equal(new Set(walls.map((w) => w.hash)).size, walls.length);
});

test('collection ids are valid and unique', () => {
  for (const c of collections) assert.match(c.id, /^[a-z0-9-]{1,40}$/);
  assert.equal(new Set(collections.map((c) => c.id)).size, collections.length);
});

test('every collection reference exists', () => {
  const ids = new Set(collections.map((c) => c.id));
  for (const w of walls) if (w.collection !== undefined) assert.ok(ids.has(w.collection), `${w.name}: ${w.collection}`);
});

test('every cover is a member of its collection', () => {
  for (const c of collections) {
    if (!c.cover) continue;
    assert.equal(walls.find((w) => w.hash === c.cover)?.collection, c.id, `cover of ${c.id}`);
  }
});

test('legacy ids map old links to hashes', () => {
  for (const [id, h] of Object.entries(legacy)) {
    assert.match(id, /^[a-z0-9-]+$/);
    assert.match(h, /^[0-9a-f]{10}$/, id);
  }
});
