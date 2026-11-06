-- Toki database schema (already applied to the Supabase project "toki").
-- Kept here for reference and for setting up a fresh project.

create type public.user_role as enum ('admin', 'creator');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  role public.user_role not null default 'creator',
  created_at timestamptz not null default now()
);

create table public.invites (
  code text primary key check (char_length(code) between 6 and 40),
  role public.user_role not null default 'creator',
  note text check (note is null or char_length(note) <= 80),
  created_by uuid references public.profiles(id) on delete set null,
  used_by uuid references public.profiles(id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 40),
  title text not null check (char_length(title) between 1 and 60),
  description text not null default '' check (char_length(description) <= 1000),
  description_de text check (description_de is null or char_length(description_de) <= 1000),
  controls text not null default '' check (char_length(controls) <= 500),
  category text not null check (category in ('action','adventure','arcade','horror','platformer','puzzle','racing','shooter','sports','strategy','other')),
  engine text check (engine is null or char_length(engine) <= 30),
  play_url text not null check (play_url ~ '^https://' and char_length(play_url) <= 500),
  thumbnail_url text check (thumbnail_url is null or (thumbnail_url ~ '^https://' and char_length(thumbnail_url) <= 500)),
  cover text check (cover is null or char_length(cover) <= 20),
  featured boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index games_created_by_idx on public.games(created_by);
create index invites_created_by_idx on public.invites(created_by);
create index invites_used_by_idx on public.invites(used_by);

create function public.my_role() returns public.user_role
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = auth.uid()
$$;

create function public.check_invite(p_code text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.invites where code = p_code and used_by is null)
$$;

-- Every new account must carry a valid invite code + username in its signup metadata.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_code text := new.raw_user_meta_data ->> 'invite';
  v_username text := lower(new.raw_user_meta_data ->> 'username');
  v_role public.user_role;
begin
  select role into v_role from public.invites where code = v_code and used_by is null for update;
  if v_role is null then
    raise exception 'invalid_invite';
  end if;
  insert into public.profiles (id, username, role) values (new.id, v_username, v_role);
  update public.invites set used_by = new.id, used_at = now() where code = v_code;
  if v_role = 'admin' then
    update public.games set created_by = new.id where created_by is null;
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Non-admin users can't feature games or change who owns a game.
create function public.games_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
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
create trigger games_guard before insert or update on public.games
  for each row execute function public.games_guard();

alter table public.profiles enable row level security;
alter table public.invites enable row level security;
alter table public.games enable row level security;

create policy "profiles are public" on public.profiles for select using (true);
create policy "games are public" on public.games for select using (true);
create policy "members add games" on public.games for insert to authenticated
  with check ((select public.my_role()) is not null and created_by = (select auth.uid()));
create policy "owners or admins edit games" on public.games for update to authenticated
  using (created_by = (select auth.uid()) or (select public.my_role()) = 'admin');
create policy "owners or admins delete games" on public.games for delete to authenticated
  using (created_by = (select auth.uid()) or (select public.my_role()) = 'admin');
create policy "admins read invites" on public.invites for select to authenticated
  using ((select public.my_role()) = 'admin');
create policy "admins create invites" on public.invites for insert to authenticated
  with check ((select public.my_role()) = 'admin' and created_by = (select auth.uid()));
create policy "admins delete invites" on public.invites for delete to authenticated
  using ((select public.my_role()) = 'admin');

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.games_guard() from public, anon, authenticated;
revoke execute on function public.my_role() from public, anon;
grant execute on function public.my_role() to authenticated;
grant execute on function public.check_invite(text) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('thumbnails', 'thumbnails', true, 2097152, array['image/png','image/jpeg','image/webp','image/gif']);
create policy "members upload thumbnails" on storage.objects for insert to authenticated
  with check (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = (select auth.uid())::text and (select public.my_role()) is not null);
create policy "members manage own thumbnails" on storage.objects for delete to authenticated
  using (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Accounts are invite-only, so an email confirmation adds nothing: confirm on creation.
create function public.auto_confirm_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email_confirmed_at is null then
    new.email_confirmed_at := now();
  end if;
  return new;
end $$;
revoke execute on function public.auto_confirm_user() from public, anon, authenticated;
create trigger auto_confirm_user before insert on auth.users
  for each row execute function public.auto_confirm_user();
