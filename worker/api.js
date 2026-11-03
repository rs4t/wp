import { handleInbox } from './inbox.js';

// Admin API: password login, list wallpapers, stream uploads to R2, and
// commit adds / moves / deletes to wallpapers.json as one commit (one commit = one rebuild).
//
// Secrets (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   ADMIN_PASSWORD  shared admin password
//   GITHUB_TOKEN    fine-grained token with Contents: read & write on the repo
// Vars (wrangler.jsonc): GITHUB_REPO, GITHUB_BRANCH; GITHUB_API only for local testing

const ROOT_DIR = 'wallpapers';
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff']);
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

// "wallpapers/<category>/<name>.<ext>" → its parts.
function splitPath(p) {
  const rel = p.slice(ROOT_DIR.length + 1).split('/');
  return { category: rel.length > 1 ? rel[0] : '', name: rel[rel.length - 1] };
}

// ---------- validation ----------

const ext = (p) => (p.match(/\.([^./]+)$/)?.[1] || '').toLowerCase();

function cleanCategory(c) {
  const v = String(c || '').trim().toLowerCase().replace(/[^a-z0-9 _-]+/g, '').replace(/\s+/g, '-').slice(0, 40);
  return v.replace(/^[-_]+|[-_]+$/g, '');
}

function cleanName(n) {
  return String(n || '').normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 100);
}

const pathFor = (category, name, extension) => `${ROOT_DIR}/${category ? category + '/' : ''}${name}.${extension}`;

function uniquePath(category, name, extension, taken) {
  let p = pathFor(category, name, extension);
  for (let n = 2; taken.has(p.toLowerCase()); n++) p = pathFor(category, `${name} ${n}`, extension);
  taken.add(p.toLowerCase());
  return p;
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

// [{ path: "wallpapers/<category>/<name>.<ext>", hash, size, added, credit? }]
const LIST = 'wallpapers.json';
const SETUPS = 'community/setups.json';

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

function cleanCredit(c) {
  if (!c) return null;
  const name = String(c.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60);
  if (!name) return null;
  let link = String(c.link || '').trim().slice(0, 300);
  if (link && !/^https?:\/\//i.test(link)) link = 'https://' + link;
  try { if (link) link = new URL(link).href; } catch { link = ''; }
  return link ? { name, link } : { name };
}

// Applies every kind of change as one commit:
//   add      new wallpapers (optional credit)    move     move / rename (credits follow)
//   delete   remove wallpapers (and credits)     credit   set / clear credits on wallpapers
//   setups   publish community setups            unsetup  remove community setups
async function commit(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return fail(400, 'Bad request');
  const list = (k) => (Array.isArray(body[k]) ? body[k] : []);
  const add = list('add'), del = list('delete'), move = list('move'), credit = list('credit'), setups = list('setups'), unsetup = list('unsetup');
  const total = add.length + del.length + move.length + credit.length + setups.length + unsetup.length;
  if (!total) return fail(400, 'Nothing to do');
  if (total > 300) return fail(400, 'Too many changes at once');

  // Retry if someone else pushed between reading and updating the branch.
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await headCommit(env);
    const fullTree = (await ghJson(env, `/git/trees/${head.tree}?recursive=1`)).tree;
    const walls = await readJsonFile(env, fullTree, LIST, []);
    const byPath = new Map(walls.map((w) => [w.path, w]));
    const taken = new Set(walls.map((w) => w.path.toLowerCase()));
    const tree = [];
    const added = [];
    const setupList = setups.length || unsetup.length ? await readJsonFile(env, fullTree, SETUPS, []) : null;
    // Originals stay in R2 when a wallpaper is deleted, so reverting the commit brings it back.
    const gone = new Set(del.map((p) => byPath.get(p)));
    let changed = del.length > 0;
    const uploaded = async (hash) => /^[0-9a-f]{10}$/.test(hash || '') && (await env.WALLS.head(`orig/${hash}`));

    for (const p of [...del, ...move.map((m) => m.from), ...credit.map((c) => c.path)]) {
      if (!byPath.has(p)) return fail(400, `Not found: ${p}`);
    }
    for (const p of del) taken.delete(p.toLowerCase());
    for (const m of move) {
      const w = byPath.get(m.from);
      const from = splitPath(w.path);
      const category = m.category === undefined ? from.category : cleanCategory(m.category);
      const oldStem = from.name.replace(/\.[^.]+$/, '');
      const stem = m.name === undefined ? oldStem : cleanName(m.name);
      if (!stem) return fail(400, 'Every wallpaper needs a name');
      if (from.category === category && stem === oldStem) continue;
      taken.delete(w.path.toLowerCase());
      w.path = uniquePath(category, stem, ext(w.path), taken);
      changed = true;
    }
    for (const a of add) {
      const extension = ext(`x.${a.ext || ''}`);
      const name = cleanName(a.name);
      const obj = await uploaded(a.hash);
      if (!obj) return fail(400, 'Upload not found — please upload again');
      if (!IMAGE_EXT.has(extension)) return fail(400, `Unsupported file type: .${a.ext}`);
      if (!name) return fail(400, 'Every wallpaper needs a name');
      const p = uniquePath(cleanCategory(a.category), name, extension, taken);
      const c = cleanCredit(a.credit);
      walls.push({ path: p, hash: a.hash, size: obj.size, added: Date.now(), ...(c ? { credit: c } : {}) });
      added.push(p);
      changed = true;
    }
    for (const c of credit) {
      const w = byPath.get(c.path), v = cleanCredit(c);
      if (v) w.credit = v; else delete w.credit;
      changed = true;
    }
    for (const st of setups) {
      if (!(await uploaded(st.hash))) return fail(400, 'Upload not found — please upload again');
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
      const who = cleanCredit({ name: st.name, link: st.link }) || { name: 'anonymous' };
      setupList.push({
        id, hash: st.hash, ...who,
        caption: String(st.caption || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200),
        wallpapers: (Array.isArray(st.wallpapers) ? st.wallpapers : []).filter((h) => /^[0-9a-f]{10}$/.test(h)).slice(0, 5),
        added: Date.now(),
      });
    }
    for (const id of unsetup) {
      const i = setupList.findIndex((x) => x.id === id);
      if (i < 0) return fail(400, `Setup not found: ${id}`);
      setupList.splice(i, 1);
    }
    if (changed) tree.push({ path: LIST, mode: '100644', type: 'blob', sha: await jsonBlob(env, walls.filter((w) => !gone.has(w))) });
    if (setupList && (setups.length || unsetup.length)) tree.push({ path: SETUPS, mode: '100644', type: 'blob', sha: await jsonBlob(env, setupList) });
    if (!tree.length) return json({ ok: true, noop: true });

    const parts = [];
    const n = (k, arr) => arr.length && parts.push(`${k} ${arr.length}`);
    n('add', add);
    const renames = move.filter((m) => m.name !== undefined);
    n('rename', renames); n('move', move.filter((m) => m.name === undefined)); n('delete', del); n('credit', credit);
    const what = parts.length ? `${parts.join(', ')} wallpaper${add.length + move.length + del.length + credit.length === 1 ? '' : 's'}` : '';
    const comm = [setups.length && `publish ${setups.length} setup${setups.length === 1 ? '' : 's'}`, unsetup.length && `remove ${unsetup.length} setup${unsetup.length === 1 ? '' : 's'}`].filter(Boolean).join(', ');
    const message = `Admin: ${[what, comm].filter(Boolean).join('; ')}`;

    const newTree = await ghJson(env, '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree, tree }) });
    const newCommit = await ghJson(env, '/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [head.sha] }) });
    const res = await gh(env, `/git/refs/heads/${env.GITHUB_BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false }) });
    if (res.ok) return json({ ok: true, commit: newCommit.sha, url: `https://github.com/${env.GITHUB_REPO}/commit/${newCommit.sha}`, added });
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
      const files = (await readJsonFile(env, tree, LIST, [])).map((w) => ({ path: w.path, hash: w.hash, size: w.size, ...splitPath(w.path) }));
      return json({ head: head.sha, files });
    }
    if (route === 'PUT /api/upload') return await uploadOriginal(request, env, new URL(request.url));
    if (route === 'POST /api/commit') return await commit(request, env);
    if (pathname.startsWith('/api/inbox')) return (await handleInbox(request, env, pathname)) || fail(404, 'Not found');
    return fail(404, 'Not found');
  } catch (err) {
    const status = err.status === 401 || err.status === 403 ? 502 : 500;
    const hint = err.status === 401 || err.status === 403 || err.status === 404 ? ' (check the GITHUB_TOKEN secret and its repo access)' : '';
    return fail(status, `${err.message}${hint}`);
  }
}
