-- Safety fixes from a check against common legal risks:
-- 1. A report reason for when someone may be in danger or want to hurt themselves.
-- 2. Unused pictures (replaced, from an add form that was left, or of games an admin deleted) are
--    found here and deleted by the server's nightly cleanup (server/pictures.ts).
-- 3. The copy of your data also holds used invite codes, the AI free-use counter and release notes.

-- ---------- 1. "Someone may be in danger" ----------
alter table public.content_reports drop constraint content_reports_category_check;
alter table public.content_reports add constraint content_reports_category_check
  check (category in ('illegal', 'copyright', 'harassment', 'sexual', 'spam', 'danger', 'other'));

-- ---------- 2. unused pictures ----------
-- Pictures in the two picture buckets that no game and no profile uses any more. Only those older
-- than a day, so a picture in an add form someone is still filling in stays.
create function public.unused_pictures(p_limit integer default 200)
returns table (bucket text, name text)
language sql stable security definer set search_path = '' as $$
  with used as (
    select split_part(substring(u from '/object/public/(.*)$'), '?', 1) as path
    from (
      select unnest(array[g.thumbnail_url, g.banner_url] || coalesce(g.screenshots, '{}')) as u from public.games g
      union all
      select p.avatar_url from public.profiles p
    ) urls
    where u is not null
  )
  select o.bucket_id, o.name
  from storage.objects o
  where o.bucket_id in ('avatars', 'thumbnails')
    and o.created_at < now() - interval '1 day'
    and not exists (select 1 from used where used.path = o.bucket_id || '/' || o.name)
  order by o.created_at
  limit greatest(1, least(coalesce(p_limit, 200), 1000))
$$;
revoke execute on function public.unused_pictures(integer) from public, anon, authenticated;
grant execute on function public.unused_pictures(integer) to service_role;

-- ---------- 3. a copy of your data ----------
-- from 20261213090000_reviews_and_feed.sql, now also with used invite codes, the AI free-use
-- counter and the release notes one wrote.
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
    ['own_limits', 'limit_overrides', 'user_id'],
    ['ai_free_use', 'ai_free_limits', 'user_id'],
    ['invite_used', 'invites', 'used_by'],
    ['release_notes', 'game_releases', 'created_by']
  ] loop
    -- Keys that only the device or the server should know stay out, and so do the notes on a
    -- report ("note" and the "ai_" columns only exist on the two report tables here, and "note"
    -- on invites, where it's the admin's own note about the code).
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(t) - ''p256dh'' - ''auth'' - ''token'' - ''key_hash'''
      ' - ''note'' - ''ai_verdict'' - ''ai_reason'' - ''ai_checked_at''), ''[]'') from public.%I t where t.%I = $1',
      v_part[2], v_part[3]) into v_rows using v_me;
    v_out := v_out || jsonb_build_object(v_part[1], v_rows);
  end loop;
  return v_out;
end $$;
