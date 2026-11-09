# Setting up Toki's AI (Toki Connect)

Toki Connect lets developers have an AI add Toki saves and high scores to their game: it reads the
game's GitHub repository, may ask the developer questions, and opens a pull request.

You need three things: an AI endpoint, a Supabase secret key, and a GitHub App. Keys go into
Vercel's environment variables, never into the code or the database.

## 1. Supabase secret key

Supabase → project **toki** → Project Settings → API Keys → create or copy a **secret key**
(`sb_secret_…`). It lets the server write AI costs and Connect runs; it skips row level security,
so keep it secret.

## 2. GitHub App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**:

| Field | Value |
| --- | --- |
| GitHub App name | e.g. `Toki Connect` (the address name, e.g. `toki-connect`, is the "slug") |
| Homepage URL | `https://www.playtoki.app` |
| Callback URL | `https://www.playtoki.app/connect/github` |
| Request user authorization (OAuth) during installation | **on** (Toki uses this to check which installations belong to whom) |
| Webhook → Active | **off** |
| Repository permissions | **Contents: Read and write**, **Pull requests: Read and write**, Metadata: Read-only. Nothing else (no Workflows). |
| Where can this GitHub App be installed? | **Any account** |

After creating it: note the **App ID** and **Client ID**, generate a **client secret**, and
generate a **private key** (a `.pem` file).

## 3. Vercel environment variables

Vercel → project **toki** → Settings → Environment Variables (Production, and Preview if you want
to try it there):

| Name | Value |
| --- | --- |
| `AI_API_KEY` | the key of your OpenAI-compatible endpoint |
| `SUPABASE_SECRET_KEY` | the secret key from step 1 |
| `GITHUB_APP_ID` | the App ID |
| `GITHUB_APP_SLUG` | the app's address name, e.g. `toki-connect` |
| `GITHUB_APP_CLIENT_ID` | the Client ID |
| `GITHUB_APP_CLIENT_SECRET` | the client secret |
| `GITHUB_APP_PRIVATE_KEY` | the whole content of the `.pem` file |

Then redeploy (Deployments → … → Redeploy), so the functions see the new values.

## 4. On Toki

Open **AI** in the admin menu (`/admin/ai`):

1. *Setup* should show all three keys as set.
2. Fill in the endpoint address (the part before `/chat/completions`, e.g. `https://api.example.com/v1`),
   the model, and the prices per million tokens from your provider's price list. Toki counts costs
   with these prices; without them the AI can't be turned on.
3. Check the monthly cap ($20) and the quota per developer ($5), turn the AI on, save.
4. **Test the connection.** The test call costs a tiny amount and shows up in the list of calls.

## How the limits work

- Before every AI call, the server reserves the call's highest possible cost (the request's size
  plus the most it may answer). The database checks, under one lock, that this fits the
  developer's quota for the month and Toki's monthly cap. After the answer, the real cost replaces
  the reservation. So requests at the same time can't overspend either.
- Admins have no quota of their own; the monthly cap applies to everyone.
- Months are calendar months in UTC.
- One run makes at most 8 AI calls and can only change the requested features. Changes to
  `.github/` are refused, and the app has no permission for workflows anyway.

## Adding Anthropic later

`server/ai/provider.ts` has one `complete()` function for all providers. Adding Anthropic means
another case there (and its own key variable), and allowing `'anthropic'` in the `provider` column
of `ai_settings` with a migration.
