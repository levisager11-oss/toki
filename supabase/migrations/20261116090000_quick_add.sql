-- One-click "Add your game": the AI reads the game, proposes its details, and adds leaderboard
-- support. For that, Toki Connect also works on a game uploaded to Toki (not only on a GitHub
-- repository): it reads the live version's files and puts its change live as the next version.
--
-- * ai_settings.quick_code_ai: which AI writes that leaderboard code: the free AI (no cost), the
--   strong AI (counts towards the developer's quota), or none. Set by admins on the AI page.
-- * connect_jobs.source: 'github' (as before) or 'upload' (a game hosted on Toki; no installation).
-- * connect_jobs.ai: which AI makes the change for this run ('strong' as before, or 'free').

alter table public.ai_settings
  add column quick_code_ai text not null default 'free' check (quick_code_ai in ('free', 'strong', 'off'));
grant update (quick_code_ai) on public.ai_settings to authenticated;

alter table public.connect_jobs
  add column source text not null default 'github' check (source in ('github', 'upload')),
  add column ai text not null default 'strong' check (ai in ('strong', 'free')),
  alter column installation_id drop not null,
  add constraint connect_jobs_installation_check check (source = 'upload' or installation_id is not null);
grant select (source, ai) on public.connect_jobs to authenticated;
