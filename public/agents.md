# Publishing a game on Toki (for AI agents)

Toki (https://www.playtoki.app) is a website for free browser games. This page tells an AI agent
how to put a web game on Toki for a developer. Follow it step by step, and explain to the
developer in plain words what you did.

## What you need

- A **Toki upload key** from the developer. It starts with `toki_`. They make one on Toki under
  **My games → Upload keys**. Treat it like a password: never commit it, never print it in logs,
  never put it in a file that gets uploaded. Use it only as the `TOKI_KEY` environment variable
  (or a GitHub secret called `TOKI_KEY`).
- **Node.js 18 or newer** to run the upload script (or use the HTTP API at the end of this page).
- A **web build** of the game: a folder with an `index.html` that plays in a browser.

## 1. Get a web build

| Engine | How |
| --- | --- |
| Plain HTML/JS, Phaser, PixiJS, Three.js, Kaboom… | The folder with `index.html` (after `npm run build`, usually `dist/` or `build/`). |
| Godot 4 | Project → Export → Web. Export to a folder as `index.html`. With "Thread Support" on, set `"isolation": true` in toki.json. |
| Unity | Build Settings → WebGL → Build. Upload the folder with `index.html`. Compressed builds (.br/.gz) work. |
| GameMaker | Target GX.games or HTML5, then export to a folder. |
| Construct 3 | Export → Web (HTML5). |
| PICO-8 | `export game.html`, then rename it to `index.html`. |

Limits: at most **100 MB** and **3000 files** per game. Don't upload source files, `.git`,
`node_modules` or big unused assets.

## 2. Add a toki.json (recommended)

Put a `toki.json` next to `index.html` (or at the repository root with `"folder"` pointing to the
build). Every field is optional:

```json
{
  "title": "Moon Hop",
  "slug": "moon-hop",
  "description": "Hop across the moon and collect every star.",
  "description_de": "Hüpf über den Mond und sammle alle Sterne.",
  "controls": "Arrow keys to move, Space to jump",
  "category": "platformer",
  "engine": "Godot",
  "version": "1.1",
  "update_title": "Faster and prettier",
  "notes": ["Faster loading", "New level: the dark side"],
  "cover_image": "cover.png",
  "screenshots": ["shots/1.png", "shots/2.png"],
  "score_order": "high",
  "score_format": "points",
  "isolation": false,
  "entry": "index.html",
  "folder": "build"
}
```

- `category`: one of action, adventure, arcade, horror, platformer, puzzle, racing, shooter,
  sports, strategy, other.
- `slug`: the game's name in links (`/game/moon-hop`), lowercase letters, numbers and dashes. If
  there is no game with this slug yet, the upload **creates the game**. Without a slug, it is made
  from the title.
- `version` + `notes`: when the version is new, Toki posts an update on the game's Updates page
  for players. Write notes for players in plain words, no technical terms. `1.2.1`-style versions
  show as a small fix.
- `cover_image`, `screenshots`: paths of pictures inside the uploaded folder (or https links).
- `score_order`/`score_format`: whether a higher or lower score is better, and points or a time
  in milliseconds.
- `isolation`: only for games that need cross-origin isolation (Godot 4 with threads, some Unity
  builds). Leave it out otherwise.

## 3. Saves and high scores

- **Saves work by themselves** for games hosted on Toki: Toki adds its save script
  (`https://www.playtoki.app/toki-save.js`) to the game's page. Progress the game keeps in
  `localStorage` follows the player to other devices.
- **High scores**: call `window.toki && window.toki.score(points)` when a round ends (for times:
  milliseconds). Outside Toki it does nothing.

## 4. Upload

```bash
curl -fsSL https://www.playtoki.app/toki-upload.mjs -o toki-upload.mjs
TOKI_KEY="$TOKI_KEY" node toki-upload.mjs path/to/build
```

`--dry-run` lists what would be uploaded. `--game <slug>` picks the game when toki.json has no
slug. The script prints the game's Toki page and its address (`https://<game>.playtoki.app/`).
Uploading again replaces the game with the new version right away; the version before is kept
for 30 days so the developer can roll back on Toki.

Afterwards, tell the developer to open the game's page on Toki, check it plays, and add a cover
picture on the edit page if toki.json has none.

## 5. Publish on every push (GitHub)

Add the key as a repository secret named `TOKI_KEY` (the developer does this on GitHub:
Settings → Secrets and variables → Actions → New repository secret), then add
`.github/workflows/toki.yml`:

```yaml
name: Publish to Toki
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      # If the game must be built first, add the build steps here (e.g. npm ci && npm run build).
      - run: curl -fsSL https://www.playtoki.app/toki-upload.mjs -o /tmp/toki-upload.mjs
      - run: node /tmp/toki-upload.mjs .
        env:
          TOKI_KEY: ${{ secrets.TOKI_KEY }}
```

Change `.` to the build folder, or set `"folder"` in toki.json. Bump `version` in toki.json when
there is something new for players.

## 6. The HTTP API (without Node.js)

All calls: `POST https://www.playtoki.app/api/hosting` with `Authorization: Bearer <TOKI_KEY>` and
a JSON body.

1. `{"action": "start", "slug": "moon-hop", "toki": { …toki.json… }, "files": [{"path": "index.html", "size": 1234}, …]}`
   answers `{"build_id": "…", "uploads": [{"path": "index.html", "size": 1234, "url": "https://…"}, …]}`.
2. For each upload: `PUT` the file's exact bytes to its `url` (no other headers needed; the size
   must match). The links work for one hour.
3. `{"action": "finish", "build_id": "…", "toki": { …toki.json… }}` answers
   `{"play_url": "https://moon-hop.playtoki.app/", "game_url": "/game/moon-hop", "release": …}`.

To put the version before back, the developer uses "Roll back" on the game's edit page on Toki.

## Errors

| error | What to do |
| --- | --- |
| `bad_key` | The key is wrong or was deleted: ask the developer for a new one. |
| `not_allowed` | The account isn't a developer on Toki, or the game belongs to someone else. |
| `slug_taken` | Another developer has a game with this slug: pick another `slug`. |
| `no_entry` | No `index.html` in the folder: upload the web export folder, or set `entry`. |
| `too_big` / `too_many_files` | Over 100 MB or 3000 files: remove unused files, compress assets. |
| `account_full` | The developer's games use 1 GB already. |
| `rate_limited` | Too many uploads this hour: wait. |
| `hosting_off` | Toki's admins haven't set up uploads yet. |
