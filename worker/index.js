// Serves the static build from dist/ on wp.egorz.com, and the same files under
// egorz.com/wp/ by stripping the /wp prefix before looking up assets.
// /api/* is the admin API (see api.js).
import { handleApi } from './api.js';

const PREFIX = '/wp';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const prefixed = url.pathname === PREFIX || url.pathname.startsWith(PREFIX + '/');

    // Relative asset paths need the trailing slash: /wp -> /wp/
    if (url.pathname === PREFIX) {
      url.pathname = PREFIX + '/';
      return Response.redirect(url.href, 308);
    }
    if (prefixed) url.pathname = url.pathname.slice(PREFIX.length);

    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url.pathname);
    if (!prefixed) return env.ASSETS.fetch(request);

    const res = await env.ASSETS.fetch(new Request(url, request));

    // Asset-level redirects (e.g. /w/name -> /w/name/) must keep the prefix.
    const loc = res.headers.get('Location');
    if (loc && res.status >= 300 && res.status < 400) {
      const target = new URL(loc, url);
      if (target.origin === url.origin && !target.pathname.startsWith(PREFIX + '/')) {
        const headers = new Headers(res.headers);
        headers.set('Location', PREFIX + target.pathname + target.search);
        return new Response(null, { status: res.status, headers });
      }
    }
    return res;
  },
};
