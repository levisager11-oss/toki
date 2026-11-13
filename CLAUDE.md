# Notes for Claude

## Every change gets a Toki release note

Whenever you change something in Toki, also post a Toki update (release notes) so players see it on `/updates`.

- Updates of Toki itself are rows in `public.game_releases` with `game_id = null`, in the live Supabase project `toki` (id `oygszctxhkubofspywzr`). Post them with the Supabase connector (`execute_sql`), after the change is pushed.
- Version: look up the latest Toki update (`select version from game_releases where game_id is null order by published_at desc limit 1`) and count up (1.1 → 1.2). Smaller fixes use a third number (1.2 → 1.2.1) and are posted with `small = true`: they show compactly under the main version instead of as a big card, and the main version stays on show.
- Write for players, in plain English: a short `title` and `notes` where lines starting with `- ` become a list. No technical words.
- If a change fixes feedback posts, link them with `set_release_fixes` (or set `fixed_in` and `status = 'done'`).

## New things for developers' games

When the script games use (`public/toki-save.js`) or the integration guide (`src/lib/integration.ts`) gets something new that developers have to add to their games:

- Make sure Toki Connect can add it (a feature in `server/connect/agent.ts`) and the instructions to copy explain it.
- Add an entry for it in `src/lib/gameUpdates.ts` (a topic, the Toki Connect feature, which games it is for, and one short sentence for the AI on what exactly to add), with its texts `devup.<topic>.title`, `.short`, `.text` and `.notif` in `src/lib/i18n.tsx`. That puts it on the card on *My games*, where each game gets one "Update with Toki Connect" that adds everything the game is missing in one run, and "Copy instructions" with all of it, plus the text of their notification. All updates together must fit in a run's 1000 characters of notes (`tests/game-updates.test.ts` checks).
- Tell the developers once the app that knows the topic is live: run `select public.notify_developers('<topic>')` with the Supabase connector. It sends one notification per developer and topic, which leads to the card.

## Stay on Supabase's free plan

The owner doesn't want to pay for Supabase if it can be avoided. When adding features:

- Delete old rows on a schedule with `pg_cron` (e.g. chat messages after 7 or 30 days, notifications after 30 days), and cap rows per player where it makes sense.
- Keep files small (shrink images in the browser before upload) and delete replaced files.
- Use Supabase Realtime sparingly: only subscribe while something is on screen, and don't listen for events that would reach everyone (like deletes). The one standing exception: while a friend is online, Toki listens for a "you got an invite" nudge (`src/lib/useBadges.ts`).
- Prefer one row that is overwritten over a growing log.

## Database changes

New changes go in `supabase/migrations/` (one file per change). They are tested in `tests/db/` (PGlite, no Docker) and applied to the live project with the Supabase connector (`apply_migration`). Run `npm test` and `npm run typecheck` before pushing.

## Texts

Every text is in English and German. The German texts use „…“ quotes and “ss” instead of “ß”. Texts live in `src/lib/i18n.tsx`; texts that only pages loaded on demand use (player pages, developer and admin pages, terms and privacy) can live in `src/lib/texts/` and are named in that page's `page()` call in `src/App.tsx`. A new text can always go into `i18n.tsx`; `tests/texts.test.ts` says when one is in the wrong place.

## Legal

Toki is run by a private person in Switzerland and is meant to be safe to use in Switzerland, the EU and the USA. Accounts are for players of 13 and older (13 to 15 with a parent's OK); the terms, the privacy policy and the legal notice are in `src/lib/texts/legalEn.ts` and `legalDe.ts`. When a change touches any of this, update those texts (and their date) in the same change:

- A new kind of data about players, a new place it is stored, or a new deletion time: the privacy policy. Add the table to `export_my_data` (the download on the account page) and make sure it is deleted with the account.
- A new outside service that sees players' data or their IP address (a host, a script, fonts, an AI service): name it in the privacy policy first. Don't load anything from other companies' servers on pages visitors see without an account.
- New things players can post where others see them: add "Report" for it (`src/components/ReportButton.tsx`, `report_content`).
- No ads, no tracking, nothing that needs a cookie banner.
- Changes to the terms are announced in a Toki update 14 days before they apply.
