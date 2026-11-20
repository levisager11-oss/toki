-- Toki 2.0: reviews with stars, following developers, and what friends did lately.
--
-- * Reviews: a logged-in player who played a game for at least 10 minutes gives it 1 to 5 stars
--   and, if they like, a few words. One review per player and game, which they can change or
--   delete. The developer can answer it once (and change the answer); nobody but an admin can
--   remove it, after a report. Game cards show the average (game_stats.reviews and .stars).
-- * Following: players follow developers and see their new games and updates in the feed.
-- * Activity: what friends did (a new level, achievements, a new best score, a new cosmetic, a
--   review). One row per thing, overwritten (all of one day's achievements in a game are one
--   row), at most 100 per player, deleted after 30 days. Only friends see it, and a player can
--   turn it off on their account page (profiles.share_activity).

-- ---------- reviews ----------

create table public.game_reviews (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  stars smallint not null check (stars between 1 and 5),
  body text not null default '' check (char_length(body) <= 1000),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  -- the developer's answer
  reply text check (reply is null or char_length(reply) between 1 and 1000),
  reply_by uuid references public.profiles(id) on delete set null,
  reply_at timestamptz,
  -- removed by an admin after a report
  hidden boolean not null default false,
  unique (game_id, user_id)
);
create index game_reviews_game_idx on public.game_reviews(game_id, created_at desc);
create index game_reviews_user_idx on public.game_reviews(user_id);
create index game_reviews_reply_by_idx on public.game_reviews(reply_by);

alter table public.game_reviews enable row level security;
create policy "reviews are public" on public.game_reviews for select
  using (not hidden or user_id = (select auth.uid()) or public.feedback_manager(game_id));
revoke all on public.game_reviews from anon, authenticated;
grant select on public.game_reviews to anon, authenticated;

alter table public.game_stats
  add column reviews integer not null default 0 check (reviews >= 0),
  -- the sum of all stars: the average is stars / reviews
  add column stars integer not null default 0 check (stars >= 0);

create function public.game_reviews_count() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_game uuid := coalesce(new.game_id, old.game_id);
begin
  insert into public.game_stats (game_id) values (v_game) on conflict do nothing;
  update public.game_stats s set
    reviews = (select count(*) from public.game_reviews r where r.game_id = v_game and not r.hidden),
    stars = coalesce((select sum(r.stars) from public.game_reviews r where r.game_id = v_game and not r.hidden), 0)
  where s.game_id = v_game and exists (select 1 from public.games where id = v_game);
  return null;
end $$;
revoke execute on function public.game_reviews_count() from public, anon, authenticated;
create trigger game_reviews_count after insert or update of stars, hidden or delete on public.game_reviews
  for each row execute function public.game_reviews_count();

-- Whether the logged-in player may review the game: how long they played it, how long they have
-- to (600 seconds), whether it is their own game, and their review if they wrote one.
create function public.review_status(p_game uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'seconds', coalesce((select seconds from public.playtime where user_id = auth.uid() and game_id = p_game), 0),
    'needed', 600,
    'own', exists (select 1 from public.games where id = p_game and created_by = auth.uid()),
    'review', (select to_jsonb(r) from public.game_reviews r where r.game_id = p_game and r.user_id = auth.uid()))
  where auth.uid() is not null
$$;

-- Writes or changes the logged-in player's review. Raises play_more (under 10 minutes of
-- playtime), own_game, banned, not_found or rate_limited:reviews_day.
create function public.save_review(p_game uuid, p_stars integer, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_owner uuid;
  v_title text;
  v_id uuid;
  v_body text := btrim(coalesce(p_body, ''));
begin
  perform public.limit_lock(v_me);
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  select created_by, title into v_owner, v_title from public.games where id = p_game;
  if v_title is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_owner = v_me then
    raise exception 'own_game' using errcode = 'P0001';
  end if;
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  if coalesce((select seconds from public.playtime where user_id = v_me and game_id = p_game), 0) < 600 then
    raise exception 'play_more' using errcode = 'P0001';
  end if;
  if p_stars is null or p_stars not between 1 and 5 or char_length(v_body) > 1000 then
    raise exception 'bad_review' using errcode = 'P0001';
  end if;
  select id into v_id from public.game_reviews where game_id = p_game and user_id = v_me for update;
  if v_id is not null then
    update public.game_reviews set stars = p_stars, body = v_body, edited_at = now() where id = v_id;
    return v_id;
  end if;
  perform public.check_limit(v_me, 'reviews_day',
    (select count(*) from public.game_reviews where user_id = v_me and created_at > now() - interval '1 day'));
  insert into public.game_reviews (game_id, user_id, stars, body) values (p_game, v_me, p_stars, v_body) returning id into v_id;
  perform public.notify(v_owner, 'review', v_me, jsonb_build_object('game', p_game, 'title', v_title, 'stars', p_stars, 'review', v_id));
  return v_id;
end $$;

-- Deletes the logged-in player's review of a game.
create function public.delete_review(p_game uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.game_reviews where game_id = p_game and user_id = auth.uid()
$$;

-- The game's developer (or an admin) answers a review; an empty answer removes it.
create function public.reply_review(p_id uuid, p_text text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.game_reviews;
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
begin
  select * into r from public.game_reviews where id = p_id for update;
  if r.id is null or not public.feedback_manager(r.game_id) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if char_length(v_text) > 1000 then
    raise exception 'bad_review' using errcode = 'P0001';
  end if;
  update public.game_reviews set reply = v_text, reply_by = case when v_text is null then null else auth.uid() end,
    reply_at = case when v_text is null then null else now() end
    where id = p_id;
  if v_text is not null and r.reply is null then
    perform public.notify(r.user_id, 'review_reply', auth.uid(), jsonb_build_object(
      'game', r.game_id, 'title', (select title from public.games where id = r.game_id)));
  end if;
end $$;

-- ---------- reports about reviews ----------

alter table public.content_reports drop constraint content_reports_kind_check;
alter table public.content_reports add constraint content_reports_kind_check
  check (kind in ('game', 'profile', 'feedback', 'idea', 'review'));

-- from 20261211090000_limit_lock.sql, now also for reviews
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
  elsif p_kind = 'review' then
    select true, r.user_id, g.title || ': ' || left(coalesce(nullif(r.body, ''), repeat('★', r.stars)), 80)
      into v_found, v_owner, v_title
      from public.game_reviews r join public.games g on g.id = r.game_id where r.id = p_target and not r.hidden;
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

-- from 20261201090000_legal.sql, now also for reviews ('removed' hides the review)
create or replace function public.handle_content_report(p_report bigint, p_outcome text, p_note text default '', p_days integer default 0) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.content_reports;
  v_note text := left(btrim(coalesce(p_note, '')), 500);
  v_reporter uuid;
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if p_outcome not in ('dismissed', 'removed', 'banned') then
    raise exception 'bad_outcome' using errcode = 'P0001';
  end if;
  select * into r from public.content_reports where id = p_report and handled_at is null;
  if r.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  for v_reporter in
    update public.content_reports set handled_at = now(), outcome = p_outcome, note = v_note
      where handled_at is null and kind = r.kind and target = r.target
      returning reporter_id
  loop
    perform public.notify(v_reporter, 'report_done', null,
      jsonb_build_object('what', r.kind, 'title', r.title, 'outcome', p_outcome));
  end loop;
  if p_outcome in ('removed', 'banned') then
    if r.kind = 'game' then
      delete from public.games where id = r.target;
    elsif r.kind = 'profile' then
      update public.profiles set bio = '', avatar_url = null where id = r.target;
    elsif r.kind = 'feedback' then
      update public.feedback_posts set hidden = true where id = r.target;
    elsif r.kind = 'idea' then
      delete from public.game_ideas where id = r.target;
    elsif r.kind = 'review' then
      update public.game_reviews set hidden = true where id = r.target;
    end if;
    perform public.notify(r.owner_id, 'moderation', null, jsonb_build_object(
      'what', r.kind, 'title', r.title, 'note', v_note, 'days', case when p_outcome = 'banned' then greatest(p_days, 1) end));
  end if;
  if p_outcome = 'banned' then
    perform public.ban_user(r.owner_id, greatest(p_days, 1));
  end if;
end $$;

-- ---------- following developers ----------

create table public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  developer_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, developer_id),
  check (follower_id <> developer_id)
);
create index follows_developer_idx on public.follows(developer_id);

alter table public.follows enable row level security;
create policy "follows: own" on public.follows for select to authenticated
  using (follower_id = (select auth.uid()));
revoke all on public.follows from anon, authenticated;
grant select on public.follows to authenticated;

-- Follows (p_on) or stops following a developer. At most 500. Raises not_developer.
create function public.follow_developer(p_dev uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  if not coalesce(p_on, false) then
    delete from public.follows where follower_id = v_me and developer_id = p_dev;
    return;
  end if;
  if not exists (select 1 from public.profiles where id = p_dev and role in ('creator', 'admin')) or p_dev = v_me then
    raise exception 'not_developer' using errcode = 'P0001';
  end if;
  if (select count(*) from public.follows where follower_id = v_me) >= 500 then
    raise exception 'too_many' using errcode = 'P0001';
  end if;
  insert into public.follows (follower_id, developer_id) values (v_me, p_dev) on conflict do nothing;
end $$;

-- How many follow a developer, and whether the logged-in player does.
create function public.follow_info(p_dev uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'followers', (select count(*) from public.follows where developer_id = p_dev),
    'following', exists (select 1 from public.follows where follower_id = auth.uid() and developer_id = p_dev))
$$;

-- ---------- what friends did ----------

alter table public.profiles add column share_activity boolean not null default true;
grant select (share_activity) on public.profiles to authenticated;
grant update (share_activity) on public.profiles to authenticated;

create table public.activity (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('level', 'achievement', 'best', 'cosmetic', 'review')),
  -- one row per thing: a later one of the same thing overwrites it
  key text not null check (char_length(key) <= 200),
  game_id uuid references public.games(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, key)
);
create index activity_user_idx on public.activity(user_id, created_at desc);
create index activity_created_idx on public.activity(created_at);
create index activity_game_idx on public.activity(game_id);

alter table public.activity enable row level security;
create policy "activity: self and friends" on public.activity for select to authenticated
  using (user_id = (select auth.uid()) or public.is_friend(user_id));
revoke all on public.activity from anon, authenticated;
grant select on public.activity to authenticated;

-- Notes something a player did, for their friends (not when they turned it off). p_merge: a JSON
-- key whose list grows instead of being replaced (the day's achievements, at most 10).
create function public.add_activity(p_user uuid, p_kind text, p_key text, p_game uuid, p_data jsonb, p_merge text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce((select share_activity from public.profiles where id = p_user), false) then
    return;
  end if;
  insert into public.activity as a (user_id, kind, key, game_id, data)
    values (p_user, p_kind, p_key, p_game, p_data)
    on conflict (user_id, key) do update set created_at = now(), data = case
      when p_merge is null then excluded.data
      else excluded.data || jsonb_build_object(p_merge, (
        select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select distinct x from jsonb_array_elements(coalesce(a.data->p_merge, '[]'::jsonb) || coalesce(excluded.data->p_merge, '[]'::jsonb)) x
          limit 10) y))
    end;
  delete from public.activity where user_id = p_user and id in (
    select id from public.activity where user_id = p_user order by created_at desc offset 100);
end $$;
revoke execute on function public.add_activity(uuid, text, text, uuid, jsonb, text) from public, anon, authenticated;

create function public.activity_level() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.level > old.level then
    perform public.add_activity(new.user_id, 'level', 'level:' || new.level, null, jsonb_build_object('level', new.level));
  end if;
  return null;
end $$;

create function public.activity_achievement() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.add_activity(new.user_id, 'achievement', 'ach:' || new.game_id || ':' || public.utc_today(), new.game_id,
    jsonb_build_object('ids', jsonb_build_array(new.achievement)), 'ids');
  return null;
end $$;

create function public.activity_best() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.score is distinct from old.score then
    perform public.add_activity(new.user_id, 'best', 'best:' || new.game_id || ':' || new.board || ':' || public.utc_today(), new.game_id,
      jsonb_build_object('score', new.score, 'board', new.board));
  end if;
  return null;
end $$;

create function public.activity_cosmetic() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.how in ('shop', 'achievement') then
    perform public.add_activity(new.user_id, 'cosmetic', 'cos:' || new.cosmetic_id,
      (select game_id from public.cosmetics where id = new.cosmetic_id), jsonb_build_object('id', new.cosmetic_id));
  end if;
  return null;
end $$;

create function public.activity_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not new.hidden then
    perform public.add_activity(new.user_id, 'review', 'review:' || new.game_id, new.game_id, jsonb_build_object('stars', new.stars));
  else
    delete from public.activity where user_id = new.user_id and key = 'review:' || new.game_id;
  end if;
  return null;
end $$;

revoke execute on function public.activity_level(), public.activity_achievement(), public.activity_best(),
  public.activity_cosmetic(), public.activity_review() from public, anon, authenticated;

create trigger player_progress_activity after update of level on public.player_progress
  for each row execute function public.activity_level();
create trigger achievement_unlocks_activity after insert on public.achievement_unlocks
  for each row execute function public.activity_achievement();
create trigger game_scores_activity after insert or update of score on public.game_scores
  for each row execute function public.activity_best();
create trigger player_cosmetics_activity after insert on public.player_cosmetics
  for each row execute function public.activity_cosmetic();
create trigger game_reviews_activity after insert or update of stars, hidden on public.game_reviews
  for each row execute function public.activity_review();

-- Turning it off takes back what friends could see.
create function public.share_activity_off() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.share_activity and not new.share_activity then
    delete from public.activity where user_id = new.id;
  end if;
  return null;
end $$;
revoke execute on function public.share_activity_off() from public, anon, authenticated;
create trigger profiles_share_activity after update of share_activity on public.profiles
  for each row execute function public.share_activity_off();

-- The feed: what the logged-in player's friends did, and the new games and updates of the
-- developers they follow, newest first, before p_before (for "more").
create function public.my_feed(p_before timestamptz default null, p_limit integer default 30) returns table (
  kind text, at timestamptz, user_id uuid, username text, avatar_url text, avatar_seed text,
  game_id uuid, game_slug text, game_title text, data jsonb
)
language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as id),
  friend_activity as (
    select a.kind, a.created_at as at, a.user_id, a.game_id, a.data
    from public.activity a join public.friends f on f.friend_id = a.user_id and f.user_id = (select id from me)
    where a.created_at > now() - interval '30 days'
  ),
  followed_games as (
    select 'new_game'::text as kind, g.created_at as at, g.created_by as user_id, g.id as game_id, '{}'::jsonb as data
    from public.games g join public.follows fo on fo.developer_id = g.created_by and fo.follower_id = (select id from me)
    where g.created_at > now() - interval '60 days'
  ),
  followed_updates as (
    select 'release'::text, r.published_at, g.created_by, g.id,
      jsonb_build_object('version', r.version, 'title', r.title, 'small', r.small, 'release', r.id)
    from public.game_releases r join public.games g on g.id = r.game_id
    join public.follows fo on fo.developer_id = g.created_by and fo.follower_id = (select id from me)
    where r.published_at > now() - interval '60 days'
  ),
  everything as (
    select * from friend_activity union all select * from followed_games union all select * from followed_updates
  )
  select e.kind, e.at, e.user_id, p.username, p.avatar_url, p.avatar_seed, e.game_id, g.slug, g.title, e.data
  from everything e
  join public.profiles p on p.id = e.user_id
  left join public.games g on g.id = e.game_id
  where e.at < coalesce(p_before, now() + interval '1 minute') and (select id from me) is not null
  order by e.at desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100)
$$;

-- ---------- notifications, limits, deletion ----------

alter table public.notifications drop constraint notifications_kind_check;
-- review: a player reviewed your game. review_reply: the developer answered your review.
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'fb_reply', 'fb_status', 'friend_request', 'friend_accept', 'group_add', 'score_beaten', 'game_invite', 'dev_news',
  'game_idea', 'moderation', 'report_done', 'application', 'level_up', 'trade', 'review', 'review_reply'));

insert into public.limits (key, who, player, creator, min_value, max_value, sort) values
  ('reviews_day', 'both', 10, 10, 0, 1000, 23);
insert into public.keep_times (key, value, unit, min_value, max_value, sort) values
  ('activity', 30, 'days', 1, 90, 71);

select cron.schedule('delete-old-activity', '51 4 * * *',
  $$delete from public.activity where created_at < now() - make_interval(days => public.keep_value('activity'))$$);

-- ---------- a copy of your data ----------
-- from 20261208090000_review_fixes.sql, now also with levels, tokens, cosmetics, trades, reviews,
-- the developers one follows and what friends could see.
create or replace function public.export_my_data() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_out jsonb;
  v_rows jsonb;
  v_part text[];
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  select jsonb_build_object('exported_at', now(), 'account', jsonb_build_object(
      'username', p.username, 'email', u.email, 'role', p.role, 'created_at', p.created_at, 'bio', p.bio,
      'avatar_url', p.avatar_url, 'month_of_birth', to_char(p.born, 'YYYY-MM'), 'parent_ok_at', p.parent_ok_at,
      'banned_until', p.banned_until, 'frame', p.frame, 'name_color', p.name_color, 'title', p.title, 'theme', p.theme,
      'share_activity', p.share_activity))
    into v_out from public.profiles p join auth.users u on u.id = p.id where p.id = v_me;
  -- name in the document, table, the column that holds the account
  foreach v_part slice 1 in array array[
    ['games', 'games', 'created_by'],
    ['favorites', 'game_likes', 'visitor'],
    ['saves', 'game_saves', 'user_id'],
    ['save_history', 'game_save_history', 'user_id'],
    ['scores', 'game_scores', 'user_id'],
    ['daily_and_weekly_scores', 'period_scores', 'user_id'],
    ['daily_streaks', 'daily_streaks', 'user_id'],
    ['achievements', 'achievement_unlocks', 'user_id'],
    ['playtime', 'playtime', 'user_id'],
    ['recent_plays', 'recent_plays', 'user_id'],
    ['level_and_tokens', 'player_progress', 'user_id'],
    ['token_history', 'token_log', 'user_id'],
    ['cosmetics', 'player_cosmetics', 'user_id'],
    ['trades_offered', 'trades', 'from_id'],
    ['trades_received', 'trades', 'to_id'],
    ['reviews', 'game_reviews', 'user_id'],
    ['following', 'follows', 'follower_id'],
    ['activity_for_friends', 'activity', 'user_id'],
    ['online_status', 'presence', 'user_id'],
    ['friends', 'friends', 'user_id'],
    ['friend_requests_sent', 'friend_requests', 'from_id'],
    ['friend_requests_received', 'friend_requests', 'to_id'],
    ['blocked_players', 'blocks', 'blocker_id'],
    ['chats', 'chat_members', 'user_id'],
    ['messages', 'messages', 'author_id'],
    ['message_reports', 'message_reports', 'reporter_id'],
    ['other_reports', 'content_reports', 'reporter_id'],
    ['feedback_posts', 'feedback_posts', 'author_id'],
    ['feedback_replies', 'feedback_replies', 'author_id'],
    ['feedback_votes', 'feedback_votes', 'user_id'],
    ['game_ideas', 'game_ideas', 'author_id'],
    ['game_idea_replies', 'game_idea_replies', 'author_id'],
    ['notifications', 'notifications', 'user_id'],
    ['party', 'party_members', 'user_id'],
    ['devices_with_invites', 'push_subscriptions', 'user_id'],
    ['developer_applications', 'developer_applications', 'user_id'],
    ['github_connections', 'github_installations', 'user_id'],
    ['upload_keys', 'upload_keys', 'user_id'],
    ['toki_connect_runs', 'connect_jobs', 'user_id'],
    ['ai_use', 'ai_usage', 'user_id'],
    ['ai_limit', 'ai_quotas', 'user_id'],
    ['suggested_games', 'ai_suggestions', 'user_id'],
    ['own_limits', 'limit_overrides', 'user_id']
  ] loop
    -- Keys that only the device or the server should know stay out, and so do the notes on a
    -- report ("note" and the "ai_" columns only exist on the two report tables here).
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(t) - ''p256dh'' - ''auth'' - ''token'' - ''key_hash'''
      ' - ''note'' - ''ai_verdict'' - ''ai_reason'' - ''ai_checked_at''), ''[]'') from public.%I t where t.%I = $1',
      v_part[2], v_part[3]) into v_rows using v_me;
    v_out := v_out || jsonb_build_object(v_part[1], v_rows);
  end loop;
  return v_out;
end $$;

revoke execute on function public.review_status(uuid), public.save_review(uuid, integer, text), public.delete_review(uuid),
  public.reply_review(uuid, text), public.follow_developer(uuid, boolean), public.my_feed(timestamptz, integer)
  from public, anon;
grant execute on function public.review_status(uuid), public.save_review(uuid, integer, text), public.delete_review(uuid),
  public.reply_review(uuid, text), public.follow_developer(uuid, boolean), public.my_feed(timestamptz, integer)
  to authenticated;
grant execute on function public.follow_info(uuid) to anon, authenticated;
