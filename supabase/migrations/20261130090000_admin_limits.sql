-- Admins set Toki's limits and deletion times on /admin/limits instead of them being fixed here.
--  * limits: how often accounts may do something (ideas a day, messages an hour, free AI calls an
--    hour, ...), with one value for players and one for developers. Admins have none of these.
--    Two sizes (people in a group chat, players in a party) are one value for everyone.
--  * limit_overrides: an admin can give a single account its own value for a limit.
--  * keep_times: how long things are kept before the nightly cleanup deletes them. Each has a
--    safe maximum so Toki stays within Supabase's free plan.
-- The defaults are the values Toki used until now. Errors from a limit read "rate_limited:<key>",
-- so the app can say which limit it was and show the number the admin set.

create table public.limits (
  key text primary key,
  -- both: players and developers each have a value; player / creator: only they can do it;
  -- everyone: a single value that applies to every account, admins too, and can't be overridden.
  who text not null check (who in ('both', 'player', 'creator', 'everyone')),
  player integer not null,
  creator integer not null,
  min_value integer not null default 0,
  max_value integer not null,
  sort smallint not null,
  check (player between min_value and max_value and creator between min_value and max_value)
);

create table public.limit_overrides (
  user_id uuid not null references public.profiles(id) on delete cascade,
  key text not null references public.limits(key) on delete cascade,
  value integer not null check (value >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table public.keep_times (
  key text primary key,
  value integer not null,
  unit text not null default 'days' check (unit in ('days', 'count')),
  min_value integer not null,
  max_value integer not null,
  sort smallint not null,
  check (value between min_value and max_value)
);

insert into public.limits (key, who, player, creator, min_value, max_value, sort) values
  ('ideas_day',             'both',      3,    3,    0, 100,   10),
  ('ideas_month',           'both',      10,   10,   0, 1000,  11),
  ('idea_replies_hour',     'both',      30,   30,   0, 1000,  12),
  ('feedback_posts_hour',   'both',      5,    5,    0, 100,   20),
  ('feedback_posts_day',    'both',      20,   20,   0, 1000,  21),
  ('feedback_replies_hour', 'both',      30,   30,   0, 1000,  22),
  ('messages_20s',          'both',      8,    8,    1, 100,   30),
  ('messages_hour',         'both',      200,  200,  1, 5000,  31),
  ('groups_day',            'both',      10,   10,   0, 100,   32),
  ('group_size',            'everyone',  20,   20,   3, 100,   33),
  ('reports_day',           'both',      30,   30,   1, 1000,  34),
  ('friend_requests_day',   'both',      30,   30,   0, 1000,  40),
  ('game_invites_10min',    'both',      30,   30,   0, 1000,  41),
  ('party_size',            'everyone',  8,    8,    2, 64,    42),
  ('applications_month',    'player',    3,    3,    0, 100,   50),
  ('ai_translate',          'both',      120,  120,  0, 10000, 60),
  ('ai_similar',            'both',      30,   30,   0, 10000, 61),
  ('ai_suggest',            'both',      10,   10,   0, 10000, 62),
  ('ai_help',               'both',      40,   40,   0, 10000, 63),
  ('ai_release',            'creator',   30,   30,   0, 10000, 64),
  ('ai_describe',           'creator',   30,   30,   0, 10000, 65),
  ('ai_summary',            'creator',   30,   30,   0, 10000, 66),
  ('ai_learn',              'creator',   10,   10,   0, 10000, 67),
  ('ai_connect',            'creator',   60,   60,   0, 10000, 68),
  ('uploads_hour',          'creator',   30,   30,   0, 1000,  70),
  -- MB of uploaded games per developer. All games together stay below 9.5 GB regardless.
  ('storage_mb',            'creator',   1024, 1024, 0, 9728,  71);

insert into public.keep_times (key, value, unit, min_value, max_value, sort) values
  ('chat_public',         7,   'days',  1,  90,  10),
  ('chat_private',        30,  'days',  1,  365, 11),
  ('notifications',       30,  'days',  1,  180, 20),
  ('notifications_count', 100, 'count', 10, 500, 21),
  ('reports_handled',     30,  'days',  1,  180, 30),
  ('reports_all',         60,  'days',  7,  365, 31),
  ('ideas',               180, 'days',  7,  730, 40),
  ('translations',        30,  'days',  1,  180, 50),
  ('suggestions',         7,   'days',  1,  90,  51),
  ('connect_runs',        90,  'days',  7,  365, 60);

alter table public.limits enable row level security;
alter table public.limit_overrides enable row level security;
alter table public.keep_times enable row level security;
revoke all on public.limits, public.limit_overrides, public.keep_times from anon, authenticated;

-- ---------- reading ----------

-- An account's limit, or null when there is none (admins, except for the sizes).
create function public.limit_of(p_user uuid, p_key text) returns integer
language plpgsql stable security definer set search_path = '' as $$
declare
  l public.limits;
  v_role public.user_role;
  v_own integer;
begin
  select * into l from public.limits where key = p_key;
  if l.key is null then
    raise exception 'unknown_limit' using errcode = 'P0001';
  end if;
  if l.who = 'everyone' then
    return l.player;
  end if;
  select role into v_role from public.profiles where id = p_user;
  if v_role = 'admin' then
    return null;
  end if;
  select value into v_own from public.limit_overrides where user_id = p_user and key = p_key;
  if v_own is not null then
    return v_own;
  end if;
  return case when l.who = 'creator' or (l.who = 'both' and v_role = 'creator') then l.creator else l.player end;
end $$;

-- Raises rate_limited:<key> once p_count has reached the account's limit.
create function public.check_limit(p_user uuid, p_key text, p_count bigint) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := public.limit_of(p_user, p_key);
begin
  if v_limit is not null and p_count >= v_limit then
    raise exception 'rate_limited:%', p_key using errcode = 'P0001';
  end if;
end $$;

create function public.keep_value(p_key text) returns integer
language plpgsql stable security definer set search_path = '' as $$
declare
  v integer;
begin
  select value into v from public.keep_times where key = p_key;
  if v is null then
    raise exception 'unknown_keep_time' using errcode = 'P0001';
  end if;
  return v;
end $$;

-- What the app shows: this account's limits (null = none) and the deletion times. Visitors get
-- the players' values.
create function public.my_limits() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'limits', (select jsonb_object_agg(key, public.limit_of(auth.uid(), key)) from public.limits),
    'keep', (select jsonb_object_agg(key, value) from public.keep_times))
$$;

revoke execute on function public.limit_of(uuid, text), public.check_limit(uuid, text, bigint), public.keep_value(text)
  from public, anon, authenticated;
grant execute on function public.limit_of(uuid, text) to service_role;
revoke execute on function public.my_limits() from public;
grant execute on function public.my_limits() to anon, authenticated;

-- ---------- admins ----------

create function public.admin_limits() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'limits', (select coalesce(jsonb_agg(to_jsonb(l) order by l.sort), '[]') from public.limits l),
    'keep', (select coalesce(jsonb_agg(to_jsonb(k) order by k.sort), '[]') from public.keep_times k),
    'overrides', (select coalesce(jsonb_agg(jsonb_build_object(
        'user_id', o.user_id, 'username', p.username, 'role', p.role, 'key', o.key, 'value', o.value)
        order by p.username, l.sort), '[]')
      from public.limit_overrides o
      join public.profiles p on p.id = o.user_id
      join public.limits l on l.key = o.key));
end $$;

create function public.admin_set_limit(p_key text, p_player integer, p_creator integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  l public.limits;
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  select * into l from public.limits where key = p_key;
  if l.key is null then
    raise exception 'unknown_limit' using errcode = 'P0001';
  end if;
  -- Limits with a single value keep both columns the same.
  if l.who in ('everyone', 'player') then
    p_creator := p_player;
  elsif l.who = 'creator' then
    p_player := p_creator;
  end if;
  if p_player is null or p_creator is null
     or p_player not between l.min_value and l.max_value or p_creator not between l.min_value and l.max_value then
    raise exception 'out_of_range' using errcode = 'P0001';
  end if;
  update public.limits set player = p_player, creator = p_creator where key = p_key;
end $$;

-- p_value null removes the account's own value.
create function public.admin_set_limit_override(p_user uuid, p_key text, p_value integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  l public.limits;
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  select * into l from public.limits where key = p_key;
  if l.key is null or l.who = 'everyone' then
    raise exception 'unknown_limit' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_value is null then
    delete from public.limit_overrides where user_id = p_user and key = p_key;
    return;
  end if;
  if p_value not between l.min_value and l.max_value then
    raise exception 'out_of_range' using errcode = 'P0001';
  end if;
  insert into public.limit_overrides (user_id, key, value) values (p_user, p_key, p_value)
    on conflict (user_id, key) do update set value = excluded.value, updated_at = now();
end $$;

create function public.admin_set_keep_time(p_key text, p_value integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k public.keep_times;
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  select * into k from public.keep_times where key = p_key;
  if k.key is null then
    raise exception 'unknown_keep_time' using errcode = 'P0001';
  end if;
  if p_value is null or p_value not between k.min_value and k.max_value then
    raise exception 'out_of_range' using errcode = 'P0001';
  end if;
  update public.keep_times set value = p_value where key = p_key;
end $$;

revoke execute on function public.admin_limits(), public.admin_set_limit(text, integer, integer),
  public.admin_set_limit_override(uuid, text, integer), public.admin_set_keep_time(text, integer) from public, anon;
grant execute on function public.admin_limits(), public.admin_set_limit(text, integer, integer),
  public.admin_set_limit_override(uuid, text, integer), public.admin_set_keep_time(text, integer) to authenticated;

-- ---------- the limits, now read from the table ----------

create or replace function public.game_ideas_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
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

create or replace function public.game_idea_replies_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
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

create or replace function public.feedback_posts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
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

create or replace function public.feedback_replies_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
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

create or replace function public.developer_applications_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
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

create or replace function public.send_friend_request(p_user uuid) returns text
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
  perform public.check_limit(v_me, 'messages_20s',
    (select count(*) from public.messages where author_id = v_me and created_at > now() - interval '20 seconds'));
  perform public.check_limit(v_me, 'messages_hour',
    (select count(*) from public.messages where author_id = v_me and created_at > now() - interval '1 hour'));
  return new;
end $$;

create or replace function public.create_group(p_title text, p_members uuid[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_id uuid;
begin
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

create or replace function public.add_to_group(p_chat uuid, p_user uuid) returns void
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
  if (select count(*) from public.chat_members where chat_id = p_chat) >= public.limit_of(v_me, 'group_size') then
    raise exception 'group_full' using errcode = 'P0001';
  end if;
  insert into public.chat_members (chat_id, user_id) values (p_chat, p_user) on conflict do nothing;
end $$;

create or replace function public.report_message(p_message bigint, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  msg public.messages;
begin
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

create or replace function public.join_party(p_party uuid, p_code text default null) returns jsonb
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
  if (select count(*) from public.party_members where party_id = p_party) >= public.limit_of(v_me, 'party_size') then
    raise exception 'party_full' using errcode = 'P0001';
  end if;
  perform public.party_drop(v_me);
  insert into public.party_members (user_id, party_id) values (v_me, p_party);
  update public.parties set updated_at = now() where id = p_party;
  return public.party_state(p_party);
end $$;

-- Free AI: the calls per hour come from the limits too (key ai_<feature>). Who may use which
-- feature stays as before; the admins' test has no limit.
create or replace function public.ai_free_take(p_user uuid, p_feature text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.user_role;
  v_limit integer;
  v_calls integer;
begin
  if not public.ai_free_on() then
    raise exception 'free_off' using errcode = 'P0001';
  end if;
  select role into v_role from public.profiles where id = p_user;
  if v_role is null
     or p_feature is null
     or p_feature not in ('translate', 'similar', 'suggest', 'help', 'release', 'describe', 'summary', 'learn', 'connect', 'test')
     or (p_feature in ('release', 'describe', 'summary', 'learn', 'connect') and v_role = 'player')
     or (p_feature = 'test' and v_role <> 'admin') then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  v_limit := case when p_feature = 'test' then null else public.limit_of(p_user, 'ai_' || p_feature) end;
  insert into public.ai_free_limits as l (user_id, feature, window_start, calls)
    values (p_user, p_feature, now(), 1)
    on conflict (user_id, feature) do update
      set calls = case when l.window_start < now() - interval '1 hour' then 1 else l.calls + 1 end,
          window_start = case when l.window_start < now() - interval '1 hour' then now() else l.window_start end
    returning calls into v_calls;
  if v_limit is not null and v_calls > v_limit then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
end $$;
revoke execute on function public.ai_free_take(uuid, text) from public, anon, authenticated;
grant execute on function public.ai_free_take(uuid, text) to service_role;

-- ---------- deletion times, now read from the table ----------

create or replace function public.notify(p_user uuid, p_kind text, p_actor uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null or p_user is not distinct from p_actor then
    return;
  end if;
  if p_actor is not null and exists (select 1 from public.blocks where blocker_id = p_user and blocked_id = p_actor) then
    return;
  end if;
  insert into public.notifications (user_id, kind, actor_id, data) values (p_user, p_kind, p_actor, p_data);
  -- keep only the newest ones
  delete from public.notifications where user_id = p_user and id <= (
    select id from public.notifications where user_id = p_user order by id desc offset public.keep_value('notifications_count') limit 1
  );
end $$;

create or replace function public.cleanup_old_logs()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.connect_jobs
    where status in ('done', 'failed') and updated_at < now() - make_interval(days => public.keep_value('connect_runs'));
  -- AI costs stay 400 days: the monthly budgets and the AI page need them.
  delete from public.ai_usage
    where status <> 'reserved' and created_at < now() - interval '400 days';
$$;
revoke execute on function public.cleanup_old_logs() from public, anon, authenticated;

select cron.schedule('delete-old-messages', '41 3 * * *', $$
  delete from public.messages m using public.chats c
    where c.id = m.chat_id and (
      (c.kind in ('public', 'game') and m.created_at < now() - make_interval(days => public.keep_value('chat_public')))
      or (c.kind in ('dm', 'group') and m.created_at < now() - make_interval(days => public.keep_value('chat_private'))));
  delete from public.message_reports
    where (handled_at is not null and handled_at < now() - make_interval(days => public.keep_value('reports_handled')))
      or created_at < now() - make_interval(days => public.keep_value('reports_all'));
$$);

select cron.schedule('delete-old-notifications', '53 3 * * *',
  $$delete from public.notifications where created_at < now() - make_interval(days => public.keep_value('notifications'))$$);

select cron.schedule('delete-old-game-ideas', '23 4 * * *', $$
  delete from public.game_ideas
  where (claimed_by is null and done_at is null and updated_at < now() - make_interval(days => public.keep_value('ideas')))
     or done_at < now() - make_interval(days => public.keep_value('ideas'))
$$);

select cron.schedule('delete-old-free-ai', '37 3 * * *', $$
  delete from public.ai_free_limits where window_start < now() - interval '1 day';
  delete from public.ai_free_usage where day < (now() at time zone 'utc')::date - 60;
  delete from public.ai_translations where created_at < now() - make_interval(days => public.keep_value('translations'));
  delete from public.ai_suggestions where created_at < now() - make_interval(days => public.keep_value('suggestions'));
$$);
