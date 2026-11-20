-- The limits per minute, hour or day hold when an account's requests arrive at the same moment.
--
-- Each limit counts the account's rows and then writes a new one. Requests sent at once all
-- counted before any of them had written, so all of them passed: a script could send a hundred
-- chat messages through "8 per 20 seconds", or post ideas (each one notifies every developer)
-- past the daily limit. Now each of these takes a lock for its account first, as a step of its
-- own, so one request at a time counts and writes and the next one sees what it wrote.
-- Held until the request's transaction ends; only ever taken for the account itself, so two
-- accounts can't wait on each other. The functions below are as they were, plus that one step.
create function public.limit_lock(p_user uuid) returns void
language sql security definer set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('limits:' || p_user::text, 0)) where p_user is not null
$$;
revoke execute on function public.limit_lock(uuid) from public, anon, authenticated;

-- from 20261130090000_admin_limits.sql
create or replace function public.create_group(p_title text, p_members uuid[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_id uuid;
begin
  -- One request of an account at a time, so the counts below see what its other requests wrote.
  perform public.limit_lock(auth.uid());
  if v_me is null or not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  p_members := array(select distinct x from unnest(coalesce(p_members, '{}')) x where x <> v_me);
  if cardinality(p_members) = 0 or cardinality(p_members) >= public.limit_of(v_me, 'group_size') then
    raise exception 'bad_members' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(p_members) x where not public.is_friend(x) or public.is_blocked(v_me, x)) then
    raise exception 'not_friends' using errcode = 'P0001';
  end if;
  perform public.check_limit(v_me, 'groups_day',
    (select count(*) from public.chats where created_by = v_me and kind = 'group' and created_at > now() - interval '1 day'));
  insert into public.chats (kind, title, created_by) values ('group', btrim(p_title), v_me) returning id into v_id;
  insert into public.chat_members (chat_id, user_id) select v_id, x from unnest(array[v_me] || p_members) x;
  return v_id;
end $$;

-- from 20261130090000_admin_limits.sql
create or replace function public.developer_applications_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- One request of an account at a time, so the counts below see what its other requests wrote.
  perform public.limit_lock(auth.uid());
  if auth.uid() is null then
    return new; -- the SQL editor
  end if;
  if public.my_role() is distinct from 'player' then
    raise exception 'already_developer' using errcode = 'P0001';
  end if;
  perform public.check_limit(auth.uid(), 'applications_month',
    (select count(*) from public.developer_applications where user_id = auth.uid() and created_at > now() - interval '30 days'));
  new.user_id := auth.uid();
  new.about := btrim(new.about);
  new.links := btrim(new.links);
  new.status := 'pending';
  new.review_note := null;
  new.reviewed_by := null;
  new.reviewed_at := null;
  new.created_at := now();
  return new;
end $$;

-- from 20261130090000_admin_limits.sql
create or replace function public.feedback_posts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  -- One request of an account at a time, so the counts below see what its other requests wrote.
  perform public.limit_lock(auth.uid());
  -- Count updates from the vote and reply triggers below, and the SQL editor (no user).
  if pg_trigger_depth() > 1 or v_me is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    perform public.check_limit(v_me, 'feedback_posts_hour',
      (select count(*) from public.feedback_posts where author_id = v_me and created_at > now() - interval '1 hour'));
    perform public.check_limit(v_me, 'feedback_posts_day',
      (select count(*) from public.feedback_posts where author_id = v_me and created_at > now() - interval '1 day'));
    new.author_id := v_me;
    new.title := btrim(new.title);
    new.status := 'open';
    new.hidden := false;
    new.answered := false;
    new.vote_count := 0;
    new.reply_count := 0;
    new.created_at := now();
    new.edited_at := null;
    new.status_at := now();
    new.updated_at := now();
    return new;
  end if;

  new.id := old.id;
  new.game_id := old.game_id;
  new.author_id := old.author_id;
  new.answered := old.answered;
  new.vote_count := old.vote_count;
  new.reply_count := old.reply_count;
  new.created_at := old.created_at;
  if not public.feedback_manager(old.game_id) then
    new.status := old.status;
    new.hidden := old.hidden;
  end if;
  if old.author_id is distinct from v_me then
    new.kind := old.kind;
    new.title := old.title;
    new.body := old.body;
    new.device := old.device;
    new.private := old.private;
  end if;
  new.title := btrim(new.title);

  new.edited_at := old.edited_at;
  new.status_at := old.status_at;
  new.updated_at := old.updated_at;
  if new.title is distinct from old.title or new.body is distinct from old.body then
    new.edited_at := now();
    new.updated_at := now();
  end if;
  if new.status is distinct from old.status then
    new.status_at := now();
    new.updated_at := now();
  end if;
  return new;
end $$;

-- from 20261130090000_admin_limits.sql
create or replace function public.feedback_replies_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  -- One request of an account at a time, so the counts below see what its other requests wrote.
  perform public.limit_lock(auth.uid());
  if v_me is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.author_id := v_me;
    new.official := public.feedback_manager((select game_id from public.feedback_posts where id = new.post_id));
    -- Developers answer many posts at once, so the limit is only for everyone else.
    if not new.official then
      perform public.check_limit(v_me, 'feedback_replies_hour',
        (select count(*) from public.feedback_replies where author_id = v_me and created_at > now() - interval '1 hour'));
    end if;
    new.body := btrim(new.body);
    new.created_at := now();
    new.edited_at := null;
    return new;
  end if;
  new.id := old.id;
  new.post_id := old.post_id;
  new.author_id := old.author_id;
  new.official := old.official;
  new.created_at := old.created_at;
  new.body := btrim(new.body);
  new.edited_at := case when new.body is distinct from old.body then now() else old.edited_at end;
  return new;
end $$;

-- from 20261130090000_admin_limits.sql
create or replace function public.game_idea_replies_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  -- One request of an account at a time, so the counts below see what its other requests wrote.
  perform public.limit_lock(auth.uid());
  if v_me is null then
    return new;
  end if;
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  perform public.check_limit(v_me, 'idea_replies_hour',
    (select count(*) from public.game_idea_replies where author_id = v_me and created_at > now() - interval '1 hour'));
  new.author_id := v_me;
  new.body := btrim(new.body);
  new.created_at := now();
  return new;
end $$;

-- from 20261130090000_admin_limits.sql
create or replace function public.game_ideas_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  -- One request of an account at a time, so the counts below see what its other requests wrote.
  perform public.limit_lock(auth.uid());
  if v_me is null then
    return new;
  end if;
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  perform public.check_limit(v_me, 'ideas_day',
    (select count(*) from public.game_ideas where author_id = v_me and created_at > now() - interval '1 day'));
  perform public.check_limit(v_me, 'ideas_month',
    (select count(*) from public.game_ideas where author_id = v_me and created_at > now() - interval '30 days'));
  new.author_id := v_me;
  new.title := btrim(new.title);
  new.body := btrim(new.body);
  new.claimed_by := null;
  new.claimed_at := null;
  new.done_at := null;
  new.game_id := null;
  new.reply_count := 0;
  new.created_at := now();
  new.updated_at := now();
  return new;
end $$;

-- from 20261130090000_admin_limits.sql
create or replace function public.invite_to_game(p_user uuid, p_game uuid, p_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_title text;
  v_party uuid;
begin
  -- One request of an account at a time, so the counts below see what its other requests wrote.
  perform public.limit_lock(auth.uid());
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
  -- The same friend at most every 15 seconds stays fixed: it only stops double taps.
  if exists (
    select 1 from public.notifications
    where actor_id = v_me and kind = 'game_invite' and user_id = p_user and created_at > now() - interval '15 seconds'
  ) then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  perform public.check_limit(v_me, 'game_invites_10min', (
    select count(*) from public.notifications
    where actor_id = v_me and kind = 'game_invite' and created_at > now() - interval '10 minutes'));
  v_party := public.party_ensure(v_me, p_game, p_code);
  -- One invite per friend: the new one replaces the earlier one.
  delete from public.notifications where actor_id = v_me and kind = 'game_invite' and user_id = p_user;
  perform public.notify(p_user, 'game_invite', v_me,
    jsonb_build_object('game', p_game, 'title', v_title, 'code', p_code, 'party', v_party));
end $$;

-- from 20261130090000_admin_limits.sql
create or replace function public.messages_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  c public.chats;
  v_other uuid;
begin
  -- One request of an account at a time, so the counts below see what its other requests wrote.
  perform public.limit_lock(auth.uid());
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
  perform public.check_limit(v_me, 'messages_20s',
    (select count(*) from public.messages where author_id = v_me and created_at > now() - interval '20 seconds'));
  perform public.check_limit(v_me, 'messages_hour',
    (select count(*) from public.messages where author_id = v_me and created_at > now() - interval '1 hour'));
  return new;
end $$;

-- from 20261201090000_legal.sql
create or replace function public.report_content(p_kind text, p_target uuid, p_category text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_owner uuid;
  v_title text;
  v_found boolean := false;
begin
  -- One request of an account at a time, so the counts below see what its other requests wrote.
  perform public.limit_lock(auth.uid());
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  if p_kind = 'game' then
    select true, created_by, title into v_found, v_owner, v_title from public.games where id = p_target;
  elsif p_kind = 'profile' then
    select true, id, '@' || username into v_found, v_owner, v_title from public.profiles where id = p_target;
  elsif p_kind = 'feedback' then
    select true, author_id, title into v_found, v_owner, v_title from public.feedback_posts
      where id = p_target and (not private or author_id = v_me) and not hidden;
  elsif p_kind = 'idea' then
    select true, author_id, title into v_found, v_owner, v_title from public.game_ideas where id = p_target;
  end if;
  if not coalesce(v_found, false) or v_owner is not distinct from v_me then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform public.check_limit(v_me, 'reports_day',
    (select count(*) from public.message_reports where reporter_id = v_me and created_at > now() - interval '1 day')
    + (select count(*) from public.content_reports where reporter_id = v_me and created_at > now() - interval '1 day'));
  insert into public.content_reports (kind, target, reporter_id, owner_id, category, reason, title)
    values (p_kind, p_target, v_me, v_owner, p_category, left(btrim(coalesce(p_reason, '')), 1000), v_title)
    on conflict (kind, target, reporter_id) do nothing;
end $$;

-- from 20261130090000_admin_limits.sql
create or replace function public.report_message(p_message bigint, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  msg public.messages;
begin
  -- One request of an account at a time, so the counts below see what its other requests wrote.
  perform public.limit_lock(auth.uid());
  select * into msg from public.messages where id = p_message;
  if v_me is null or msg.id is null or not public.can_read_chat(msg.chat_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform public.check_limit(v_me, 'reports_day',
    (select count(*) from public.message_reports where reporter_id = v_me and created_at > now() - interval '1 day'));
  insert into public.message_reports (message_id, chat_id, reporter_id, author_id, body, reason)
    values (msg.id, msg.chat_id, v_me, msg.author_id, msg.body, left(btrim(coalesce(p_reason, '')), 200))
    on conflict (message_id, reporter_id) do nothing;
end $$;

-- from 20261130090000_admin_limits.sql
create or replace function public.send_friend_request(p_user uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  -- One request of an account at a time, so the counts below see what its other requests wrote.
  perform public.limit_lock(auth.uid());
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
  if exists (select 1 from public.friend_requests where from_id = v_me and to_id = p_user) then
    return 'sent';
  end if;
  perform public.check_limit(v_me, 'friend_requests_day', greatest(
    (select count(*) from public.friend_requests where from_id = v_me and created_at > now() - interval '1 day'),
    (select count(*) from public.notifications
      where actor_id = v_me and kind = 'friend_request' and created_at > now() - interval '1 day')));
  insert into public.friend_requests (from_id, to_id) values (v_me, p_user) on conflict do nothing;
  return 'sent';
end $$;
