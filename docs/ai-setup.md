# Setting up Toki's AI (Toki Connect)

Toki Connect lets developers have an AI add Toki saves and high scores to their game: it reads the
game's GitHub repository, may ask the developer questions, and opens a pull request.

Almost everything is set up on Toki itself, on the **AI** page (`/admin/ai`, admins only). Do it on
the real site (`https://www.playtoki.app`), not on a preview, because the GitHub App remembers the
address it was created from.

## 1. Supabase key in Vercel (once, the only step outside Toki)

The server needs it to use the database, and to keep the other keys encrypted.

1. Supabase → project **toki** → Project Settings → **API Keys**. Under "Secret keys", copy the key
   (or click "New secret key" and copy that one). It starts with `sb_secret_`.
2. Vercel → project **toki** → Settings → **Environment Variables** → Add New.
   Name: `SUPABASE_SECRET_KEY`, value: the key, environments: Production and Preview. Save.
3. Vercel → Deployments → newest deployment → … → **Redeploy**.

The AI page shows these steps with direct links, and a "Check again" button.

## 2. AI key (on Toki)

Paste the key of your OpenAI-compatible endpoint on the AI page and save. The server stores it
encrypted (AES-256-GCM, with a key derived from the Supabase secret key), and nobody can read it
back, not even admins. If you ever change the Supabase secret key, save the AI key again.

## 3. GitHub App (on Toki)

Click **Create the GitHub App**. Toki sends GitHub a filled-in app description (a "manifest"):
read and write access to code and pull requests only, no webhooks, callback
`https://www.playtoki.app/connect/github`, "request user authorization during installation" on.
On GitHub's page, click **Create GitHub App** (change the name there if it's taken). GitHub sends
you back to Toki with a one-time code; the server exchanges it for the app's credentials and stores
them encrypted.

## 4. AI settings (on Toki)

Fill in the endpoint address (the part before `/chat/completions`, e.g.
`https://api.example.com/v1`), the model, and the prices per million tokens from your provider's
price list. Toki counts costs with these prices; without them the AI can't be turned on. Check the
monthly cap ($20) and the quota per developer ($5), turn the AI on, save, and **Test the
connection** (it costs a tiny amount and shows up in the list of calls).

## Using Vercel's settings instead

Every key can also be set as an environment variable in Vercel; those win over what is stored on
Toki: `AI_API_KEY`, and for a GitHub App made by hand `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` (the whole `.pem`).
A GitHub App made by hand needs: callback URL `https://www.playtoki.app/connect/github`, "Request
user authorization (OAuth) during installation" on, webhook off, repository permissions Contents
and Pull requests read and write, installable by any account.

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
another case there (and its own key, stored like the AI key), and allowing `'anthropic'` in the
`provider` column of `ai_settings` with a migration.
