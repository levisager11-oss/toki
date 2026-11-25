-- A game's own cosmetics: looks the shop sells for many tokens stay the shop's, and their names
-- can be reported.

-- The looks a game's cosmetics may have: no glowing, spinning or rainbow frames, one name color
-- (no gradient), and no star or wave themes. Those are the shop's.
create function public.game_cosmetic_style_ok(p_kind text, p_style jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case p_kind
    when 'frame' then coalesce(p_style->>'style', '') in ('ring', 'double', 'dashed', 'pixel')
    when 'color' then not (p_style ? 'b') or p_style->>'b' = p_style->>'a'
    when 'theme' then coalesce(p_style->>'pattern', 'plain') in ('plain', 'dots', 'grid', 'stripes')
    else true
  end
$$;

alter table public.cosmetics add constraint cosmetics_game_look_check
  check (game_id is null or public.game_cosmetic_style_ok(kind, style));

-- A uuid for each cosmetic, so a report (whose target is a uuid) can name one.
alter table public.cosmetics add column ref uuid generated always as (md5(id)::uuid) stored;
create index cosmetics_ref_idx on public.cosmetics(ref);

-- ---------- reports about a game's cosmetics ----------

alter table public.content_reports drop constraint content_reports_kind_check;
alter table public.content_reports add constraint content_reports_kind_check
  check (kind in ('game', 'profile', 'feedback', 'idea', 'review', 'cosmetic'));

-- from 20261213090000_reviews_and_feed.sql, now also for a game's cosmetics (target: its ref)
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
  elsif p_kind = 'cosmetic' then
    select true, g.created_by, g.title || ': ' || c.name into v_found, v_owner, v_title
      from public.cosmetics c join public.games g on g.id = c.game_id where c.ref = p_target;
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

-- from 20261213090000_reviews_and_feed.sql; 'removed' deletes the game's cosmetic
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
    elsif r.kind = 'cosmetic' then
      delete from public.cosmetics where ref = r.target and game_id is not null;
    end if;
    perform public.notify(r.owner_id, 'moderation', null, jsonb_build_object(
      'what', r.kind, 'title', r.title, 'note', v_note, 'days', case when p_outcome = 'banned' then greatest(p_days, 1) end));
  end if;
  if p_outcome = 'banned' then
    perform public.ban_user(r.owner_id, greatest(p_days, 1));
  end if;
end $$;
