// Slugs and redirects: every old link keeps working, no live page gets hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, assignSlugs, collectAliases, redirectsFor, redirectsFile, withRetry, loadJson, fetchPrevious, markNew, orderCollections, creatorsOf, fill } from '../scripts/site.mjs';

const DAY = 864e5;

test('markNew: only the newest few recent wallpapers get the badge', () => {
  const now = 100 * DAY;
  const items = [{ added: 0 }, ...Array.from({ length: 20 }, (_, i) => ({ added: now - i * 3600e3 }))];
  markNew(items, now, { days: 14, max: 12 });
  assert.equal(items.filter((i) => i.new).length, 12);
  assert.ok(items[1].new && !items[20].new, 'the newest ones win');
  assert.equal(items[0].new, false);
});

test('markNew: nothing is new on a brand-new site', () => {
  const items = Array.from({ length: 5 }, () => ({ added: 10 * DAY }));
  markNew(items, 10 * DAY, { days: 14, max: 12 });
  assert.ok(items.every((i) => !i.new));
});

test('orderCollections: most recently updated first, ties keep their order', () => {
  const cols = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const items = [{ coll: 'a', added: 1 }, { coll: 'b', added: 5 }, { coll: 'c', added: 1 }, { coll: 'a', added: 2 }];
  assert.deepEqual(orderCollections(cols, items).map((c) => c.id), ['b', 'a', 'c']);
});

test('creatorsOf: one entry per credited name, most work first', () => {
  const items = [
    { credit: { name: 'alexandr' }, added: 1, hash: 'x1' }, { credit: { name: 'Ryku', link: 'https://r.k/' }, added: 2, hash: 'y1' },
    { credit: { name: 'alexandr' }, added: 3, hash: 'x2' }, {},
  ];
  assert.deepEqual(creatorsOf(items), [
    { id: 'alexandr', name: 'alexandr', count: 2, cover: 'x2' },
    { id: 'ryku', name: 'Ryku', count: 1, cover: 'y1', link: 'https://r.k/' },
  ]);
});

test('fill: values with $ are inserted literally', () => {
  assert.equal(fill('<t>{{title}}</t><b>x</b>', { title: "A $' $& B" }), "<t>A $' $& B</t><b>x</b>");
});
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'wp-test-'));
const file = (name, text) => { const p = path.join(tmp, name); writeFileSync(p, text); return p; };

test('loadJson: a broken file fails instead of becoming empty', async () => {
  await assert.rejects(loadJson(file('bad.json', '[{"hash": '), []), /bad\.json/);
});

test('loadJson: a required file that is missing fails', async () => {
  await assert.rejects(loadJson(path.join(tmp, 'nope.json')), /nope\.json/);
});

test('loadJson: an optional missing file uses the fallback', async () => {
  assert.deepEqual(await loadJson(path.join(tmp, 'nope.json'), []), []);
  assert.deepEqual(await loadJson(file('ok.json', '[1]'), []), [1]);
});

const res = (status, body) => ({ ok: status < 300, status, json: async () => body });

test('fetchPrevious: no site yet (404) means no previous deploy', async () => {
  assert.equal(await fetchPrevious('u', async () => res(404), 0), null);
});

test('fetchPrevious: a site that does not answer fails the build', async () => {
  let n = 0;
  await assert.rejects(fetchPrevious('u', async () => { n++; return res(503); }, 0), /503/);
  assert.equal(n, 3, 'retried');
  await assert.rejects(fetchPrevious('u', async () => { throw new Error('fetch failed'); }, 0), /fetch failed/);
});

test('fetchPrevious: returns the manifest', async () => {
  assert.deepEqual(await fetchPrevious('u', async () => res(200, { items: [] }), 0), { items: [] });
});

test('withRetry gets through passing failures', async () => {
  let n = 0;
  assert.equal(await withRetry(async () => { if (++n < 3) throw new Error('blip'); return 'ok'; }, 3, 0), 'ok');
  assert.equal(n, 3);
});

test('withRetry gives up after the last try', async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw new Error('down'); }, 3, 0), /down/);
  assert.equal(n, 3);
});

test('slugify keeps the old rules', () => {
  assert.equal(slugify('Canmore, Alberta'), 'canmore-alberta');
  assert.equal(slugify("Egor's Café"), 'egors-cafe');
  assert.equal(slugify('!!!'), 'wallpaper');
});

test('assignSlugs gives duplicates -2 by age', () => {
  const s = assignSlugs([{ hash: 'b', name: 'Sea', added: 2 }, { hash: 'a', name: 'Sea', added: 1 }]);
  assert.equal(s.get('a'), 'sea');
  assert.equal(s.get('b'), 'sea-2');
});

test('collectAliases merges legacy, previous aliases and previous slugs', () => {
  const a = collectAliases({ legacy: { 'mountains-3': 'h1' }, prevAliases: { x: 'h2' }, prevItems: [{ id: 'crimson', hash: 'h1' }] });
  assert.deepEqual(a, { 'mountains-3': 'h1', x: 'h2', crimson: 'h1' });
});

test('renamed twice still redirects', () => {
  assert.deepEqual(redirectsFor({ x: 'h1', y: 'h1' }, new Map([['h1', 'z']])), { x: 'z', y: 'z' });
});

test('never redirects a live slug', () => {
  assert.deepEqual(redirectsFor({ sea: 'h1' }, new Map([['h1', 'ocean'], ['h2', 'sea']])), {});
});

test('drops deleted wallpapers and unchanged slugs', () => {
  assert.deepEqual(redirectsFor({ old: 'gone', same: 'h1' }, new Map([['h1', 'same']])), {});
});

test('redirectsFile has both slash forms and community', () => {
  const f = redirectsFile({ a: 'b' });
  assert.ok(f.includes('/w/a /w/b/ 301'));
  assert.ok(f.includes('/w/a/ /w/b/ 301'));
  assert.ok(f.includes('/community / 301'));
  assert.ok(f.includes('/community/* / 301'));
});
