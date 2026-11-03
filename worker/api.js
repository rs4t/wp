import { applyChanges } from './changes.js';

// Admin API: password login, list wallpapers, stream uploads to R2, and
// commit edits to wallpapers.json + collections.json as one commit (one commit = one rebuild).
//
// Secrets (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   ADMIN_PASSWORD  shared admin password
//   GITHUB_TOKEN    fine-grained token with Contents: read & write on the repo
// Vars (wrangler.jsonc): GITHUB_REPO, GITHUB_BRANCH; GITHUB_API only for local testing

const MAX_UPLOAD = 50 * 1024 * 1024;
const SESSION_DAYS = 30;
const COOKIE = 'wp_admin';

const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const fail = (status, error) => json({ error }, status);

// ---------- auth ----------

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
}

async function safeEqual(a, b) {
  // Hash first so lengths match; timingSafeEqual needs equal-length inputs.
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}

async function makeSession(env) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return `${exp}.${await hmac(env.ADMIN_PASSWORD, `session:${exp}`)}`;
}

async function isAuthed(request, env) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(env.ADMIN_PASSWORD, `session:${exp}`));
}

const cookie = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

// ---------- GitHub ----------

function gh(env, path, init = {}) {
  return fetch(`${env.GITHUB_API || 'https://api.github.com'}/repos/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'egorz-wp-admin',
      ...(init.headers || {}),
    },
  });
}

async function ghJson(env, path, init) {
  const res = await gh(env, path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `GitHub ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function headCommit(env) {
  const ref = await ghJson(env, `/git/ref/heads/${env.GITHUB_BRANCH}`);
  const commit = await ghJson(env, `/git/commits/${ref.object.sha}`);
  return { sha: ref.object.sha, tree: commit.tree.sha };
}


// ---------- handlers ----------

async function login(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (env.LOGIN_LIMIT && !(await env.LOGIN_LIMIT.limit({ key: ip })).success) return fail(429, 'Too many tries — wait a minute');
  const { password } = await request.json().catch(() => ({}));
  if (typeof password === 'string' && (await safeEqual(password, env.ADMIN_PASSWORD))) {
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(await makeSession(env), SESSION_DAYS * 86400) });
  }
  await new Promise((r) => setTimeout(r, 1200)); // slow down guessing
  return fail(401, 'Wrong password');
}

// The raw file streams straight into R2 as orig/<hash>. R2 checks the SHA-1 the
// browser computed, so the hash (= the site's wallpaper id) is guaranteed right.
async function uploadOriginal(request, env, url) {
  const sha1 = url.searchParams.get('sha1') || '';
  if (!/^[0-9a-f]{40}$/.test(sha1)) return fail(400, 'Bad checksum');
  const len = Number(request.headers.get('Content-Length'));
  if (!len || !request.body) return fail(411, 'Missing Content-Length');
  if (len > MAX_UPLOAD) return fail(413, `File too large (max ${MAX_UPLOAD / 1048576} MB)`);
  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
  try { await env.WALLS.put(`orig/${sha1.slice(0, 10)}`, request.body, { sha1, httpMetadata: { contentType } }); }
  catch { return fail(400, 'The upload arrived damaged — please try again'); }
  return json({ hash: sha1.slice(0, 10) });
}

// ---------- the two data files ----------

const LIST = 'wallpapers.json';
const COLLECTIONS = 'collections.json';

async function readJsonFile(env, tree, path, fallback) {
  const entry = tree.find((e) => e.path === path && e.type === 'blob');
  if (!entry) return fallback;
  const blob = await ghJson(env, `/git/blobs/${entry.sha}`);
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(blob.content.replace(/\s/g, '')), (c) => c.charCodeAt(0)))); }
  catch { return fallback; }
}

async function jsonBlob(env, data) {
  const blob = await ghJson(env, '/git/blobs', { method: 'POST', body: JSON.stringify({ content: JSON.stringify(data, null, 2) + '\n', encoding: 'utf-8' }) });
  return blob.sha;
}

// One admin save = one commit (= one rebuild). The change rules live in changes.js.
async function commit(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return fail(400, 'Bad request');
  // Sizes of the newly uploaded files, straight from R2.
  const uploads = new Map();
  for (const a of Array.isArray(body.add) ? body.add : []) {
    const obj = /^[0-9a-f]{10}$/.test(a?.hash || '') && (await env.WALLS.head(`orig/${a.hash}`));
    if (obj) uploads.set(a.hash, obj.size);
  }

  // Retry if someone else pushed between reading and updating the branch.
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await headCommit(env);
    const tree = (await ghJson(env, `/git/trees/${head.tree}`)).tree;
    const walls = await readJsonFile(env, tree, LIST, []);
    const collections = await readJsonFile(env, tree, COLLECTIONS, []);
    const r = applyChanges({ walls, collections, body, uploads, now: Date.now() });
    if (r.error) return fail(400, r.error);

    const files = [];
    if (JSON.stringify(r.walls) !== JSON.stringify(walls)) files.push({ path: LIST, mode: '100644', type: 'blob', sha: await jsonBlob(env, r.walls) });
    if (JSON.stringify(r.collections) !== JSON.stringify(collections)) files.push({ path: COLLECTIONS, mode: '100644', type: 'blob', sha: await jsonBlob(env, r.collections) });
    if (!files.length) return json({ ok: true, noop: true });

    const newTree = await ghJson(env, '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree, tree: files }) });
    const newCommit = await ghJson(env, '/git/commits', { method: 'POST', body: JSON.stringify({ message: r.message, tree: newTree.sha, parents: [head.sha] }) });
    const res = await gh(env, `/git/refs/heads/${env.GITHUB_BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false }) });
    if (res.ok) return json({ ok: true, commit: newCommit.sha, url: `https://github.com/${env.GITHUB_REPO}/commit/${newCommit.sha}` });
    if (res.status !== 422 && res.status !== 409) {
      const b = await res.json().catch(() => ({}));
      return fail(502, b.message || `GitHub ${res.status}`);
    }
  }
  return fail(409, 'The repo changed while saving — please try again');
}

export async function handleApi(request, env, pathname) {
  if (!env.ADMIN_PASSWORD || !env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return fail(503, 'Admin is not configured: set the ADMIN_PASSWORD and GITHUB_TOKEN secrets on the Worker');
  }
  const route = `${request.method} ${pathname}`;
  // State-changing requests must come from our own page (SameSite cookie + custom header).
  if (request.method !== 'GET' && request.headers.get('X-WP-Admin') !== '1') return fail(403, 'Forbidden');

  try {
    if (route === 'POST /api/login') return await login(request, env);
    if (route === 'POST /api/logout') return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
    if (!(await isAuthed(request, env))) return fail(401, 'Not logged in');

    if (route === 'GET /api/session') return json({ ok: true, repo: env.GITHUB_REPO, branch: env.GITHUB_BRANCH });
    if (route === 'GET /api/list') {
      const head = await headCommit(env);
      const tree = (await ghJson(env, `/git/trees/${head.tree}`)).tree;
      return json({ head: head.sha, files: await readJsonFile(env, tree, LIST, []), collections: await readJsonFile(env, tree, COLLECTIONS, []) });
    }
    if (route === 'PUT /api/upload') return await uploadOriginal(request, env, new URL(request.url));
    if (route === 'POST /api/commit') return await commit(request, env);
    return fail(404, 'Not found');
  } catch (err) {
    const status = err.status === 401 || err.status === 403 ? 502 : 500;
    const hint = err.status === 401 || err.status === 403 || err.status === 404 ? ' (check the GITHUB_TOKEN secret and its repo access)' : '';
    return fail(status, `${err.message}${hint}`);
  }
}
