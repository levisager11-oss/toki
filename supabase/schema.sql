-- Toki database schema (already applied to the Supabase project "toki").
-- Kept here for reference and for setting up a fresh project.
-- Newer changes are in supabase/migrations/: for a fresh project, run this file, then those in name order.

create type public.user_role as enum ('admin', 'creator');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  role public.user_role not null default 'creator',
  created_at timestamptz not null default now()
);

create table public.invites (
  code text primary key check (char_length(code) between 6 and 40),
  role public.user_role not null default 'creator',
  note text check (note is null or char_length(note) <= 80),
  created_by uuid references public.profiles(id) on delete set null,
  used_by uuid references public.profiles(id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 40),
  title text not null check (char_length(title) between 1 and 60),
  description text not null default '' check (char_length(description) <= 1000),
  description_de text check (description_de is null or char_length(description_de) <= 1000),
  controls text not null default '' check (char_length(controls) <= 500),
  category text not null check (category in ('action','adventure','arcade','horror','platformer','puzzle','racing','shooter','sports','strategy','other')),
  engine text check (engine is null or char_length(engine) <= 30),
  play_url text not null check (play_url ~ '^https://' and char_length(play_url) <= 500),
  thumbnail_url text check (thumbnail_url is null or (thumbnail_url ~ '^https://' and char_length(thumbnail_url) <= 500)),
  cover text check (cover is null or char_length(cover) <= 20),
  featured boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index games_created_by_idx on public.games(created_by);
create index invites_created_by_idx on public.invites(created_by);
create index invites_used_by_idx on public.invites(used_by);

create function public.my_role() returns public.user_role
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = auth.uid()
$$;

create function public.check_invite(p_code text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.invites where code = p_code and used_by is null)
$$;

-- Every new account must carry a valid invite code + username in its signup metadata.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_code text := new.raw_user_meta_data ->> 'invite';
  v_username text := lower(new.raw_user_meta_data ->> 'username');
  v_role public.user_role;
begin
  select role into v_role from public.invites where code = v_code and used_by is null for update;
  if v_role is null then
    raise exception 'invalid_invite';
  end if;
  insert into public.profiles (id, username, role) values (new.id, v_username, v_role);
  update public.invites set used_by = new.id, used_at = now() where code = v_code;
  if v_role = 'admin' then
    update public.games set created_by = new.id where created_by is null;
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Non-admin users can't feature games or change who owns a game.
create function public.games_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and public.my_role() is distinct from 'admin' then
    if tg_op = 'INSERT' then
      new.featured := false;
      new.created_by := auth.uid();
    else
      new.featured := old.featured;
      new.created_by := old.created_by;
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger games_guard before insert or update on public.games
  for each row execute function public.games_guard();

alter table public.profiles enable row level security;
alter table public.invites enable row level security;
alter table public.games enable row level security;

create policy "profiles are public" on public.profiles for select using (true);
create policy "games are public" on public.games for select using (true);
create policy "members add games" on public.games for insert to authenticated
  with check ((select public.my_role()) is not null and created_by = (select auth.uid()));
create policy "owners or admins edit games" on public.games for update to authenticated
  using (created_by = (select auth.uid()) or (select public.my_role()) = 'admin');
create policy "owners or admins delete games" on public.games for delete to authenticated
  using (created_by = (select auth.uid()) or (select public.my_role()) = 'admin');
create policy "admins read invites" on public.invites for select to authenticated
  using ((select public.my_role()) = 'admin');
create policy "admins create invites" on public.invites for insert to authenticated
  with check ((select public.my_role()) = 'admin' and created_by = (select auth.uid()));
create policy "admins delete invites" on public.invites for delete to authenticated
  using ((select public.my_role()) = 'admin');

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.games_guard() from public, anon, authenticated;
revoke execute on function public.my_role() from public, anon;
grant execute on function public.my_role() to authenticated;
grant execute on function public.check_invite(text) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('thumbnails', 'thumbnails', true, 2097152, array['image/png','image/jpeg','image/webp','image/gif']);
create policy "members upload thumbnails" on storage.objects for insert to authenticated
  with check (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.my_role()) is not null);
create policy "members manage own thumbnails" on storage.objects for delete to authenticated
  using (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Accounts are invite-only, so an email confirmation adds nothing: confirm on creation.
create function public.auto_confirm_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email_confirmed_at is null then
    new.email_confirmed_at := now();
  end if;
  return new;
end $$;
revoke execute on function public.auto_confirm_user() from public, anon, authenticated;
create trigger auto_confirm_user before insert on auth.users
  for each row execute function public.auto_confirm_user();


-- Play counts, likes, screenshots, and one featured game at a time.
-- Visitors have no account, so each browser sends a random "visitor" id it keeps in localStorage.

create table public.game_stats (
  game_id uuid primary key references public.games(id) on delete cascade,
  plays integer not null default 0 check (plays >= 0),
  likes integer not null default 0 check (likes >= 0)
);

-- One row per game, browser and day: a browser adds at most one play per game per day.
create table public.game_plays (
  game_id uuid not null references public.games(id) on delete cascade,
  visitor uuid not null,
  day date not null default current_date,
  primary key (game_id, visitor, day)
);
create index game_plays_day_idx on public.game_plays(game_id, day);

create table public.game_likes (
  game_id uuid not null references public.games(id) on delete cascade,
  visitor uuid not null,
  created_at timestamptz not null default now(),
  primary key (game_id, visitor)
);

alter table public.game_stats enable row level security;
alter table public.game_plays enable row level security;
alter table public.game_likes enable row level security;
create policy "stats are public" on public.game_stats for select using (true);
-- game_plays and game_likes have no policies: only the functions below touch them.

create function public.record_play(p_game uuid, p_visitor uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.game_plays (game_id, visitor) values (p_game, p_visitor) on conflict do nothing;
  if found then
    insert into public.game_stats (game_id, plays) values (p_game, 1)
    on conflict (game_id) do update set plays = public.game_stats.plays + 1;
  end if;
end $$;

-- Returns the game's like count after the change.
-- Logged-in players like as their account (visitor = their user id), so a like counts once
-- per account across all their devices.
create function public.set_like(p_game uuid, p_visitor uuid, p_like boolean) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_likes integer;
  v_who uuid := coalesce(auth.uid(), p_visitor);
begin
  if p_like then
    insert into public.game_likes (game_id, visitor) values (p_game, v_who) on conflict do nothing;
    if found then
      insert into public.game_stats (game_id, likes) values (p_game, 1)
      on conflict (game_id) do update set likes = public.game_stats.likes + 1;
    end if;
  else
    delete from public.game_likes where game_id = p_game and visitor = v_who;
    if found then
      update public.game_stats set likes = greatest(likes - 1, 0) where game_id = p_game;
    end if;
  end if;
  select likes into v_likes from public.game_stats where game_id = p_game;
  return coalesce(v_likes, 0);
end $$;

-- Daily plays for the last 14 days (oldest first) for the caller's games, or all games for admins.
create function public.my_game_stats() returns table (game_id uuid, daily integer[])
language sql stable security definer set search_path = '' as $$
  select g.id,
    array(
      select count(p.visitor)::integer
      from generate_series(current_date - 13, current_date, interval '1 day') d
      left join public.game_plays p on p.game_id = g.id and p.day = d::date
      group by d order by d
    )
  from public.games g
  where g.created_by = auth.uid() or public.my_role() = 'admin'
$$;

revoke execute on function public.record_play(uuid, uuid) from public;
revoke execute on function public.set_like(uuid, uuid, boolean) from public;
revoke execute on function public.my_game_stats() from public, anon;
grant execute on function public.record_play(uuid, uuid) to anon, authenticated;
grant execute on function public.set_like(uuid, uuid, boolean) to anon, authenticated;
grant execute on function public.my_game_stats() to authenticated;

-- Up to 4 screenshot links per game.
create function public.all_https(urls text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(u ~ '^https://' and char_length(u) <= 500), true) from unnest(urls) u
$$;
alter table public.games add column screenshots text[] not null default '{}'
  check (cardinality(screenshots) <= 4 and public.all_https(screenshots));

-- Only one featured game: featuring a game un-features the others in the same step.
create function public.games_single_featured() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.games set featured = false where featured and id <> new.id;
  return null;
end $$;
revoke execute on function public.games_single_featured() from public, anon, authenticated;
create trigger games_single_featured after insert or update of featured on public.games
  for each row when (new.featured) execute function public.games_single_featured();


-- Player accounts: anyone can sign up to play. An invite code makes a creator or admin.
alter type public.user_role add value if not exists 'player';

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_code text := nullif(trim(new.raw_user_meta_data ->> 'invite'), '');
  v_username text := lower(new.raw_user_meta_data ->> 'username');
  v_role public.user_role := 'player';
begin
  if v_code is not null then
    select role into v_role from public.invites where code = v_code and used_by is null for update;
    if v_role is null then
      raise exception 'invalid_invite';
    end if;
  end if;
  insert into public.profiles (id, username, role) values (new.id, v_username, v_role);
  if v_code is not null then
    update public.invites set used_by = new.id, used_at = now() where code = v_code;
  end if;
  if v_role = 'admin' then
    update public.games set created_by = new.id where created_by is null;
  end if;
  return new;
end $$;

-- A player who gets an invite later can use it to become a creator (or admin).
create function public.redeem_invite(p_code text) returns public.user_role
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.user_role;
begin
  if auth.uid() is null then
    raise exception 'login_required';
  end if;
  update public.invites set used_by = auth.uid(), used_at = now()
    where code = p_code and used_by is null returning role into v_role;
  if v_role is null then
    raise exception 'invalid_invite';
  end if;
  update public.profiles set role = v_role where id = auth.uid() and role = 'player';
  return v_role;
end $$;
revoke execute on function public.redeem_invite(text) from public, anon;
grant execute on function public.redeem_invite(text) to authenticated;

-- Only creators and admins add games and upload images.
alter policy "members add games" on public.games
  with check ((select public.my_role()) in ('admin', 'creator') and created_by = (select auth.uid()));
alter policy "members upload thumbnails" on storage.objects
  with check (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.my_role()) in ('admin', 'creator'));

-- Cloud saves: one save per player per game. data = { "keys": { ... }, "t": <ms timestamp> }.
create table public.game_saves (
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  game_id uuid not null references public.games(id) on delete cascade,
  data jsonb not null check (pg_column_size(data) <= 1048576),
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
create index game_saves_game_idx on public.game_saves(game_id);
alter table public.game_saves enable row level security;
create policy "own saves: read" on public.game_saves for select to authenticated using (user_id = (select auth.uid()));
create policy "own saves: add" on public.game_saves for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own saves: change" on public.game_saves for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own saves: delete" on public.game_saves for delete to authenticated using (user_id = (select auth.uid()));


-- Per game: send cross-origin isolation headers (COOP/COEP) only for games that need them,
-- e.g. Godot 4 exports with threads. Every other game page gets no such headers.
alter table public.games add column needs_isolation boolean not null default false;

-- Safe cloud saves. A device sends its save together with the account versions it knows
-- ("bases": the "t" of the account save it started from). A save only replaces the account
-- copy when it was made on top of it. Otherwise the account copy stays and the other save
-- is kept as a conflict copy. Earlier versions are kept so a bad overwrite can be undone.
alter table public.game_saves add column device text check (device is null or char_length(device) <= 64);

create table public.game_save_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  game_id uuid not null references public.games(id) on delete cascade,
  data jsonb not null check (pg_column_size(data) <= 1048576),
  kind text not null check (kind in ('earlier', 'conflict')),
  device text check (device is null or char_length(device) <= 64),
  saved_at timestamptz not null default now()
);
create index game_save_history_user_game_idx on public.game_save_history(user_id, game_id, id desc);
create index game_save_history_game_idx on public.game_save_history(game_id);
alter table public.game_save_history enable row level security;
create policy "own save history: read" on public.game_save_history for select to authenticated using (user_id = (select auth.uid()));

-- The "t" of a save, or null.
create function public.save_t(d jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(d -> 't') = 'number' then (d ->> 't')::numeric end
$$;

-- Keeps the 10 newest earlier versions and the 5 newest conflict copies per player and game.
create function public.trim_save_history(p_user uuid, p_game uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.game_save_history h
  where h.user_id = p_user and h.game_id = p_game
    and h.id not in (
      select id from (
        select id, row_number() over (partition by kind order by id desc) as n
        from public.game_save_history where user_id = p_user and game_id = p_game
      ) r where (kind = 'earlier' and n <= 10) or (kind = 'conflict' and n <= 5)
    )
$$;

-- Returns {"ok": true} when the save is now the account save, or {"ok": false, "current": <account save>}.
create function public.put_game_save(p_game uuid, p_data jsonb, p_bases numeric[], p_device text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_t numeric := public.save_t(p_data);
  v_cur jsonb;
  v_cur_device text;
  v_last timestamptz;
begin
  if v_user is null then
    raise exception 'login_required';
  end if;
  if v_t is null or v_t <= 0 or jsonb_typeof(p_data -> 'keys') is distinct from 'object' then
    raise exception 'bad_save';
  end if;
  p_device := left(p_device, 64);
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || p_game::text, 0));
  select data, device into v_cur, v_cur_device from public.game_saves where user_id = v_user and game_id = p_game;

  if v_cur is null then
    insert into public.game_saves (user_id, game_id, data, device, updated_at) values (v_user, p_game, p_data, p_device, now());
    return jsonb_build_object('ok', true);
  end if;
  if public.save_t(v_cur) = v_t then
    return jsonb_build_object('ok', true); -- already stored (a repeated request)
  end if;

  if public.save_t(v_cur) = any(coalesce(p_bases, '{}')) then
    -- Keep the replaced version when another device made it, every 30 minutes of play, or when
    -- the new save is less than half the size (a "new game" or wipe), so a reset can be undone.
    select max(saved_at) into v_last from public.game_save_history
      where user_id = v_user and game_id = p_game and kind = 'earlier';
    if v_cur_device is distinct from p_device or v_last is null or v_last < now() - interval '30 minutes'
      or octet_length(p_data::text) * 2 < octet_length(v_cur::text) then
      insert into public.game_save_history (user_id, game_id, data, kind, device) values (v_user, p_game, v_cur, 'earlier', v_cur_device);
      perform public.trim_save_history(v_user, p_game);
    end if;
    update public.game_saves set data = p_data, device = p_device, updated_at = now() where user_id = v_user and game_id = p_game;
    return jsonb_build_object('ok', true);
  end if;

  -- Made on top of an older version (or none): keep the account copy, and this save as a conflict copy (one per device).
  update public.game_save_history set data = p_data, saved_at = now()
    where user_id = v_user and game_id = p_game and kind = 'conflict' and device is not distinct from p_device;
  if not found then
    insert into public.game_save_history (user_id, game_id, data, kind, device) values (v_user, p_game, p_data, 'conflict', p_device);
    perform public.trim_save_history(v_user, p_game);
  end if;
  return jsonb_build_object('ok', false, 'current', v_cur);
end $$;

-- Makes a kept version the account save again (as the newest one, so every device picks it up).
create function public.restore_game_save(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_game uuid;
  v_data jsonb;
  v_cur jsonb;
  v_cur_device text;
begin
  select game_id, data into v_game, v_data from public.game_save_history where id = p_id and user_id = v_user;
  if v_game is null then
    raise exception 'not_found';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || v_game::text, 0));
  select data, device into v_cur, v_cur_device from public.game_saves where user_id = v_user and game_id = v_game;
  v_data := jsonb_set(v_data, '{t}', to_jsonb(greatest(floor(extract(epoch from clock_timestamp()) * 1000), coalesce(public.save_t(v_cur), 0) + 1)));
  if v_cur is not null then
    insert into public.game_save_history (user_id, game_id, data, kind, device) values (v_user, v_game, v_cur, 'earlier', v_cur_device);
    perform public.trim_save_history(v_user, v_game);
  end if;
  insert into public.game_saves (user_id, game_id, data, device, updated_at) values (v_user, v_game, v_data, null, now())
    on conflict (user_id, game_id) do update set data = excluded.data, device = null, updated_at = now();
  return v_data;
end $$;

revoke execute on function public.trim_save_history(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.put_game_save(uuid, jsonb, numeric[], text) from public, anon;
revoke execute on function public.restore_game_save(bigint) from public, anon;
grant execute on function public.put_game_save(uuid, jsonb, numeric[], text) to authenticated;
grant execute on function public.restore_game_save(bigint) to authenticated;

-- Saves are only written through put_game_save / restore_game_save, so no device can
-- overwrite newer progress directly.
drop policy "own saves: add" on public.game_saves;
drop policy "own saves: change" on public.game_saves;


-- Likes follow the account. After logging in, a browser hands its earlier likes to the account
-- (a game liked on two devices then counts once), and every device loads the account's likes.
-- Returns how many likes were moved or merged.
create function public.claim_likes(p_visitor uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_dups integer;
  v_moved integer;
begin
  if v_me is null or p_visitor = v_me then
    return 0;
  end if;
  with dup as (
    delete from public.game_likes b
    where b.visitor = p_visitor
      and exists (select 1 from public.game_likes a where a.game_id = b.game_id and a.visitor = v_me)
    returning b.game_id
  )
  update public.game_stats s set likes = greatest(s.likes - 1, 0) from dup where s.game_id = dup.game_id;
  get diagnostics v_dups = row_count;
  update public.game_likes set visitor = v_me where visitor = p_visitor;
  get diagnostics v_moved = row_count;
  return v_dups + v_moved;
end $$;

-- Games the logged-in player likes, newest first.
create function public.my_likes() returns table (game_id uuid, slug text)
language sql stable security definer set search_path = '' as $$
  select l.game_id, g.slug
  from public.game_likes l join public.games g on g.id = l.game_id
  where l.visitor = auth.uid()
  order by l.created_at desc
$$;

revoke execute on function public.claim_likes(uuid) from public, anon;
revoke execute on function public.my_likes() from public, anon;
grant execute on function public.claim_likes(uuid) to authenticated;
grant execute on function public.my_likes() to authenticated;

-- Earlier versions and conflict copies are kept for 3 days, then deleted to save storage.
-- They are removed when new versions are kept, and once an hour for everyone else.
create or replace function public.trim_save_history(p_user uuid, p_game uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.game_save_history h
  where h.user_id = p_user and h.game_id = p_game
    and (h.saved_at < now() - interval '3 days'
      or h.id not in (
        select id from (
          select id, row_number() over (partition by kind order by id desc) as n
          from public.game_save_history where user_id = p_user and game_id = p_game
        ) r where (kind = 'earlier' and n <= 10) or (kind = 'conflict' and n <= 5)
      ))
$$;
revoke execute on function public.trim_save_history(uuid, uuid) from public, anon, authenticated;

create index game_save_history_saved_at_idx on public.game_save_history(saved_at);

create extension if not exists pg_cron;
select cron.schedule('delete-old-save-history', '17 * * * *',
  $$delete from public.game_save_history where saved_at < now() - interval '3 days'$$);

-- Players only see and restore versions from the last 3 days, even before the hourly cleanup ran.
alter policy "own save history: read" on public.game_save_history
  using (user_id = (select auth.uid()) and saved_at >= now() - interval '3 days');

create or replace function public.restore_game_save(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_game uuid;
  v_data jsonb;
  v_cur jsonb;
  v_cur_device text;
begin
  select game_id, data into v_game, v_data from public.game_save_history
    where id = p_id and user_id = v_user and saved_at >= now() - interval '3 days';
  if v_game is null then
    raise exception 'not_found';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text || v_game::text, 0));
  select data, device into v_cur, v_cur_device from public.game_saves where user_id = v_user and game_id = v_game;
  v_data := jsonb_set(v_data, '{t}', to_jsonb(greatest(floor(extract(epoch from clock_timestamp()) * 1000), coalesce(public.save_t(v_cur), 0) + 1)));
  if v_cur is not null then
    insert into public.game_save_history (user_id, game_id, data, kind, device) values (v_user, v_game, v_cur, 'earlier', v_cur_device);
    perform public.trim_save_history(v_user, v_game);
  end if;
  insert into public.game_saves (user_id, game_id, data, device, updated_at) values (v_user, v_game, v_data, null, now())
    on conflict (user_id, game_id) do update set data = excluded.data, device = null, updated_at = now();
  return v_data;
end $$;
revoke execute on function public.restore_game_save(bigint) from public, anon;
grant execute on function public.restore_game_save(bigint) to authenticated;
