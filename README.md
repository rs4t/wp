# egor's wallpapers

The source for **[wp.egorz.com](https://wp.egorz.com)** and **[egorz.com/wp](https://egorz.com/wp)**, a quiet, dark gallery for my wallpaper collection.

## Adding wallpapers

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
2. Build command: `npm run build`. Deploy command: `npx wrangler deploy`.
3. `wrangler.jsonc` already declares both domains:
   - `wp.egorz.com` as a custom domain
   - `egorz.com/wp` and `egorz.com/wp/*` as routes on the `egorz.com` zone

   `worker/index.js` strips the `/wp` prefix, so one build serves both. Every asset path in the site is relative, which is why the same files work at either location. If you'd rather attach domains in the dashboard, delete the `routes` block.

**Using Cloudflare Pages instead?** Set the build command to `npm run build` and the output directory to `dist`. Pages can serve `wp.egorz.com` directly, but `egorz.com/wp` still needs the Worker above, so Workers is the simpler route.
