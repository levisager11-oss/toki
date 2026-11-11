-- Achievements: games give players badges with toki.achievement("id") (public/toki-save.js).
--
-- The developer defines a game's achievements on Toki (the game's form) or in toki.json: a short
-- id, a name and a one-line description in English (and German, if given), and an emoji as its
-- icon. At most 30 per game. Each unlock is one small row (player, game, achievement, time), and a
-- player keeps at most 2000, so this stays tiny on the free plan. Unlocks are kept for good (they
-- are the badges), and go when the player, the game or the achievement is deleted.
-- No Realtime: the game page asks once, and adds the player's own new unlocks itself.

create table public.game_achievements (
  game_id uuid not null references public.games(id) on delete cascade,
  -- what the game calls toki.achievement() with
  id text not null check (id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$'),
  position smallint not null default 0,
  name text not null check (char_length(name) between 1 and 40),
  name_de text check (name_de is null or char_length(name_de) between 1 and 40),
  description text not null default '' check (char_length(description) <= 120),
  description_de text check (description_de is null or char_length(description_de) <= 120),
  -- an emoji
  icon text not null default '🏆' check (char_length(icon) between 1 and 16 and icon !~ '\s'),
  created_at timestamptz not null default now(),
  primary key (game_id, id)
);

create table public.achievement_unlocks (
  user_id uuid not null references public.profiles(id) on delete cascade,
  game_id uuid not null,
  achievement text not null,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, game_id, achievement),
  -- An achievement the developer removes takes its unlocks along.
  foreign key (game_id, achievement) references public.game_achievements(game_id, id) on delete cascade
);
create index achievement_unlocks_game_idx on public.achievement_unlocks(game_id, achievement);

alter table public.game_achievements enable row level security;
alter table public.achievement_unlocks enable row level security;
create policy "achievements are public" on public.game_achievements for select using (true);
create policy "unlocks are public" on public.achievement_unlocks for select using (true);
-- Changes only through the functions below.
revoke all on public.game_achievements from anon, authenticated;
revoke all on public.achievement_unlocks from anon, authenticated;
grant select on public.game_achievements to anon, authenticated;
grant select on public.achievement_unlocks to anon, authenticated;

-- ---------- the developer's list ----------

-- Sets a game's achievements: p_list is a JSON array of {id, name, name_de, description,
-- description_de, icon}, in the order to show them. p_mode:
-- - 'replace' (the game's form): the list as it is; achievements left out are deleted, with
--   players' unlocks of them.
-- - 'merge' (toki.json): adds new ones (as many as fit) and updates the ones listed; deletes
--   nothing, so an upload never takes badges away from players.
-- - 'add' (proposed by Toki Connect): only adds the ones the game doesn't have yet (as many as
--   fit), and changes nothing else.
-- For the game's developer and admins, and for the server (toki.json, Toki Connect), which has no
-- account. Returns how many achievements the game has now.
create function public.set_achievements(p_game uuid, p_list jsonb, p_mode text default 'replace') returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_ids text[] := '{}';
  v_id text;
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
    raise exception 'bad_achievements' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_list) > 30 then
    raise exception 'too_many_achievements' using errcode = 'P0001';
  end if;
  for v_item in select e from jsonb_array_elements(p_list) e loop
    v_id := case when jsonb_typeof(v_item) = 'object' then v_item->>'id' end;
    if v_id is null or v_id !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$' or v_id = any(v_ids) then
      raise exception 'bad_achievements' using errcode = 'P0001';
    end if;
    v_ids := v_ids || v_id;
  end loop;
  perform pg_advisory_xact_lock(hashtextextended('achievements:' || p_game, 0));

  if p_mode = 'replace' then
    delete from public.game_achievements where game_id = p_game and not (id = any(v_ids));
  end if;
  if p_mode in ('replace', 'merge') then
    update public.game_achievements a set
      position = x.n, name = btrim(x.e->>'name'), name_de = nullif(btrim(coalesce(x.e->>'name_de', '')), ''),
      description = coalesce(btrim(x.e->>'description'), ''), description_de = nullif(btrim(coalesce(x.e->>'description_de', '')), ''),
      icon = coalesce(nullif(btrim(coalesce(x.e->>'icon', '')), ''), '🏆')
    from jsonb_array_elements(p_list) with ordinality as x(e, n)
    where a.game_id = p_game and a.id = x.e->>'id';
  end if;
  -- The new ones, after the others ('add'; in the list's order otherwise), as many as fit.
  select count(*), coalesce(max(position), 0) into v_have, v_last from public.game_achievements where game_id = p_game;
  insert into public.game_achievements (game_id, id, position, name, name_de, description, description_de, icon)
  select p_game, x.e->>'id', case when p_mode = 'add' then v_last + row_number() over (order by x.n) else x.n end,
    btrim(x.e->>'name'), nullif(btrim(coalesce(x.e->>'name_de', '')), ''),
    coalesce(btrim(x.e->>'description'), ''), nullif(btrim(coalesce(x.e->>'description_de', '')), ''),
    coalesce(nullif(btrim(coalesce(x.e->>'icon', '')), ''), '🏆')
  from jsonb_array_elements(p_list) with ordinality as x(e, n)
  where not exists (select 1 from public.game_achievements a where a.game_id = p_game and a.id = x.e->>'id')
  order by x.n
  limit greatest(0, 30 - v_have);
  return (select count(*) from public.game_achievements where game_id = p_game);
end $$;

-- ---------- unlocking ----------

-- toki.achievement("id") for the logged-in player. An id the game doesn't have on Toki is
-- ignored (null). Unlocking again changes nothing. Returns {"new": true/false, "at": <time>}.
create function public.unlock_achievement(p_game uuid, p_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_at timestamptz;
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.game_achievements where game_id = p_game and id = p_id) then
    return null;
  end if;
  select unlocked_at into v_at from public.achievement_unlocks where user_id = v_me and game_id = p_game and achievement = p_id;
  if found then
    return jsonb_build_object('new', false, 'at', v_at);
  end if;
  if (select count(*) from public.achievement_unlocks where user_id = v_me) >= 2000 then
    return jsonb_build_object('new', false, 'full', true);
  end if;
  insert into public.achievement_unlocks (user_id, game_id, achievement) values (v_me, p_game, p_id)
    on conflict do nothing;
  return jsonb_build_object('new', found, 'at', now());
end $$;

-- After logging in, a browser hands over what was unlocked there without an account: a JSON
-- array of {game, id, at} (at: milliseconds since 1970). Unknown ones are left out. Returns how
-- many were new for the account.
create function public.claim_achievements(p_list jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_room integer;
  v_moved integer;
begin
  if v_me is null or p_list is null or jsonb_typeof(p_list) <> 'array' then
    return 0;
  end if;
  v_room := 2000 - (select count(*) from public.achievement_unlocks where user_id = v_me);
  if v_room <= 0 then
    return 0;
  end if;
  insert into public.achievement_unlocks (user_id, game_id, achievement, unlocked_at)
  select v_me, a.game_id, a.id, min(
    case when x.e->>'at' ~ '^\d{1,15}$'
      then least(now(), greatest(to_timestamp((x.e->>'at')::bigint / 1000.0), now() - interval '1 year'))
      else now() end)
  from (select e from jsonb_array_elements(p_list) with ordinality as y(e, n) where n <= 300 and jsonb_typeof(e) = 'object') x
  join public.game_achievements a on a.game_id::text = lower(x.e->>'game') and a.id = x.e->>'id'
  group by a.game_id, a.id
  limit v_room
  on conflict do nothing;
  get diagnostics v_moved = row_count;
  return v_moved;
end $$;

-- ---------- showing them ----------

-- A game's achievements in order, how many players have each, and when the logged-in player got
-- it (null: not yet).
create function public.game_achievement_list(p_game uuid) returns table (
  id text, name text, name_de text, description text, description_de text, icon text, players bigint, mine timestamptz
)
language sql stable security definer set search_path = '' as $$
  select a.id, a.name, a.name_de, a.description, a.description_de, a.icon,
    (select count(*) from public.achievement_unlocks u where u.game_id = a.game_id and u.achievement = a.id),
    (select u.unlocked_at from public.achievement_unlocks u where u.user_id = auth.uid() and u.game_id = a.game_id and u.achievement = a.id)
  from public.game_achievements a
  where a.game_id = p_game
  order by a.position, a.id
$$;

-- A player's achievements, newest first, for the profile page; total: how many they have in all.
create function public.player_achievements(p_user uuid, p_limit integer default 24) returns table (
  game_id uuid, id text, name text, name_de text, description text, description_de text, icon text, unlocked_at timestamptz, total bigint
)
language sql stable security definer set search_path = '' as $$
  select u.game_id, a.id, a.name, a.name_de, a.description, a.description_de, a.icon, u.unlocked_at, count(*) over ()
  from public.achievement_unlocks u
  join public.game_achievements a on a.game_id = u.game_id and a.id = u.achievement
  where u.user_id = p_user
  order by u.unlocked_at desc, a.position
  limit least(greatest(coalesce(p_limit, 24), 1), 100)
$$;

revoke execute on function public.set_achievements(uuid, jsonb, text) from public, anon;
revoke execute on function public.unlock_achievement(uuid, text) from public, anon;
revoke execute on function public.claim_achievements(jsonb) from public, anon;
grant execute on function public.set_achievements(uuid, jsonb, text) to authenticated, service_role;
grant execute on function public.unlock_achievement(uuid, text) to authenticated;
grant execute on function public.claim_achievements(jsonb) to authenticated;
grant execute on function public.game_achievement_list(uuid) to anon, authenticated;
grant execute on function public.player_achievements(uuid, integer) to anon, authenticated;

-- ---------- Toki Connect can add them ----------
alter table public.connect_jobs drop constraint connect_jobs_features_check;
alter table public.connect_jobs add constraint connect_jobs_features_check check (
  (cardinality(features) between 1 and 4 and features <@ array['saves', 'scores', 'multiplayer', 'achievements'])
  or features = array['fix']);
