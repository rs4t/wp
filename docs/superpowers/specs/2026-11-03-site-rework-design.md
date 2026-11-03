# wp.egorz.com rework — design

Date: 2026-11-03 · Owner: egor · Status: approved 2026-11-03

## Why

The site works, but the main screen feels crowded (category chips, color dots,
sort and several buttons all in the header) and browsing "everything" feels odd,
because categories are the main way in. The owner wants to add many one-off
wallpapers that belong to no set, without them looking like leftovers. And no
wallpaper has a real name: titles are file names like `mountains/3`.

What already works and must survive: the dark look, the color usage, the
calligraphic Instrument Serif titles, the modern feel, and above all the
**viewer** (click a wallpaper: big image, ambient colored background, name,
resolution/ratio/size/format, download), e.g. https://wp.egorz.com/w/grain-8/.

## Goals

1. **Calmer main screen.** Header = wordmark + two icons (search, shuffle).
   Below it a strip of **collection covers**, then one **Everything** wall that
   mixes every wallpaper (collection members and one-offs) as equals.
2. **Collections instead of categories.** Optional: a wallpaper has zero or one
   collection. One-offs are first-class: the Everything wall is every
   wallpaper's real home; collections are shortcuts into subsets.
3. **Collection pages** with their own URL and a **banner header** (wide crop of
   the cover wallpaper fading into the page, collection name large in italic
   serif, count), then that collection's wall.
4. **Real names** for every wallpaper.
5. **Debloat:** remove the grain overlay, favorites, and the whole community
   feature.
6. Add the new wallpapers in `wallpapers/` (local folder, untracked), except
   any under 1920 px wide (owner: "remove the really bad small wallpapers").
   That excludes School of Athens (1080×838); 16 get added.

## Non-goals

- No redesign of the viewer beyond showing real names (and removing the heart
  and the "seen in N setups" link).
- No phone crops, resolution picker, tags, accounts, or new features.
- No framework or new dependencies.

## Anti-goals (failure even if it "works")

- One-offs feeling second-class or tucked into a "misc" bucket.
- The viewer losing its look (big image + ambient glow + serif title + mono specs).
- Any existing shared link (`/w/<old-id>/`, `/community/`, `egorz.com/wp/...`)
  turning into a 404.
- Losing download counts (they are keyed by file hash: keep hashes).

## Decisions (made by the owner)

- Main screen = layout "B": collection strip on top, Everything wall below.
- Collection page = banner header (option 2), not a viewer-style hero.
- Viewer stays as it is today.
- Keep: intro animation, tile tilt, column parallax, the "popular" sort.
- Remove: grain overlay, favorites, community page + submit form (and with it
  setups, the admin inbox and the submission backend).
- Sort order and color filter move into the search panel; no community link anywhere.
- Collections (final list):
  - Series: **Fractal Maze** (60), **Dark Waves** (10), **Distort** (10),
    **Fiery Vivid** (8, renamed from the misspelled `firey-vivid`), **Fusion**
    (6), **Grain** (7), **Fractal Glass** (new: the 4 `fractal glass <color>` files).
  - Themes: **Mountains** (14 + new mountain/landscape photos), **Paintings**
    (2).
  - Dissolved into one-offs: Forest (4), Plants (4).
  - New one-offs: Glass Palette, Minimalist Architecture, Silent Migration
    Across a Crimson Sky, Somewhere Between Episodes (+ any new photo that
    isn't a mountain scene).
- Naming: wallpapers in big look-alike sets keep numbers inside the set
  ("Fractal Maze 07"). Everything else gets a real name chosen by Claude after
  looking at each image; famous works/places use their real name (e.g. the
  ceiling painting → its actual title). The owner fixes anything later in admin.
  New-folder names are the owner's, with spelling/casing fixed
  ("minimalist architechture" → "Minimalist Architecture", "Zhangjiajie
  national park" → "Zhangjiajie National Park").
- Stack: unchanged — plain HTML/CSS/JS, the existing Node + sharp build,
  Cloudflare Workers + static assets + R2.

## Data model

`wallpapers.json` (repo root), one entry per wallpaper:

```json
{ "hash": "3c85b0e7ba", "ext": "jpg", "name": "Sierra Afterglow", "collection": "mountains",
  "size": 9123456, "added": 1790705582000, "credit": { "name": "…", "link": "…" } }
```

- `hash` (10 hex, sha1 prefix) is the identity: R2 key `orig/<hash>`, download
  counts, everything. `path` goes away; `name` + `collection` replace it.
- `collection` optional; absent = one-off.
- `collections.json` (repo root): ordered list
  `[{ "id": "mountains", "name": "Mountains", "cover": "<hash>" }]`. Order = order
  of the cover strip. `cover` optional (default: newest member).

## URLs

- Wallpaper: `/w/<slug>/` where slug = slugified name (`annapurna`,
  `fractal-maze-07`); duplicates get `-2`, `-3`.
- Collection: `/c/<id>/`.
- Download: `/o/<hash>/<slug>.<ext>` (Worker streams from R2; filename is
  cosmetic).
- **Redirects:** build writes `redirects.json` mapping every old id
  (`mountains-3`, `firey-vivid-1`, …, taken from the live manifest at migration
  time and kept forever) → new slug; the Worker 301s `/w/<old>/` to `/w/<new>/`.
  `/community/` and `/community/*` 301 to `/`. `/wp/*` redirect stays.

## Screens

**Main (`/`)**
- Header: wordmark left; right: search icon, shuffle icon. Header hides on
  scroll down as today.
- Collection strip: cover cards (image, serif name, count), horizontal scroll
  on narrow screens.
- "Everything" heading + count, then the masonry wall (existing tile/tilt/
  parallax/reveal code). Tile hover shows the name.
- Footer: count · updated date · egorz.com.
- Search panel (opens from the icon, also `/` shortcut): text search over
  names + collection names + color words (reuse the forgiving search from
  `src/submit.js`), sort (random / newest / oldest / popular), color swatches.
  Filters keep working through the URL query (`?q=`, `?sort=`, `?color=`).

**Collection (`/c/<id>/`)**
- Same header. Banner: cover wallpaper cropped wide, fading into the page;
  collection name in large italic serif + count. Then the collection's wall.
- Viewer prev/next stays inside the collection when opened from it.

**Viewer (`/w/<slug>/`)**
- Unchanged look. Title = real name in serif; collection shown small (linking to
  `/c/<id>/`) when present. Remove the heart button and "seen in setups".
- Specs line unchanged (resolution / ratio / size / format / downloads).

## Removals

- Grain: `.grain` element + CSS.
- Favorites: tile hearts, viewer heart, favorites toggle, `F` key, localStorage.
- Community: `community/` dir, `src/submit.js`, community template parts,
  `worker/inbox.js`, `/api/submit/*`, `/api/inbox/*`, admin inbox + setups UI,
  setup handling in build/manifest/worker commit.
  Cloudflare side: the `Inbox` Durable Object (needs a `deleted_classes`
  migration), the `SUBMISSIONS` binding. **Before deleting**, check the inbox
  for pending submissions and show them to the owner. Deleting the
  `wp-submissions` bucket, the Turnstile widget and the Turnstile secrets is
  done only after the owner confirms.
- The existing setup photo's R2 object can stay (harmless).

## Admin

- Library: shows names; edit name and collection inline (no `prompt()`).
- Upload: name field (prefilled from the file name, cleaned up) + collection
  picker defaulting to "none" + "new collection".
- Collections section: rename, reorder, set cover.
- Delete stays (originals remain in R2).

## Migration

1. Look at all 125 live wallpapers and name them per the rules above.
2. Upload the 17 new files from `wallpapers/` to R2 (same way as the first
   migration: `wrangler r2 object put … orig/<hash>`).
3. Write the new `wallpapers.json` + `collections.json` + old-id redirect map.
4. Keep `wallpapers/` and `.superpowers/` out of git (`.gitignore`).

## Verification

- Every old `/w/<id>/` from the pre-rework manifest returns 301 to a page that
  returns 200.
- All 141 wallpapers appear on the Everything wall; each collection page lists
  exactly its members; one-offs appear only on the wall.
- Download of every original still matches its hash; download counts carry over.
- Local end-to-end admin test (wrangler dev + mock GitHub, as in the R2
  migration) covers: upload with name + collection, rename, change collection,
  collection rename/cover/reorder, delete.
- Phone width (390px): header, strip, wall, viewer usable; no horizontal scroll.

## Claude's calls (owner can override)

- Staying on plain HTML/CSS/JS: the site is one gallery, one viewer and an
  admin page; a framework would add a build step and weight without a gain.
- Which new photos join Mountains is decided by looking at each one (mountain
  scenes in, sea/architecture out).
- Initial collection strip order: series first by size (Fractal Maze, Dark
  Waves, Distort, Fiery Vivid, Grain, Fusion, Fractal Glass), then Mountains,
  Paintings. Reorderable in admin.
- Everything wall keeps "random" as the default sort.
- Download filenames use the new slug.

## Left to the builder

- Exact visual details of the strip, banner and search panel within the
  existing style (fonts, colors, spacing tokens already in `src/styles.css`).
- How the intro animation counts (wallpapers / collections).
- Exact slug rules and the name for each wallpaper.
