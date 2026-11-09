-- Release notes: a game's developer (for Toki itself: admins) posts what changed in each version,
-- and links the feedback posts the update fixes. Linked posts are marked done and show
-- "Fixed in <version>". Everyone can read release notes.

create table public.game_releases (
  id uuid primary key default gen_random_uuid(),
  -- null: an update of Toki itself
  game_id uuid references public.games(id) on delete cascade,
  version text not null check (char_length(btrim(version)) between 1 and 20),
  title text check (title is null or char_length(title) <= 80),
  notes text not null default '' check (char_length(notes) <= 5000),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  published_at timestamptz not null default now(),
  edited_at timestamptz,
  unique nulls not distinct (game_id, version)
);
create index game_releases_game_idx on public.game_releases(game_id, published_at desc);
create index game_releases_created_by_idx on public.game_releases(created_by);

-- The update that fixed (or did) this post. Only set_release_fixes() changes it.
alter table public.feedback_posts add column fixed_in uuid references public.game_releases(id) on delete set null;
create index feedback_posts_fixed_in_idx on public.feedback_posts(fixed_in);

create function public.game_releases_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    return new; -- the SQL editor
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.published_at := now();
    new.edited_at := null;
  else
    new.id := old.id;
    new.game_id := old.game_id;
    new.created_by := old.created_by;
    new.published_at := old.published_at;
    new.edited_at := now();
  end if;
  new.version := btrim(new.version);
  new.title := nullif(btrim(new.title), '');
  return new;
end $$;
create trigger game_releases_guard before insert or update on public.game_releases
  for each row execute function public.game_releases_guard();

alter table public.game_releases enable row level security;
create policy "releases are public" on public.game_releases for select using (true);
create policy "developers add releases" on public.game_releases for insert to authenticated
  with check (public.feedback_manager(game_id));
create policy "developers change releases" on public.game_releases for update to authenticated
  using (public.feedback_manager(game_id));
create policy "developers delete releases" on public.game_releases for delete to authenticated
  using (public.feedback_manager(game_id));

revoke all on public.game_releases from anon, authenticated;
grant select on public.game_releases to anon, authenticated;
grant insert (game_id, version, title, notes) on public.game_releases to authenticated;
grant update (version, title, notes) on public.game_releases to authenticated;
grant delete on public.game_releases to authenticated;

-- Makes these posts the ones the update fixed: they get marked done. Posts that were linked
-- before but aren't in the list any more are unlinked (their status stays as it is).
-- Returns how many posts are linked.
create function public.set_release_fixes(p_release uuid, p_posts uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_game uuid;
  v_n integer;
begin
  select game_id into v_game from public.game_releases where id = p_release;
  if not found or not public.feedback_manager(v_game) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  p_posts := coalesce(p_posts, '{}');
  if exists (
    select 1 from unnest(p_posts) as x(id)
    where not exists (select 1 from public.feedback_posts p where p.id = x.id and p.game_id is not distinct from v_game)
  ) then
    raise exception 'wrong_game' using errcode = 'P0001';
  end if;
  update public.feedback_posts set fixed_in = null where fixed_in = p_release and id <> all(p_posts);
  update public.feedback_posts set fixed_in = p_release, status = 'done'
    where id = any(p_posts) and (fixed_in is distinct from p_release or status <> 'done');
  select count(*) into v_n from public.feedback_posts where fixed_in = p_release;
  return v_n;
end $$;

revoke execute on function public.game_releases_guard() from public, anon, authenticated;
revoke execute on function public.set_release_fixes(uuid, uuid[]) from public, anon;
grant execute on function public.set_release_fixes(uuid, uuid[]) to authenticated;
