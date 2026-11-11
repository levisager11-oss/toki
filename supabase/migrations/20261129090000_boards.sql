-- Boards: several high-score lists per game.
--
-- Every game keeps its one list as before: the main board, id '' (its order and format are the
-- game's score_order and score_format, and toki.score(points) goes there). On top of that, a
-- game can have up to 10 more boards (e.g. one per level, mode or difficulty), each with a short
-- id, a name in English (and German, if given), its own order (higher or lower is better) and
-- format (points or a time). Games send to one with toki.score(points, "id"); ids a game doesn't
-- have on Toki are ignored. The developer may also name the main board (games.board_name).
--
-- * game_scores and period_scores get a board column, part of their keys: still one row per
--   player, game and board (and week or day), overwritten when beaten, so this stays small.
-- * Today's game, its day list and streaks stay on the main board. This week's lists work on
--   every board.
-- * Removing a board deletes its scores. No Realtime.

-- ---------- the boards ----------
alter table public.games
  -- what the main list is called (null: "Main" in the app), when the game has more boards
  add column board_name text check (board_name is null or char_length(board_name) between 1 and 40),
  add column board_name_de text check (board_name_de is null or char_length(board_name_de) between 1 and 40);

create table public.game_boards (
  game_id uuid not null references public.games(id) on delete cascade,
  -- what the game calls toki.score(points, id) with (the same rules as achievement ids)
  id text not null check (id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$'),
  position smallint not null default 0,
  name text not null check (char_length(name) between 1 and 40),
  name_de text check (name_de is null or char_length(name_de) between 1 and 40),
  score_order text not null default 'high' check (score_order in ('high', 'low')),
  score_format text not null default 'points' check (score_format in ('points', 'time')),
  created_at timestamptz not null default now(),
  primary key (game_id, id)
);
alter table public.game_boards enable row level security;
create policy "boards are public" on public.game_boards for select using (true);
-- Changes only through set_boards().
revoke all on public.game_boards from anon, authenticated;
grant select on public.game_boards to anon, authenticated;

-- ---------- scores per board ----------
alter table public.game_scores
  add column board text not null default '' check (board = '' or board ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$');
alter table public.game_scores drop constraint game_scores_pkey;
alter table public.game_scores add primary key (game_id, board, user_id);
drop index public.game_scores_board_idx;
create index game_scores_board_idx on public.game_scores(game_id, board, score desc);

alter table public.period_scores
  add column board text not null default '' check (board = '' or board ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$');
alter table public.period_scores drop constraint period_scores_pkey;
alter table public.period_scores add primary key (game_id, board, period, since, user_id);

-- Whether higher ('high') or lower ('low') is better on a board; null: the game has no such board.
create function public.board_order(p_game uuid, p_board text) returns text
language sql stable security definer set search_path = '' as $$
  select case when coalesce(p_board, '') = '' then (select score_order from public.games where id = p_game)
    else (select score_order from public.game_boards where game_id = p_game and id = p_board) end
$$;
revoke execute on function public.board_order(uuid, text) from public, anon, authenticated;

-- A removed score (by its developer, or the player) also leaves this week's and today's list of
-- its board (as in 20261127090000_daily_and_weekly.sql, now per board).
create or replace function public.game_scores_removed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.period_scores where game_id = old.game_id and board = old.board and user_id = old.user_id;
  return old;
end $$;

-- A removed board takes its scores along.
create function public.game_boards_removed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.game_scores where game_id = old.game_id and board = old.id;
  delete from public.period_scores where game_id = old.game_id and board = old.id;
  return old;
end $$;
revoke execute on function public.game_boards_removed() from public, anon, authenticated;
create trigger game_boards_removed after delete on public.game_boards
  for each row execute function public.game_boards_removed();

-- ---------- the developer's list ----------

-- Sets a game's boards: p_list is a JSON array of {id, name, name_de, score_order, score_format},
-- in the order to show them. An entry with id "" names the main board ({id: "", name, name_de};
-- its order and format stay the game's own). At most 10 others. p_mode, as for achievements:
-- - 'replace' (the game's form): the list as it is; boards left out are deleted, with their scores.
-- - 'merge' (toki.json): adds new ones (as many as fit) and updates the ones listed; deletes
--   nothing, so an upload never takes scores away from players.
-- - 'add' (proposed by Toki Connect): only adds the ones the game doesn't have yet (as many as
--   fit), and names the main board only when it has no name yet.
-- For the game's developer and admins, and for the server (toki.json, Toki Connect), which has no
-- account. Returns how many boards (besides the main one) the game has now.
create function public.set_boards(p_game uuid, p_list jsonb, p_mode text default 'replace') returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_ids text[] := '{}';
  v_id text;
  v_main jsonb;
  v_main_name text;
  v_main_de text;
  v_have integer;
  v_last integer;
begin
  if auth.uid() is not null and not public.feedback_manager(p_game) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.games where id = p_game) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_mode is null or p_mode not in ('replace', 'merge', 'add') or p_list is null or jsonb_typeof(p_list) <> 'array' then
    raise exception 'bad_boards' using errcode = 'P0001';
  end if;
  for v_item in select e from jsonb_array_elements(p_list) e loop
    v_id := case when jsonb_typeof(v_item) = 'object' then v_item->>'id' end;
    if v_id = '' then
      -- the main board: only its name
      if v_main is not null or char_length(btrim(coalesce(v_item->>'name', ''))) > 40 or char_length(btrim(coalesce(v_item->>'name_de', ''))) > 40 then
        raise exception 'bad_boards' using errcode = 'P0001';
      end if;
      v_main := v_item;
      continue;
    end if;
    if v_id is null or v_id !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$' or v_id = any(v_ids)
      or char_length(btrim(coalesce(v_item->>'name', ''))) not between 1 and 40
      or char_length(btrim(coalesce(v_item->>'name_de', ''))) > 40
      or coalesce(v_item->>'score_order', 'high') not in ('high', 'low')
      or coalesce(v_item->>'score_format', 'points') not in ('points', 'time') then
      raise exception 'bad_boards' using errcode = 'P0001';
    end if;
    v_ids := v_ids || v_id;
  end loop;
  if cardinality(v_ids) > 10 then
    raise exception 'too_many_boards' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('boards:' || p_game, 0));

  if v_main is not null then
    v_main_name := nullif(btrim(coalesce(v_main->>'name', '')), '');
    v_main_de := nullif(btrim(coalesce(v_main->>'name_de', '')), '');
    update public.games set board_name = v_main_name, board_name_de = v_main_de
    where id = p_game and (board_name, board_name_de) is distinct from (v_main_name, v_main_de)
      and (p_mode <> 'add' or (board_name is null and v_main_name is not null));
  end if;

  if p_mode = 'replace' then
    delete from public.game_boards where game_id = p_game and not (id = any(v_ids));
  end if;
  if p_mode in ('replace', 'merge') then
    update public.game_boards b set
      position = x.n, name = btrim(x.e->>'name'), name_de = nullif(btrim(coalesce(x.e->>'name_de', '')), ''),
      score_order = coalesce(x.e->>'score_order', b.score_order), score_format = coalesce(x.e->>'score_format', b.score_format)
    from jsonb_array_elements(p_list) with ordinality as x(e, n)
    where b.game_id = p_game and b.id = x.e->>'id';
  end if;
  -- The new ones, after the others ('add'; in the list's order otherwise), as many as fit.
  select count(*), coalesce(max(position), 0) into v_have, v_last from public.game_boards where game_id = p_game;
  insert into public.game_boards (game_id, id, position, name, name_de, score_order, score_format)
  select p_game, x.e->>'id', case when p_mode = 'add' then v_last + row_number() over (order by x.n) else x.n end,
    btrim(x.e->>'name'), nullif(btrim(coalesce(x.e->>'name_de', '')), ''),
    coalesce(x.e->>'score_order', 'high'), coalesce(x.e->>'score_format', 'points')
  from jsonb_array_elements(p_list) with ordinality as x(e, n)
  where x.e->>'id' <> ''
    and not exists (select 1 from public.game_boards b where b.game_id = p_game and b.id = x.e->>'id')
  order by x.n
  limit greatest(0, 10 - v_have);
  return (select count(*) from public.game_boards where game_id = p_game);
end $$;
revoke execute on function public.set_boards(uuid, jsonb, text) from public, anon;
grant execute on function public.set_boards(uuid, jsonb, text) to authenticated, service_role;

-- ---------- sending a score ----------

-- As before (20261127090000_daily_and_weekly.sql), on one board: saves the score when it beats
-- the player's best of all time or of this week on that board, or (main board of Today's game) of
-- today. A board the game doesn't have is ignored (null). Returns {"best", "new", "week",
-- "week_new", "day", "day_new", "daily", "bar", "board"}; day / daily only on the main board.
-- Whoever drops out of the board's top 3 hears about it, with the board's name.
create function public.submit_score(p_game uuid, p_score bigint, p_board text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_board text := coalesce(p_board, '');
  v_today date := public.utc_today();
  v_week date := public.week_start(public.utc_today());
  v_order text;
  v_old bigint;
  v_best bigint;
  v_new boolean := false;
  v_daily boolean := false;
  v_week_best bigint;
  v_week_new boolean := false;
  v_day_best bigint;
  v_day_new boolean := false;
  v_rank_before uuid[];
  v_rank_after uuid[];
  v_title text;
  v_board_name text;
  v_board_name_de text;
  v_note jsonb;
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
  if v_board <> '' then
    select score_order, name, name_de into v_order, v_board_name, v_board_name_de
      from public.game_boards where game_id = p_game and id = v_board;
    if not found then
      return null;
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('score:' || p_game || ':' || v_board, 0));
  if v_board = '' then
    v_daily := public.daily_game_for(v_today) is not distinct from p_game;
  end if;

  -- this week
  select score into v_week_best from public.period_scores
    where game_id = p_game and board = v_board and period = 'week' and since = v_week and user_id = v_me;
  if v_week_best is null or (case when v_order = 'high' then p_score > v_week_best else p_score < v_week_best end) then
    insert into public.period_scores (game_id, board, user_id, period, since, score) values (p_game, v_board, v_me, 'week', v_week, p_score)
      on conflict (game_id, board, period, since, user_id) do update set score = excluded.score, achieved_at = now();
    v_week_best := p_score;
    v_week_new := true;
  end if;

  -- today, on Today's game (main board)
  if v_daily then
    select score into v_day_best from public.period_scores
      where game_id = p_game and board = '' and period = 'day' and since = v_today and user_id = v_me;
    if v_day_best is null or (case when v_order = 'high' then p_score > v_day_best else p_score < v_day_best end) then
      insert into public.period_scores (game_id, board, user_id, period, since, score) values (p_game, '', v_me, 'day', v_today, p_score)
        on conflict (game_id, board, period, since, user_id) do update set score = excluded.score, achieved_at = now();
      v_day_best := p_score;
      v_day_new := true;
    end if;
  end if;

  -- all time
  select score into v_old from public.game_scores where game_id = p_game and board = v_board and user_id = v_me;
  if v_old is not null and (case when v_order = 'high' then p_score <= v_old else p_score >= v_old end) then
    v_best := v_old;
  else
    v_rank_before := array(select user_id from public.game_scores where game_id = p_game and board = v_board
      order by case when v_order = 'high' then -score else score end, achieved_at limit 3);
    insert into public.game_scores (game_id, board, user_id, score) values (p_game, v_board, v_me, p_score)
      on conflict (game_id, board, user_id) do update set score = excluded.score, achieved_at = now();
    v_rank_after := array(select user_id from public.game_scores where game_id = p_game and board = v_board
      order by case when v_order = 'high' then -score else score end, achieved_at limit 3);
    -- Whoever dropped out of the top 3 because of this score hears about it.
    v_note := jsonb_build_object('game', p_game, 'title', v_title);
    if v_board <> '' then
      v_note := v_note || jsonb_build_object('board', v_board, 'board_name', v_board_name, 'board_name_de', v_board_name_de);
    end if;
    for v_lost in select x from unnest(v_rank_before) x where x <> v_me and not (x = any(v_rank_after)) loop
      perform public.notify(v_lost, 'score_beaten', v_me, v_note);
    end loop;
    v_best := p_score;
    v_new := true;
  end if;

  return jsonb_build_object(
    'best', v_best, 'new', v_new,
    'week', v_week_best, 'week_new', v_week_new,
    'day', v_day_best, 'day_new', v_day_new,
    'daily', v_daily,
    'bar', case when v_daily then v_day_best else v_week_best end,
    'board', v_board
  );
end $$;
revoke execute on function public.submit_score(uuid, bigint, text) from public, anon;
grant execute on function public.submit_score(uuid, bigint, text) to authenticated;

-- toki.score(points) as before: the main board.
create or replace function public.submit_score(p_game uuid, p_score bigint) returns jsonb
language sql security definer set search_path = '' as $$
  select public.submit_score(p_game, p_score, '')
$$;
revoke execute on function public.submit_score(uuid, bigint) from public, anon;
grant execute on function public.submit_score(uuid, bigint) to authenticated;

-- ---------- the lists ----------

-- The top 10 of a board (p_board '': the main one), and the logged-in player's own place.
-- Called as before (p_game, p_limit), it is the main board.
drop function public.leaderboard(uuid, integer);
create function public.leaderboard(p_game uuid, p_limit integer default 10, p_board text default '') returns table (
  rank bigint, user_id uuid, username text, avatar_url text, avatar_seed text, score bigint, achieved_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  with g as (select public.board_order(p_game, coalesce(p_board, '')) as score_order),
  ranked as (
    select rank() over (order by case when (select score_order from g) = 'high' then -s.score else s.score end) as rank,
      s.user_id, p.username, p.avatar_url, p.avatar_seed, s.score, s.achieved_at
    from public.game_scores s join public.profiles p on p.id = s.user_id
    where s.game_id = p_game and s.board = coalesce(p_board, '')
  )
  select * from ranked where rank <= least(greatest(p_limit, 1), 50) or user_id = auth.uid()
  order by rank, achieved_at
$$;
grant execute on function public.leaderboard(uuid, integer, text) to anon, authenticated;

-- This week's ('week') or today's ('day', main board only) list of a board, as before.
drop function public.period_leaderboard(uuid, text, integer);
create function public.period_leaderboard(p_game uuid, p_period text, p_limit integer default 10, p_board text default '') returns table (
  rank bigint, user_id uuid, username text, avatar_url text, avatar_seed text, score bigint, achieved_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  with g as (select public.board_order(p_game, coalesce(p_board, '')) as score_order),
  ranked as (
    select rank() over (order by case when (select score_order from g) = 'high' then -s.score else s.score end) as rank,
      s.user_id, p.username, p.avatar_url, p.avatar_seed, s.score, s.achieved_at
    from public.period_scores s join public.profiles p on p.id = s.user_id
    where s.game_id = p_game and s.board = coalesce(p_board, '') and s.period = p_period
      and s.since = case when p_period = 'day' then public.utc_today() else public.week_start(public.utc_today()) end
  )
  select * from ranked where rank <= least(greatest(p_limit, 1), 50) or user_id = auth.uid()
  order by rank, achieved_at
$$;
grant execute on function public.period_leaderboard(uuid, text, integer, text) to anon, authenticated;

-- A player's best scores with their place, for the profile page, now with the board: its id, its
-- name (for the main board: the name the developer gave it, if any), how its scores are shown,
-- and whether the game has more than one board.
drop function public.player_scores(uuid);
create function public.player_scores(p_user uuid) returns table (
  game_id uuid, score bigint, rank bigint, players bigint, board text, board_name text, board_name_de text, score_format text, has_boards boolean
)
language sql stable security definer set search_path = '' as $$
  select s.game_id, s.score,
    (select count(*) + 1 from public.game_scores o where o.game_id = s.game_id and o.board = s.board
      and case when coalesce(b.score_order, g.score_order) = 'high' then o.score > s.score else o.score < s.score end),
    (select count(*) from public.game_scores o where o.game_id = s.game_id and o.board = s.board),
    s.board,
    case when s.board = '' then g.board_name else b.name end,
    case when s.board = '' then g.board_name_de else b.name_de end,
    coalesce(b.score_format, g.score_format),
    exists (select 1 from public.game_boards x where x.game_id = s.game_id)
  from public.game_scores s
  join public.games g on g.id = s.game_id
  left join public.game_boards b on b.game_id = s.game_id and b.id = s.board
  where s.user_id = p_user
  order by s.achieved_at desc
  limit 24
$$;
grant execute on function public.player_scores(uuid) to anon, authenticated;

-- ---------- Today's game: the main board ----------
-- As before, picked from games with scores on their main board.
create or replace function public.daily_game_for(p_day date) returns uuid
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
    where exists (select 1 from public.game_scores s where s.game_id = g.id and s.board = '')
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

-- ---------- the stats page ----------
-- As before (20261118090000_playtime.sql); "scores" counts the main board, and "boards" lists the
-- other boards with how many players have a score on each.
create or replace function public.game_analytics(p_game uuid, p_days integer default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 7), 365);
begin
  if not exists (select 1 from public.games g where g.id = p_game and (g.created_by = auth.uid() or public.my_role() = 'admin')) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'plays', coalesce((select plays from public.game_stats where game_id = p_game), 0),
    'likes', coalesce((select likes from public.game_stats where game_id = p_game), 0),
    'seconds', coalesce((select seconds from public.game_stats where game_id = p_game), 0),
    'players', (select count(*) from public.playtime where game_id = p_game),
    'active_players', (select count(*) from public.playtime where game_id = p_game and last_at > now() - make_interval(days => v_days)),
    'scores', (select count(*) from public.game_scores where game_id = p_game and board = ''),
    'boards', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'name_de', b.name_de,
        'scores', (select count(*) from public.game_scores s where s.game_id = p_game and s.board = b.id)) order by b.position, b.id)
      from public.game_boards b where b.game_id = p_game
    ), '[]'),
    'saves', (select count(*) from public.game_saves where game_id = p_game),
    'open_feedback', (select count(*) from public.feedback_posts
      where game_id = p_game and not hidden and status in ('open', 'planned', 'in_progress')),
    'open_bugs', (select count(*) from public.feedback_posts
      where game_id = p_game and not hidden and kind = 'bug' and status in ('open', 'planned', 'in_progress')),
    'days', (
      select jsonb_agg(jsonb_build_array(d::date, coalesce(x.plays, 0), coalesce(x.seconds, 0)) order by d)
      from generate_series(current_date - (2 * v_days - 1), current_date, interval '1 day') d
      left join public.game_days x on x.game_id = p_game and x.day = d::date
    ),
    'releases', coalesce((
      select jsonb_agg(jsonb_build_object('version', r.version, 'day', r.published_at::date) order by r.published_at)
      from public.game_releases r
      where r.game_id = p_game and r.published_at::date > current_date - 2 * v_days
    ), '[]')
  );
end $$;

-- ---------- Toki Connect can add them ----------
alter table public.connect_jobs drop constraint connect_jobs_features_check;
alter table public.connect_jobs add constraint connect_jobs_features_check check (
  (cardinality(features) between 1 and 5 and features <@ array['saves', 'scores', 'multiplayer', 'achievements', 'boards'])
  or features = array['fix']);
