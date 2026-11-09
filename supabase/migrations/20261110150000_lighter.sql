-- Lighter on Supabase's free plan: fewer requests, fewer writes, less storage.
--
-- * ping(): one request every 2 minutes does what three did (online status, unread
--   notifications, unread chats). The bell no longer keeps a Realtime connection open, so
--   Realtime connections are only used while a chat is on screen (the free plan allows 200).
-- * Unread chat messages are counted by message id instead of time, which the existing
--   index answers directly, and counting stops at 99.
-- * Hidden messages of blocked players are worked out once per request, not once per message.
-- * Indexes that only helped rare deletes (of whole games or accounts) or tiny tables are
--   gone: every index costs storage and work on each write.
-- * Plays: only the last 15 days are needed (for "plays per day" and one play per day per
--   browser); the totals stay in game_stats. Before, this table grew forever.
-- * Save history: 5 earlier versions and 3 conflict copies per game (was 10 and 5), cleaned
--   up once a day instead of every hour (players only ever see the last 3 days anyway).

-- ---------- indexes ----------
drop index if exists public.feedback_votes_user_idx;
drop index if exists public.game_releases_created_by_idx;
drop index if exists public.games_old_slugs_idx;
drop index if exists public.presence_game_idx;
drop index if exists public.recent_plays_game_idx;
drop index if exists public.friends_friend_idx;
drop index if exists public.chats_game_idx;
drop index if exists public.chats_created_by_idx;
drop index if exists public.messages_created_idx;
drop index if exists public.message_reports_open_idx;
drop index if exists public.message_reports_author_idx;
drop index if exists public.message_reports_reporter_idx;
drop index if exists public.message_reports_chat_idx;
drop index if exists public.notifications_actor_idx;
drop index if exists public.notifications_created_idx;
drop index if exists public.game_save_history_game_idx;

-- Online status is overwritten every few minutes: room in each page lets Postgres update it
-- in place (no index on it changes), without leaving dead rows behind.
alter table public.presence set (fillfactor = 70);

-- ---------- blocked players, once per request ----------
-- Everyone the logged-in player blocked or was blocked by.
create function public.blocked_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(case when blocker_id = auth.uid() then blocked_id else blocker_id end), '{}')
  from public.blocks where blocker_id = auth.uid() or blocked_id = auth.uid()
$$;
revoke execute on function public.blocked_ids() from public, anon;
grant execute on function public.blocked_ids() to authenticated;

-- "(select …)" runs once per request instead of once per message (coalesce turns it into a list).
alter policy "messages: readable, not from blocked players" on public.messages
  using (public.can_read_chat(chat_id) and not (author_id = any (coalesce((select public.blocked_ids()), '{}'::uuid[]))));

-- ---------- unread messages by id ----------
alter table public.chat_members add column last_read_id bigint not null default 0;
update public.chat_members m set last_read_id = coalesce(
  (select max(x.id) from public.messages x where x.chat_id = m.chat_id and x.created_at <= m.last_read_at), 0);
alter table public.chat_members drop column last_read_at;

create or replace function public.messages_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.chats set last_message_at = new.created_at where id = new.chat_id;
  update public.chat_members set last_read_id = new.id where chat_id = new.chat_id and user_id = new.author_id;
  return null;
end $$;

create or replace function public.mark_chat_read(p_chat uuid) returns void
language sql security definer set search_path = '' as $$
  update public.chat_members
    set last_read_id = coalesce((select max(id) from public.messages where chat_id = p_chat), 0)
    where chat_id = p_chat and user_id = auth.uid()
$$;

drop function public.my_chats();
create function public.my_chats() returns table (
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
  join public.chats c on c.id = m.chat_id
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
revoke execute on function public.my_chats() from public, anon;
grant execute on function public.my_chats() to authenticated;

-- ---------- one request every 2 minutes ----------
-- Marks the player online (p_here: Toki is visible; p_game: the game they have open) and
-- returns {"notifications": unread notifications, "chats": chats with unread messages}.
-- Online status is only written when it changed or is a minute old.
create function public.ping(p_game uuid default null, p_here boolean default true) returns jsonb
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
      where x.chat_id = m.chat_id and x.id > m.last_read_id and x.author_id <> v_me and not (x.author_id = any (v_blocked)))));
end $$;
revoke execute on function public.ping(uuid, boolean) from public, anon;
grant execute on function public.ping(uuid, boolean) to authenticated;

-- The bell asks with ping() now: notifications don't need to go through Realtime.
alter publication supabase_realtime drop table public.notifications;

-- ---------- plays: keep 15 days ----------
delete from public.game_plays where day < current_date - 15;
select cron.schedule('delete-old-plays', '29 3 * * *',
  $$delete from public.game_plays where day < current_date - 15$$);

-- ---------- save history: fewer copies, daily cleanup ----------
create or replace function public.trim_save_history(p_user uuid, p_game uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.game_save_history h
  where h.user_id = p_user and h.game_id = p_game
    and (h.saved_at < now() - interval '3 days'
      or h.id not in (
        select id from (
          select id, row_number() over (partition by kind order by id desc) as n
          from public.game_save_history where user_id = p_user and game_id = p_game
        ) r where (kind = 'earlier' and n <= 5) or (kind = 'conflict' and n <= 3)
      ))
$$;
revoke execute on function public.trim_save_history(uuid, uuid) from public, anon, authenticated;

-- Copies beyond the new limits go now.
delete from public.game_save_history h where h.id not in (
  select id from (
    select id, kind, row_number() over (partition by user_id, game_id, kind order by id desc) as n
    from public.game_save_history
  ) r where (kind = 'earlier' and n <= 5) or (kind = 'conflict' and n <= 3)
);

select cron.unschedule('delete-old-save-history');
select cron.schedule('delete-old-save-history', '17 3 * * *',
  $$delete from public.game_save_history where saved_at < now() - interval '3 days'$$);
