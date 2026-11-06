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

Toki sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`, so games that use threads (Godot 4, some Unity builds) can run inside the game page.

For that to work, the game's own site must allow being embedded. Its responses need:

```
Cross-Origin-Resource-Policy: cross-origin
Cross-Origin-Embedder-Policy: require-corp
```

The game form checks this as soon as you paste a link, and lets you try the game right there.

If a game still won't load inside Toki, the game page has an "Open in new tab" link.
