// Serves the static build from dist/ on wp.egorz.com. The old egorz.com/wp
// address permanently redirects there, so previously shared links still work.
// /api/* is the download counter (stats.js), community submissions (inbox.js)
// and the admin API (api.js).
import { handleApi } from './api.js';
import { handleStats } from './stats.js';
import { handleSubmit } from './inbox.js';

export { Stats } from './stats.js';
export { Inbox } from './inbox.js';

const HOME = 'https://wp.egorz.com';
const OLD_PREFIX = '/wp';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === OLD_PREFIX || url.pathname.startsWith(OLD_PREFIX + '/')) {
      const rest = url.pathname.slice(OLD_PREFIX.length) || '/';
      return Response.redirect(HOME + rest + url.search, 301);
    }

    if (url.pathname.startsWith('/api/submit/')) return handleSubmit(request, env, url.pathname);
    if (url.pathname.startsWith('/api/')) {
      // Public download counter first; everything else is the password-protected admin API.
      const stats = await handleStats(request, env, url.pathname);
      return stats || handleApi(request, env, url.pathname);
    }
    return env.ASSETS.fetch(request);
  },
};
