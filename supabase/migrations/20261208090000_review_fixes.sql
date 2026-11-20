-- Fixes from a review of the database rules.

-- ---------- profile pictures only from Toki's own storage ----------
-- avatar_url took any https address, and players set it themselves. Everyone who saw that
-- player (on a high-score list, also without an account) loaded the picture from a server of the
-- player's choice, which then knew their IP address. Toki's pages load nothing from elsewhere.
-- Avatars are uploaded to the "avatars" bucket, into a folder named after the account.
update public.profiles set avatar_url = null
  where avatar_url is not null
    and avatar_url !~ ('^https://oygszctxhkubofspywzr\.supabase\.co/storage/v1/object/public/avatars/' || id::text || '/[A-Za-z0-9._-]+$');
alter table public.profiles drop constraint profiles_avatar_url_check;
alter table public.profiles add constraint profiles_avatar_url_check check (
  avatar_url is null or (
    char_length(avatar_url) <= 500
    and avatar_url ~ ('^https://oygszctxhkubofspywzr\.supabase\.co/storage/v1/object/public/avatars/' || id::text || '/[A-Za-z0-9._-]+$')));

-- ---------- deleting an account ----------
-- Favorites have no foreign key (visitors without an account have them too), so they stayed
-- behind, under an id anyone could then claim. And a party whose leader deleted their account
-- ended for everyone in it: now it goes on, like when the leader leaves.
create or replace function public.remove_account(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.party_drop(p_user);
  with gone as (delete from public.game_likes where visitor = p_user returning game_id)
    update public.game_stats s set likes = greatest(s.likes - 1, 0) from gone where s.game_id = gone.game_id;
  delete from public.games where created_by = p_user;
  delete from auth.users where id = p_user;
end $$;

-- ---------- a copy of your data ----------
-- Now also: favorites, upload keys (never the key itself), the games Toki suggested, and the
-- limits an admin set for the account. What admins (or the AI's first look) noted on a report
-- is not the reporter's data and stays out.
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
      'banned_until', p.banned_until))
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

-- ---------- invite codes ----------
-- A code was used up even when it changed nothing: an admin code entered by a developer left
-- them a developer, with the code gone. Now it makes a developer an admin, and a code that
-- would change nothing stays unused.
create or replace function public.redeem_invite(p_code text) returns public.user_role
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.user_role;
  v_mine public.user_role;
begin
  if auth.uid() is null then
    raise exception 'login_required';
  end if;
  select role into v_role from public.invites where code = p_code and used_at is null for update;
  if v_role is null then
    raise exception 'invalid_invite';
  end if;
  select role into v_mine from public.profiles where id = auth.uid();
  if not (v_mine = 'player' or (v_mine = 'creator' and v_role = 'admin')) then
    raise exception 'no_change' using errcode = 'P0001';
  end if;
  update public.invites set used_by = auth.uid(), used_at = now() where code = p_code;
  update public.profiles set role = v_role where id = auth.uid();
  return v_role;
end $$;

-- ---------- playtime over midnight ----------
-- The first report of a new day (UTC) made the day's row for this browser with "last report:
-- now", so only the extra minute counted and the rest of the time since yesterday's last
-- report was lost. The browser's last report now also counts when it was yesterday.
create or replace function public.record_playtime(p_game uuid, p_visitor uuid, p_seconds integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_add integer;
  v_last timestamptz;
  v_before timestamptz;
begin
  if coalesce(p_seconds, 0) <= 0 or not exists (select 1 from public.games where id = p_game) then
    return 0;
  end if;
  select max(last_at) into v_before from public.game_plays
    where game_id = p_game and visitor = p_visitor and day >= current_date - 1;
  perform public.count_play(p_game, p_visitor);
  -- At most the time since this browser's last report (a minute extra for the first one),
  -- and at most a whole day per browser and game.
  select least(p_seconds, 86400 - gp.seconds, floor(extract(epoch from now() - coalesce(v_before, gp.last_at)))::integer + 60)
    into v_add
    from public.game_plays gp
    where gp.game_id = p_game and gp.visitor = p_visitor and gp.day = current_date
    for update;
  if v_me is not null then
    select last_at into v_last from public.playtime where user_id = v_me and game_id = p_game for update;
    -- An account can't collect more time than has passed, even from several browsers.
    if v_last is not null then
      v_add := least(v_add, floor(extract(epoch from now() - v_last))::integer);
    end if;
  end if;
  if coalesce(v_add, 0) <= 0 then
    return 0;
  end if;

  update public.game_plays set seconds = seconds + v_add, last_at = now()
    where game_id = p_game and visitor = p_visitor and day = current_date;
  update public.game_days set seconds = seconds + v_add where game_id = p_game and day = current_date;
  update public.game_stats set seconds = seconds + v_add where game_id = p_game;
  if v_me is not null then
    insert into public.playtime (user_id, game_id, seconds) values (v_me, p_game, v_add)
    on conflict (user_id, game_id) do update set seconds = public.playtime.seconds + v_add, last_at = now();
  end if;
  return v_add;
end $$;
