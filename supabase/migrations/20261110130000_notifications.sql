-- Notifications: a reply to your feedback, your feedback's status changed (e.g. fixed in an
-- update), friend requests, accepted requests, being added to a group, a new high score
-- beating yours.
-- New chat messages don't make a notification each (that would fill the database): the chat
-- shows how many are unread instead.
-- Free plan: notifications are deleted after 30 days, and each player keeps at most 100.

create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('fb_reply', 'fb_status', 'friend_request', 'friend_accept', 'group_add', 'score_beaten')),
  -- who did it (may be null, e.g. for status changes made in the SQL editor)
  actor_id uuid references public.profiles(id) on delete cascade,
  -- what it is about, e.g. {"post": "<id>", "title": "…"} or {"chat": "<id>"}
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_user_idx on public.notifications(user_id, id desc);
create index notifications_actor_idx on public.notifications(actor_id);
create index notifications_created_idx on public.notifications(created_at);

alter table public.notifications enable row level security;
create policy "notifications: own" on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy "notifications: delete own" on public.notifications for delete to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.notifications from anon, authenticated;
grant select, delete on public.notifications to authenticated;

-- Adds a notification, unless the player blocked whoever caused it, or caused it themself.
create function public.notify(p_user uuid, p_kind text, p_actor uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null or p_user is not distinct from p_actor then
    return;
  end if;
  if p_actor is not null and exists (select 1 from public.blocks where blocker_id = p_user and blocked_id = p_actor) then
    return;
  end if;
  insert into public.notifications (user_id, kind, actor_id, data) values (p_user, p_kind, p_actor, p_data);
  -- keep the newest 100
  delete from public.notifications where user_id = p_user and id <= (
    select id from public.notifications where user_id = p_user order by id desc offset 100 limit 1
  );
end $$;
revoke execute on function public.notify(uuid, text, uuid, jsonb) from public, anon, authenticated;

create function public.mark_notifications_read(p_ids bigint[] default null) returns void
language sql security definer set search_path = '' as $$
  update public.notifications set read_at = now()
  where user_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids))
$$;
revoke execute on function public.mark_notifications_read(bigint[]) from public, anon;
grant execute on function public.mark_notifications_read(bigint[]) to authenticated;

-- Feedback: replies and status changes reach the post's author.
create function public.notify_feedback_reply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  p public.feedback_posts;
begin
  select * into p from public.feedback_posts where id = new.post_id;
  perform public.notify(p.author_id, 'fb_reply', new.author_id,
    jsonb_build_object('post', p.id, 'title', p.title, 'official', new.official));
  return null;
end $$;
create trigger notify_feedback_reply after insert on public.feedback_replies
  for each row execute function public.notify_feedback_reply();

create function public.notify_feedback_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.notify(new.author_id, 'fb_status', auth.uid(), jsonb_build_object(
    'post', new.id, 'title', new.title, 'status', new.status,
    'version', (select version from public.game_releases where id = new.fixed_in)));
  return null;
end $$;
create trigger notify_feedback_status after update of status on public.feedback_posts
  for each row when (new.status is distinct from old.status) execute function public.notify_feedback_status();

-- Friends.
create function public.notify_friend_request() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.notify(new.to_id, 'friend_request', new.from_id, '{}');
  return null;
end $$;
create trigger notify_friend_request after insert on public.friend_requests
  for each row execute function public.notify_friend_request();

-- A friendship is two rows: the one where the accepting player is the friend tells the other.
create function public.notify_friend_accept() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.friend_id = auth.uid() then
    perform public.notify(new.user_id, 'friend_accept', new.friend_id, '{}');
  end if;
  return null;
end $$;
create trigger notify_friend_accept after insert on public.friends
  for each row execute function public.notify_friend_accept();

-- Groups: everyone added (except whoever made or joined the group themself).
create function public.notify_group_add() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.chats where id = new.chat_id and kind = 'group') then
    perform public.notify(new.user_id, 'group_add', auth.uid(),
      jsonb_build_object('chat', new.chat_id, 'title', (select title from public.chats where id = new.chat_id)));
  end if;
  return null;
end $$;
create trigger notify_group_add after insert on public.chat_members
  for each row execute function public.notify_group_add();

revoke execute on function public.notify_feedback_reply() from public, anon, authenticated;
revoke execute on function public.notify_feedback_status() from public, anon, authenticated;
revoke execute on function public.notify_friend_request() from public, anon, authenticated;
revoke execute on function public.notify_friend_accept() from public, anon, authenticated;
revoke execute on function public.notify_group_add() from public, anon, authenticated;

-- The bell updates right away.
alter publication supabase_realtime add table public.notifications;

select cron.schedule('delete-old-notifications', '53 3 * * *',
  $$delete from public.notifications where created_at < now() - interval '30 days'$$);
