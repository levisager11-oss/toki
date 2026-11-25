-- A "This week" list of top players, so new players have a chance.
--
-- * player_progress gets the XP of the current week (xp_week) and the Monday that week started on
--   (week, UTC, like the weekly high scores). award() starts the count again with the first award
--   of a new week. One row per player, overwritten: no new table, nothing to clean up.
-- * top_players_week: the same list as top_players, for this week's XP. Players whose last award
--   was in an earlier week count as 0.

alter table public.player_progress
  add column xp_week integer not null default 0,
  add column week date;

create or replace function public.award(p_user uuid, p_source text, p_amount integer, p_tokens integer default 0, p_data jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.player_progress;
  v_today date := public.utc_today();
  v_week date := public.week_start(public.utc_today());
  v_xp integer := 0;
  v_tokens integer := greatest(coalesce(p_tokens, 0), 0);
  v_play integer;
  v_level integer;
  v_level_tokens integer;
begin
  if p_user is null or not exists (select 1 from public.profiles where id = p_user) then
    return;
  end if;
  insert into public.player_progress (user_id, day) values (p_user, v_today) on conflict do nothing;
  select * into p from public.player_progress where user_id = p_user for update;
  if p.week is distinct from v_week then
    p.week := v_week;
    p.xp_week := 0;
  end if;
  if p.day <> v_today then
    p.day := v_today;
    p.xp_today := 0;
    p.play_seconds_today := 0;
    p.play_xp_today := 0;
    p.score_xp_today := 0;
    p.achievement_tokens_today := 0;
  end if;

  if p_source = 'play' then
    p.play_seconds_today := least(p.play_seconds_today + greatest(coalesce(p_amount, 0), 0), 86400);
    v_play := least(120, p.play_seconds_today / 60);
    v_xp := greatest(v_play - p.play_xp_today, 0);
    p.play_xp_today := v_play;
    v_tokens := 0;
  elsif p_source = 'score' then
    v_xp := greatest(least(coalesce(p_amount, 0), 50 - p.score_xp_today), 0);
    p.score_xp_today := p.score_xp_today + v_xp;
    v_tokens := 0;
  elsif p_source = 'achievement' then
    v_xp := greatest(coalesce(p_amount, 0), 0);
    v_tokens := greatest(least(v_tokens, 50 - p.achievement_tokens_today), 0);
    p.achievement_tokens_today := p.achievement_tokens_today + v_tokens;
  elsif p_source = 'daily' then
    v_xp := greatest(coalesce(p_amount, 0), 0);
  else
    raise exception 'bad_source' using errcode = 'P0001';
  end if;
  v_xp := greatest(least(v_xp, 600 - p.xp_today), 0);
  p.xp_today := p.xp_today + v_xp;
  p.xp_week := p.xp_week + v_xp;

  v_level := public.level_for_xp(p.xp + v_xp);
  v_level_tokens := 20 * greatest(v_level - p.level, 0);
  update public.player_progress set
    xp = p.xp + v_xp, level = greatest(v_level, p.level), tokens = p.tokens + v_tokens + v_level_tokens,
    day = p.day, xp_today = p.xp_today, week = p.week, xp_week = p.xp_week, play_seconds_today = p.play_seconds_today, play_xp_today = p.play_xp_today,
    score_xp_today = p.score_xp_today, achievement_tokens_today = p.achievement_tokens_today, updated_at = now()
  where user_id = p_user;
  perform public.log_tokens(p_user, v_tokens, p_source, p_data);
  if v_level > p.level then
    perform public.log_tokens(p_user, v_level_tokens, 'level', jsonb_build_object('level', v_level));
    perform public.notify(p_user, 'level_up', null, jsonb_build_object('level', v_level, 'tokens', v_level_tokens));
  end if;
end $$;

create function public.top_players_week(p_friends boolean default false, p_limit integer default 50) returns table (
  rank bigint, user_id uuid, username text, avatar_url text, avatar_seed text, level integer, xp bigint, xp_week bigint
)
language sql stable security definer set search_path = '' as $$
  with ranked as (
    select rank() over (order by w.xp_week desc) as rank, pr.id as user_id, pr.username, pr.avatar_url, pr.avatar_seed,
      coalesce(p.level, 1) as level, coalesce(p.xp, 0) as xp, w.xp_week, pr.created_at
    from public.profiles pr
    left join public.player_progress p on p.user_id = pr.id
    cross join lateral (
      select case when p.week = public.week_start(public.utc_today()) then p.xp_week else 0 end::bigint as xp_week
    ) w
    where (not coalesce(p_friends, false) and w.xp_week > 0)
       or (coalesce(p_friends, false) and (pr.id = auth.uid() or exists (
         select 1 from public.friends f where f.user_id = auth.uid() and f.friend_id = pr.id)))
  )
  select rank, user_id, username, avatar_url, avatar_seed, level, xp, xp_week from ranked
  where rank <= least(greatest(coalesce(p_limit, 50), 1), 100) or user_id = auth.uid()
  order by rank, created_at
$$;
grant execute on function public.top_players_week(boolean, integer) to anon, authenticated;
