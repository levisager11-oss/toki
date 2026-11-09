-- Games hosted on Toki: developers upload a build (a ZIP, a folder or one HTML file) and Toki puts
-- it on Cloudflare R2. Each hosted game gets its own address, <site>.playtoki.app, served by a
-- small Cloudflare Worker (cloudflare/games-worker). The files never pass through Supabase.
--
-- * games.hosted_site: the game's address name. Only the server sets it, and it never changes,
--   so old links keep working when the game is renamed.
-- * game_builds: one row per uploaded version. The newest is live, the one before stays for 30
--   days (to roll back), older ones and unfinished uploads are deleted by the server (it removes
--   the files from Cloudflare first, then the row). Rows are kept after a game is deleted until
--   its files are gone, so there is no foreign key to games.
-- * upload_keys: personal keys for uploading without logging in (GitHub Actions, AI agents).
--   Only a hash is stored; the key itself is shown once.

alter table public.games add column hosted_site text unique
  check (hosted_site is null or (hosted_site ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(hosted_site) <= 50));

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
  -- the hosting address is only set by the server
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.hosted_site := null;
    else
      new.hosted_site := old.hosted_site;
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;

create table public.game_builds (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null,
  site text not null,
  created_by uuid references public.profiles(id) on delete set null,
  status text not null default 'uploading' check (status in ('uploading', 'live', 'previous', 'deleting')),
  files integer not null default 0 check (files >= 0),
  bytes bigint not null default 0 check (bytes >= 0),
  entry text not null default 'index.html' check (char_length(entry) between 1 and 300),
  version text check (version is null or char_length(version) <= 20),
  created_at timestamptz not null default now(),
  live_at timestamptz,
  -- when the server deletes the files (null: kept)
  delete_after timestamptz
);
create index game_builds_game_idx on public.game_builds(game_id, created_at desc);
create index game_builds_due_idx on public.game_builds(delete_after) where delete_after is not null;
create index game_builds_created_by_idx on public.game_builds(created_by);
alter table public.game_builds enable row level security;
-- The game's developer and admins see its versions (to roll back); only the server writes.
create policy "game builds: owners read" on public.game_builds for select to authenticated
  using (
    (select public.my_role()) = 'admin'
    or exists (select 1 from public.games g where g.id = game_id and g.created_by = (select auth.uid()))
  );
revoke insert, update, delete on public.game_builds from anon, authenticated;
revoke all on public.game_builds from anon;

-- A deleted game: its files go at the next clean-up.
create function public.game_builds_on_game_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.game_builds set status = 'deleting', delete_after = now() where game_id = old.id;
  return old;
end $$;
revoke execute on function public.game_builds_on_game_delete() from public, anon, authenticated;
create trigger game_builds_on_game_delete after delete on public.games
  for each row execute function public.game_builds_on_game_delete();

create table public.upload_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  -- the key's last characters, so the owner can tell keys apart
  hint text not null check (char_length(hint) <= 8),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index upload_keys_user_idx on public.upload_keys(user_id);
alter table public.upload_keys enable row level security;
create policy "upload keys: owner reads" on public.upload_keys for select to authenticated
  using (user_id = (select auth.uid()));
create policy "upload keys: owner deletes" on public.upload_keys for delete to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update on public.upload_keys from anon, authenticated;
revoke all on public.upload_keys from anon;
-- Owners never need the hash.
revoke select on public.upload_keys from authenticated;
grant select (id, user_id, name, hint, created_at, last_used_at) on public.upload_keys to authenticated;

-- The Cloudflare R2 settings an admin sets up on Toki.
alter table public.server_secrets drop constraint server_secrets_name_check;
alter table public.server_secrets add constraint server_secrets_name_check
  check (name in ('ai_api_key', 'anthropic_api_key', 'free_ai_api_key', 'github_app', 'cloudflare_r2'));

-- Like Vercel: a hosted game can follow a GitHub repository. Every push to the chosen branch
-- puts the chosen folder on Toki as the game's new version (through the Toki GitHub App's push
-- events, api/github.ts). One row per game, overwritten on each deploy; only the server writes.
create table public.game_git (
  game_id uuid primary key references public.games(id) on delete cascade,
  installation_id bigint not null,
  repo text not null check (repo ~ '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$' and char_length(repo) <= 140),
  branch text not null check (char_length(branch) between 1 and 200),
  -- the folder with the game's index.html ('' = the whole repository)
  folder text not null default '' check (char_length(folder) <= 200),
  status text not null default 'waiting' check (status in ('waiting', 'deploying', 'live', 'failed')),
  last_sha text check (last_sha is null or last_sha ~ '^[0-9a-f]{40}$'),
  last_message text check (last_message is null or char_length(last_message) <= 200),
  error text check (error is null or char_length(error) <= 300),
  created_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index game_git_repo_idx on public.game_git(repo, branch);
create index game_git_created_by_idx on public.game_git(created_by);
alter table public.game_git enable row level security;
create policy "game git: owners read" on public.game_git for select to authenticated
  using (
    (select public.my_role()) = 'admin'
    or exists (select 1 from public.games g where g.id = game_id and g.created_by = (select auth.uid()))
  );
revoke insert, update, delete on public.game_git from anon, authenticated;
revoke all on public.game_git from anon;
