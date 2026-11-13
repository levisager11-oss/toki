# Setting up Toki's AI

Every AI feature on Toki uses Claude, through Anthropic's API, and each feature has its own model:
small helpers for players and developers (translations, similar feedback, game suggestions, "Ask
AI", release note drafts, descriptions, summaries) and Toki Connect, which adds Toki saves and high
scores to a game: it reads the game's code, may ask the developer questions, and opens a pull
request.

Almost everything is set up on Toki itself, on the **AI** page (`/admin/ai`, admins only). Do it on
the real site (`https://www.playtoki.app`), not on a preview, because the GitHub App remembers the
address it was created from.

## 0. The privacy policy follows these settings by itself

The privacy policy (`/privacy`) says whether the AI features are on and names the AI service that
gets players' text (Anthropic). It reads that from the settings on the **AI** page: switching AI on
or off, or entering another address for Anthropic's API, changes the policy and its date right
away. Nothing to edit.

## 1. Supabase key in Vercel (once, the only step outside Toki)

The server needs it to use the database, and to keep the other keys encrypted.

1. Supabase → project **toki** → Project Settings → **API Keys**. Under "Secret keys", copy the key
   (or click "New secret key" and copy that one). It starts with `sb_secret_`.
2. Vercel → project **toki** → Settings → **Environment Variables** → Add New.
   Name: `SUPABASE_SECRET_KEY`, value: the key, environments: Production and Preview. Save.
3. Vercel → Deployments → newest deployment → … → **Redeploy**.

The AI page shows these steps with direct links, and a "Check again" button.

## 2. Anthropic key (on Toki)

Make an API key in the Claude Console (API keys), paste it on the AI page and save. Before it is
saved, Toki asks Anthropic whether the key works (it lists the models, which costs nothing), so a
mistyped key is never stored; when Anthropic can't be reached, "Save it anyway" stores it
unchecked. The AI page checks the key in use again each time it opens. The server stores keys encrypted (AES-256-GCM, with a key derived from the Supabase secret
key), and nobody can read them back, not even admins. If you ever change the Supabase secret key,
save the key again.

## 3. Turn on the AI (on Toki, one click)

Once the key works, **Turn on AI** switches the AI on with a monthly cap of $50 for all of Toki and
$5 a month per developer (where nothing is set yet), then makes one tiny test call. If your
Anthropic account has no credit yet, it says so right away (Claude Console → Billing). Every
feature with a model below is then on; change the limits on the same page any time.

## 4. GitHub App (on Toki)

Click **Create the GitHub App**. Toki sends GitHub a filled-in app description (a "manifest"):
read and write access to code and pull requests only, no webhooks, callback
`https://www.playtoki.app/connect/github`, "request user authorization during installation" on.
On GitHub's page, click **Create GitHub App** (change the name there if it's taken). GitHub sends
you back to Toki with a one-time code; the server exchanges it for the app's credentials and stores
them encrypted.

## 5. AI settings (on Toki)

The *AI settings* card has the main switch (off: no feature works and nothing is sent to
Anthropic), an optional other address for Anthropic's API (empty: `https://api.anthropic.com`),
Toki's monthly cap and the quota per developer, and Toki Connect's settings. Set a monthly cap
first: with $0 nothing can run.

## 6. A model per feature (on Toki)

The *A model per feature* card (table `ai_features`) has one row per feature: its Claude model,
how much it may think (sent as "effort") and its prices per million tokens. Known Claude models are
always in the lists and fill in their list prices (`src/lib/claudeModels.ts`); **Find models** adds
the ones the key can use. A feature without a model is off, and its buttons don't show. Each row
has **Test this model** (a tiny call that shows up in the list of calls), and **Test every
feature** tries them all at once.

| Feature | Who | Starts with |
| --- | --- | --- |
| `translate`: posts, replies, chat messages and game descriptions (each translation is saved for 30 days) | players | Haiku |
| `similar`: similar feedback before posting | players | Haiku |
| `suggest`: "You might like" on the home page (saved for a day per account) | players | Haiku |
| `help`: "Ask AI" on a game's page | players | Haiku |
| `learn`: learns a game from its GitHub repository for "Ask AI" | developers | Haiku |
| `release`: release note drafts (from a few words, ticked feedback and commits) | developers | Haiku |
| `describe`: game descriptions in both languages, and reading new games in one-click adding | developers | Haiku |
| `summary`: summaries of the feedback inbox and of applications, prompts for a coding AI | developers | Haiku |
| `connect`: the Toki Connect steps that write code (also Managed Agents) | developers | Sonnet |
| `connect_steps`: Toki Connect's easy steps (reading code, asking the developer); off: `connect` does them | developers | Haiku |
| `connect_quick`: leaderboard code in one-click "Add your game"; off: one-click adding leaves the code alone | developers | Sonnet |
| `moderate`: a first look at open reports on `/reports` (remove / keep / unsure, with a reason, kept on the report; an admin always decides). Works from the day the terms allow it (`TERMS_NEXT_DATE` in `src/lib/terms.ts`, 28 November 2026) | admins | off |

The prompts are in `server/assist/prompts.ts` and `server/assist/help.ts`; the helpers' server code
is `api/assist.ts`.

- **Structured outputs:** every helper that answers in JSON (translations, similar feedback,
  suggestions, release notes, descriptions, reading a new game, the coding-AI prompt, the report
  check) sends its JSON schema (`server/assist/schemas.ts`), so the answer always parses. A model
  that doesn't know structured outputs gets asked again without.
- **Prompt caching:** the parts that stay the same between calls are cached (read back at a tenth
  of the price): Ask AI's instructions and the conversation so far (the player's progress comes
  last, as a system message in the conversation), the board's posts for similar feedback, and
  Toki Connect's files.
- **Batches:** "Learn from GitHub" runs as a Message Batch at half the price (`server/ai/batch.ts`).
  The batch is kept on the game's row (`game_help.learn_batch`) and collected when the developer's
  form looks again (every 20 seconds while it's open) or a player asks the helper. With another
  address for Anthropic's API that has no batches, it is learned right away as before.
- **Streaming:** Ask AI's answers show word by word (`stream: true`, one JSON object per line).
- **Errors:** a busy Anthropic (429, 529) is retried by the SDK and then shows "very busy, try again
  in a minute"; a refused key or an account without credit shows players "the AI isn't working right
  now" and admins the exact reason on the AI page.

- **Ask AI (game helper):** a button on every game's page opens a small chat under the game for
  players who are stuck or have a question about Toki. It answers from the game's description and
  controls, the developer's tips, a short player's guide it learned once from the game's GitHub
  repository, and a guide to Toki (`server/assist/help.ts`). It also knows where the asking player
  is: the game page sends their save in this game as short text (`src/lib/saveSummary.ts`: at most
  6000 characters, long lists and packed data shortened, logins and e-mail addresses left out), and
  the server adds their best score and playtime. Developers set it up at the bottom of
  their game's form ("AI helper for players"): tips, and "Learn from GitHub" (one call, saved in
  `game_help`; "Learn again" after an update).

Every call counts against Toki's monthly cap; developers also have their quota. On top of that,
every account may use each feature only so often an hour (the `ai_…` limits on `/admin/limits`,
e.g. 120 translations, 10 suggestions; the Connect features share `ai_connect`). Players have no
money quota: the calls per hour and the monthly cap hold them. Rules:
`supabase/migrations/20261204090000_ai_feature_models.sql`.

"Fix with AI" on a bug report (developers and admins) starts a Toki Connect run that fixes the bug
and opens a pull request. It uses the `connect` model and its limits.

Buttons only show when the feature behind them is on (`ai_status()` lists them): without a
`connect` model, Toki Connect's runs and "Fix with AI" are hidden, and the Toki Connect page only
connects GitHub (which the helpers use for update drafts and the game helper).

## 7. Toki Connect with Claude Managed Agents (optional)

The AI page offers "Toki Connect with Claude Managed Agents"
(off by default). Then a Connect run (adding saves/high scores, or "Fix with AI") doesn't send
files to the AI step by step: a Claude agent works in its own copy of the repository on
Anthropic's servers, finds what it needs itself, and can try things. With it off, Connect works
step by step as before.

- **Read-only:** the agent gets a GitHub token that can only read that one repository, and the
  token never enters its sandbox. When done, it writes its changes into one JSON file; Toki checks
  them (paths, sizes, no `.github/`) and opens the pull request itself.
- **It talks to Toki through two tools:** `ask_developer` (the run pauses for the developer's
  answers, as before) and `finish`.
- **Cheap by design:** short instructions (read only what's needed, smallest change, no installs
  or long test runs), no web access, the model and thinking level of the `connect` feature, and a hard
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
Toki: `ANTHROPIC_API_KEY`, and for a GitHub App made by hand `GITHUB_APP_ID`, `GITHUB_APP_SLUG`,
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
  feature's calls per hour, the developer's quota for the month and Toki's monthly cap. After the
  answer, the real cost replaces the reservation. So requests at the same time can't overspend
  either.
- Only developers have a quota. Admins have none of their own, and players are held by the calls
  per hour; the monthly cap applies to everyone.
- Months are calendar months in UTC.
- One run makes at most 8 AI calls and can only change the requested features. Changes to
  `.github/` are refused (only Toki itself adds the build file, see above).

## Anthropic

`server/ai/anthropic.ts` calls Claude through the official SDK, streamed. On the newest Claude
models (Fable 5.2 and 5.1, Opus 5.5 and 5, Sonnet 5.5) it turns on Anthropic's server-side fallback: if Anthropic's safety checks decline a
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
