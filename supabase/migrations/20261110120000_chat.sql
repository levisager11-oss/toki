-- Chat: private messages between friends, group chats of friends, a chat room for every game
-- and one public Toki chat room. Logged-in players only.
--
-- Safety: private messages and groups only between friends; blocked players' messages are
-- hidden; players report messages and admins delete them or ban the sender for a while;
-- at most 8 messages per 20 seconds and 200 per hour.
-- Free plan: messages in rooms are deleted after 7 days, in private chats and groups after
-- 30 days, reports 30 days after they were handled (pg_cron, once a day).

create table public.chats (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('public', 'game', 'dm', 'group')),
  game_id uuid references public.games(id) on delete cascade,
  -- 'public', 'game:<id>' or 'dm:<smaller id>:<bigger id>': one chat each. null for groups.
  key text unique,
  title text check (title is null or char_length(btrim(title)) between 1 and 40),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz,
  check ((kind = 'game') = (game_id is not null)),
  check ((kind = 'group') = (title is not null))
);
create index chats_game_idx on public.chats(game_id);
create index chats_created_by_idx on public.chats(created_by);

-- Who is in a private chat or group. Rooms have no members: every logged-in player can join in.
create table public.chat_members (
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);
create index chat_members_user_idx on public.chat_members(user_id);

create table public.messages (
  id bigint generated always as identity primary key,
  chat_id uuid not null references public.chats(id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);
create index messages_chat_idx on public.messages(chat_id, id desc);
create index messages_author_idx on public.messages(author_id, created_at desc);
create index messages_created_idx on public.messages(created_at);

create table public.message_reports (
  id bigint generated always as identity primary key,
  -- null once the message was deleted; author and text are kept for the admin
  message_id bigint references public.messages(id) on delete set null,
  chat_id uuid references public.chats(id) on delete set null,
  reporter_id uuid references public.profiles(id) on delete set null,
  author_id uuid references public.profiles(id) on delete cascade,
  body text not null,
  reason text not null default '' check (char_length(reason) <= 200),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  -- what the admin did: 'dismissed', 'deleted' or 'banned'
  outcome text check (outcome is null or outcome in ('dismissed', 'deleted', 'banned'))
);
create unique index message_reports_once_idx on public.message_reports(message_id, reporter_id);
create index message_reports_open_idx on public.message_reports(created_at) where handled_at is null;
create index message_reports_author_idx on public.message_reports(author_id);
create index message_reports_reporter_idx on public.message_reports(reporter_id);
create index message_reports_chat_idx on public.message_reports(chat_id);

create function public.is_chat_member(p_chat uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chat_members where chat_id = p_chat and user_id = auth.uid())
$$;

-- Rooms are open to every logged-in player; private chats and groups to their members.
create function public.can_read_chat(p_chat uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.chats c where c.id = p_chat
      and (c.kind in ('public', 'game') or exists (select 1 from public.chat_members m where m.chat_id = c.id and m.user_id = auth.uid()))
  )
$$;

alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_reports enable row level security;

create policy "chats: readable" on public.chats for select to authenticated using (public.can_read_chat(id));
create policy "chat members: fellow members" on public.chat_members for select to authenticated
  using (public.is_chat_member(chat_id));
create policy "messages: readable, not from blocked players" on public.messages for select to authenticated
  using (public.can_read_chat(chat_id) and not public.blocked_with(author_id));
create policy "messages: write" on public.messages for insert to authenticated
  with check (author_id = (select auth.uid()));
create policy "messages: delete own, admins all" on public.messages for delete to authenticated
  using (author_id = (select auth.uid()) or (select public.my_role()) = 'admin');
create policy "reports: admins" on public.message_reports for select to authenticated
  using ((select public.my_role()) = 'admin');

revoke all on public.chats, public.chat_members, public.messages, public.message_reports from anon, authenticated;
grant select on public.chats, public.chat_members, public.messages, public.message_reports to authenticated;
grant insert (chat_id, body) on public.messages to authenticated;
grant delete on public.messages to authenticated;

-- New messages: the server sets author and time, checks who may write here, and the limits.
create function public.messages_guard() returns trigger
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
  if c.id is null or (c.kind in ('dm', 'group') and not public.is_chat_member(c.id)) then
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
create trigger messages_guard before insert on public.messages
  for each row execute function public.messages_guard();

create function public.messages_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.chats set last_message_at = new.created_at where id = new.chat_id;
  update public.chat_members set last_read_at = new.created_at where chat_id = new.chat_id and user_id = new.author_id;
  return null;
end $$;
create trigger messages_after after insert on public.messages
  for each row execute function public.messages_after();

-- The public Toki room (p_game null) or a game's room. Made the first time someone opens it.
create function public.room(p_game uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_key text := case when p_game is null then 'public' else 'game:' || p_game end;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  select id into v_id from public.chats where key = v_key;
  if v_id is not null then
    return v_id;
  end if;
  if p_game is not null and not exists (select 1 from public.games where id = p_game) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  insert into public.chats (kind, game_id, key) values (case when p_game is null then 'public' else 'game' end, p_game, v_key)
    on conflict (key) do nothing returning id into v_id;
  return coalesce(v_id, (select id from public.chats where key = v_key));
end $$;

-- The private chat with a friend.
create function public.open_dm(p_user uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_key text;
  v_id uuid;
begin
  if v_me is null or not public.is_friend(p_user) or public.is_blocked(v_me, p_user) then
    raise exception 'not_friends' using errcode = 'P0001';
  end if;
  v_key := 'dm:' || least(v_me, p_user) || ':' || greatest(v_me, p_user);
  select id into v_id from public.chats where key = v_key;
  if v_id is null then
    insert into public.chats (kind, key, created_by) values ('dm', v_key, v_me)
      on conflict (key) do nothing returning id into v_id;
    v_id := coalesce(v_id, (select id from public.chats where key = v_key));
  end if;
  insert into public.chat_members (chat_id, user_id) values (v_id, v_me), (v_id, p_user) on conflict do nothing;
  return v_id;
end $$;

-- A group chat with some of the player's friends (at most 20 people in a group).
create function public.create_group(p_title text, p_members uuid[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_id uuid;
begin
  if v_me is null or not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  p_members := array(select distinct x from unnest(coalesce(p_members, '{}')) x where x <> v_me);
  if cardinality(p_members) = 0 or cardinality(p_members) > 19 then
    raise exception 'bad_members' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(p_members) x where not public.is_friend(x) or public.is_blocked(v_me, x)) then
    raise exception 'not_friends' using errcode = 'P0001';
  end if;
  if (select count(*) from public.chats where created_by = v_me and kind = 'group' and created_at > now() - interval '1 day') >= 10 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  insert into public.chats (kind, title, created_by) values ('group', btrim(p_title), v_me) returning id into v_id;
  insert into public.chat_members (chat_id, user_id) select v_id, x from unnest(array[v_me] || p_members) x;
  return v_id;
end $$;

-- A group member adds one of their friends.
create function public.add_to_group(p_chat uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  if not exists (select 1 from public.chats where id = p_chat and kind = 'group') or not public.is_chat_member(p_chat) then
    raise exception 'not_member' using errcode = 'P0001';
  end if;
  if not public.is_friend(p_user) or public.is_blocked(v_me, p_user) then
    raise exception 'not_friends' using errcode = 'P0001';
  end if;
  if (select count(*) from public.chat_members where chat_id = p_chat) >= 20 then
    raise exception 'group_full' using errcode = 'P0001';
  end if;
  insert into public.chat_members (chat_id, user_id) values (p_chat, p_user) on conflict do nothing;
end $$;

create function public.rename_group(p_chat uuid, p_title text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_chat_member(p_chat) then
    raise exception 'not_member' using errcode = 'P0001';
  end if;
  update public.chats set title = btrim(p_title) where id = p_chat and kind = 'group';
end $$;

-- Leaves a group. A group nobody is in any more is deleted with its messages.
create function public.leave_group(p_chat uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.chat_members m using public.chats c
    where m.chat_id = p_chat and m.user_id = auth.uid() and c.id = m.chat_id and c.kind = 'group';
  delete from public.chats c where c.id = p_chat and c.kind = 'group'
    and not exists (select 1 from public.chat_members m where m.chat_id = c.id);
end $$;

create function public.mark_chat_read(p_chat uuid) returns void
language sql security definer set search_path = '' as $$
  update public.chat_members set last_read_at = now() where chat_id = p_chat and user_id = auth.uid()
$$;

-- The player's private chats and groups (and the public room), newest activity first,
-- with the last message and how many messages are unread.
create function public.my_chats() returns table (
  id uuid, kind text, title text, game_id uuid, last_message_at timestamptz,
  last_body text, last_author text, unread integer, members integer,
  other_id uuid, other_username text, other_avatar_url text, other_avatar_seed text
)
language sql stable security definer set search_path = '' as $$
  select c.id, c.kind, c.title, c.game_id, c.last_message_at,
    lm.body, lp.username,
    (select count(*)::integer from public.messages x
      where x.chat_id = c.id and x.created_at > m.last_read_at and x.author_id <> auth.uid()
        and not public.is_blocked(auth.uid(), x.author_id)),
    (select count(*)::integer from public.chat_members y where y.chat_id = c.id),
    o.id, o.username, o.avatar_url, o.avatar_seed
  from public.chat_members m
  join public.chats c on c.id = m.chat_id
  left join lateral (
    select x.body, x.author_id from public.messages x
    where x.chat_id = c.id and not public.is_blocked(auth.uid(), x.author_id)
    order by x.id desc limit 1
  ) lm on true
  left join public.profiles lp on lp.id = lm.author_id
  left join lateral (
    select p.* from public.chat_members y join public.profiles p on p.id = y.user_id
    where c.kind = 'dm' and y.chat_id = c.id and y.user_id <> auth.uid() limit 1
  ) o on true
  where m.user_id = auth.uid()
  order by coalesce(c.last_message_at, c.created_at) desc
$$;

-- Reports a message to the admins. Each player reports a message once.
create function public.report_message(p_message bigint, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  msg public.messages;
begin
  select * into msg from public.messages where id = p_message;
  if v_me is null or msg.id is null or not public.can_read_chat(msg.chat_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if (select count(*) from public.message_reports where reporter_id = v_me and created_at > now() - interval '1 day') >= 30 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  insert into public.message_reports (message_id, chat_id, reporter_id, author_id, body, reason)
    values (msg.id, msg.chat_id, v_me, msg.author_id, msg.body, left(btrim(coalesce(p_reason, '')), 200))
    on conflict (message_id, reporter_id) do nothing;
end $$;

-- Admins: no chatting and friend requests for p_days days (0: lift the ban).
create function public.ban_user(p_user uuid, p_days integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  update public.profiles
    set banned_until = case when p_days > 0 then now() + make_interval(days => least(p_days, 3650)) end
    where id = p_user and role <> 'admin';
end $$;

-- Admins handle a report: 'dismissed', 'deleted' (the message) or 'banned' (deletes the
-- message and bans the sender for p_days). Other reports of the same message are handled too.
create function public.handle_report(p_report bigint, p_outcome text, p_days integer default 0) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.message_reports;
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if p_outcome not in ('dismissed', 'deleted', 'banned') then
    raise exception 'bad_outcome' using errcode = 'P0001';
  end if;
  select * into r from public.message_reports where id = p_report;
  if r.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  update public.message_reports set handled_at = now(), outcome = p_outcome
    where handled_at is null and (id = p_report or (r.message_id is not null and message_id = r.message_id));
  if p_outcome in ('deleted', 'banned') and r.message_id is not null then
    delete from public.messages where id = r.message_id;
  end if;
  if p_outcome = 'banned' then
    perform public.ban_user(r.author_id, greatest(p_days, 1));
  end if;
end $$;

revoke execute on function public.messages_guard() from public, anon, authenticated;
revoke execute on function public.messages_after() from public, anon, authenticated;
revoke execute on function public.is_chat_member(uuid) from public, anon;
revoke execute on function public.can_read_chat(uuid) from public, anon;
revoke execute on function public.room(uuid) from public, anon;
revoke execute on function public.open_dm(uuid) from public, anon;
revoke execute on function public.create_group(text, uuid[]) from public, anon;
revoke execute on function public.add_to_group(uuid, uuid) from public, anon;
revoke execute on function public.rename_group(uuid, text) from public, anon;
revoke execute on function public.leave_group(uuid) from public, anon;
revoke execute on function public.mark_chat_read(uuid) from public, anon;
revoke execute on function public.my_chats() from public, anon;
revoke execute on function public.report_message(bigint, text) from public, anon;
revoke execute on function public.ban_user(uuid, integer) from public, anon;
revoke execute on function public.handle_report(bigint, text, integer) from public, anon;
grant execute on function public.is_chat_member(uuid) to authenticated;
grant execute on function public.can_read_chat(uuid) to authenticated;
grant execute on function public.room(uuid) to authenticated;
grant execute on function public.open_dm(uuid) to authenticated;
grant execute on function public.create_group(text, uuid[]) to authenticated;
grant execute on function public.add_to_group(uuid, uuid) to authenticated;
grant execute on function public.rename_group(uuid, text) to authenticated;
grant execute on function public.leave_group(uuid) to authenticated;
grant execute on function public.mark_chat_read(uuid) to authenticated;
grant execute on function public.my_chats() to authenticated;
grant execute on function public.report_message(bigint, text) to authenticated;
grant execute on function public.ban_user(uuid, integer) to authenticated;
grant execute on function public.handle_report(bigint, text, integer) to authenticated;

-- New messages reach open chats right away (Supabase Realtime, which applies the read rules above).
alter publication supabase_realtime add table public.messages;

select cron.schedule('delete-old-messages', '41 3 * * *', $$
  delete from public.messages m using public.chats c
    where c.id = m.chat_id and (
      (c.kind in ('public', 'game') and m.created_at < now() - interval '7 days')
      or (c.kind in ('dm', 'group') and m.created_at < now() - interval '30 days'));
  delete from public.message_reports
    where (handled_at is not null and handled_at < now() - interval '30 days')
      or created_at < now() - interval '60 days';
$$);
