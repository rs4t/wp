// End-to-end test of the admin API and /o/ downloads against a local Worker.
// 1. node test/support/mock-github.mjs wallpapers.json collections.json
// 2. npx wrangler dev --var ADMIN_PASSWORD:test --var GITHUB_TOKEN:x --var GITHUB_API:http://localhost:9999
// 3. node test/admin.e2e.mjs
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const B = 'http://localhost:8787', GH = 'http://localhost:9999';
const file = async (p) => JSON.parse(await (await fetch(`${GH}/_file?path=${p}`)).text());

const login = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'X-WP-Admin': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test' }) });
assert.equal(login.status, 200, 'login');
const H = { 'X-WP-Admin': '1', Cookie: login.headers.get('set-cookie').split(';')[0] };
const api = async (path, body, expect = true) => {
  const r = await fetch(`${B}/api/${path}`, { method: body ? 'POST' : 'GET', headers: { ...H, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json();
  assert.equal(r.ok, expect, `${path}: ${j.error}`);
  return j;
};

const img = await sharp({ create: { width: 64, height: 40, channels: 3, background: '#c33' } }).jpeg().toBuffer();
const sha1 = crypto.createHash('sha1').update(img).digest('hex');
const put = (s) => fetch(`${B}/api/upload?sha1=${s}`, { method: 'PUT', headers: { ...H, 'Content-Type': 'image/jpeg' }, body: img });
assert.equal((await put('0'.repeat(40))).status, 400, 'wrong checksum is rejected');
const { hash } = await (await put(sha1)).json();
assert.equal(hash, sha1.slice(0, 10));

const before = await file('wallpapers.json');
const cols = await file('collections.json');
await api('commit', { collections: [...cols, { id: 'test-set', name: 'Test Set' }], add: [{ hash, ext: 'jpg', name: 'Red Test', collection: 'test-set', credit: { name: 'Bob', link: 'bob.com' } }] });
let w = (await file('wallpapers.json')).find((x) => x.hash === hash);
assert.deepEqual([w.name, w.collection, w.size, w.credit.link], ['Red Test', 'test-set', img.length, 'https://bob.com/']);
assert.equal((await file('collections.json')).at(-1).id, 'test-set');

const o = await fetch(`${B}/o/${hash}/red-test.jpg`);
assert.equal(o.status, 200);
assert.ok(Buffer.from(await o.arrayBuffer()).equals(img), 'original bytes match');
const ranged = await fetch(`${B}/o/${hash}/x.jpg`, { headers: { Range: 'bytes=0-9' } });
assert.equal(ranged.status, 206);
assert.equal((await ranged.arrayBuffer()).byteLength, 10);

await api('commit', { update: [{ hash, name: 'Renamed', collection: null, credit: null }] }, true);
w = (await file('wallpapers.json')).find((x) => x.hash === hash);
assert.deepEqual([w.name, 'collection' in w, 'credit' in w], ['Renamed', false, false]);

await api('commit', { update: [{ hash, collection: 'test-set' }] });
const reordered = [{ id: 'test-set', name: 'Test Set', cover: hash }, ...cols];
await api('commit', { collections: reordered });
assert.deepEqual((await file('collections.json'))[0], { id: 'test-set', name: 'Test Set', cover: hash });

const list = await api('list');
assert.ok(list.files.some((f) => f.hash === hash) && list.collections[0].id === 'test-set');

await api('commit', { collections: cols }, false); // still has a wallpaper
await api('commit', { delete: [hash] });
await api('commit', { collections: cols });
assert.equal((await file('wallpapers.json')).length, before.length, 'delete removes the entry');

let limited = false;
for (let i = 0; i < 7 && !limited; i++) {
  const r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'X-WP-Admin': '1' }, body: JSON.stringify({ password: 'nope' }) });
  limited = r.status === 429;
}
assert.ok(limited, 'login gets rate limited');
console.log('ALL PASS');
