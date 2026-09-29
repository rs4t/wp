# egor's wallpapers

A quiet, dark gallery for my wallpaper collection. Browse, preview, and download the originals at full resolution.

**→ [wp.egorz.com](https://wp.egorz.com)**

![The gallery](docs/gallery.jpg)

![The viewer](docs/viewer.jpg)

## How it works

The wallpapers live in [`wallpapers/`](wallpapers), one folder per category. On every push, a small Node build script uses [sharp](https://sharp.pixelplumbing.com) to generate thumbnails, previews, color palettes and link-preview images, and writes a static site to `dist/`. Cloudflare Workers serves the result.

No framework, just plain HTML, CSS and JavaScript.

```sh
npm install
npm run dev   # build and preview at http://localhost:8788
```
