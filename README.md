# toki

A small website for free browser games, in English and German.

- **Accounts:** players sign up with a username, email and password. *Forgot your password?* on the login page sends a reset link that leads to `/reset-password`; logged-in players change their password on their account page. For the link to land on `/reset-password` directly, add `https://<your domain>/reset-password` to the redirect URLs in Supabase (Authentication → URL Configuration); otherwise Toki sends the player there itself.
- **Play:** anyone can play, without an account. Favorites and recently played are saved in the visitor's browser. For logged-in players, favorites (likes) belong to the account: a like counts once per account and shows on every device (`claim_likes` / `my_likes` in `supabase/schema.sql`).
- **Plays and likes:** a visit counts as a play after 10 seconds on a game's page (once per browser per game per day). Tapping the heart saves a game to Favorites and adds a public like. Members see plays per day on *My games*.
- **Add games:** only developers (creators and admins) can add games. *Add game* starts with the one-click way (`src/components/QuickAdd.tsx`): drop the game or pick its GitHub repository, the free AI reads its files and proposes the title, both descriptions, category, controls and score settings (`server/assist/scan.ts`), and one button puts it live. Saves work by themselves; if the game has a score, Toki Connect adds `toki.score` to its code: for an upload as the next live version (`server/connect/buildRepo.ts`), for a repository as a pull request. Admins choose which AI writes that code (free, strong or off) on the AI page. The ways underneath:
  - **Upload to Toki:** drop a ZIP, a folder or one HTML file (at most 100 MB). It goes straight from the browser to Cloudflare R2, and the game runs at its own address, `<game>.playtoki.app`, served by a small Cloudflare Worker (`cloudflare/games-worker/`), which also adds Toki's save script. The version before is kept 30 days for "roll back". Setup: [`docs/hosting-setup.md`](docs/hosting-setup.md). Server: `api/hosting.ts`, `server/hosting.ts`, `server/r2.ts`; rules: `supabase/migrations/20261115090000_game_hosting.sql`.
  - **From GitHub** (like Vercel): pick a repository, a branch and a folder; every push to that branch puts the new version live (the Toki GitHub App's push events, `server/gitDeploy.ts`).
  - **Upload keys** for AI agents, the upload script (`public/toki-upload.mjs`) and GitHub Actions, on *My games*. Agents read [`public/agents.md`](public/agents.md) (also linked from `/llms.txt`). A `toki.json` next to the game sets its title, controls, pictures and version; a new version posts an update for players.
  - **By link:** paste the address where the game runs (for example a Vercel or GitHub Pages site). When the game is updated there, Toki shows the new version automatically.

  *Fill in from a link* reads an itch.io page, a GitHub repository or any game page and fills in the form (`server/importer.ts`); the free AI then writes the English and German descriptions.
- **Developer accounts:** a player becomes a developer with an invite code, or by applying on *Become a developer* (`/apply`): they write what games they make and add links. Admins approve or decline (with a note) on *Applications* (`/applications`), and can take developer access away again (the games stay). One open application per account, at most 3 in 30 days. Rules: `supabase/migrations/20261109200000_developer_applications.sql` (it also undoes the per-game review from `20261109190000_game_review.sql`, which was live for a short time).
- **Invites:** admins create invite codes on the *Invites* page. Each code works once.
- **Toki Connect (AI):** developers connect Toki's GitHub App and let an AI add Toki saves and high scores to their game's repository (`/connect`). It reads the code, may ask the developer questions (e.g. what counts as the score), and opens a pull request. Admins pick the AI provider (an OpenAI-compatible endpoint or Anthropic), search its models, set prices, see the month's spending, and set quotas on *AI* (`/admin/ai`). Every call reserves its highest possible cost first, so a developer's monthly quota ($5 by default) and Toki's monthly cap ($20) can't be exceeded. Setup happens on the *AI* page itself (only the Supabase secret key goes into Vercel): [`docs/ai-setup.md`](docs/ai-setup.md). Rules: `supabase/migrations/20261110170000_ai.sql`; server code: `server/ai/`, `server/connect/`, `server/github.ts`, `api/ai.ts`, `api/github.ts`, `api/connect.ts`.
- **Free AI helpers:** next to Toki Connect's AI (the "strong AI", with prices and limits), admins can set up a "free AI" (an OpenAI-compatible endpoint where tokens cost nothing). It translates posts, replies, chat messages and game descriptions on request, points to similar feedback before posting, suggests games on the home page, drafts release notes and game descriptions, summarizes the feedback inbox and developer applications, answers players on a game's page ("Ask AI", from the developer's tips and what it learned from the game's GitHub repository), and does Toki Connect's easy steps. Buttons only show when the AI behind them is on. Each account may use each helper only so often an hour. "Fix with AI" on a bug report starts a Toki Connect run that fixes it. See [`docs/ai-setup.md`](docs/ai-setup.md); server code: `api/assist.ts`, `server/assist/`, `server/ai/free.ts`; rules: `supabase/migrations/20261112090000_free_ai.sql`.
- **Feedback:** every game has a feedback board (`/game/<slug>/feedback`), and Toki has its own (`/feedback`). Logged-in players post bug reports, ideas and other notes, reply, and vote. A bug report can be private: then only the reporter, the game's developer and admins see it. The developer (for Toki's board: admins) sets the status (open, planned, in progress, done, declined), replies with a *Developer* badge, and can hide posts. Developers see all feedback for their games in the *Feedback inbox* (`/feedback/inbox`); players see their own posts and replies on their account page. Posting is limited to 5 posts an hour and 20 a day per account, replies to 30 an hour (developers have no reply limit).
- **Updates (release notes):** a game's developer posts what changed in each version on the game's *Updates* page (`/game/<slug>/updates`); admins do the same for Toki (`/updates`). Notes are plain text, and lines starting with `-` become a list. When posting an update, the developer ticks the feedback it fixes: those posts are marked done and show "Fixed in 1.2" with a link to the update. The game page shows the latest update under *What's new*.

- **Profiles:** every account has a page at `/u/<username>` with an avatar (an uploaded picture, shrunk to 128 px in the browser, or a pixel avatar drawn from a seed), a short bio, their games, favorites and best scores. Friends also see whether they're online, which game they're playing and what they played lately.
- **Friends:** players send friend requests, which the other player accepts or declines (`/friends`). Blocking someone ends the friendship, stops requests and hides their messages.
- **Chat (`/chat`):** private messages between friends, group chats of friends (up to 20 people), a chat room on every game page and one public Toki room. At most 8 messages per 20 seconds and 200 an hour. Players report messages; admins handle reports on `/reports` (delete the message, or also ban the sender from chatting for a while). New messages arrive live (Supabase Realtime) while a chat is open.
- **Notifications (`/notifications`):** replies to your feedback, status changes ("fixed in 1.2"), friend requests and accepts, being added to a group, and losing a top-3 high score. New chat messages show as unread counts instead of notifications.
- **High scores:** games call `toki.score(points)` (from `public/toki-save.js`, times in milliseconds). Each player keeps their best score per game; the game page shows the top 10. The developer chooses whether higher or lower is better and can remove scores.
- **Free plan:** old data is deleted on a schedule (`pg_cron`) so Toki fits Supabase's free plan: room messages after 7 days, private and group messages after 30 days, notifications after 30 days (and at most 100 per player), online status after 7 days, handled reports after 30 days, per-day plays after 15 days (the totals stay), finished Toki Connect runs after 90 days and AI cost rows after 400 days (`cleanup_old_logs()`). Hosted games keep only the live version and the one before (30 days); the rest is deleted nightly from Cloudflare (`/api/hosting?action=sweep`). Game pictures are shrunk in the browser before upload (covers 1200 px, banners 2000 px, screenshots 1920 px, as WebP; GIFs stay as they are), and pictures a game no longer uses are deleted when it is saved or deleted (`src/lib/gameImages.ts`). Saves go up at most every 30 seconds while playing (at once when the page closes or is hidden), and not at all when nothing changed. Online status and the unread counts come in one request (`ping`) every 2 minutes; Realtime is only used while a chat is open.

## Tech

- Vite + React + TypeScript, hosted on Vercel (`vercel.json`)
- Supabase for logins, the games list, feedback and cover images. `supabase/schema.sql` holds everything up to the feedback system; newer changes are in `supabase/migrations/` (one file per change, applied in name order)
- Pixel-art covers are drawn in the browser (`src/pixel/scenes.ts`) when a game has no uploaded image
- `middleware.ts` fills in the title, description and image for link previews (WhatsApp, Discord, …). `api/og.ts` draws the preview image from the pixel cover
- `api/check.ts` tells members, while they fill in the game form, whether a game link can be shown inside Toki

## Checks

```sh
npm test          # unit tests and database tests
npm run typecheck
```

The database tests (`tests/db/`) run `supabase/schema.sql` and every migration in a real Postgres that runs inside the test process ([PGlite](https://pglite.dev)), then check the row level security rules as visitors, players, developers and admins. They need no Docker or Supabase account.

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
- Earlier versions are kept (`game_save_history`) and can be restored on the *Account* page for 3 days; older ones are deleted (daily `pg_cron` job and on every new copy) to save storage. Each game keeps at most 5 earlier versions and 3 conflict copies. A copy is kept every 30 minutes of play, when another device saves, and always right before a save shrinks to less than half its size (a "new game" or wipe).
- To put a save back, the script writes it into the game's storage and reloads the game. Script v2 ignores the game's own writes until the reload, because many games save their current state then (autosave, saving on close) and would write their fresh state over it. For games still on v1, when the first save after that reload is less than half the size of the save Toki gave, Toki keeps the progress, stores the new save only as a backup and offers "Load my progress".
