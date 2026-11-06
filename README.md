# toki

A small website for browser games by Levi and friends, in English and German.

- **Play:** anyone can play, without an account. Favorites and recently played are saved in the visitor's browser.
- **Add games:** only invited members can add games. A game is added **by link**: paste the address where the game runs (for example a Vercel or GitHub Pages site). When the game is updated there, Toki shows the new version automatically.
- **Invites:** admins create invite codes on the *Invites* page. Each code works once.

## Tech

- Vite + React + TypeScript, hosted on Vercel (`vercel.json`)
- Supabase for logins, the games list and cover images (`supabase/schema.sql`)
- Pixel-art covers are drawn in the browser (`src/pixel/scenes.ts`) when a game has no uploaded image

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

If a game still won't load inside Toki, the game page has an "Open in new tab" link.
