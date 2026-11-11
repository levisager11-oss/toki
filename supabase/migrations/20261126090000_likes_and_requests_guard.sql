-- Likes of an account are stored under the account's id, and account ids are public.
-- set_like and claim_likes trusted any p_visitor, so a visitor could remove an account's likes
-- and a logged-in player could move another player's likes to themselves. Account ids are now
-- never accepted as a visitor id.
create or replace function public.set_like(p_game uuid, p_visitor uuid, p_like boolean) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_likes integer;
  v_who uuid := coalesce(auth.uid(), p_visitor);
begin
  if auth.uid() is null and exists (select 1 from public.profiles where id = p_visitor) then
    v_who := null; -- not this visitor's id to use: change nothing
  end if;
  if v_who is not null and p_like then
    insert into public.game_likes (game_id, visitor) values (p_game, v_who) on conflict do nothing;
    if found then
      insert into public.game_stats (game_id, likes) values (p_game, 1)
      on conflict (game_id) do update set likes = public.game_stats.likes + 1;
    end if;
  elsif v_who is not null then
    delete from public.game_likes where game_id = p_game and visitor = v_who;
    if found then
      update public.game_stats set likes = greatest(likes - 1, 0) where game_id = p_game;
    end if;
  end if;
  select likes into v_likes from public.game_stats where game_id = p_game;
  return coalesce(v_likes, 0);
end $$;

create or replace function public.claim_likes(p_visitor uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_dups integer;
  v_moved integer;
begin
  if v_me is null or p_visitor = v_me or exists (select 1 from public.profiles where id = p_visitor) then
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

-- Taking a friend request back deleted the row the daily limit counted, so send, take back, send
-- notified the same player again and again. The limit now counts the notifications sent, and the
-- same player is notified about requests from the same sender at most once a day.
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
  if greatest(
    (select count(*) from public.friend_requests where from_id = v_me and created_at > now() - interval '1 day'),
    (select count(*) from public.notifications
      where actor_id = v_me and kind = 'friend_request' and created_at > now() - interval '1 day')
  ) >= 30 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  insert into public.friend_requests (from_id, to_id) values (v_me, p_user) on conflict do nothing;
  return 'sent';
end $$;

create or replace function public.notify_friend_request() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.notifications
    where user_id = new.to_id and actor_id = new.from_id and kind = 'friend_request'
      and created_at > now() - interval '1 day'
  ) then
    perform public.notify(new.to_id, 'friend_request', new.from_id, '{}');
  end if;
  return null;
end $$;

-- Open friend requests nobody answered are dropped after 60 days.
select cron.schedule('delete-old-friend-requests', '17 4 * * *',
  $$delete from public.friend_requests where created_at < now() - interval '60 days'$$);
