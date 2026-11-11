# Publishing a game on Toki (for AI agents)

Toki (https://playtoki.app) is a website for free browser games. This page tells an AI agent
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
  "multiplayer": true,
  "max_players": 4,
  "isolation": false,
  "entry": "index.html",
  "folder": "build",
  "achievements": [
    { "id": "first-star", "name": "First star", "name_de": "Erster Stern", "description": "Collect your first star.", "description_de": "Sammle deinen ersten Stern.", "icon": "⭐" }
  ],
  "boards": [
    { "id": "", "name": "Normal", "name_de": "Normal" },
    { "id": "hard", "name": "Hard mode", "name_de": "Schwer", "score_order": "high", "score_format": "points" },
    { "id": "speedrun", "name": "Speedrun", "score_order": "low", "score_format": "time" }
  ]
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
- `multiplayer`: `true` only for games with online rooms that other players join with a code
  (see "Play together" below). `max_players`: how many can play in one room. `join_param`: the
  name of the room code in the game's invite links, when it isn't `room`.
- `isolation`: only for games that need cross-origin isolation (Godot 4 with threads, some Unity
  builds). Leave it out otherwise.
- `achievements`: badges players earn in the game (at most 30). `id`: what the game calls
  `toki.achievement` with (letters, digits, `_`, `-` and `.`, at most 32). `name` (at most 40
  characters), `description` (one line, at most 120), the German ones optional, `icon` one emoji.
  Each upload adds new ones and updates the ones listed; it never deletes any (the developer
  removes them on Toki, in the game's settings).
- `boards`: more high-score lists besides the main one (at most 10), e.g. one per level, mode or
  difficulty. `id`: what the game calls `toki.score(points, id)` with (letters, digits, `_`, `-`
  and `.`, at most 32). `name` (at most 40 characters), `name_de` optional, `score_order` `high`
  or `low`, `score_format` `points` or `time` (milliseconds). An entry with `"id": ""` only names
  the main list (its order and format are `score_order`/`score_format` above). Each upload adds
  new lists and updates the ones listed; it never deletes any (the developer removes them on
  Toki, in the game's settings, which also removes their scores).

## 3. Saves and high scores

- **Saves work by themselves** for games hosted on Toki: Toki adds its save script
  (`https://www.playtoki.app/toki-save.js`) to the game's page. Progress the game keeps in
  `localStorage` follows the player to other devices.
- **High scores**: call `window.toki && window.toki.score(points)` when a round ends (for times:
  milliseconds). Outside Toki it does nothing.
- **More lists** (if the game has `boards`): `window.toki && window.toki.score(points, "hard")`
  sends the score to that list instead of the main one. Ids Toki doesn't know are ignored.
- **Achievements** (if the developer wants them): call
  `window.toki && window.toki.achievement("first-star")` when the player earns one, with an id
  from `achievements` in toki.json (or from the game's settings on Toki). Calling it again is free;
  Toki shows "Achievement unlocked" itself.

### Play together (only games with online rooms)

Toki doesn't replace the game's multiplayer. It brings a player's Toki friends into the room
they opened in the game:

- When the player has opened or joined a room, call `window.toki && window.toki.room(code)` with
  the room's code (letters, digits, `-` and `_`, at most 32 characters). Call
  `window.toki.room(null)` when they leave it. Toki then shows "Invite friends" next to the game.
- When a friend accepts, Toki opens the game with `?room=CODE` in its address. Read it at the
  start (`new URLSearchParams(location.search).get("room")`) and take the player into that room.
- If the game can open a room without the player choosing anything first, call
  `window.toki && window.toki.onHost(fn)` once when it has loaded. Toki calls `fn` when the
  player invites friends before a room is open: open a room in it (what the game's "host"
  button does) and call `window.toki.room(code)` as always. Do nothing in `fn` if the player is
  in a room already.
- Set `"multiplayer": true` in toki.json.

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

**Easiest, no key:** on Toki, open the game's settings, choose **From GitHub** with the game's
repository. If the repository holds the game's source (it must be built first, e.g. Vite),
Toki offers to build it with GitHub Actions and adds `.github/workflows/toki.yml` with a pull
request. That workflow needs no secret: it asks GitHub for a signed token for the run
(`permissions: id-token: write`), and Toki accepts the upload only for the game that follows
that repository and branch. The workflow runs `node toki-upload.mjs --build`, which installs the
packages (npm, pnpm, yarn or bun), runs `build`, finds the built `index.html` (`dist`, `build`,
`out`, …) and uploads it. Godot projects (GDScript) are exported for the web with the project's
Godot version. Unity, GameMaker and Construct need their own editor: commit the web export to a
folder of the repository, and choose that folder under **From GitHub**.

**With an upload key** (for a game that doesn't follow its repository on Toki): add the key as a
repository secret named `TOKI_KEY` (the developer does this on GitHub: Settings → Secrets and
variables → Actions → New repository secret), then add `.github/workflows/toki.yml`:

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
          node-version: lts/*
      - run: curl -fsSL https://www.playtoki.app/toki-upload.mjs -o /tmp/toki-upload.mjs
      # --build: install, build and upload the built game (leave it out for a game that needs no building)
      - run: node /tmp/toki-upload.mjs --build
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
