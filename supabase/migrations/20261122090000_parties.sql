-- Parties: friends who play together stay together.
--
-- A party comes together by itself: whoever invites a friend to a game leads a party, and a
-- friend who accepts is in it. The leader's room (the game and its room code, as the game tells
-- Toki) is the party's room: when the leader opens another room, or another game, everyone
-- else's Toki follows. A party has a chat of its own, shown next to the game.
--
-- Free plan: a party is one row that is overwritten (no log of rooms), a player is in one party
-- at most, a party has at most 8 players, and it is deleted with its chat and messages once its
-- players have left Toki.

-- ---------- the party's chat ----------
alter table public.chats drop constraint chats_kind_check;
alter table public.chats add constraint chats_kind_check check (kind in ('public', 'game', 'dm', 'group', 'party'));

-- Only its members write in a party's chat (as in private chats and groups).
create or replace function public.messages_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  c public.chats;
  v_other uuid;
begin
  if v_me is null then
    return new; -- the SQL editor
  end if;
  new.author_id := v_me;
  new.body := btrim(new.body);
  new.created_at := now();
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  select * into c from public.chats where id = new.chat_id;
  if c.id is null or (c.kind in ('dm', 'group', 'party') and not public.is_chat_member(c.id)) then
    raise exception 'not_member' using errcode = 'P0001';
  end if;
  if c.kind = 'dm' then
    select user_id into v_other from public.chat_members where chat_id = c.id and user_id <> v_me;
    if v_other is null or not public.is_friend(v_other) or public.is_blocked(v_me, v_other) then
      raise exception 'not_friends' using errcode = 'P0001';
    end if;
  end if;
  if (select count(*) from public.messages where author_id = v_me and created_at > now() - interval '20 seconds') >= 8
    or (select count(*) from public.messages where author_id = v_me and created_at > now() - interval '1 hour') >= 200 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ---------- parties ----------
create table public.parties (
  id uuid primary key default gen_random_uuid(),
  leader_id uuid not null references public.profiles(id) on delete cascade,
  chat_id uuid references public.chats(id) on delete set null,
  -- The leader's room: the game and its room code. "open" while the leader is in it.
  game_id uuid references public.games(id) on delete set null,
  code text check (code is null or code ~ '^[A-Za-z0-9_-]{1,32}$'),
  open boolean not null default false,
  -- Counts the rooms the leader opened, so everyone follows each one once.
  seq integer not null default 0,
  created_at timestamptz not null default now(),
  -- the last time someone joined, left or was invited
  updated_at timestamptz not null default now()
);
create index parties_leader_idx on public.parties(leader_id);
create index parties_chat_idx on public.parties(chat_id);
create index parties_game_idx on public.parties(game_id);

-- A player is in one party at most.
create table public.party_members (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  party_id uuid not null references public.parties(id) on delete cascade,
  joined_at timestamptz not null default now()
);
create index party_members_party_idx on public.party_members(party_id);

alter table public.parties enable row level security;
alter table public.party_members enable row level security;
-- No policies: everything goes through the functions below.
revoke all on public.parties, public.party_members from anon, authenticated;

-- The party's chat has the party's members, and goes with the party.
create function public.party_members_chat() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.chat_members (chat_id, user_id)
      select p.chat_id, new.user_id from public.parties p where p.id = new.party_id and p.chat_id is not null
      on conflict do nothing;
    return null;
  end if;
  delete from public.chat_members cm using public.parties p
    where p.id = old.party_id and cm.chat_id = p.chat_id and cm.user_id = old.user_id;
  return null;
end $$;
create trigger party_members_chat after insert or delete on public.party_members
  for each row execute function public.party_members_chat();

create function public.parties_chat_gone() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.chats where id = old.chat_id and kind = 'party';
  return null;
end $$;
create trigger parties_chat_gone after delete on public.parties
  for each row execute function public.parties_chat_gone();

-- What a party's members see: who leads, the room to be in, the chat, and who is in it
-- (with the game each one has open).
create function public.party_state(p_party uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'leader', p.leader_id, 'game', p.game_id, 'code', case when p.open then p.code end,
    'seq', p.seq, 'chat', p.chat_id,
    'members', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', pr.id, 'username', pr.username, 'avatar_url', pr.avatar_url, 'avatar_seed', pr.avatar_seed,
        'playing', case when o.last_seen > now() - interval '5 minutes' then o.game_id end
      ) order by m.joined_at, pr.username), '[]')
      from public.party_members m
      join public.profiles pr on pr.id = m.user_id
      left join public.presence o on o.user_id = m.user_id
      where m.party_id = p.id))
  from public.parties p where p.id = p_party
$$;

-- Takes a player out of their party. The longest member leads on; a party nobody is in is deleted.
create function public.party_drop(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_party uuid;
begin
  delete from public.party_members where user_id = p_user returning party_id into v_party;
  if v_party is null then
    return;
  end if;
  if not exists (select 1 from public.party_members where party_id = v_party) then
    delete from public.parties where id = v_party;
    return;
  end if;
  update public.parties p set
    updated_at = now(),
    leader_id = case when p.leader_id = p_user
      then (select user_id from public.party_members where party_id = v_party order by joined_at, user_id limit 1)
      else p.leader_id end,
    -- A new leader's room isn't known yet.
    open = p.open and p.leader_id <> p_user
  where p.id = v_party;
end $$;

-- The leader's room. A new room (another code, or another game) counts up "seq"; leaving the
-- room (p_code null) only closes it, so coming back to the same room moves nobody.
create function public.party_set_room(p_party uuid, p_leader uuid, p_game uuid, p_code text) returns void
language sql security definer set search_path = '' as $$
  update public.parties set
    seq = seq + case when p_code is not null and (game_id is distinct from p_game or code is distinct from p_code) then 1 else 0 end,
    game_id = case when p_code is not null then p_game else game_id end,
    code = coalesce(p_code, code),
    open = case when p_code is not null then true when game_id is not distinct from p_game then false else open end
  where id = p_party and leader_id = p_leader
$$;

-- The player's party, made now if they have none (they lead it, in this room). Their own
-- party's room is set when they lead it.
create function public.party_ensure(p_me uuid, p_game uuid, p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_party uuid;
  v_chat uuid;
begin
  select party_id into v_party from public.party_members where user_id = p_me;
  if v_party is not null then
    update public.parties set updated_at = now() where id = v_party;
    perform public.party_set_room(v_party, p_me, p_game, p_code);
    return v_party;
  end if;
  insert into public.chats (kind) values ('party') returning id into v_chat;
  insert into public.parties (leader_id, chat_id, game_id, code, open, seq)
    values (p_me, v_chat, p_game, p_code, true, 1) returning id into v_party;
  insert into public.party_members (user_id, party_id) values (p_me, v_party);
  return v_party;
end $$;

-- Members who left Toki (not seen for 15 minutes) leave the party; a party that stayed alone
-- for 30 minutes ends. Runs when a member asks for news (ping), never for the one asking.
create function public.party_tidy(p_party uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  for v_user in
    select m.user_id from public.party_members m
    left join public.presence o on o.user_id = m.user_id
    where m.party_id = p_party and m.user_id is distinct from auth.uid()
      and greatest(coalesce(o.last_seen, m.joined_at), m.joined_at) < now() - interval '15 minutes'
  loop
    perform public.party_drop(v_user);
  end loop;
  delete from public.parties p
    where p.id = p_party and p.updated_at < now() - interval '30 minutes'
      and (select count(*) from public.party_members m where m.party_id = p.id) <= 1;
end $$;

revoke execute on function public.party_members_chat() from public, anon, authenticated;
revoke execute on function public.parties_chat_gone() from public, anon, authenticated;
revoke execute on function public.party_state(uuid) from public, anon, authenticated;
revoke execute on function public.party_drop(uuid) from public, anon, authenticated;
revoke execute on function public.party_set_room(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.party_ensure(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.party_tidy(uuid) from public, anon, authenticated;

-- ---------- what players call ----------

-- Checks shared by the calls that carry a room: logged in, not banned, a multiplayer game, a plain code.
create function public.party_check(p_game uuid, p_code text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.games where id = p_game and multiplayer) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_code is not null and p_code !~ '^[A-Za-z0-9_-]{1,32}$' then
    raise exception 'bad_code' using errcode = 'P0001';
  end if;
end $$;
revoke execute on function public.party_check(uuid, text) from public, anon, authenticated;

-- The game told Toki the player's room (p_code null: they left it). Only a party's leader
-- moves the party; for everyone else nothing changes. Returns the player's party, if any.
create function public.party_room(p_game uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_party uuid;
begin
  perform public.party_check(p_game, p_code);
  select party_id into v_party from public.party_members where user_id = v_me;
  if v_party is null then
    return null;
  end if;
  perform public.party_set_room(v_party, v_me, p_game, p_code);
  return public.party_state(v_party);
end $$;

-- For a link to share: the player's party in this room (made now if they have none).
create function public.open_party(p_game uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_party uuid;
begin
  perform public.party_check(p_game, p_code);
  if p_code is null then
    raise exception 'bad_code' using errcode = 'P0001';
  end if;
  -- In two steps: party_state only sees what was written before its statement began.
  v_party := public.party_ensure(auth.uid(), p_game, p_code);
  return public.party_state(v_party);
end $$;

-- Joins a party: with an invite from one of its members (30 minutes), or with the code of
-- the room it is in right now (from a shared link) as a friend of one of its members.
-- Leaves the party the player was in before.
-- Errors: login_required, banned, not_found, not_invited, blocked, party_full.
create function public.join_party(p_party uuid, p_code text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  p public.parties;
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  select * into p from public.parties where id = p_party;
  if p.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.party_members where party_id = p_party and user_id = v_me) then
    return public.party_state(p_party);
  end if;
  if not exists (
    select 1 from public.notifications n
    join public.party_members m on m.user_id = n.actor_id and m.party_id = p_party
    where n.user_id = v_me and n.kind = 'game_invite' and n.created_at > now() - interval '30 minutes'
      and n.data->>'party' = p_party::text
  ) and not (
    p_code is not null and p.open and p.code = p_code and exists (
      select 1 from public.party_members m
      join public.friends f on f.user_id = v_me and f.friend_id = m.user_id
      where m.party_id = p_party)
  ) then
    raise exception 'not_invited' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.party_members m where m.party_id = p_party and public.is_blocked(v_me, m.user_id)) then
    raise exception 'blocked' using errcode = 'P0001';
  end if;
  if (select count(*) from public.party_members where party_id = p_party) >= 8 then
    raise exception 'party_full' using errcode = 'P0001';
  end if;
  perform public.party_drop(v_me);
  insert into public.party_members (user_id, party_id) values (v_me, p_party);
  update public.parties set updated_at = now() where id = p_party;
  return public.party_state(p_party);
end $$;

create function public.leave_party() returns void
language sql security definer set search_path = '' as $$
  select public.party_drop(auth.uid())
$$;

revoke execute on function public.party_room(uuid, text) from public, anon;
revoke execute on function public.open_party(uuid, text) from public, anon;
revoke execute on function public.join_party(uuid, text) from public, anon;
revoke execute on function public.leave_party() from public, anon;
grant execute on function public.party_room(uuid, text) to authenticated;
grant execute on function public.open_party(uuid, text) to authenticated;
grant execute on function public.join_party(uuid, text) to authenticated;
grant execute on function public.leave_party() to authenticated;

-- ---------- invites carry the party ----------
-- As before, and: whoever invites has a party (made now if needed), and the invite says which,
-- so the friend who accepts joins it.
create or replace function public.invite_to_game(p_user uuid, p_game uuid, p_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_title text;
  v_party uuid;
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  if p_user is null or not exists (select 1 from public.friends where user_id = v_me and friend_id = p_user) then
    raise exception 'not_friends' using errcode = 'P0001';
  end if;
  select title into v_title from public.games where id = p_game and multiplayer;
  if v_title is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_code is null or p_code !~ '^[A-Za-z0-9_-]{1,32}$' then
    raise exception 'bad_code' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.notifications
    where actor_id = v_me and kind = 'game_invite' and user_id = p_user and created_at > now() - interval '15 seconds'
  ) or (
    select count(*) from public.notifications
    where actor_id = v_me and kind = 'game_invite' and created_at > now() - interval '10 minutes'
  ) >= 30 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  v_party := public.party_ensure(v_me, p_game, p_code);
  -- One invite per friend: the new one replaces the earlier one.
  delete from public.notifications where actor_id = v_me and kind = 'game_invite' and user_id = p_user;
  perform public.notify(p_user, 'game_invite', v_me,
    jsonb_build_object('game', p_game, 'title', v_title, 'code', p_code, 'party', v_party));
end $$;

-- ---------- ping: also the player's party ----------
-- "party": the player's party (see party_state), null without one. "chats" leaves the party's
-- chat out: it is on screen next to the game, not in the list of chats.
create or replace function public.ping(p_game uuid default null, p_here boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_blocked uuid[];
  v_party uuid;
begin
  if v_me is null then
    return null;
  end if;
  if p_here then
    insert into public.presence as pr (user_id, last_seen, game_id)
    values (v_me, now(), (select id from public.games where id = p_game))
    on conflict (user_id) do update set last_seen = now(), game_id = excluded.game_id
      where pr.last_seen < now() - interval '60 seconds' or pr.game_id is distinct from excluded.game_id;
  end if;
  select party_id into v_party from public.party_members where user_id = v_me;
  if v_party is not null then
    perform public.party_tidy(v_party);
  end if;
  v_blocked := public.blocked_ids();
  return jsonb_build_object(
    'notifications', (select count(*) from (
      select 1 from public.notifications where user_id = v_me and read_at is null limit 99) n),
    'chats', (select count(*) from public.chat_members m join public.chats c on c.id = m.chat_id
      where m.user_id = v_me and c.kind <> 'party' and exists (
        select 1 from public.messages x
        where x.chat_id = m.chat_id and x.id > m.last_read_id and x.author_id <> v_me and not (x.author_id = any (v_blocked)))),
    'friends_online', (select count(*) from (
      select 1 from public.friends f join public.presence o on o.user_id = f.friend_id
      where f.user_id = v_me and o.last_seen > now() - interval '5 minutes' limit 9) here),
    'invite', (
      select jsonb_build_object('id', n.id, 'game', n.data->>'game', 'code', n.data->>'code', 'party', n.data->>'party',
        'from', jsonb_build_object('id', p.id, 'username', p.username, 'avatar_url', p.avatar_url, 'avatar_seed', p.avatar_seed))
      from public.notifications n join public.profiles p on p.id = n.actor_id
      where n.user_id = v_me and n.kind = 'game_invite' and n.read_at is null
        and n.created_at > now() - interval '5 minutes' and not (n.actor_id = any (v_blocked))
      order by n.id desc limit 1),
    'party', (select public.party_state(m.party_id) from public.party_members m where m.user_id = v_me));
end $$;

-- The list of chats: without the party's chat.
create or replace function public.my_chats() returns table (
  id uuid, kind text, title text, game_id uuid, last_message_at timestamptz,
  last_body text, last_author text, unread integer, members integer,
  other_id uuid, other_username text, other_avatar_url text, other_avatar_seed text
)
language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as id, public.blocked_ids() as blocked)
  select c.id, c.kind, c.title, c.game_id, c.last_message_at,
    lm.body, lp.username,
    (select count(*)::integer from (
      select 1 from public.messages x
      where x.chat_id = c.id and x.id > m.last_read_id and x.author_id <> me.id and not (x.author_id = any (me.blocked))
      limit 99) u),
    (select count(*)::integer from public.chat_members y where y.chat_id = c.id),
    o.id, o.username, o.avatar_url, o.avatar_seed
  from me
  join public.chat_members m on m.user_id = me.id
  join public.chats c on c.id = m.chat_id and c.kind <> 'party'
  left join lateral (
    select x.body, x.author_id from public.messages x
    where x.chat_id = c.id and not (x.author_id = any (me.blocked))
    order by x.id desc limit 1
  ) lm on true
  left join public.profiles lp on lp.id = lm.author_id
  left join lateral (
    select p.id, p.username, p.avatar_url, p.avatar_seed from public.chat_members y join public.profiles p on p.id = y.user_id
    where c.kind = 'dm' and y.chat_id = c.id and y.user_id <> me.id limit 1
  ) o on true
  order by coalesce(c.last_message_at, c.created_at) desc
$$;

-- ---------- cleaning up ----------
-- Parties whose players all closed Toki without leaving (nobody asks for news any more).
select cron.schedule('delete-old-parties', '7 4 * * *', $$
  delete from public.parties p
    where p.updated_at < now() - interval '30 minutes' and not exists (
      select 1 from public.party_members m join public.presence o on o.user_id = m.user_id
      where m.party_id = p.id and o.last_seen > now() - interval '15 minutes');
$$);
