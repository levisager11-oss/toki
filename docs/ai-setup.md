# Setting up Toki's AI (Toki Connect)

Toki Connect lets developers have an AI add Toki saves and high scores to their game: it reads the
game's GitHub repository, may ask the developer questions, and opens a pull request.

Almost everything is set up on Toki itself, on the **AI** page (`/admin/ai`, admins only). Do it on
the real site (`https://www.playtoki.app`), not on a preview, because the GitHub App remembers the
address it was created from.

## 0. Name the AI service in the privacy policy (before switching AI on)

The privacy policy (`src/lib/texts/legalEn.ts` and `legalDe.ts`) says the AI features are switched
off and that the AI service will be named before they are switched on. So before enabling AI on the
**AI** page, change the "AI features" section to name the service and its country, add it to "Who
helps run Toki", change the date at the top, and post a Toki update about it.

## 1. Supabase key in Vercel (once, the only step outside Toki)

The server needs it to use the database, and to keep the other keys encrypted.

1. Supabase → project **toki** → Project Settings → **API Keys**. Under "Secret keys", copy the key
   (or click "New secret key" and copy that one). It starts with `sb_secret_`.
2. Vercel → project **toki** → Settings → **Environment Variables** → Add New.
   Name: `SUPABASE_SECRET_KEY`, value: the key, environments: Production and Preview. Save.
3. Vercel → Deployments → newest deployment → … → **Redeploy**.

The AI page shows these steps with direct links, and a "Check again" button.

## 2. AI key (on Toki)

Pick the provider in the AI settings first (an OpenAI-compatible endpoint, or Anthropic), then
paste its key on the AI page and save. Each provider has its own key, so you can switch between
them. The server stores keys encrypted (AES-256-GCM, with a key derived from the Supabase secret
key), and nobody can read them back, not even admins. If you ever change the Supabase secret key,
save the keys again.

## 3. GitHub App (on Toki)

Click **Create the GitHub App**. Toki sends GitHub a filled-in app description (a "manifest"):
read and write access to code and pull requests only, no webhooks, callback
`https://www.playtoki.app/connect/github`, "request user authorization during installation" on.
On GitHub's page, click **Create GitHub App** (change the name there if it's taken). GitHub sends
you back to Toki with a one-time code; the server exchanges it for the app's credentials and stores
them encrypted.

## 4. AI settings (on Toki)

Fill in the endpoint address (the part before `/chat/completions`, e.g.
`https://api.example.com/v1`; for Anthropic leave it empty), the model, and the prices per million
tokens from your provider's price list. **Find models** asks the provider which models it offers, so
you can search them; when the provider tells the prices (OpenRouter does, and for Claude models Toki
knows the list prices), they are filled in, but check them. Toki counts costs with these prices; without them the AI can't be turned on. Check the
monthly cap ($20) and the quota per developer ($5), turn the AI on, save, and **Test the
connection** (it costs a tiny amount and shows up in the list of calls).

## 5. Free AI (on Toki)

Next to the "strong AI" above (prices, quotas, the monthly cap; used to write code), Toki has a
**Free AI**: an OpenAI-compatible endpoint where tokens cost nothing (e.g. a school's endpoint). It
uses the same key as the OpenAI-compatible endpoint (`AI_API_KEY`). Fill in its address and model
in the *Free AI* card on the AI page, turn it on, save and test it.

**Key:** the free AI can have its own key (the "Own key" field in the Free AI card, or
`FREE_AI_API_KEY` in Vercel). Without one, it uses the OpenAI-compatible key, but only when the
strong AI is Anthropic or the same endpoint, so the strong AI's key never goes to another service.

It does the small helpers (`api/assist.ts`, prompts in `server/assist/prompts.ts`):

- **Translate** posts, replies, chat messages and game descriptions between English and German
  (on request; each translation is saved for 30 days, so it's made once).
- **Similar feedback:** before a bug report or idea is posted, it points to posts about the same thing.
- **You might like:** game suggestions on the home page, from what a player liked and played
  (saved for a day per account).
- For developers: **release note drafts** (from a few words, the ticked feedback and the commits
  on GitHub since the last update), **game descriptions** in both languages, a **summary of
  the feedback inbox**, and a **prompt for a coding AI** made from a game's open feedback (the free AI
  sorts out posts that don't help and puts the same wishes together; Toki writes the prompt around
  its tasks, without the players' own words or links: `improvePrompt` in `server/assist/prompts.ts`). For admins: a **summary of a developer application** (with what its links show).
- **Toki Connect's easy steps** (if ticked): it reads the code and asks the developer; only the
  step that writes the change uses the strong AI. If the free AI fails, the strong AI takes over.

- **Ask AI (game helper):** a button on every game's page opens a small chat under the game for
  players who are stuck or have a question about Toki. It answers from the game's description and
  controls, the developer's tips, a short player's guide it learned once from the game's GitHub
  repository, and a guide to Toki (`server/assist/help.ts`). It also knows where the asking player
  is: the game page sends their save in this game as short text (`src/lib/saveSummary.ts`: at most
  6000 characters, long lists and packed data shortened, logins and e-mail addresses left out), and
  the server adds their best score and playtime. Developers set it up at the bottom of
  their game's form ("AI helper for players"): tips, and "Learn from GitHub" (one call, saved in
  `game_help`; "Learn again" after an update).

There are no prices, so instead every account may use each helper only so often an hour
(`ai_free_take` in `supabase/migrations/20261112090000_free_ai.sql`, e.g. 120 translations, 10
suggestions). Calls are counted per day and helper (one row each) and shown on the AI page.

"Fix with AI" on a bug report (developers and admins) starts a Toki Connect run that fixes the bug
and opens a pull request. It uses the strong AI and its limits.

Buttons only show when the AI behind them is on (`ai_status()`): without the strong AI, Toki
Connect's runs and "Fix with AI" are hidden, and the Toki Connect page only connects GitHub (which
the free helpers use for update drafts and the game helper).

## 6. Toki Connect with Claude Managed Agents (optional, Anthropic only)

With the strong AI on Anthropic, the AI page offers "Toki Connect with Claude Managed Agents"
(off by default). Then a Connect run (adding saves/high scores, or "Fix with AI") doesn't send
files to the AI step by step: a Claude agent works in its own copy of the repository on
Anthropic's servers, finds what it needs itself, and can try things. With any other provider, or
with it off, Connect works step by step as before.

- **Read-only:** the agent gets a GitHub token that can only read that one repository, and the
  token never enters its sandbox. When done, it writes its changes into one JSON file; Toki checks
  them (paths, sizes, no `.github/`) and opens the pull request itself.
- **It talks to Toki through two tools:** `ask_developer` (the run pauses for the developer's
  answers, as before) and `finish`.
- **Cheap by design:** short instructions (read only what's needed, smallest change, no installs
  or long test runs), no web access, the thinking level from the strong AI's settings, and a hard
  cap per run ("Most per run", $1 by default) that Anthropic enforces. The whole cap is reserved
  from the developer's quota and Toki's monthly cap while the run works; afterwards only its real
  cost counts (`ai_settle_amount`).
- The agent and its environment are created once by the server and stored in `ai_settings`
  (`agent_id`, `environment_id`); a change of model or thinking level updates the agent to a new
  version. Each run's session can be watched in the Anthropic Console (Managed Agents → Sessions).
- Code: `server/connect/managed.ts` (the run's steps), `server/connect/managedClient.ts` (the SDK
  calls); rules: `supabase/migrations/20261112130000_connect_agent.sql`.

## Using Vercel's settings instead

Every key can also be set as an environment variable in Vercel; those win over what is stored on
Toki: `AI_API_KEY`, `ANTHROPIC_API_KEY`, and for a GitHub App made by hand `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` (the whole `.pem`).
A GitHub App made by hand needs: callback URL `https://www.playtoki.app/connect/github`, "Request
user authorization (OAuth) during installation" on, webhook off, repository permissions Contents,
Pull requests, Workflows and Actions read and write, installable by any account.

**Workflows permission (for games that must be built first).** Toki adds a build file
(`.github/workflows/toki.yml`) to a game's repository with a pull request, and GitHub only lets an
app touch workflow files with the "Workflows: Read and write" permission. Apps set up before
this don't have it: add it on GitHub (Settings → Developer settings → GitHub Apps → the Toki app →
Permissions & events → Repository permissions → Workflows), then each account that installed the
app approves the new permission once. Until then, Toki gives developers GitHub's "new file" page
with the build file filled in instead (one click on "Commit changes"), so it works either way.

**Actions permission (to start the first build).** When a game's repository has the build file
already, Toki starts the first build itself, which needs "Actions: Read and write". Apps set up
before this don't have it (add it the same way). Until then, the first build starts with the next
push, and Toki shows the developer a link to GitHub's "Run workflow" button.

## How the limits work

- Before every AI call, the server reserves the call's highest possible cost (the request's size
  plus the most it may answer). The database checks, under one lock, that this fits the
  developer's quota for the month and Toki's monthly cap. After the answer, the real cost replaces
  the reservation. So requests at the same time can't overspend either.
- Admins have no quota of their own; the monthly cap applies to everyone.
- Months are calendar months in UTC.
- One run makes at most 8 AI calls and can only change the requested features. Changes to
  `.github/` are refused (only Toki itself adds the build file, see above).

## Anthropic

`server/ai/anthropic.ts` calls Claude through the official SDK, streamed. On the newest Claude
models it turns on Anthropic's server-side fallback: if Anthropic's safety checks decline a
request, Anthropic answers it with another fitting model in the same call, instead of failing.
To turn that off, empty the `WITH_FALLBACK` list there. A refused request that isn't answered shows
up as `ai_refused`.

One Connect call may answer with up to 32,000 tokens (enough for whole files). Only what the model
really writes is paid for; the budget only holds back the most a call could cost until it's done.

## Endpoints with a broken certificate chain

Some servers send their HTTPS certificate without the right intermediate certificate. Browsers
quietly fetch the missing one, so the site works there, but Node.js (and so Toki's server) refuses
the connection ("unable to verify the first certificate"). `server/tls.ts` does what browsers do:
on exactly that error it downloads the missing intermediate from the address written in the
server's certificate, checks every signature up to a trusted root, and repeats the request. The
connection stays fully verified. The admin page shows the endpoint's error under "Find models", so
problems like this are visible.
