-- Today's game, daily streaks and this week's best.
--
-- * Every day (UTC) one game is "Today's game". It is picked once per day from the games that
--   have high scores (by a hash of the date, never yesterday's game when there are two or
--   more) and then kept in daily_games, so it can't change during the day when another game
--   gets its first score. Admins can choose the game for today or a later day.
--   One row per day, deleted after 7 days.
-- * period_scores: each player's best score of this week (since Monday 00:00 UTC) on every
--   game, and of today on Today's game. One row per player, game and week (or day), overwritten
--   when beaten. Weeks are deleted after 2 weeks, days after 2 days.
-- * daily_streaks: one row per player, overwritten: how many days in a row they played
--   Today's game (a counted play of that game on that day), and their best streak.
-- * Like the all-time list, only logged-in players' scores count. No Realtime.

-- ---------- days and weeks ----------
create function public.utc_today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'utc')::date
$$;

-- The Monday a week starts on.
create function public.week_start(p_day date) returns date
language sql immutable set search_path = '' as $$
  select (p_day - (extract(isodow from p_day)::integer - 1))::date
$$;

-- ---------- today's game ----------
create table public.daily_games (
  day date primary key,
  game_id uuid not null references public.games(id) on delete cascade,
  -- the admin who chose it; null: picked automatically
  chosen_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index daily_games_game_idx on public.daily_games(game_id);
alter table public.daily_games enable row level security;
-- No policies: read and changed through the functions below.
revoke all on public.daily_games from anon, authenticated;

-- The game of a day: the one chosen or picked already, else picked now and kept.
create function public.daily_game_for(p_day date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_game uuid;
  v_before uuid;
  v_ids uuid[];
  v_n integer;
begin
  select game_id into v_game from public.daily_games where day = p_day;
  if v_game is not null then
    return v_game;
  end if;
  v_ids := array(
    select g.id from public.games g
    where exists (select 1 from public.game_scores s where s.game_id = g.id)
    order by g.id
  );
  v_n := cardinality(v_ids);
  if v_n = 0 then
    return null;
  end if;
  select game_id into v_before from public.daily_games where day = p_day - 1;
  if v_n >= 2 and v_before = any(v_ids) then
    v_ids := array_remove(v_ids, v_before);
    v_n := v_n - 1;
  end if;
  v_game := v_ids[1 + ((hashtextextended(p_day::text, 0) % v_n + v_n) % v_n)::integer];
  insert into public.daily_games (day, game_id) values (p_day, v_game) on conflict (day) do nothing;
  select game_id into v_game from public.daily_games where day = p_day;
  return v_game;
end $$;
revoke execute on function public.daily_game_for(date) from public, anon, authenticated;

-- Admins: choose the game for a day (today or up to 60 days ahead). p_game null: back to
-- picking automatically.
create function public.set_daily_game(p_day date, p_game uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_day is null or p_day < public.utc_today() or p_day > public.utc_today() + 60 then
    raise exception 'bad_day' using errcode = 'P0001';
  end if;
  if p_game is null then
    delete from public.daily_games where day = p_day;
    return;
  end if;
  if not exists (select 1 from public.games where id = p_game) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  insert into public.daily_games (day, game_id, chosen_by) values (p_day, p_game, auth.uid())
  on conflict (day) do update set game_id = excluded.game_id, chosen_by = excluded.chosen_by;
end $$;
revoke execute on function public.set_daily_game(date, uuid) from public, anon;
grant execute on function public.set_daily_game(date, uuid) to authenticated;

-- Admins: today's game and the days chosen ahead.
create function public.daily_schedule() returns table (day date, game_id uuid, chosen boolean)
language sql stable security definer set search_path = '' as $$
  select d.day, d.game_id, d.chosen_by is not null
  from public.daily_games d
  where d.day >= public.utc_today() and public.my_role() = 'admin'
  order by d.day
$$;
revoke execute on function public.daily_schedule() from public, anon;
grant execute on function public.daily_schedule() to authenticated;

-- ---------- this week's and today's best ----------
create table public.period_scores (
  game_id uuid not null references public.games(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  period text not null check (period in ('day', 'week')),
  -- the day, or the Monday the week starts on
  since date not null,
  score bigint not null check (score between -1000000000000 and 1000000000000),
  achieved_at timestamptz not null default now(),
  primary key (game_id, period, since, user_id)
);
create index period_scores_user_idx on public.period_scores(user_id);
alter table public.period_scores enable row level security;
-- No policies: the lists are read through period_leaderboard() and daily_today().
revoke all on public.period_scores from anon, authenticated;

-- A removed score (by its developer, or the player) also leaves this week's and today's list.
create function public.game_scores_removed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.period_scores where game_id = old.game_id and user_id = old.user_id;
  return old;
end $$;
revoke execute on function public.game_scores_removed() from public, anon, authenticated;
create trigger game_scores_removed after delete on public.game_scores
  for each row execute function public.game_scores_removed();

-- Saves the score when it beats the player's best of all time, of this week, or (on Today's
-- game) of today. Returns {"best", "new"} for all time as before, plus "week" / "week_new",
-- "day" / "day_new" (null when the game isn't Today's game), "daily" and "bar": the score a
-- new one must beat to change anything, so the game page can skip sending the others.
create or replace function public.submit_score(p_game uuid, p_score bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_today date := public.utc_today();
  v_week date := public.week_start(public.utc_today());
  v_order text;
  v_old bigint;
  v_best bigint;
  v_new boolean := false;
  v_daily boolean;
  v_week_best bigint;
  v_week_new boolean := false;
  v_day_best bigint;
  v_day_new boolean := false;
  v_rank_before uuid[];
  v_rank_after uuid[];
  v_title text;
  v_lost uuid;
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  select score_order, title into v_order, v_title from public.games where id = p_game;
  if v_order is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_score is null or p_score not between -1000000000000 and 1000000000000 then
    raise exception 'bad_score' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('score:' || p_game, 0));
  v_daily := public.daily_game_for(v_today) is not distinct from p_game;

  -- this week
  select score into v_week_best from public.period_scores
    where game_id = p_game and period = 'week' and since = v_week and user_id = v_me;
  if v_week_best is null or (case when v_order = 'high' then p_score > v_week_best else p_score < v_week_best end) then
    insert into public.period_scores (game_id, user_id, period, since, score) values (p_game, v_me, 'week', v_week, p_score)
      on conflict (game_id, period, since, user_id) do update set score = excluded.score, achieved_at = now();
    v_week_best := p_score;
    v_week_new := true;
  end if;

  -- today, on Today's game
  if v_daily then
    select score into v_day_best from public.period_scores
      where game_id = p_game and period = 'day' and since = v_today and user_id = v_me;
    if v_day_best is null or (case when v_order = 'high' then p_score > v_day_best else p_score < v_day_best end) then
      insert into public.period_scores (game_id, user_id, period, since, score) values (p_game, v_me, 'day', v_today, p_score)
        on conflict (game_id, period, since, user_id) do update set score = excluded.score, achieved_at = now();
      v_day_best := p_score;
      v_day_new := true;
    end if;
  end if;

  -- all time
  select score into v_old from public.game_scores where game_id = p_game and user_id = v_me;
  if v_old is not null and (case when v_order = 'high' then p_score <= v_old else p_score >= v_old end) then
    v_best := v_old;
  else
    v_rank_before := array(select user_id from public.game_scores where game_id = p_game
      order by case when v_order = 'high' then -score else score end, achieved_at limit 3);
    insert into public.game_scores (game_id, user_id, score) values (p_game, v_me, p_score)
      on conflict (game_id, user_id) do update set score = excluded.score, achieved_at = now();
    v_rank_after := array(select user_id from public.game_scores where game_id = p_game
      order by case when v_order = 'high' then -score else score end, achieved_at limit 3);
    -- Whoever dropped out of the top 3 because of this score hears about it.
    for v_lost in select x from unnest(v_rank_before) x where x <> v_me and not (x = any(v_rank_after)) loop
      perform public.notify(v_lost, 'score_beaten', v_me, jsonb_build_object('game', p_game, 'title', v_title));
    end loop;
    v_best := p_score;
    v_new := true;
  end if;

  return jsonb_build_object(
    'best', v_best, 'new', v_new,
    'week', v_week_best, 'week_new', v_week_new,
    'day', v_day_best, 'day_new', v_day_new,
    'daily', v_daily,
    'bar', case when v_daily then v_day_best else v_week_best end
  );
end $$;
revoke execute on function public.submit_score(uuid, bigint) from public, anon;
grant execute on function public.submit_score(uuid, bigint) to authenticated;

-- The top of this week's (p_period 'week') or today's ('day') list of a game, and the
-- logged-in player's own place. Same columns as leaderboard().
create function public.period_leaderboard(p_game uuid, p_period text, p_limit integer default 10) returns table (
  rank bigint, user_id uuid, username text, avatar_url text, avatar_seed text, score bigint, achieved_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  with g as (select score_order from public.games where id = p_game),
  ranked as (
    select rank() over (order by case when (select score_order from g) = 'high' then -s.score else s.score end) as rank,
      s.user_id, p.username, p.avatar_url, p.avatar_seed, s.score, s.achieved_at
    from public.period_scores s join public.profiles p on p.id = s.user_id
    where s.game_id = p_game and s.period = p_period
      and s.since = case when p_period = 'day' then public.utc_today() else public.week_start(public.utc_today()) end
  )
  select * from ranked where rank <= least(greatest(p_limit, 1), 50) or user_id = auth.uid()
  order by rank, achieved_at
$$;
grant execute on function public.period_leaderboard(uuid, text, integer) to anon, authenticated;

-- ---------- streaks ----------
create table public.daily_streaks (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  -- days in a row up to last_day; it counts as broken once last_day is before yesterday
  streak integer not null default 0 check (streak >= 0),
  best_streak integer not null default 0 check (best_streak >= 0),
  last_day date not null
);
alter table public.daily_streaks enable row level security;
-- Shown on profiles, like the other numbers there. Only the functions below change it.
create policy "streaks are public" on public.daily_streaks for select using (true);
revoke all on public.daily_streaks from anon, authenticated;
grant select on public.daily_streaks to anon, authenticated;

-- A counted play: when it is Today's game, the player's streak goes up (once a day).
create function public.count_daily_play(p_user uuid, p_game uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := public.utc_today();
begin
  if p_user is null or public.daily_game_for(v_day) is distinct from p_game then
    return;
  end if;
  insert into public.daily_streaks as s (user_id, streak, best_streak, last_day) values (p_user, 1, 1, v_day)
  on conflict (user_id) do update set
    streak = case when s.last_day = v_day - 1 then s.streak + 1 else 1 end,
    best_streak = greatest(s.best_streak, case when s.last_day = v_day - 1 then s.streak + 1 else 1 end),
    last_day = v_day
  where s.last_day < v_day;
end $$;
revoke execute on function public.count_daily_play(uuid, uuid) from public, anon, authenticated;

-- As before (20261118090000_playtime.sql), plus the streak.
create or replace function public.record_play(p_game uuid, p_visitor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  if not exists (select 1 from public.games where id = p_game) then
    return;
  end if;
  perform public.count_play(p_game, p_visitor);
  if v_me is not null then
    insert into public.recent_plays (user_id, game_id) values (v_me, p_game)
    on conflict (user_id, game_id) do update set played_at = now();
    delete from public.recent_plays where user_id = v_me and game_id not in (
      select game_id from public.recent_plays where user_id = v_me order by played_at desc limit 12
    );
    perform public.count_daily_play(v_me, p_game);
  end if;
end $$;
revoke execute on function public.record_play(uuid, uuid) from public;
grant execute on function public.record_play(uuid, uuid) to anon, authenticated;

-- ---------- the card on the home page ----------
-- Today's game, its top 3 today (and the logged-in player's own place), how many players
-- scored today, and the player's streak. null when no game has high scores yet.
create function public.daily_today() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_day date := public.utc_today();
  v_game uuid := public.daily_game_for(public.utc_today());
begin
  if v_game is null then
    return null;
  end if;
  return jsonb_build_object(
    'day', v_day,
    'game_id', v_game,
    'top', coalesce((
      select jsonb_agg(to_jsonb(b) order by b.rank, b.achieved_at) from public.period_leaderboard(v_game, 'day', 3) b
    ), '[]'),
    'players', (select count(*) from public.period_scores where game_id = v_game and period = 'day' and since = v_day),
    'streak', (
      select jsonb_build_object('streak', s.streak, 'best_streak', s.best_streak, 'last_day', s.last_day)
      from public.daily_streaks s where s.user_id = v_me
    )
  );
end $$;
revoke execute on function public.daily_today() from public;
grant execute on function public.daily_today() to anon, authenticated;

-- ---------- cleanup (free plan) ----------
select cron.schedule('delete-old-period-scores', '43 3 * * *', $$
  delete from public.period_scores
    where (period = 'day' and since < public.utc_today() - 2)
       or (period = 'week' and since < public.utc_today() - 14);
  delete from public.daily_games where day < public.utc_today() - 7;
$$);
