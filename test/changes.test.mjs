// Admin edits to wallpapers.json / collections.json, as applied by the Worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, parseRepoJson } from '../worker/changes.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('parseRepoJson reads GitHub blob content (base64, with newlines)', () => {
  const content = b64('[{"name":"Café"}]').replace(/(.{8})/g, '$1\n');
  assert.deepEqual(parseRepoJson(content, 'wallpapers.json'), [{ name: 'Café' }]);
});

test('parseRepoJson refuses a broken file instead of treating it as empty', () => {
  assert.throws(() => parseRepoJson(b64('[{"hash": '), 'wallpapers.json'), /wallpapers\.json is not valid JSON/);
});

const walls = [
  { hash: 'aaaaaaaaaa', ext: 'jpg', name: 'Everest', collection: 'mountains', size: 10, added: 1 },
  { hash: 'bbbbbbbbbb', ext: 'png', name: 'Monstera', size: 20, added: 2 },
];
const collections = [{ id: 'mountains', name: 'Mountains' }, { id: 'grain', name: 'Grain' }];
const run = (body, uploads = new Map()) => applyChanges({ walls, collections, body, uploads, now: 99 });
const NEW = 'cccccccccc';

test('nothing to do is an error', () => {
  assert.ok(run({}).error);
});

test('add needs an uploaded hash', () => {
  assert.match(run({ add: [{ hash: NEW, ext: 'jpg', name: 'Sea' }] }).error, /upload/i);
  const r = run({ add: [{ hash: NEW, ext: 'jpg', name: '  Sea  ' }] }, new Map([[NEW, 42]]));
  assert.deepEqual(r.walls.at(-1), { hash: NEW, ext: 'jpg', name: 'Sea', size: 42, added: 99 });
});

test('add rejects a file that is already on the site', () => {
  assert.ok(run({ add: [{ hash: 'aaaaaaaaaa', ext: 'jpg', name: 'Again' }] }, new Map([['aaaaaaaaaa', 10]])).error);
});

test('add/update reject unknown collection', () => {
  assert.ok(run({ add: [{ hash: NEW, ext: 'jpg', name: 'Sea', collection: 'nope' }] }, new Map([[NEW, 1]])).error);
  assert.ok(run({ update: [{ hash: 'bbbbbbbbbb', collection: 'nope' }] }).error);
});

test('add into a collection created in the same save', () => {
  const r = run({ collections: [...collections, { id: 'sea', name: 'Sea' }], add: [{ hash: NEW, ext: 'jpg', name: 'Waves', collection: 'sea' }] }, new Map([[NEW, 1]]));
  assert.equal(r.walls.at(-1).collection, 'sea');
  assert.equal(r.collections.at(-1).id, 'sea');
});

test('update renames and clears collection with null', () => {
  const r = run({ update: [{ hash: 'aaaaaaaaaa', name: 'Ama Dablam', collection: null }] });
  assert.equal(r.walls[0].name, 'Ama Dablam');
  assert.equal('collection' in r.walls[0], false);
  assert.equal(walls[0].name, 'Everest', 'input is not mutated');
});

test('update sets and clears a credit', () => {
  const set = run({ update: [{ hash: 'bbbbbbbbbb', credit: { name: 'Bob', link: 'bob.com' } }] });
  assert.deepEqual(set.walls[1].credit, { name: 'Bob', link: 'https://bob.com/' });
  const cleared = applyChanges({ walls: set.walls, collections, body: { update: [{ hash: 'bbbbbbbbbb', credit: null }] }, uploads: new Map(), now: 1 });
  assert.equal('credit' in cleared.walls[1], false);
});

test('update rejects an empty name', () => {
  assert.ok(run({ update: [{ hash: 'aaaaaaaaaa', name: '   ' }] }).error);
});

test('delete removes by hash; unknown hash is an error', () => {
  assert.deepEqual(run({ delete: ['bbbbbbbbbb'] }).walls.map((w) => w.hash), ['aaaaaaaaaa']);
  assert.ok(run({ delete: ['ffffffffff'] }).error);
});

test('collections replacement keeps order', () => {
  const r = run({ collections: [{ id: 'grain', name: 'Grain' }, { id: 'mountains', name: 'Peaks', cover: 'aaaaaaaaaa' }] });
  assert.deepEqual(r.collections, [{ id: 'grain', name: 'Grain' }, { id: 'mountains', name: 'Peaks', cover: 'aaaaaaaaaa' }]);
});

test('collections replacement rejects removing an id still used', () => {
  assert.ok(run({ collections: [{ id: 'grain', name: 'Grain' }] }).error);
});

test('collections replacement rejects bad ids and duplicate ids', () => {
  assert.ok(run({ collections: [...collections, { id: 'Bad Id', name: 'x' }] }).error);
  assert.ok(run({ collections: [...collections, { id: 'grain', name: 'Again' }] }).error);
});

test('a cover must be a member of its collection', () => {
  assert.ok(run({ collections: [{ id: 'mountains', name: 'Mountains', cover: 'bbbbbbbbbb' }, collections[1]] }).error);
});

test('deleting or moving a cover wallpaper drops the cover', () => {
  const cols = [{ id: 'mountains', name: 'Mountains', cover: 'aaaaaaaaaa' }, collections[1]];
  const del = applyChanges({ walls, collections: cols, body: { delete: ['aaaaaaaaaa'] }, uploads: new Map(), now: 1 });
  assert.deepEqual(del.collections[0], { id: 'mountains', name: 'Mountains' });
  const moved = applyChanges({ walls, collections: cols, body: { update: [{ hash: 'aaaaaaaaaa', collection: 'grain' }] }, uploads: new Map(), now: 1 });
  assert.deepEqual(moved.collections[0], { id: 'mountains', name: 'Mountains' });
});

test('message summarises the save', () => {
  const r = run({ add: [{ hash: NEW, ext: 'jpg', name: 'Sea' }], update: [{ hash: 'aaaaaaaaaa', name: 'X' }, { hash: 'bbbbbbbbbb', name: 'Y' }], delete: [], collections }, new Map([[NEW, 1]]));
  assert.equal(r.message, 'Admin: add 1, update 2 wallpapers; collections');
});
