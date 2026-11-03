// Slugs and redirects: every old link keeps working, no live page gets hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, assignSlugs, collectAliases, redirectsFor, redirectsFile } from '../scripts/site.mjs';

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
