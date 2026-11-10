-- Play together: games say that they have multiplayer, and players invite their friends
-- into the room they opened in the game.
--
-- The game keeps doing its own multiplayer (its rooms, its room codes). Toki only brings
-- friends into the same room: the host's game tells Toki its room code (toki.room(code) in
-- toki-save.js, or the host types it), Toki sends it to the invited friends, and their game
-- opens with the code in its address (e.g. ?room=ABCD), the way the game's own invite links work.
--
-- Free plan: an invite is one notification (no new table). A new invite to the same friend
-- replaces the earlier one, notifications are deleted after 30 days and capped at 100 per
-- player as before.

-- ---------- games ----------
alter table public.games
  add column multiplayer boolean not null default false,
  -- how many can play together (shown to players), if the developer says
  add column max_players smallint check (max_players between 2 and 64),
  -- the name of the room code in the game's own invite links: <game>?room=ABCD
  add column join_param text not null default 'room' check (join_param ~ '^[a-z][a-z0-9_-]{0,19}$');

-- ---------- notifications ----------
-- game_invite: a friend invites you into their room. dev_news: Toki has something new for
-- developers' games (see notify_developers below).
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'fb_reply', 'fb_status', 'friend_request', 'friend_accept', 'group_add', 'score_beaten', 'game_invite', 'dev_news'));

-- Only the invites, so "how many did this player send lately" stays a tiny lookup.
create index notifications_invites_idx on public.notifications(actor_id) where kind = 'game_invite';

-- Invites a friend into the room p_code of a multiplayer game. The friend sees it in the bell
-- and, while they are on Toki, as a pop-up (ping() below).
-- Errors: login_required, banned, not_friends, not_found (no such multiplayer game),
-- bad_code, rate_limited (the same friend within 15 seconds, or 30 invites in 10 minutes).
create function public.invite_to_game(p_user uuid, p_game uuid, p_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_title text;
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
  -- One invite per friend: the new one replaces the earlier one.
  delete from public.notifications where actor_id = v_me and kind = 'game_invite' and user_id = p_user;
  perform public.notify(p_user, 'game_invite', v_me, jsonb_build_object('game', p_game, 'title', v_title, 'code', p_code));
end $$;
revoke execute on function public.invite_to_game(uuid, uuid, text) from public, anon;
grant execute on function public.invite_to_game(uuid, uuid, text) to authenticated;

-- ---------- ping: also the newest invite, and whether friends are online ----------
-- "invite": the newest unread invite of the last 5 minutes, for the pop-up.
-- "friends_online": how many friends are on Toki now (up to 9). Only then can an invite
-- arrive, so only then does the app listen for the "you got an invite" nudge.
create or replace function public.ping(p_game uuid default null, p_here boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_blocked uuid[];
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
  v_blocked := public.blocked_ids();
  return jsonb_build_object(
    'notifications', (select count(*) from (
      select 1 from public.notifications where user_id = v_me and read_at is null limit 99) n),
    'chats', (select count(*) from public.chat_members m where m.user_id = v_me and exists (
      select 1 from public.messages x
      where x.chat_id = m.chat_id and x.id > m.last_read_id and x.author_id <> v_me and not (x.author_id = any (v_blocked)))),
    'friends_online', (select count(*) from (
      select 1 from public.friends f join public.presence o on o.user_id = f.friend_id
      where f.user_id = v_me and o.last_seen > now() - interval '5 minutes' limit 9) here),
    'invite', (
      select jsonb_build_object('id', n.id, 'game', n.data->>'game', 'code', n.data->>'code',
        'from', jsonb_build_object('id', p.id, 'username', p.username, 'avatar_url', p.avatar_url, 'avatar_seed', p.avatar_seed))
      from public.notifications n join public.profiles p on p.id = n.actor_id
      where n.user_id = v_me and n.kind = 'game_invite' and n.read_at is null
        and n.created_at > now() - interval '5 minutes' and not (n.actor_id = any (v_blocked))
      order by n.id desc limit 1));
end $$;

-- ---------- news for developers ----------
-- Tells everyone who has a game on Toki that Toki can do something new for their games
-- (p_topic, e.g. 'multiplayer': the app has the text for it). They add it with Toki Connect
-- or the instructions to copy. One notification per developer and topic.
-- Run it by hand (SQL editor, or the Supabase connector) once the app that knows the topic
-- is live: select public.notify_developers('multiplayer');
create function public.notify_developers(p_topic text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_dev uuid;
  v_count integer := 0;
begin
  if p_topic is null or p_topic !~ '^[a-z][a-z0-9_]{0,29}$' then
    raise exception 'bad_topic' using errcode = 'P0001';
  end if;
  for v_dev in
    select distinct g.created_by from public.games g
    where g.created_by is not null and not exists (
      select 1 from public.notifications n
      where n.user_id = g.created_by and n.kind = 'dev_news' and n.data->>'topic' = p_topic)
  loop
    perform public.notify(v_dev, 'dev_news', null, jsonb_build_object('topic', p_topic));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke execute on function public.notify_developers(text) from public, anon, authenticated;

-- ---------- Toki Connect can add it ----------
alter table public.connect_jobs drop constraint connect_jobs_features_check;
alter table public.connect_jobs add constraint connect_jobs_features_check check (
  (cardinality(features) between 1 and 3 and features <@ array['saves', 'scores', 'multiplayer'])
  or features = array['fix']);
