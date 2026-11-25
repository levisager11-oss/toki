-- Following developers: optional notifications when a followed developer releases a new game
-- or a big update. Everyone who follows hears about it by default and can turn it off per developer.

alter table public.follows add column notify boolean not null default true;

create or replace function public.follow_info(p_dev uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'followers', (select count(*) from public.follows where developer_id = p_dev),
    'following', exists (select 1 from public.follows where follower_id = auth.uid() and developer_id = p_dev),
    'notify', coalesce((select f.notify from public.follows f where f.follower_id = auth.uid() and f.developer_id = p_dev), false))
$$;

-- Turns notifications for a followed developer on or off.
create function public.set_follow_notify(p_dev uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  update public.follows set notify = coalesce(p_on, false) where follower_id = v_me and developer_id = p_dev;
end $$;

revoke execute on function public.set_follow_notify(uuid, boolean) from public, anon;
grant execute on function public.set_follow_notify(uuid, boolean) to authenticated;

-- 'follow_news': a developer you follow released a new game or a big update.
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'fb_reply', 'fb_status', 'friend_request', 'friend_accept', 'group_add', 'score_beaten', 'game_invite', 'dev_news',
  'game_idea', 'moderation', 'report_done', 'application', 'level_up', 'trade', 'review', 'review_reply', 'follow_news'));

-- Tells the followers (with notifications on) of a developer about a game or release.
-- At most 2000 followers per event, so one release can never flood the database.
create function public.notify_followers(p_dev uuid, p_game uuid, p_title text, p_slug text, p_version text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_follower uuid;
  v_data jsonb := jsonb_strip_nulls(jsonb_build_object('game', p_game, 'title', p_title, 'slug', p_slug, 'version', p_version));
begin
  if p_dev is null then
    return;
  end if;
  for v_follower in
    select follower_id from public.follows where developer_id = p_dev and notify order by created_at limit 2000
  loop
    perform public.notify(v_follower, 'follow_news', p_dev, v_data);
  end loop;
end $$;
revoke execute on function public.notify_followers(uuid, uuid, text, text, text) from public, anon, authenticated;

create function public.follow_news_game() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.notify_followers(new.created_by, new.id, new.title, new.slug, null);
  return null;
end $$;
create trigger games_follow_news after insert on public.games
  for each row execute function public.follow_news_game();

create function public.follow_news_release() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  g record;
begin
  if new.game_id is null or new.small then
    return null;
  end if;
  select created_by, title, slug into g from public.games where id = new.game_id;
  if found then
    perform public.notify_followers(g.created_by, new.game_id, g.title, g.slug, new.version);
  end if;
  return null;
end $$;
create trigger game_releases_follow_news after insert on public.game_releases
  for each row execute function public.follow_news_release();
