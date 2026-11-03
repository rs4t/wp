# Site Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace categories with optional collections and real names, calm the main screen (collection strip + one "Everything" wall + search panel), add banner collection pages, and remove grain, favorites and community.

**Architecture:** `wallpapers.json` + `collections.json` become the source of truth (identity = file hash). The Node build derives slugs, manifest, `/w/<slug>/` and `/c/<id>/` pages and a static `_redirects` file for every old URL. The Worker keeps serving originals from R2 and the admin API; the pure change logic moves to a testable module. The browser client stays one classic script plus a small search module.

**Tech Stack:** Node ≥20 (`node:test`), sharp, Cloudflare Workers + static assets (`_redirects`) + R2, plain HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-11-03-site-rework-design.md`

## Global Constraints

- No new dependencies. Tests use `node:test` + `node:assert/strict`. No framework.
- Identity is the 10-hex sha1 prefix `hash`; R2 key `orig/<hash>`; download counts stay keyed by hash.
- No existing shared link may 404: every old `/w/<id>/` (from the pre-rework manifest), `/community/`, `/community/*`, `egorz.com/wp/*`.
- Keep: intro animation, tile tilt, column parallax, "popular" sort, the viewer's look.
- Remove: grain overlay, favorites, community (page, submit form, setups, admin inbox, submission backend).
- Collections: zero or one per wallpaper; one-offs live on the Everything wall like everything else.
- Wallpapers under 1920 px wide are not added (School of Athens is out).
- Phone width 390 px: no horizontal page scroll.
- Work on branch `rework`; push the branch after every task. Merging to `main` deploys (Workers Builds), so `main` only gets the finished, verified work (Task 7).

## Review Focus

1. Two wallpapers with the same name → different slugs (`name`, `name-2`), both pages exist. Test in Task 2.
2. A wallpaper renamed twice → both earlier slugs still redirect to the current one. Test in Task 2.
3. An old slug that now belongs to a different live wallpaper must not be redirected (it would hide a real page). Test in Task 2.
4. Opening a wallpaper from a collection page, then closing it or pressing back, returns to that collection page, not home. Browser check in Task 4.
5. Search finds "Fractal Maze 07" from `fractal maze 7` and from `fractl maze 7` (typo). Test in Task 4.

---

### Task 1: Test runner, new data files, new wallpapers in R2

**Files:**
- Modify: `package.json` (add `"test": "node --test test/"`)
- Create: `legacy-ids.json`, `collections.json`; Rewrite: `wallpapers.json`
- Test: `test/data.test.mjs`

**Interfaces:**
- Produces:
  - `wallpapers.json`: `[{ hash, ext, name, collection?, size, added, credit? }]` (no `path`).
  - `collections.json`: `[{ id, name, cover? }]` in strip order: `fractal-maze, dark-waves, distort, fiery-vivid, grain, fusion, fractal-glass, mountains, paintings`.
  - `legacy-ids.json`: `{ "<old manifest id>": "<hash>" }` for all 125 ids in the live manifest before this change.

- [ ] **Step 1: Branch.** `git switch -c rework`
- [ ] **Step 2: Write `test/data.test.mjs`** with tests:
  - `every wallpaper is well-formed`: hash `/^[0-9a-f]{10}$/`, ext in `jpg jpeg png webp avif tif tiff`, non-empty `name`, `size > 0`, `added` a number.
  - `hashes are unique`.
  - `collections are the spec's nine, in order` (ids exactly as listed above).
  - `every collection reference exists` and `every cover is a member of its collection`.
  - `legacy ids all point at a wallpaper` (125 entries, each hash present).
  - `141 wallpapers` (125 + 16).
- [ ] **Step 3: Run** `npm test` → FAIL (old `wallpapers.json` has `path`).
- [ ] **Step 4: Write `legacy-ids.json`** from `https://wp.egorz.com/manifest.json` (`items[].id → items[].hash`).
- [ ] **Step 5: Upload the 16 new files** from `wallpapers/` (skip `school of athens.jpeg`) with `wrangler r2 object put wp-wallpapers/orig/<hash> --file <f> --content-type <type> --remote`, `CLOUDFLARE_ACCOUNT_ID=cf1d580e023fcbaee26b635dc36da524`. Verify each with `curl -sI https://wp.egorz.com/o/<hash>/x.<ext>` → 200.
- [ ] **Step 6: Rewrite `wallpapers.json`** (keep `hash, size, added, credit` of existing entries; new entries `added` = upload time). Names and collections:
  - Series collections (fractal-maze, dark-waves, distort, fiery-vivid, grain, fusion): `"<Collection Name> <n>"`, n = rank by the old file number, zero-padded to 2 digits when the collection has ≥ 10 members (`Fractal Maze 07`, `Dark Waves 03`, `Fiery Vivid 4`).
  - Fractal Glass: `Fractal Glass Blue / Green / Orange / Purple`.
  - Mountains and Paintings members and the old forest/plants images (now one-offs): look at each image (`t/<…>-960.webp`) and give a short real name; use the real title/place for famous works and places.
  - New files: the owner's names with fixed spelling/casing: `Annapurna`, `Canmore, Alberta`, `Everest`, `Glass Palette`, `Lake McDonald`, `Lake Tahoe`, `Minimalist Architecture`, `Mountain View`, `Norway Sea`, `Silent Migration Across a Crimson Sky`, `Somewhere Between Episodes`, `Zhangjiajie National Park`. Mountain scenes join `mountains` (decide by looking); the rest are one-offs. Glass Palette, Minimalist Architecture, Silent Migration, Somewhere Between Episodes are one-offs.
- [ ] **Step 7: Write `collections.json`** (names: `Fractal Maze, Dark Waves, Distort, Fiery Vivid, Grain, Fusion, Fractal Glass, Mountains, Paintings`; covers optional).
- [ ] **Step 8: Run** `npm test` → PASS.
- [ ] **Step 9: Commit + push branch** `git add package.json test legacy-ids.json collections.json wallpapers.json && git commit -m "Name every wallpaper; collections replace categories" && git push -u origin rework`

### Task 2: Build — slugs, collections, pages, redirects

**Files:**
- Create: `scripts/site.mjs`
- Modify: `scripts/build.mjs`, `src/template.html`, `src/_headers`
- Test: `test/site.test.mjs`, `test/build.test.mjs`

**Interfaces:**
- Consumes: Task 1 data files.
- Produces (`scripts/site.mjs`):
  - `slugify(s: string): string` (moved from build.mjs, unchanged).
  - `assignSlugs(walls: {hash, name, added}[]): Map<hash, slug>`: oldest `added` first (then hash) keeps the plain slug; later duplicates get `-2`, `-3`.
  - `collectAliases({ legacy, prevAliases, prevItems }): Record<slug, hash>`: union of `legacy-ids.json`, previous manifest's `aliases`, and previous manifest's `items[].id → hash`.
  - `redirectsFor(aliases, slugByHash): Record<oldSlug, newSlug>`: drops entries whose hash is gone, whose old slug equals the new one, or whose old slug is any current slug.
  - `redirectsFile(redirects): string`: for each pair `/w/<old> /w/<new>/ 301` and `/w/<old>/ /w/<new>/ 301`, plus `/community / 301` and `/community/* / 301`.
- Produces (manifest, `a/manifest.<hash>.json` + `manifest.json`): `{ name, generated, pipeline, widths, colors, collections: [{id, name, count, cover}], items, aliases }`; item = `{ id: slug, name, coll: id|null, w, h, ratio, size, added, color, pal, colors, lqip, hash, t, p, og, o, file, credit?, new }`; `o = o/<hash>/<slug>.<ext>`. `collections` keeps `collections.json` order, drops empty ones, `cover` defaults to the newest member's hash. No `setups`, no `categories`.
- Produces (pages): `dist/index.html` (`data-page="gallery"`), `dist/c/<id>/index.html` (`data-page="collection" data-collection="<id>"`, title `<Name> — egor's wallpapers`, og image = cover's og), `dist/w/<slug>/index.html`, `dist/_redirects`, sitemap with `/`, `/c/<id>/`, `/w/<slug>/`. No community page. Template gets `{{collection}}` and `{{banner}}` (banner = `<header class="banner"><img src="/<cover t>-1440.webp" alt=""><h1>…</h1><span class="mono">N wallpapers</span></header>` on collection pages, empty elsewhere).

- [ ] **Step 1: Write `test/site.test.mjs`:**
  - `assignSlugs gives duplicates -2 by age`: `[{hash:'b',name:'Sea',added:2},{hash:'a',name:'Sea',added:1}]` → `a→sea`, `b→sea-2`.
  - `renamed twice still redirects`: aliases `{x:'h1', y:'h1'}`, slugByHash `{h1→z}` → `{x:'z', y:'z'}`.
  - `never redirects a live slug`: aliases `{sea:'h1'}`, slugByHash `{h1→ocean, h2→sea}` → `{}`.
  - `drops deleted wallpapers`: aliases `{old:'gone'}` → `{}`.
  - `redirectsFile has both slash forms and community`: output contains `/w/a /w/b/ 301`, `/w/a/ /w/b/ 301`, `/community/* / 301`.
- [ ] **Step 2: Run** `npm test` → FAIL (module missing).
- [ ] **Step 3: Implement `scripts/site.mjs`.**
- [ ] **Step 4: Run** `npm test` → site tests PASS.
- [ ] **Step 5: Rework `scripts/build.mjs`** to read both JSON files, use `site.mjs`, write the manifest/pages/redirects above, and drop setup + community code. Reuse from the previous deploy stays keyed by hash.
- [ ] **Step 6: Write `test/build.test.mjs`** (reads `dist/`, skip with a message if `dist/manifest.json` is missing): 141 items; `dist/c/mountains/index.html` and `dist/w/everest/index.html` exist; `_redirects` has a line for `/w/mountains-3/`; no `dist/community`; every item's `coll` is null or a manifest collection id.
- [ ] **Step 7: Run** `npm run build && npm test` → PASS (16 new images processed, the rest reused).
- [ ] **Step 7b: Check `_redirects` works with the Worker in front:** `wrangler dev`, then `curl -sI localhost:8787/w/mountains-3/` → `301` with `Location: /w/<new>/`. If static redirects are not applied, add `"/w/*"` to `run_worker_first` and 301 from the Worker using `/manifest.json`'s `aliases` resolved through its items instead.
- [ ] **Step 8: Commit + push** `"Build: slugs, collection pages, redirects for old links"`

### Task 3: Worker — admin change logic, community backend removed

**Files:**
- Create: `worker/changes.js`
- Modify: `worker/api.js`, `worker/index.js`, `wrangler.jsonc`
- Delete: `worker/inbox.js`
- Test: `test/changes.test.mjs`, `test/admin.e2e.mjs`, `test/support/mock-github.mjs`

**Interfaces:**
- Produces: `applyChanges({ walls, collections, body, uploads, now }): { walls, collections, message } | { error }` (pure, no Cloudflare imports). `uploads: Map<hash, size>` = R2 `head` results for the hashes in `body.add`.
- Commit body (`POST /api/commit`): `add: [{hash, ext, name, collection?, credit?}]`, `update: [{hash, name?, collection? (null clears), credit? (null clears)}]`, `delete: [hash]`, `collections: [{id, name, cover?}]` (full ordered replacement).
- `GET /api/list` → `{ head, files: wallpapers.json entries, collections }`. `PUT /api/upload` unchanged.

- [ ] **Step 1: Check the inbox** before removing it: `wrangler r2 object list wp-submissions --prefix sub/ --remote` (account id as Task 1). If anything is listed, stop and show the owner.
- [ ] **Step 2: Write `test/changes.test.mjs`:**
  - `add needs an uploaded hash` → `{error}` when hash not in `uploads`; ok when present, entry gets `size` from `uploads` and `added = now`.
  - `add/update reject unknown collection` → `{error}`.
  - `update renames and clears collection with null`.
  - `delete removes by hash`; unknown hash → `{error}`.
  - `collections replacement keeps order; rejects removing an id still used; rejects bad ids` (`/^[a-z0-9-]{1,40}$/`) and a `cover` that isn't a member.
  - `message` e.g. `Admin: add 1, update 2, delete 1 wallpapers; collections`.
- [ ] **Step 3: Run** `npm test` → FAIL.
- [ ] **Step 4: Implement `worker/changes.js`**; reuse `cleanName`, `cleanCredit`, `IMAGE_EXT` (move them there from `api.js`).
- [ ] **Step 5: Run** `npm test` → PASS.
- [ ] **Step 6: Wire `api.js`**: `commit` reads both files, heads `orig/<hash>` for adds, calls `applyChanges`, writes changed files in one commit (same retry loop). Remove `/api/inbox*`, `/api/submit/*`, `worker/inbox.js`, the `Inbox` export. In `wrangler.jsonc`: drop the `INBOX` binding, add migration `{ "tag": "v3", "deleted_classes": ["Inbox"] }`, drop the `SUBMISSIONS` binding.
- [ ] **Step 7: Move the scratchpad e2e into the repo** (`test/support/mock-github.mjs`, `test/admin.e2e.mjs`, adapted to the new body). Run: start mock (`node test/support/mock-github.mjs wallpapers.json collections.json`) and `wrangler dev --var ADMIN_PASSWORD:test --var GITHUB_TOKEN:x --var GITHUB_API:http://localhost:9999`, then `node test/admin.e2e.mjs` → `ALL PASS` (upload, bad checksum, add with collection, update name/collection/credit, collections reorder + cover, delete, `/o/` range, login rate limit).
- [ ] **Step 8: Commit + push** `"Worker: name/collection admin API, remove community backend"`

### Task 4: Front end — main screen, collection page, search, removals

**Files:**
- Create: `src/search.js`
- Modify: `src/app.js`, `src/styles.css`, `src/template.html`, `scripts/build.mjs` (hash + include `search.js`)
- Delete: `src/submit.js`
- Test: `test/search.test.mjs`

**Interfaces:**
- Consumes: Task 2 manifest + page attributes.
- Produces: `src/search.js` is a classic script setting `globalThis.wpSearch = { rank(items, query): item[] }` (forgiving search moved from `submit.js`; haystack = name, collection name, color words). `app.js` loads before it is used; node tests `await import('../src/search.js')`.

- [ ] **Step 1: Write `test/search.test.mjs`:** with items `Fractal Maze 07 (fractal-maze)`, `Fractal Maze 17`, `Everest (mountains, colors ['blue','dark'])`: `fractal maze 7` → first is `Fractal Maze 07`; `fractl maze 7` → first is `Fractal Maze 07`; `mountains` → `Everest`; `blue` → `Everest`; `zzz` → `[]`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implement `src/search.js`. **Step 4:** Run → PASS.
- [ ] **Step 5: Main screen** (`data-page="gallery"`): header = wordmark + search button (`aria-label="Search"`, opens panel, `/` key) + shuffle; collection strip (cover card: image, serif name, mono count; links `/c/<id>/`; horizontal scroll under 640 px); `<h2>Everything</h2>` + count; existing wall (tile hover shows the name in serif); footer `count · updated date · egorz.com`. Search panel: text input (`?q=`), sort buttons random/newest/oldest/popular (`?sort=`), color swatches (`?color=`).
- [ ] **Step 6: Collection page** (`data-page="collection"`): banner from the template, wall filtered to that collection, no strip. Opening a wallpaper pushes `/w/<slug>/`; closing/back returns to `/c/<id>/` (the page's own URL is the "home" for `routeUrl('')`). Prev/next stay inside the filtered view.
- [ ] **Step 7: Viewer:** title = `name`; small collection link (`/c/<id>/`) when `coll`; no heart, no "seen in setups".
- [ ] **Step 8: Remove** grain element + CSS, favorites (tiles, viewer, toggle, `F` key, localStorage), all `data-submit` / community markup and CSS, `submit.js`.
- [ ] **Step 9: Browser check** (`npm run build && npm run serve`, Playwright at 1440×900 and 390×844): strip + Everything wall render; search `everest` narrows the wall; `?sort=newest` survives reload; `/c/mountains/` shows banner and only Mountains; open → close returns to `/c/mountains/`; back button too; `/w/everest/` direct load opens the viewer; `document.documentElement.scrollWidth <= innerWidth` at 390 px; no console errors.
- [ ] **Step 10: Commit + push** `"Front end: collection strip, Everything wall, collection pages, search panel"`

### Task 5: Admin UI — names, collections, inbox removed

**Files:**
- Modify: `src/admin/index.html`, `src/admin/admin.js`, `src/admin/admin.css`

**Interfaces:**
- Consumes: Task 3 API (`list`, `commit` body, `upload`).

- [ ] **Step 1: Remove** the Inbox and Community sections and their code.
- [ ] **Step 2: Library:** cards show `name` + collection; filter chips = all / each collection / one-offs. Selecting one wallpaper shows an inline editor in the dock: name, collection `<select>` (none + collections + "new collection…"), credit name, credit link, save → `update`. Multi-select: collection select + delete. No `prompt()` for rename/credit/move.
- [ ] **Step 3: Upload queue:** per-file name (prefilled from the file name, `-_` → spaces, title case) and one collection picker for the batch (default none, "new collection…") → `add` (+ `collections` when new).
- [ ] **Step 4: Collections section:** rows with name input, cover `<select>` (members), ↑/↓, save → `collections`.
- [ ] **Step 5: Browser check** against `wrangler dev` + mock GitHub (password `test`): upload a file into a new collection, rename it, move it to none, reorder collections, set a cover, delete it; each action's resulting `wallpapers.json` / `collections.json` in the mock matches.
- [ ] **Step 6: Commit + push** `"Admin: names and collections, inline editing"`

### Task 6: README

- [ ] **Step 1:** Update features (collections, search panel, no favorites/community) and "How it works" (`wallpapers.json` + `collections.json`, slugs, `_redirects`); remove the Community line. Commit + push `"README for the rework"`.

### Task 7: Ship

- [ ] **Step 1:** `npm test` all green; `npm run build` clean.
- [ ] **Step 2:** Merge `rework` into `main`, push → Workers Builds deploys. Check the build outcome via the Cloudflare builds API.
- [ ] **Step 3: Live checks:** for every id in `legacy-ids.json`, `curl -sI https://wp.egorz.com/w/<id>/` → 301, and its `Location` → 200; `/community/` → 301 to `/`; `egorz.com/wp/` → 301; 5 random originals download and hash-match; `/api/stats` still has counts for existing hashes; home, `/c/mountains/` and `/w/everest/` render at 390 px.
- [ ] **Step 4:** Ask the owner before deleting the `wp-submissions` bucket, the Turnstile widget and the `TURNSTILE_*` secrets; do it only on a yes.
