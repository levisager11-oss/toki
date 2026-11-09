-- Friends: a player sends a friend request, the other player accepts or declines it.
-- Only friends see each other's online status and recently played games, and only friends
-- can send each other private messages or add each other to groups.
-- Blocking someone ends the friendship, removes requests both ways and hides their messages.

create table public.friend_requests (
  from_id uuid not null references public.profiles(id) on delete cascade,
  to_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (from_id, to_id),
  check (from_id <> to_id)
);
create index friend_requests_to_idx on public.friend_requests(to_id);

-- Stored both ways (two rows per friendship), so "my friends" is a simple lookup.
create table public.friends (
  user_id uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  since timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);
create index friends_friend_idx on public.friends(friend_id);

create table public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on public.blocks(blocked_id);

alter table public.friend_requests enable row level security;
alter table public.friends enable row level security;
alter table public.blocks enable row level security;

create policy "friend requests: own" on public.friend_requests for select to authenticated
  using (from_id = (select auth.uid()) or to_id = (select auth.uid()));
create policy "friends: own" on public.friends for select to authenticated
  using (user_id = (select auth.uid()));
create policy "blocks: own" on public.blocks for select to authenticated
  using (blocker_id = (select auth.uid()));
-- Everything else goes through the functions below.
revoke all on public.friend_requests, public.friends, public.blocks from anon, authenticated;
grant select on public.friend_requests, public.friends, public.blocks to authenticated;

create function public.is_friend(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.friends where user_id = auth.uid() and friend_id = p_user)
$$;

-- Either of the two blocked the other.
create function public.is_blocked(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.blocks where (blocker_id = p_a and blocked_id = p_b) or (blocker_id = p_b and blocked_id = p_a))
$$;

-- The logged-in player and this player: either blocked the other.
create function public.blocked_with(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_blocked(auth.uid(), p_user)
$$;

-- Friends (and the player themself) see online status and recently played games.
create policy "presence: self and friends" on public.presence for select to authenticated
  using (user_id = (select auth.uid()) or public.is_friend(user_id));
create policy "recent plays: self and friends" on public.recent_plays for select to authenticated
  using (user_id = (select auth.uid()) or public.is_friend(user_id));
grant select on public.presence, public.recent_plays to authenticated;

-- Sends a request, or accepts the other player's request when they already sent one.
-- Returns 'sent', 'friends' (now friends) or 'already' (were friends already).
create function public.send_friend_request(p_user uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  if p_user = v_me or not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  if public.is_blocked(v_me, p_user) then
    raise exception 'blocked' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.friends where user_id = v_me and friend_id = p_user) then
    return 'already';
  end if;
  if exists (select 1 from public.friend_requests where from_id = p_user and to_id = v_me) then
    perform public.accept_friend(p_user);
    return 'friends';
  end if;
  if (select count(*) from public.friend_requests where from_id = v_me and created_at > now() - interval '1 day') >= 30 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  insert into public.friend_requests (from_id, to_id) values (v_me, p_user) on conflict do nothing;
  return 'sent';
end $$;

-- Makes the two friends (internal: callers check first).
create function public.accept_friend(p_from uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  delete from public.friend_requests where (from_id = p_from and to_id = v_me) or (from_id = v_me and to_id = p_from);
  insert into public.friends (user_id, friend_id) values (v_me, p_from), (p_from, v_me) on conflict do nothing;
end $$;

-- Accepts or declines a request sent to the logged-in player.
create function public.answer_friend_request(p_from uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  if not exists (select 1 from public.friend_requests where from_id = p_from and to_id = v_me) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_accept and not public.is_blocked(v_me, p_from) then
    perform public.accept_friend(p_from);
  else
    delete from public.friend_requests where from_id = p_from and to_id = v_me;
  end if;
end $$;

-- Takes back a request, or ends a friendship.
create function public.remove_friend(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  delete from public.friend_requests where from_id = v_me and to_id = p_user;
  delete from public.friends where (user_id = v_me and friend_id = p_user) or (user_id = p_user and friend_id = v_me);
end $$;

create function public.block_user(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null or p_user = v_me or not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  insert into public.blocks (blocker_id, blocked_id) values (v_me, p_user) on conflict do nothing;
  delete from public.friend_requests where (from_id = v_me and to_id = p_user) or (from_id = p_user and to_id = v_me);
  delete from public.friends where (user_id = v_me and friend_id = p_user) or (user_id = p_user and friend_id = v_me);
end $$;

create function public.unblock_user(p_user uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.blocks where blocker_id = auth.uid() and blocked_id = p_user
$$;

-- Everything a profile page shows, in one request. Online status and recently played games
-- only for the player themself and their friends. null when there's no such player.
create function public.get_profile(p_username text) returns jsonb
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
    ), '[]')
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
      ), '[]')
    );
  end if;
  return v_result;
end $$;

-- The logged-in player's friends with their online status, and open requests both ways.
create function public.my_friends() returns table (
  user_id uuid, username text, avatar_url text, avatar_seed text, role public.user_role,
  status text, last_seen timestamptz, playing uuid
)
language sql stable security definer set search_path = '' as $$
  select p.id, p.username, p.avatar_url, p.avatar_seed, p.role, x.status, pr.last_seen,
    case when pr.last_seen > now() - interval '5 minutes' then pr.game_id end
  from (
    select friend_id as id, 'friend' as status from public.friends where user_id = auth.uid()
    union all select to_id, 'sent' from public.friend_requests where from_id = auth.uid()
    union all select from_id, 'received' from public.friend_requests where to_id = auth.uid()
  ) x
  join public.profiles p on p.id = x.id
  left join public.presence pr on pr.user_id = p.id and x.status = 'friend'
  order by x.status, pr.last_seen desc nulls last, p.username
$$;

revoke execute on function public.is_friend(uuid) from public, anon;
revoke execute on function public.is_blocked(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.blocked_with(uuid) from public, anon;
revoke execute on function public.accept_friend(uuid) from public, anon, authenticated;
revoke execute on function public.send_friend_request(uuid) from public, anon;
revoke execute on function public.answer_friend_request(uuid, boolean) from public, anon;
revoke execute on function public.remove_friend(uuid) from public, anon;
revoke execute on function public.block_user(uuid) from public, anon;
revoke execute on function public.unblock_user(uuid) from public, anon;
revoke execute on function public.my_friends() from public, anon;
grant execute on function public.is_friend(uuid) to authenticated;
grant execute on function public.blocked_with(uuid) to authenticated;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.answer_friend_request(uuid, boolean) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.block_user(uuid) to authenticated;
grant execute on function public.unblock_user(uuid) to authenticated;
grant execute on function public.my_friends() to authenticated;
grant execute on function public.get_profile(text) to anon, authenticated;
