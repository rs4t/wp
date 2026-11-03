// The gallery's forgiving search.
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../src/search.js');
const { rank } = globalThis.wpSearch;

const items = [
  { name: 'Fractal Maze 17', coll: 'fractal-maze', collName: 'Fractal Maze', colors: ['purple'] },
  { name: 'Fractal Maze 07', coll: 'fractal-maze', collName: 'Fractal Maze', colors: ['purple'] },
  { name: 'Everest', coll: 'mountains', collName: 'Mountains', colors: ['blue', 'dark'] },
];
const names = (q) => rank(items, q).map((i) => i.name);

test('numbers ignore leading zeros', () => {
  assert.equal(names('fractal maze 7')[0], 'Fractal Maze 07');
});

test('one typo per word is forgiven', () => {
  assert.equal(names('fractl maze 7')[0], 'Fractal Maze 07');
});

test('collection names match', () => {
  assert.deepEqual(names('mountains'), ['Everest']);
});

test('color words match', () => {
  assert.deepEqual(names('blue'), ['Everest']);
});

test('no match is empty', () => {
  assert.deepEqual(names('zzz'), []);
});

test('empty query keeps everything in order', () => {
  assert.deepEqual(names('  '), items.map((i) => i.name));
});
