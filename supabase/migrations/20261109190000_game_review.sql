-- Game review. Any account can submit a game. Games from admins and trusted creators (role
-- 'creator', from an invite or given by an admin) go live right away; everyone else's wait until
-- an admin approves them. After approval, a new game link from an untrusted developer needs
-- another review: the approved link stays live until then. Text and pictures change right away.

alter table public.games
  add column status text not null default 'approved' check (status in ('pending', 'approved', 'rejected')),
  -- a new game link waiting for review (approved games of untrusted developers only)
  add column pending_play_url text check (pending_play_url is null or (pending_play_url ~ '^https://' and char_length(pending_play_url) <= 500)),
  -- the admin's note from the last review, e.g. why a game was declined
  add column review_note text check (review_note is null or char_length(review_note) <= 500),
  add column submitted_at timestamptz not null default now(),
  add column reviewed_by uuid references public.profiles(id) on delete set null,
  add column reviewed_at timestamptz;
update public.games set submitted_at = created_at;
create index games_review_idx on public.games(submitted_at) where status = 'pending' or pending_play_url is not null;
create index games_reviewed_by_idx on public.games(reviewed_by);

-- Who may add games without review: admins and trusted creators.
-- The rules for everything else on a game stay as before (non-admins can't feature games or
-- change owners). Requests without a user (SQL editor) and changes made by other triggers
-- (un-featuring the previous game) pass unchanged.
-- Owners always send the game link they want: on an approved game of an untrusted developer, a
-- different link is kept as pending_play_url, and sending the live link again withdraws it.
create or replace function public.games_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_role public.user_role;
begin
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  if v_me is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  v_role := public.my_role();
  if v_role = 'admin' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.featured := false;
    new.created_by := v_me;
    new.pending_play_url := null;
    new.review_note := null;
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.submitted_at := now();
    if v_role = 'creator' then
      new.status := 'approved';
    else
      if (select count(*) from public.games where created_by = v_me and status = 'pending') >= 3 then
        raise exception 'too_many_pending' using errcode = 'P0001';
      end if;
      new.status := 'pending';
    end if;
    return new;
  end if;

  new.featured := old.featured;
  new.created_by := old.created_by;
  new.status := old.status;
  new.pending_play_url := old.pending_play_url;
  new.review_note := old.review_note;
  new.reviewed_by := old.reviewed_by;
  new.reviewed_at := old.reviewed_at;
  new.submitted_at := old.submitted_at;

  if v_role = 'creator' then
    new.pending_play_url := null; -- trusted: a new link goes live right away
  elsif old.status = 'approved' then
    if new.play_url is distinct from old.play_url then
      if new.play_url is distinct from old.pending_play_url then
        new.submitted_at := now();
        new.review_note := null;
      end if;
      new.pending_play_url := new.play_url;
      new.play_url := old.play_url;
    else
      new.pending_play_url := null;
    end if;
  elsif old.status = 'rejected' then
    -- Changing a declined game sends it in again.
    if (select count(*) from public.games where created_by = v_me and status = 'pending') >= 3 then
      raise exception 'too_many_pending' using errcode = 'P0001';
    end if;
    new.status := 'pending';
    new.submitted_at := now();
    new.review_note := null;
  end if;
  return new;
end $$;

-- Waiting and declined games are only visible to their developer and admins.
-- Visitors read games too, so they need my_role() (it returns null for them).
grant execute on function public.my_role() to anon;
alter policy "games are public" on public.games
  using (status = 'approved' or created_by = (select auth.uid()) or (select public.my_role()) = 'admin');
-- Every account can submit games, and upload their pictures.
alter policy "members add games" on public.games
  with check ((select public.my_role()) is not null and created_by = (select auth.uid()));
alter policy "members upload thumbnails" on storage.objects
  with check (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.my_role()) is not null);
-- Feedback only on games the account can see (not on someone else's game under review).
alter policy "feedback posts: add" on public.feedback_posts
  with check (author_id = (select auth.uid()) and (game_id is null or exists (select 1 from public.games g where g.id = game_id)));

-- An admin approves or declines what waits for review: a new game, a declined game sent in
-- again, or a new link for an approved game. Declining a new link keeps the approved one live.
-- Returns the game's status afterwards.
create function public.review_game(p_game uuid, p_approve boolean, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_pending text;
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  select status, pending_play_url into v_status, v_pending from public.games where id = p_game for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_status = 'approved' and v_pending is null then
    raise exception 'nothing_to_review' using errcode = 'P0001';
  end if;
  p_note := nullif(btrim(left(p_note, 500)), '');
  if p_approve then
    update public.games set status = 'approved', play_url = coalesce(pending_play_url, play_url), pending_play_url = null,
      review_note = p_note, reviewed_by = auth.uid(), reviewed_at = now() where id = p_game;
  elsif v_status = 'approved' then
    update public.games set pending_play_url = null, review_note = p_note, reviewed_by = auth.uid(), reviewed_at = now() where id = p_game;
  else
    update public.games set status = 'rejected', review_note = p_note, reviewed_by = auth.uid(), reviewed_at = now() where id = p_game;
  end if;
  return (select status from public.games where id = p_game);
end $$;

-- An admin makes an account a trusted creator (its games skip review) or takes that back.
-- Admins stay admins.
create function public.set_trusted(p_user uuid, p_trusted boolean) returns public.user_role
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.user_role;
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  update public.profiles set role = case when p_trusted then 'creator'::public.user_role else 'player'::public.user_role end
    where id = p_user and role <> 'admin' returning role into v_role;
  if v_role is null then
    select role into v_role from public.profiles where id = p_user;
  end if;
  if v_role is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  return v_role;
end $$;

-- Whether a game's page needs cross-origin isolation, also for games under review (the server asks
-- without a login, and a developer or admin should be able to try such a game before it's live).
create function public.game_needs_isolation(p_slug text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select needs_isolation from public.games where slug = p_slug), false)
$$;

revoke execute on function public.review_game(uuid, boolean, text) from public, anon;
revoke execute on function public.set_trusted(uuid, boolean) from public, anon;
revoke execute on function public.game_needs_isolation(text) from public;
grant execute on function public.review_game(uuid, boolean, text) to authenticated;
grant execute on function public.set_trusted(uuid, boolean) to authenticated;
grant execute on function public.game_needs_isolation(text) to anon, authenticated;
