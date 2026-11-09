-- Developer accounts by application.
--
-- 1. The per-game review from 20261109190000_game_review.sql is undone: as before, only
--    developers (creators and admins) add games, and their games go live right away.
-- 2. Players who want to add games apply for a developer account. An admin approves (the
--    account becomes a creator) or declines with a note. Invite codes still work as before.

-- ---------- 1. undo the per-game review ----------
drop function public.review_game(uuid, boolean, text);
drop function public.set_trusted(uuid, boolean);
drop function public.game_needs_isolation(text);

create or replace function public.games_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- requests from signed-in users who are not admins can't feature games or change owners
  if auth.uid() is not null and public.my_role() is distinct from 'admin' then
    if tg_op = 'INSERT' then
      new.featured := false;
      new.created_by := auth.uid();
    else
      new.featured := old.featured;
      new.created_by := old.created_by;
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;

alter policy "games are public" on public.games using (true);
alter policy "members add games" on public.games
  with check ((select public.my_role()) in ('admin', 'creator') and created_by = (select auth.uid()));
alter policy "members upload thumbnails" on storage.objects
  with check (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.my_role()) in ('admin', 'creator'));
alter policy "feedback posts: add" on public.feedback_posts
  with check (author_id = (select auth.uid()));
revoke execute on function public.my_role() from anon;

alter table public.games
  drop column status,
  drop column pending_play_url,
  drop column review_note,
  drop column submitted_at,
  drop column reviewed_by,
  drop column reviewed_at;

-- ---------- 2. applications ----------
create table public.developer_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  -- what they make and want to put on Toki
  about text not null check (char_length(btrim(about)) between 20 and 2000),
  -- links to their games or other work
  links text not null default '' check (char_length(links) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  -- the admin's note, e.g. why it was declined
  review_note text check (review_note is null or char_length(review_note) <= 500),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
-- One open application per account; also finds an account's applications.
create unique index developer_applications_one_open on public.developer_applications(user_id) where status = 'pending';
create index developer_applications_user_idx on public.developer_applications(user_id, created_at desc);

-- Only players apply, at most 3 times in 30 days. The server sets everything but the text.
create function public.developer_applications_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    return new; -- the SQL editor
  end if;
  if public.my_role() is distinct from 'player' then
    raise exception 'already_developer' using errcode = 'P0001';
  end if;
  if (select count(*) from public.developer_applications where user_id = auth.uid() and created_at > now() - interval '30 days') >= 3 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  new.user_id := auth.uid();
  new.about := btrim(new.about);
  new.links := btrim(new.links);
  new.status := 'pending';
  new.review_note := null;
  new.reviewed_by := null;
  new.reviewed_at := null;
  new.created_at := now();
  return new;
end $$;
create trigger developer_applications_guard before insert on public.developer_applications
  for each row execute function public.developer_applications_guard();

alter table public.developer_applications enable row level security;
create policy "applications: own or admin" on public.developer_applications for select to authenticated
  using (user_id = (select auth.uid()) or (select public.my_role()) = 'admin');
create policy "applications: apply" on public.developer_applications for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "applications: withdraw" on public.developer_applications for delete to authenticated
  using (user_id = (select auth.uid()) and status = 'pending');

revoke all on public.developer_applications from anon, authenticated;
grant select, delete on public.developer_applications to authenticated;
grant insert (about, links) on public.developer_applications to authenticated;

-- An admin approves (the account becomes a developer) or declines an open application.
-- Returns the application's status afterwards.
create function public.review_application(p_id uuid, p_approve boolean, p_note text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_status text;
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  select user_id, status into v_user, v_status from public.developer_applications where id = p_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if v_status <> 'pending' then
    raise exception 'already_reviewed' using errcode = 'P0001';
  end if;
  update public.developer_applications
    set status = case when p_approve then 'approved' else 'rejected' end,
        review_note = nullif(btrim(left(p_note, 500)), ''), reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_id;
  if p_approve then
    update public.profiles set role = 'creator' where id = v_user and role = 'player';
  end if;
  return case when p_approve then 'approved' else 'rejected' end;
end $$;

-- An admin gives an account developer rights or takes them away (its games stay). Admins stay admins.
create function public.set_developer(p_user uuid, p_developer boolean) returns public.user_role
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.user_role;
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  update public.profiles set role = case when p_developer then 'creator'::public.user_role else 'player'::public.user_role end
    where id = p_user and role <> 'admin' returning role into v_role;
  if v_role is null then
    select role into v_role from public.profiles where id = p_user;
  end if;
  if v_role is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  return v_role;
end $$;

revoke execute on function public.developer_applications_guard() from public, anon, authenticated;
revoke execute on function public.review_application(uuid, boolean, text) from public, anon;
revoke execute on function public.set_developer(uuid, boolean) from public, anon;
grant execute on function public.review_application(uuid, boolean, text) to authenticated;
grant execute on function public.set_developer(uuid, boolean) to authenticated;
