-- What the law asks of Toki:
--  * Age: accounts are for players of 13 and older; from 13 to 15 a parent has to agree. Toki keeps
--    the month of birth (never shown to anyone) and when the parent's OK was given. Accounts from
--    before this change are asked once, the next time they open Toki.
--  * Players delete their account themselves (delete_account) and download everything Toki has
--    about them (export_my_data).
--  * Anyone logged in can report a game, a profile, a feedback post or a game idea, not only chat
--    messages. When an admin removes something, its owner is told why, and whoever reported it is
--    told what happened.
-- Free plan: reports are deleted on the same schedule as message reports.

-- ---------- age ----------

alter table public.profiles
  -- the first day of the month of birth; private (not in the columns everyone may read)
  add column born date,
  -- under 16 at sign-up: when the player confirmed that a parent agreed
  add column parent_ok_at timestamptz;

-- "2012-03" -> 2012-03-01. Anything else is refused.
create function public.parse_born(p_born text) returns date
language plpgsql stable set search_path = '' as $$
declare
  v date;
begin
  if p_born is null or p_born !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'bad_birth' using errcode = 'P0001';
  end if;
  v := to_date(p_born || '-01', 'YYYY-MM-DD');
  if v > current_date or v < date '1900-01-01' then
    raise exception 'bad_birth' using errcode = 'P0001';
  end if;
  return v;
end $$;

-- Full years, counted as if the birthday were on the last day of the month: never too old.
create function public.age_of(p_born date) returns integer
language sql stable set search_path = '' as $$
  select extract(year from age(current_date, (p_born + interval '1 month')::date))::integer
$$;

-- Sign-up: the month of birth comes with the username. Under 13 gets no account; under 16 needs
-- a parent's OK. Without a month of birth (an older version of the app) the account is asked later.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_code text := nullif(trim(new.raw_user_meta_data ->> 'invite'), '');
  v_username text := lower(new.raw_user_meta_data ->> 'username');
  v_born_text text := nullif(trim(new.raw_user_meta_data ->> 'born'), '');
  v_born date;
  v_parent_ok timestamptz;
  v_role public.user_role := 'player';
begin
  if v_born_text is not null then
    v_born := public.parse_born(v_born_text);
    if public.age_of(v_born) < 13 then
      raise exception 'too_young';
    end if;
    if public.age_of(v_born) < 16 then
      if coalesce(new.raw_user_meta_data ->> 'parent_ok', '') <> 'true' then
        raise exception 'parent_required';
      end if;
      v_parent_ok := now();
    end if;
  end if;
  if v_code is not null then
    select role into v_role from public.invites where code = v_code and used_at is null for update;
    if v_role is null then
      raise exception 'invalid_invite';
    end if;
  end if;
  insert into public.profiles (id, username, role, born, parent_ok_at) values (new.id, v_username, v_role, v_born, v_parent_ok);
  if v_code is not null then
    update public.invites set used_by = new.id, used_at = now() where code = v_code;
  end if;
  if v_role = 'admin' then
    update public.games set created_by = new.id where created_by is null;
  end if;
  return new;
end $$;

-- ---------- deleting an account ----------

-- Removes an account with everything that belongs to it: its games (their uploaded files go at
-- the next clean-up) and, through the foreign keys, saves, scores, chats, posts and the rest.
create function public.remove_account(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.games where created_by = p_user;
  delete from auth.users where id = p_user;
end $$;
revoke execute on function public.remove_account(uuid) from public, anon, authenticated;

-- The logged-in player deletes their own account. Toki always keeps one admin.
create function public.delete_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  if (select role from public.profiles where id = v_me) = 'admin'
    and not exists (select 1 from public.profiles where role = 'admin' and id <> v_me) then
    raise exception 'last_admin' using errcode = 'P0001';
  end if;
  perform public.remove_account(v_me);
end $$;
revoke execute on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;

-- What the app needs to know about the logged-in account that isn't public.
create function public.my_account() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('age_needed', born is null) from public.profiles where id = auth.uid()
$$;
revoke execute on function public.my_account() from public, anon;
grant execute on function public.my_account() to authenticated;

-- An account from before the age question answers it once. Returns 'ok', or 'too_young': then
-- the account is deleted, as the law asks for players under 13.
create function public.set_birth(p_born text, p_parent_ok boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_born date;
  v_age integer;
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  if (select born from public.profiles where id = v_me) is not null then
    return 'ok';
  end if;
  v_born := public.parse_born(p_born);
  v_age := public.age_of(v_born);
  if v_age < 13 then
    if (select role from public.profiles where id = v_me) = 'admin' then
      raise exception 'bad_birth' using errcode = 'P0001';
    end if;
    perform public.remove_account(v_me);
    return 'too_young';
  end if;
  if v_age < 16 and not coalesce(p_parent_ok, false) then
    raise exception 'parent_required' using errcode = 'P0001';
  end if;
  update public.profiles set born = v_born, parent_ok_at = case when v_age < 16 then now() end where id = v_me;
  return 'ok';
end $$;
revoke execute on function public.set_birth(text, boolean) from public, anon;
grant execute on function public.set_birth(text, boolean) to authenticated;

-- ---------- reports about games, profiles, feedback posts and ideas ----------

create table public.content_reports (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('game', 'profile', 'feedback', 'idea')),
  target uuid not null,
  reporter_id uuid references public.profiles(id) on delete set null,
  -- whose content it is; the report goes with their account
  owner_id uuid references public.profiles(id) on delete cascade,
  category text not null check (category in ('illegal', 'copyright', 'harassment', 'sexual', 'spam', 'other')),
  reason text not null default '' check (char_length(reason) <= 1000),
  -- the title or name when it was reported, for the admin and for the notifications
  title text not null default '',
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  outcome text check (outcome is null or outcome in ('dismissed', 'removed', 'banned')),
  -- the admin's reason, which the owner is told
  note text check (note is null or char_length(note) <= 500)
);
create unique index content_reports_once_idx on public.content_reports(kind, target, reporter_id);
create index content_reports_open_idx on public.content_reports(created_at) where handled_at is null;
create index content_reports_reporter_idx on public.content_reports(reporter_id);
create index content_reports_owner_idx on public.content_reports(owner_id);

alter table public.content_reports enable row level security;
create policy "content reports: admins" on public.content_reports for select to authenticated
  using ((select public.my_role()) = 'admin');
revoke all on public.content_reports from anon, authenticated;
grant select on public.content_reports to authenticated;

alter table public.notifications drop constraint notifications_kind_check;
-- moderation: something of yours was removed, with the reason. report_done: what happened to
-- something you reported.
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'fb_reply', 'fb_status', 'friend_request', 'friend_accept', 'group_add', 'score_beaten', 'game_invite', 'dev_news',
  'game_idea', 'moderation', 'report_done'));

-- Reports something to the admins. Each player reports a thing once; reports of messages and of
-- everything else share one daily limit.
create function public.report_content(p_kind text, p_target uuid, p_category text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_owner uuid;
  v_title text;
  v_found boolean := false;
begin
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
revoke execute on function public.report_content(text, uuid, text, text) from public, anon;
grant execute on function public.report_content(text, uuid, text, text) to authenticated;

-- Admins handle a report: 'dismissed', 'removed' (deletes the game or idea, hides the feedback
-- post, empties the profile's bio and picture) or 'banned' (removes it and bans its owner for
-- p_days). Other reports of the same thing are handled too. The owner is told what was removed
-- and why (p_note); everyone who reported it is told the outcome.
create function public.handle_content_report(p_report bigint, p_outcome text, p_note text default '', p_days integer default 0) returns void
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
    end if;
    perform public.notify(r.owner_id, 'moderation', null, jsonb_build_object(
      'what', r.kind, 'title', r.title, 'note', v_note, 'days', case when p_outcome = 'banned' then greatest(p_days, 1) end));
  end if;
  if p_outcome = 'banned' then
    perform public.ban_user(r.owner_id, greatest(p_days, 1));
  end if;
end $$;
revoke execute on function public.handle_content_report(bigint, text, text, integer) from public, anon;
grant execute on function public.handle_content_report(bigint, text, text, integer) to authenticated;

-- Reported messages: the sender is told when a message was removed, and whoever reported it is
-- told the outcome.
create or replace function public.handle_report(p_report bigint, p_outcome text, p_days integer default 0) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.message_reports;
  v_reporter uuid;
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  if p_outcome not in ('dismissed', 'deleted', 'banned') then
    raise exception 'bad_outcome' using errcode = 'P0001';
  end if;
  select * into r from public.message_reports where id = p_report;
  if r.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  for v_reporter in
    update public.message_reports set handled_at = now(), outcome = p_outcome
      where handled_at is null and (id = p_report or (r.message_id is not null and message_id = r.message_id))
      returning reporter_id
  loop
    perform public.notify(v_reporter, 'report_done', null, jsonb_build_object(
      'what', 'message', 'title', left(r.body, 80), 'outcome', case when p_outcome = 'deleted' then 'removed' else p_outcome end));
  end loop;
  if p_outcome in ('deleted', 'banned') then
    if r.message_id is not null then
      delete from public.messages where id = r.message_id;
    end if;
    perform public.notify(r.author_id, 'moderation', null, jsonb_build_object(
      'what', 'message', 'title', left(r.body, 80), 'note', '', 'days', case when p_outcome = 'banned' then greatest(p_days, 1) end));
  end if;
  if p_outcome = 'banned' then
    perform public.ban_user(r.author_id, greatest(p_days, 1));
  end if;
end $$;

select cron.schedule('delete-old-content-reports', '47 3 * * *', $$
  delete from public.content_reports
    where (handled_at is not null and handled_at < now() - make_interval(days => public.keep_value('reports_handled')))
      or created_at < now() - make_interval(days => public.keep_value('reports_all'));
$$);

-- ---------- a copy of your data ----------

-- Everything Toki keeps about the logged-in account, as one document.
create function public.export_my_data() returns jsonb
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
    ['toki_connect_runs', 'connect_jobs', 'user_id'],
    ['ai_use', 'ai_usage', 'user_id']
  ] loop
    -- keys that only the device or the server should know stay out
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(t) - ''p256dh'' - ''auth'' - ''token'' - ''key_hash''), ''[]'') from public.%I t where t.%I = $1',
      v_part[2], v_part[3]) into v_rows using v_me;
    v_out := v_out || jsonb_build_object(v_part[1], v_rows);
  end loop;
  return v_out;
end $$;
revoke execute on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;
