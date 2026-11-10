-- Playtime and game analytics.
--
-- * The game page counts how long a game is on screen and sends it when the player leaves
--   (or every 10 minutes): record_playtime(). The server never credits more time than has
--   really passed since the last report of that browser (and of that account).
-- * game_days: one row per game and day (plays and seconds), kept 400 days. It replaces
--   counting game_plays rows, so game_plays (one row per browser, game and day, only needed
--   for "one play per browser per day") is now kept 2 days instead of 15.
-- * playtime: one row per player and game (total seconds), for profiles.
-- * game_analytics(): everything the stats page of a game shows, for its developer and admins.

-- ---------- tables ----------
alter table public.game_plays
  add column seconds integer not null default 0 check (seconds between 0 and 86400),
  add column last_at timestamptz not null default now();

alter table public.game_stats add column seconds bigint not null default 0 check (seconds >= 0);

create table public.game_days (
  game_id uuid not null references public.games(id) on delete cascade,
  day date not null,
  plays integer not null default 0 check (plays >= 0),
  seconds bigint not null default 0 check (seconds >= 0),
  primary key (game_id, day)
);
alter table public.game_days enable row level security;
revoke all on public.game_days from anon, authenticated;

insert into public.game_days (game_id, day, plays)
  select game_id, day, count(*) from public.game_plays group by game_id, day;

create table public.playtime (
  user_id uuid not null references public.profiles(id) on delete cascade,
  game_id uuid not null references public.games(id) on delete cascade,
  seconds integer not null default 0 check (seconds >= 0),
  last_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
create index playtime_game_idx on public.playtime(game_id);
alter table public.playtime enable row level security;
-- No policies: profiles and the stats page read it through the functions below.
revoke all on public.playtime from anon, authenticated;

-- ---------- counting plays ----------
-- Counts a play for this browser today. true when it was new (once per browser, game and day).
create function public.count_play(p_game uuid, p_visitor uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.game_plays (game_id, visitor) values (p_game, p_visitor) on conflict do nothing;
  if not found then
    return false;
  end if;
  insert into public.game_stats (game_id, plays) values (p_game, 1)
  on conflict (game_id) do update set plays = public.game_stats.plays + 1;
  insert into public.game_days (game_id, day, plays) values (p_game, current_date, 1)
  on conflict (game_id, day) do update set plays = public.game_days.plays + 1;
  return true;
end $$;
revoke execute on function public.count_play(uuid, uuid) from public, anon, authenticated;

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
  end if;
end $$;
revoke execute on function public.record_play(uuid, uuid) from public;
grant execute on function public.record_play(uuid, uuid) to anon, authenticated;

-- Adds time the game was on screen. Returns the seconds that were counted.
create function public.record_playtime(p_game uuid, p_visitor uuid, p_seconds integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_add integer;
  v_last timestamptz;
begin
  if coalesce(p_seconds, 0) <= 0 or not exists (select 1 from public.games where id = p_game) then
    return 0;
  end if;
  perform public.count_play(p_game, p_visitor);
  -- At most the time since this browser's last report (a minute extra for the first one),
  -- and at most a whole day per browser and game.
  select least(p_seconds, 86400 - gp.seconds, floor(extract(epoch from now() - gp.last_at))::integer + 60)
    into v_add
    from public.game_plays gp
    where gp.game_id = p_game and gp.visitor = p_visitor and gp.day = current_date
    for update;
  if v_me is not null then
    select last_at into v_last from public.playtime where user_id = v_me and game_id = p_game for update;
    -- An account can't collect more time than has passed, even from several browsers.
    if v_last is not null then
      v_add := least(v_add, floor(extract(epoch from now() - v_last))::integer);
    end if;
  end if;
  if coalesce(v_add, 0) <= 0 then
    return 0;
  end if;

  update public.game_plays set seconds = seconds + v_add, last_at = now()
    where game_id = p_game and visitor = p_visitor and day = current_date;
  update public.game_days set seconds = seconds + v_add where game_id = p_game and day = current_date;
  update public.game_stats set seconds = seconds + v_add where game_id = p_game;
  if v_me is not null then
    insert into public.playtime (user_id, game_id, seconds) values (v_me, p_game, v_add)
    on conflict (user_id, game_id) do update set seconds = public.playtime.seconds + v_add, last_at = now();
  end if;
  return v_add;
end $$;
revoke execute on function public.record_playtime(uuid, uuid, integer) from public;
grant execute on function public.record_playtime(uuid, uuid, integer) to anon, authenticated;

-- ---------- stats for developers ----------
-- Plays and seconds per day for the last 30 days (oldest first), for the caller's games
-- (all games for admins).
drop function public.my_game_stats();
create function public.my_game_stats() returns table (game_id uuid, daily integer[], seconds integer[])
language sql stable security definer set search_path = '' as $$
  select g.id,
    array(
      select coalesce(x.plays, 0) from generate_series(current_date - 29, current_date, interval '1 day') d
      left join public.game_days x on x.game_id = g.id and x.day = d::date order by d
    ),
    array(
      select coalesce(x.seconds, 0)::integer from generate_series(current_date - 29, current_date, interval '1 day') d
      left join public.game_days x on x.game_id = g.id and x.day = d::date order by d
    )
  from public.games g
  where g.created_by = auth.uid() or public.my_role() = 'admin'
$$;
revoke execute on function public.my_game_stats() from public, anon;
grant execute on function public.my_game_stats() to authenticated;

-- A game's stats page. p_days: the period (7 to 365 days); "days" holds twice as many days
-- (oldest first) so the page can compare with the period before. Only for the game's
-- developer and admins.
create function public.game_analytics(p_game uuid, p_days integer default 30) returns jsonb
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
    'scores', (select count(*) from public.game_scores where game_id = p_game),
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
revoke execute on function public.game_analytics(uuid, integer) from public, anon;
grant execute on function public.game_analytics(uuid, integer) to authenticated;

-- ---------- profiles ----------
-- Adds "stats" (total playtime, games played, high scores, favorites) for everyone, and the
-- most played games (with time) for the player themself and their friends, like recently played.
create or replace function public.get_profile(p_username text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  p public.profiles;
  v_relation text := 'none';
  v_close boolean;
  v_result jsonb;
begin
  select * into p from public.profiles where username = lower(p_username);
  if p.id is null then
    return null;
  end if;
  if p.id = v_me then v_relation := 'self';
  elsif v_me is null then v_relation := 'guest';
  elsif exists (select 1 from public.blocks where blocker_id = v_me and blocked_id = p.id) then v_relation := 'blocked';
  elsif exists (select 1 from public.friends where user_id = v_me and friend_id = p.id) then v_relation := 'friend';
  elsif exists (select 1 from public.friend_requests where from_id = v_me and to_id = p.id) then v_relation := 'sent';
  elsif exists (select 1 from public.friend_requests where from_id = p.id and to_id = v_me) then v_relation := 'received';
  end if;
  v_close := v_relation in ('self', 'friend');

  v_result := jsonb_build_object(
    'id', p.id,
    'username', p.username,
    'role', p.role,
    'bio', p.bio,
    'avatar_url', p.avatar_url,
    'avatar_seed', p.avatar_seed,
    'created_at', p.created_at,
    'relation', v_relation,
    'friend_count', (select count(*) from public.friends where user_id = p.id),
    'likes', coalesce((
      select jsonb_agg(game_id order by created_at desc)
      from (select game_id, created_at from public.game_likes where visitor = p.id order by created_at desc limit 24) l
    ), '[]'),
    'stats', jsonb_build_object(
      'seconds', coalesce((select sum(seconds) from public.playtime where user_id = p.id), 0),
      'games', (select count(*) from public.playtime where user_id = p.id and seconds > 0),
      'scores', (select count(*) from public.game_scores where user_id = p.id),
      'likes', (select count(*) from public.game_likes where visitor = p.id)
    )
  );
  if v_relation = 'self' then
    v_result := v_result || jsonb_build_object('banned_until', p.banned_until);
  end if;
  if v_close then
    v_result := v_result || jsonb_build_object(
      'last_seen', (select last_seen from public.presence where user_id = p.id),
      'playing', (select game_id from public.presence where user_id = p.id and last_seen > now() - interval '5 minutes'),
      'recent', coalesce((
        select jsonb_agg(game_id order by played_at desc) from public.recent_plays where user_id = p.id
      ), '[]'),
      'most_played', coalesce((
        select jsonb_agg(jsonb_build_object('game_id', game_id, 'seconds', seconds) order by seconds desc)
        from (select game_id, seconds from public.playtime where user_id = p.id and seconds > 0 order by seconds desc limit 6) m
      ), '[]')
    );
  end if;
  return v_result;
end $$;
grant execute on function public.get_profile(text) to anon, authenticated;

-- ---------- cleanup ----------
-- One play per browser per day only needs today and yesterday (a game left open over midnight).
delete from public.game_plays where day < current_date - 1;
select cron.unschedule('delete-old-plays');
select cron.schedule('delete-old-plays', '29 3 * * *',
  $$delete from public.game_plays where day < current_date - 1$$);
select cron.schedule('delete-old-game-days', '31 3 * * *',
  $$delete from public.game_days where day < current_date - 400$$);
