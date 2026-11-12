# Setting up game hosting (Cloudflare R2)

With this set up, developers can **upload** a game (ZIP, folder or one HTML file), let it **follow a
GitHub branch** (every push updates it, like Vercel), or have an **AI agent / GitHub Action** publish
it with an upload key. Every game runs at its own address, e.g. `https://snake.playtoki.app/`.

It's free on Cloudflare's free plan: R2 gives 10 GB of storage and charges nothing when players
download games. Toki keeps all games together under 9.5 GB and each developer under 1 GB.

How it fits together:

- The browser (or the upload script) asks Toki's server for upload links, then sends the files
  **straight to Cloudflare R2**. They never pass through Vercel or Supabase.
- A small **Cloudflare Worker** (`cloudflare/games-worker/`) serves `<game>.playtoki.app` from the
  bucket, and adds Toki's save script to each game's start page.
- Games run at `<game>.playtoki.app` and not `<game>.games.playtoki.app`, because Cloudflare's free
  certificate only covers one level of subdomain. A deeper level would need the paid "Advanced
  Certificate Manager".

You need the Cloudflare account that has `playtoki.app`, and about 15 minutes.

## 1. Create the bucket

1. Cloudflare dashboard → **R2 Object Storage**. If asked, turn R2 on. It asks for a payment
   method, but the free amounts are not charged.
2. **Create bucket** → name `toki-games` → location: Automatic → Create.
3. Open the bucket → **Settings** → **CORS policy** → Edit, and paste:

```json
[
  {
    "AllowedOrigins": ["https://www.playtoki.app", "https://playtoki.app", "http://localhost:5173"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

This lets the website upload into the bucket. Nothing else can (each upload link is signed and
works for one file, one hour).

Keep the bucket **private**: don't turn on "Public access" or the r2.dev address. The Worker
reads it directly.

## 2. Make an R2 key for Toki

1. R2 → **Manage R2 API tokens** (or "API" → "Manage API tokens") → **Create API token**.
2. Permissions: **Object Read & Write**. Specify bucket: **only `toki-games`**. TTL: forever.
3. Create, then copy the **Access Key ID** and the **Secret Access Key**. The secret is shown
   once.
4. Also copy your **Account ID** (R2 overview page, right side, or the dashboard URL).

## 3. Point `*.playtoki.app` at Cloudflare

DNS → Records → **Add record**:

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| AAAA | `*` | `100::` | **Proxied** (orange cloud) |

Keep the records for `playtoki.app` and `www` exactly as they are (pointing to Vercel, usually
"DNS only", grey cloud). Names with their own record don't use the `*` record. If `www` is
proxied, the Worker passes it through unchanged, but every visit to Toki then counts against the
Worker's free 100,000 requests a day. Grey is better.

## 4. Deploy the Worker

With Node.js on your computer, in this repository:

```bash
cd cloudflare/games-worker
npx wrangler login
npx wrangler deploy
```

`wrangler.toml` already has the route (`*.playtoki.app/*`), the bucket (`toki-games`) and the
settings. To do it in the dashboard instead: Workers & Pages → Create → Worker → paste
`worker.js` with `lib.js` inlined, add an R2 binding `BUCKET` → `toki-games`, the variables from
`wrangler.toml`, and the route `*.playtoki.app/*`.

## 5. Turn it on in Toki

On Toki: **Admin → Game hosting**. Enter the Account ID, Access Key ID, Secret Access Key, bucket
`toki-games` and domain `playtoki.app`, then **Save and test**. It should say "Works".

(Instead, you can set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` and
`GAMES_DOMAIN` in Vercel's environment variables. Those win over what is saved on Toki.)

Developers now see **Upload to Toki** and **From GitHub** in the game form, and **Upload keys** on
*My games*.

## 6. GitHub auto-updates (games that follow a branch)

GitHub tells Toki about pushes through the Toki GitHub App's webhook.

- **A GitHub App created on Toki from now on** has this turned on already.
- **The app you created before**: on GitHub → Settings → Developer settings → GitHub Apps → your
  Toki app → **General**: tick **Webhook → Active**, URL `https://www.playtoki.app/api/github`,
  make up a long random **Webhook secret**, and save. Then **Permissions & events** → *Subscribe to
  events* → tick **Push** → save. Finally, on Toki: Admin → Game hosting → *GitHub auto-updates* →
  paste the same secret. (If the app's keys are in Vercel's settings, set `GITHUB_WEBHOOK_SECRET`
  there instead.)

Each push to a followed branch downloads that commit and puts the chosen folder live. Games that
must be built first (`npm run build`, engine exports) use the GitHub Action shown on *My games*.

## Clean-up and limits

- Each upload replaces the game right away. The version before is kept for **30 days** so the
  developer can roll back; older versions, unfinished uploads and the files of deleted games are
  deleted every night (Vercel cron → `/api/hosting?action=sweep`) and after each upload.
- Per game: 100 MB, 3000 files. Per developer: 1 GB. All games: 9.5 GB.
- Worker free plan: 100,000 requests a day. A game loads roughly 5 to 50 files, so that's about
  2,000 to 20,000 plays a day. If Toki outgrows it, the Workers paid plan is $5 a month.
- Files up to 50 MB are also kept in Cloudflare's cache for a day (a build's files never change),
  so a popular game costs few R2 reads. That saves R2 reads and time only: every file is still one
  Worker request, cached or not, so it doesn't raise the 100,000 a day.
