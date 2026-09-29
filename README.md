# egor's wallpapers

The source for **[wp.egorz.com](https://wp.egorz.com)** and **[egorz.com/wp](https://egorz.com/wp)**, a quiet, dark gallery for my wallpaper collection.

## Adding wallpapers

**Easiest: the admin page** at [wp.egorz.com/admin/](https://wp.egorz.com/admin/) (or `egorz.com/wp/admin/`). Log in with the admin password, drop in images, pick a category and press upload. You can also select existing wallpapers to move them to another category or delete them. Each save is one commit to this repo, and the site rebuilds in about 2–3 minutes.

**Or by hand in git:**

1. Put image files in `wallpapers/<category>/`, e.g. `wallpapers/landscape/misty-alps_01.jpg`.
2. Commit and push to `main`.

That's all. Cloudflare rebuilds the site on its own:

- **Categories** come from the subfolder names. A new folder becomes a new filter chip.
- **Titles** come from filenames: `misty-alps_01.jpg` shows as "Misty Alps 01".
- **Order** is newest first, based on when each file was first committed. Anything added in the last 14 days gets a `new` marker.
- Each wallpaper gets a permalink at `/w/<name>/` with a link-preview image for Discord, iMessage, X and similar apps.
- Downloads serve the **untouched original**. Cloudflare limits single files to 25 MB, so anything bigger gets re-encoded to a high-quality JPEG for the download only.

Supported formats: `.jpg .jpeg .png .webp .avif .tif .tiff`. Files at the top level of `wallpapers/` (outside any folder) appear under "all" only.

## How it works

`npm run build` (`scripts/build.mjs`) scans `wallpapers/` and uses [sharp](https://sharp.pixelplumbing.com) to generate:

| output | what |
| --- | --- |
| `t/*-{480,960,1440}.{avif,webp}` | grid thumbnails |
| `p/*.webp` | 2880px lightbox preview |
| `og/*.jpg` | 1200×630 link-preview images |
| `o/<hash>/<file>` | the original download |
| `a/manifest.*.json` | dimensions, colors, blur placeholders and dates |
| `w/<name>/index.html` | one page per wallpaper (permalinks) |

Everything goes to `dist/`, which is git-ignored. The site itself is plain HTML, CSS and JS in `src/`, with no framework.

## Local preview

```sh
npm install
npm run dev        # builds, then serves at http://localhost:8788/ and /wp/
```

## Cloudflare setup (Workers + Git)

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → `rs4t/wp`.
2. Deploy command: `npx wrangler deploy`. Leave the build command empty: `wrangler.jsonc` runs `npm run build` on every deploy.
3. `wrangler.jsonc` already declares both domains:
   - `wp.egorz.com` as a custom domain
   - `egorz.com/wp` and `egorz.com/wp/*` as routes on the `egorz.com` zone

   `worker/index.js` strips the `/wp` prefix, so one build serves both. Every asset path in the site is relative, which is why the same files work at either location. If you'd rather attach domains in the dashboard, delete the `routes` block.

**Using Cloudflare Pages instead?** Set the build command to `npm run build` and the output directory to `dist`. Pages can serve `wp.egorz.com` directly, but `egorz.com/wp` still needs the Worker above, so Workers is the simpler route.

### Admin page setup (one time)

The admin page commits to this repo through the GitHub API, so the Worker needs two secrets:

1. **GitHub token:** GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
   - Repository access: *Only select repositories* → `rs4t/wp`
   - Permissions → Repository permissions → **Contents: Read and write**
   - Pick an expiry (or none), generate, and copy the token.
2. **Cloudflare:** Workers & Pages → your Worker → **Settings → Variables and Secrets** → Add. Choose the type **Secret** for both:
   - `GITHUB_TOKEN`: the token from step 1
   - `ADMIN_PASSWORD`: the password admins will use (make it long)

Secrets survive redeploys. Changing `ADMIN_PASSWORD` logs everyone out.
