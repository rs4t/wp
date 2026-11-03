// Serves the static build from dist/ on wp.egorz.com. The old egorz.com/wp
// address permanently redirects there, so previously shared links still work.
// /o/* streams original files from R2. /api/* is the download counter (stats.js)
// and the admin API (api.js).
import { handleApi } from './api.js';
import { handleStats } from './stats.js';

export { Stats } from './stats.js';

const HOME = 'https://wp.egorz.com';
const OLD_PREFIX = '/wp';

// Original files live in the WALLS R2 bucket as orig/<hash>; the filename in
// /o/<hash>/<file> is only for the download, so renames never touch R2.
async function original(request, env, pathname) {
  const m = pathname.match(/^\/o\/([0-9a-f]{10})\/[^/]+$/);
  if (!m || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
  const key = `orig/${m[1]}`;
  const obj = request.method === 'HEAD'
    ? await env.WALLS.head(key)
    : await env.WALLS.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (request.method === 'HEAD') return new Response(null, { headers: { ...Object.fromEntries(headers), 'Content-Length': String(obj.size) } });
  if (!('body' in obj)) return new Response(null, { status: 304, headers });
  if (request.headers.has('Range') && obj.range) {
    const { offset = 0, length = obj.size - offset } = obj.range;
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === OLD_PREFIX || url.pathname.startsWith(OLD_PREFIX + '/')) {
      const rest = url.pathname.slice(OLD_PREFIX.length) || '/';
      return Response.redirect(HOME + rest + url.search, 301);
    }

    if (url.pathname.startsWith('/o/')) return original(request, env, url.pathname);
    if (url.pathname.startsWith('/api/')) {
      // Public download counter first; everything else is the password-protected admin API.
      const stats = await handleStats(request, env, url.pathname);
      return stats || handleApi(request, env, url.pathname);
    }
    return env.ASSETS.fetch(request);
  },
};
