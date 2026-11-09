-- Player profiles: an avatar (an uploaded picture or a pixel avatar), a short bio, and for
-- friends: whether the player is online, what they're playing and what they played lately.
--
-- Built for Supabase's free plan: avatars are shrunk in the browser (at most 100 KB), online
-- status is one small row per player that is overwritten, and old rows are deleted by pg_cron.

alter table public.profiles
  add column bio text not null default '' check (char_length(bio) <= 200),
  add column avatar_url text check (avatar_url is null or (avatar_url ~ '^https://' and char_length(avatar_url) <= 500)),
  -- Seed for the pixel avatar drawn in the browser. Changing it draws a new one.
  add column avatar_seed text check (avatar_seed is null or char_length(avatar_seed) <= 20),
  -- Set by admins when a player broke the chat rules: no chatting or friend requests until then.
  add column banned_until timestamptz;

-- Players change only their bio and avatar. Username, role and bans stay with the server.
create policy "own profile: change" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
revoke update on public.profiles from anon, authenticated;
grant update (bio, avatar_url, avatar_seed) on public.profiles to authenticated;
-- Bans are only for admins and the player themself to see.
revoke select on public.profiles from anon, authenticated;
grant select (id, username, role, created_at, bio, avatar_url, avatar_seed) on public.profiles to anon, authenticated;

create function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.bio := btrim(new.bio);
  new.avatar_seed := nullif(btrim(new.avatar_seed), '');
  return new;
end $$;
revoke execute on function public.profiles_guard() from public, anon, authenticated;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.profiles_guard();

-- Whether the logged-in account may chat and send friend requests right now.
create function public.not_banned() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select banned_until is null or banned_until < now() from public.profiles where id = auth.uid()), false)
$$;
revoke execute on function public.not_banned() from public, anon;
grant execute on function public.not_banned() to authenticated;

-- Avatars: small pictures, each account in its own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 102400, array['image/png','image/jpeg','image/webp']);
create policy "players upload avatars" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "players delete own avatars" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Online status: one row per player, overwritten every few minutes while Toki is open.
create table public.presence (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  last_seen timestamptz not null default now(),
  -- the game the player has open, if any
  game_id uuid references public.games(id) on delete set null
);
create index presence_game_idx on public.presence(game_id);

-- The last 12 games a logged-in player played (for their friends to see).
create table public.recent_plays (
  user_id uuid not null references public.profiles(id) on delete cascade,
  game_id uuid not null references public.games(id) on delete cascade,
  played_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
create index recent_plays_game_idx on public.recent_plays(game_id);

alter table public.presence enable row level security;
alter table public.recent_plays enable row level security;
-- Read rules are added with friends (next migration). Writes only through the functions below.
revoke all on public.presence, public.recent_plays from anon, authenticated;

create function public.heartbeat(p_game uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    return;
  end if;
  insert into public.presence (user_id, last_seen, game_id)
  values (auth.uid(), now(), (select id from public.games where id = p_game))
  on conflict (user_id) do update set last_seen = now(), game_id = excluded.game_id;
end $$;
revoke execute on function public.heartbeat(uuid) from public, anon;
grant execute on function public.heartbeat(uuid) to authenticated;

-- A play also goes into the player's recently played list when they're logged in.
create or replace function public.record_play(p_game uuid, p_visitor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  insert into public.game_plays (game_id, visitor) values (p_game, p_visitor) on conflict do nothing;
  if found then
    insert into public.game_stats (game_id, plays) values (p_game, 1)
    on conflict (game_id) do update set plays = public.game_stats.plays + 1;
  end if;
  if v_me is not null and exists (select 1 from public.games where id = p_game) then
    insert into public.recent_plays (user_id, game_id) values (v_me, p_game)
    on conflict (user_id, game_id) do update set played_at = now();
    delete from public.recent_plays where user_id = v_me and game_id not in (
      select game_id from public.recent_plays where user_id = v_me order by played_at desc limit 12
    );
  end if;
end $$;
revoke execute on function public.record_play(uuid, uuid) from public;
grant execute on function public.record_play(uuid, uuid) to anon, authenticated;

-- Online status of players who closed Toki a week ago isn't needed any more.
select cron.schedule('delete-old-presence', '23 3 * * *',
  $$delete from public.presence where last_seen < now() - interval '7 days'$$);
