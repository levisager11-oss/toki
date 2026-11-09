# toki

A small website for browser games by Levi and friends, in English and German.

- **Play:** anyone can play, without an account. Favorites and recently played are saved in the visitor's browser.
- **Plays and likes:** a visit counts as a play after 10 seconds on a game's page (once per browser per game per day). Tapping the heart saves a game to Favorites and adds a public like. Members see plays per day on *My games*.
- **Add games:** only invited members can add games. A game is added **by link**: paste the address where the game runs (for example a Vercel or GitHub Pages site). When the game is updated there, Toki shows the new version automatically.
- **Invites:** admins create invite codes on the *Invites* page. Each code works once.

## Tech

- Vite + React + TypeScript, hosted on Vercel (`vercel.json`)
- Supabase for logins, the games list and cover images (`supabase/schema.sql`)
- Pixel-art covers are drawn in the browser (`src/pixel/scenes.ts`) when a game has no uploaded image
- `middleware.ts` fills in the title, description and image for link previews (WhatsApp, Discord, …). `api/og.ts` draws the preview image from the pixel cover
- `api/check.ts` tells members, while they fill in the game form, whether a game link can be shown inside Toki

## Checks

```sh
npm test          # unit tests
npm run typecheck
```

They also run on every pull request (`.github/workflows/ci.yml`).

## Run locally

```sh
npm install
npm run dev
```

The public Supabase URL and publishable key are in `.env`. They are safe to commit: what they can do is limited by the database's row level security rules.

## Games that need special browser settings

Most games need nothing. Games that use threads (Godot 4 exports with thread support, some Unity builds) only run with *cross-origin isolation*. For those, tick **“Needs cross-origin isolation”** in the game form. Only then does that game's page get

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

(`middleware.ts`, and `vite.config.ts` for local runs). All other pages and games get neither header, because with them the browser only shows games whose own site sends matching headers.

The game's own site must then allow being embedded. Its responses need:

```
Cross-Origin-Resource-Policy: cross-origin
Cross-Origin-Embedder-Policy: require-corp
```

The game form checks this as soon as you paste a link, and lets you try the game right there.

If a game still won't load inside Toki, the game page has an "Open in new tab" link.

## Saves

Games that include `public/toki-save.js` send their localStorage to Toki (`src/lib/saves.ts`). For logged-in players:

- Toki answers the game's "hello" only once the account save is loaded or known to be missing, never with “nothing” while it is loading.
- A save only replaces the account save when it was made on top of it (`put_game_save` in `supabase/schema.sql`). A save from a device that had an older version, or none, never overwrites newer progress: the account copy stays, and the other one is kept as a conflict copy.
- Logging out sends nothing.
- Earlier versions are kept (`game_save_history`) and can be restored on the *Account* page. A copy is kept every 30 minutes of play, when another device saves, and always right before a save shrinks to less than half its size (a "new game" or wipe).
- To put a save back, the script writes it into the game's storage and reloads the game. Script v2 ignores the game's own writes until the reload, because many games save their current state then (autosave, saving on close) and would write their fresh state over it. For games still on v1, when the first save after that reload is less than half the size of the save Toki gave, Toki keeps the progress, stores the new save only as a backup and offers "Load my progress".
