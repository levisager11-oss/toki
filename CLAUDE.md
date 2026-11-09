# Notes for Claude

## Every change gets a Toki release note

Whenever you change something in Toki, also post a Toki update (release notes) so players see it on `/updates`.

- Updates of Toki itself are rows in `public.game_releases` with `game_id = null`, in the live Supabase project `toki` (id `oygszctxhkubofspywzr`). Post them with the Supabase connector (`execute_sql`), after the change is pushed.
- Version: look up the latest Toki update (`select version from game_releases where game_id is null order by published_at desc limit 1`) and count up (1.1 → 1.2). Smaller fixes may use a third number (1.2 → 1.2.1).
- Write for players, in plain English: a short `title` and `notes` where lines starting with `- ` become a list. No technical words.
- If a change fixes feedback posts, link them with `set_release_fixes` (or set `fixed_in` and `status = 'done'`).

## Stay on Supabase's free plan

The owner doesn't want to pay for Supabase if it can be avoided. When adding features:

- Delete old rows on a schedule with `pg_cron` (e.g. chat messages after 7 or 30 days, notifications after 30 days), and cap rows per player where it makes sense.
- Keep files small (shrink images in the browser before upload) and delete replaced files.
- Use Supabase Realtime sparingly: only subscribe while something is on screen, and don't listen for events that would reach everyone (like deletes).
- Prefer one row that is overwritten over a growing log.

## Database changes

New changes go in `supabase/migrations/` (one file per change). They are tested in `tests/db/` (PGlite, no Docker) and applied to the live project with the Supabase connector (`apply_migration`). Run `npm test` and `npm run typecheck` before pushing.

## Texts

Every text is in English and German (`src/lib/i18n.tsx`). The German texts use „…“ quotes and “ss” instead of “ß”.
