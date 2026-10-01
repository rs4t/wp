import { handleInbox } from './inbox.js';

// Admin API: password login, list wallpapers, stream uploads to GitHub, and
// commit adds / moves / deletes as a single commit (one commit = one rebuild).
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

function wallpapersIn(tree) {
  return tree
    .filter((e) => e.type === 'blob' && e.path.startsWith(ROOT_DIR + '/') && IMAGE_EXT.has(ext(e.path)))
    .map((e) => {
      const rel = e.path.slice(ROOT_DIR.length + 1).split('/');
      return { path: e.path, sha: e.sha, size: e.size, category: rel.length > 1 ? rel[0] : '', name: rel[rel.length - 1] };
    });
}

async function listWallpapers(env, treeSha) {
  return wallpapersIn((await ghJson(env, `/git/trees/${treeSha}?recursive=1`)).tree);
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
  const { password } = await request.json().catch(() => ({}));
  if (typeof password === 'string' && (await safeEqual(password, env.ADMIN_PASSWORD))) {
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(await makeSession(env), SESSION_DAYS * 86400) });
  }
  await new Promise((r) => setTimeout(r, 1200)); // slow down guessing
  return fail(401, 'Wrong password');
}

// Body is raw base64 text; wrap it into GitHub's blob JSON while streaming,
// so large wallpapers never have to fit in Worker memory.
async function uploadBlob(request, env) {
  const len = Number(request.headers.get('Content-Length'));
  if (!len || !request.body) return fail(411, 'Missing Content-Length');
  if (len > Math.ceil(MAX_UPLOAD / 3) * 4 + 8) return fail(413, `File too large (max ${MAX_UPLOAD / 1048576} MB)`);

  const head = enc.encode('{"encoding":"base64","content":"');
  const tail = enc.encode('"}');
  const { readable, writable } = new FixedLengthStream(head.length + len + tail.length);
  // Native pipe: the bytes never pass through JS, so this costs almost no CPU time.
  const pump = (async () => {
    let w = writable.getWriter();
    await w.write(head);
    w.releaseLock();
    await request.body.pipeTo(writable, { preventClose: true });
    w = writable.getWriter();
    await w.write(tail);
    await w.close();
  })();
  const [res] = await Promise.all([
    gh(env, '/git/blobs', { method: 'POST', body: readable, headers: { 'Content-Type': 'application/json' } }),
    pump,
  ]);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return fail(502, body.message || `GitHub ${res.status}`);
  return json({ sha: body.sha });
}

const CREDITS = `${ROOT_DIR}/credits.json`;
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
    const existing = wallpapersIn(fullTree);
    const byPath = new Map(existing.map((e) => [e.path, e]));
    const taken = new Set(existing.map((e) => e.path.toLowerCase()));
    const tree = [];
    const added = [];
    const needCredits = add.length || del.length || move.length || credit.length;
    const credits = needCredits ? await readJsonFile(env, fullTree, CREDITS, {}) : null;
    const setupList = setups.length || unsetup.length ? await readJsonFile(env, fullTree, SETUPS, []) : null;
    let creditsChanged = false;

    for (const p of [...del, ...move.map((m) => m.from), ...credit.map((c) => c.path)]) {
      if (!byPath.has(p)) return fail(400, `Not found: ${p}`);
    }
    for (const p of del) {
      tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
      taken.delete(p.toLowerCase());
      if (credits[p]) { delete credits[p]; creditsChanged = true; }
    }
    for (const m of move) {
      const from = byPath.get(m.from);
      const category = m.category === undefined ? from.category : cleanCategory(m.category);
      const oldStem = from.name.replace(/\.[^.]+$/, '');
      const stem = m.name === undefined ? oldStem : cleanName(m.name);
      if (!stem) return fail(400, 'Every wallpaper needs a name');
      if (from.category === category && stem === oldStem) continue;
      taken.delete(from.path.toLowerCase());
      const to = uniquePath(category, stem, ext(from.path), taken);
      tree.push({ path: from.path, mode: '100644', type: 'blob', sha: null });
      tree.push({ path: to, mode: '100644', type: 'blob', sha: from.sha });
      if (credits[from.path]) { credits[to] = credits[from.path]; delete credits[from.path]; creditsChanged = true; }
    }
    for (const a of add) {
      const extension = ext(`x.${a.ext || ''}`);
      const name = cleanName(a.name);
      if (!/^[0-9a-f]{40}$/.test(a.sha || '')) return fail(400, 'Bad upload reference');
      if (!IMAGE_EXT.has(extension)) return fail(400, `Unsupported file type: .${a.ext}`);
      if (!name) return fail(400, 'Every wallpaper needs a name');
      const p = uniquePath(cleanCategory(a.category), name, extension, taken);
      tree.push({ path: p, mode: '100644', type: 'blob', sha: a.sha });
      added.push(p);
      const c = cleanCredit(a.credit);
      if (c) { credits[p] = c; creditsChanged = true; }
    }
    for (const c of credit) {
      const v = cleanCredit(c);
      if (v) credits[c.path] = v; else delete credits[c.path];
      creditsChanged = true;
    }
    for (const st of setups) {
      if (!/^[0-9a-f]{40}$/.test(st.sha || '')) return fail(400, 'Bad upload reference');
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
      const image = `community/setups/${id}.jpg`;
      tree.push({ path: image, mode: '100644', type: 'blob', sha: st.sha });
      const who = cleanCredit({ name: st.name, link: st.link }) || { name: 'anonymous' };
      setupList.push({
        id, image, ...who,
        caption: String(st.caption || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200),
        wallpapers: (Array.isArray(st.wallpapers) ? st.wallpapers : []).filter((h) => /^[0-9a-f]{10}$/.test(h)).slice(0, 5),
        added: Date.now(),
      });
    }
    for (const id of unsetup) {
      const i = setupList.findIndex((x) => x.id === id);
      if (i < 0) return fail(400, `Setup not found: ${id}`);
      tree.push({ path: setupList[i].image, mode: '100644', type: 'blob', sha: null });
      setupList.splice(i, 1);
    }
    if (creditsChanged) tree.push({ path: CREDITS, mode: '100644', type: 'blob', sha: await jsonBlob(env, credits) });
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
      const files = await listWallpapers(env, head.tree);
      return json({ head: head.sha, files });
    }
    if (route === 'POST /api/blob') return await uploadBlob(request, env);
    if (route === 'POST /api/commit') return await commit(request, env);
    if (pathname.startsWith('/api/inbox')) return (await handleInbox(request, env, pathname)) || fail(404, 'Not found');
    return fail(404, 'Not found');
  } catch (err) {
    const status = err.status === 401 || err.status === 403 ? 502 : 500;
    const hint = err.status === 401 || err.status === 403 || err.status === 404 ? ' (check the GITHUB_TOKEN secret and its repo access)' : '';
    return fail(status, `${err.message}${hint}`);
  }
}
