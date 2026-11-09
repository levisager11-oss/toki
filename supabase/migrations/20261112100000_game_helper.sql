-- The AI game helper ("Ask AI" on a game's page, with the free AI): players ask when they're stuck
-- or have a question about Toki. It answers from the game's texts, the developer's notes, and what
-- it learned once from the game's GitHub repository (a short player's guide, made when the
-- developer asks for it). One row per game, overwritten; deleted with the game.
--
-- Also: which AI is on, for the pages, so buttons only show when the AI behind them works.

create table public.game_help (
  game_id uuid primary key references public.games(id) on delete cascade,
  -- tips the developer wrote for the helper (e.g. how to beat level 3)
  notes text not null default '' check (char_length(notes) <= 4000),
  -- the repository it learned from, from a GitHub connection of the developer
  installation_id bigint,
  repo text check (repo is null or (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' and char_length(repo) <= 200)),
  -- what the free AI learned from it: a short player's guide
  guide text not null default '' check (char_length(guide) <= 8000),
  learned_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.game_help enable row level security;
-- The game's developer and admins see it (to edit it); players only get the helper's answers.
create policy "game help: developer reads" on public.game_help for select to authenticated
  using ((select public.my_role()) = 'admin'
    or exists (select 1 from public.games g where g.id = game_id and g.created_by = (select auth.uid())));
revoke all on public.game_help from anon, authenticated;
grant select on public.game_help to authenticated;

-- Which AI is on: "free" for the small helpers, "strong" for Toki Connect and bug fixes.
create function public.ai_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('free', free_enabled, 'strong', enabled) from public.ai_settings where id = 1),
                  '{"free": false, "strong": false}'::jsonb)
$$;
revoke execute on function public.ai_status() from public;
grant execute on function public.ai_status() to anon, authenticated;

-- Limits now also for the helper's answers ("help") and for learning a repository ("learn").
create or replace function public.ai_free_take(p_user uuid, p_feature text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.user_role;
  v_limit integer;
  v_calls integer;
begin
  if not public.ai_free_on() then
    raise exception 'free_off' using errcode = 'P0001';
  end if;
  select role into v_role from public.profiles where id = p_user;
  v_limit := case p_feature
    when 'translate' then 120
    when 'similar' then 30
    when 'suggest' then 10
    when 'help' then 40
    when 'release' then 30
    when 'describe' then 30
    when 'summary' then 30
    when 'learn' then 10
    when 'connect' then 60
    when 'test' then 30
  end;
  if v_role is null or v_limit is null
     or (p_feature in ('release', 'describe', 'summary', 'learn', 'connect') and v_role = 'player')
     or (p_feature = 'test' and v_role <> 'admin') then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  insert into public.ai_free_limits as l (user_id, feature, window_start, calls)
    values (p_user, p_feature, now(), 1)
    on conflict (user_id, feature) do update
      set calls = case when l.window_start < now() - interval '1 hour' then 1 else l.calls + 1 end,
          window_start = case when l.window_start < now() - interval '1 hour' then now() else l.window_start end
    returning calls into v_calls;
  if v_calls > v_limit then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
end $$;
revoke execute on function public.ai_free_take(uuid, text) from public, anon, authenticated;
grant execute on function public.ai_free_take(uuid, text) to service_role;
