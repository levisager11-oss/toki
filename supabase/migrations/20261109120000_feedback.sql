-- Player feedback for Toki and for each game: bug reports, ideas, replies, votes and status.
--
-- * Anyone can read the public board. Logged-in accounts post, reply and vote.
-- * A bug report can be private: then only the reporter, the game's developer and admins see it.
-- * The game's developer (for feedback about Toki itself: admins) sets the status, can hide
--   posts and remove replies. Admins can do this everywhere.
-- * Columns that only the server may set (author, counts, status for players, ...) are kept
--   by the guard triggers, and the API roles may only write the columns listed in the grants.

create table public.feedback_posts (
  id uuid primary key default gen_random_uuid(),
  -- null: feedback about Toki itself
  game_id uuid references public.games(id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('bug', 'idea', 'other')),
  title text not null check (char_length(btrim(title)) between 3 and 100),
  body text not null default '' check (char_length(body) <= 4000),
  -- Browser, system and screen size, for bug reports. Shown to everyone who can see the post.
  device text check (device is null or char_length(device) <= 200),
  private boolean not null default false check (not private or kind = 'bug'),
  status text not null default 'open' check (status in ('open', 'planned', 'in_progress', 'done', 'declined')),
  hidden boolean not null default false,
  -- true once the developer (or an admin) has replied
  answered boolean not null default false,
  vote_count integer not null default 0 check (vote_count >= 0),
  reply_count integer not null default 0 check (reply_count >= 0),
  created_at timestamptz not null default now(),
  -- last edit of title or text by the author
  edited_at timestamptz,
  status_at timestamptz not null default now(),
  -- last activity: new post, edit, status change or reply
  updated_at timestamptz not null default now()
);
create index feedback_posts_game_idx on public.feedback_posts(game_id, created_at desc);
create index feedback_posts_game_votes_idx on public.feedback_posts(game_id, vote_count desc);
create index feedback_posts_author_idx on public.feedback_posts(author_id, created_at desc);

create table public.feedback_replies (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.feedback_posts(id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  -- written by the game's developer or an admin
  official boolean not null default false,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index feedback_replies_post_idx on public.feedback_replies(post_id, created_at);
create index feedback_replies_author_idx on public.feedback_replies(author_id, created_at desc);

create table public.feedback_votes (
  post_id uuid not null references public.feedback_posts(id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index feedback_votes_user_idx on public.feedback_votes(user_id);

-- Whether the logged-in account looks after feedback for this game (null: Toki itself).
create function public.feedback_manager(p_game uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
    or (p_game is not null and exists (select 1 from public.games where id = p_game and created_by = auth.uid()))
$$;

-- Posts: the server sets author, status, counts and times. Players edit only their own words;
-- developers and admins only change status and visibility.
create function public.feedback_posts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  -- Count updates from the vote and reply triggers below, and the SQL editor (no user).
  if pg_trigger_depth() > 1 or v_me is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if (select count(*) from public.feedback_posts where author_id = v_me and created_at > now() - interval '1 hour') >= 5
      or (select count(*) from public.feedback_posts where author_id = v_me and created_at > now() - interval '1 day') >= 20 then
      raise exception 'rate_limited' using errcode = 'P0001';
    end if;
    new.author_id := v_me;
    new.title := btrim(new.title);
    new.status := 'open';
    new.hidden := false;
    new.answered := false;
    new.vote_count := 0;
    new.reply_count := 0;
    new.created_at := now();
    new.edited_at := null;
    new.status_at := now();
    new.updated_at := now();
    return new;
  end if;

  new.id := old.id;
  new.game_id := old.game_id;
  new.author_id := old.author_id;
  new.answered := old.answered;
  new.vote_count := old.vote_count;
  new.reply_count := old.reply_count;
  new.created_at := old.created_at;
  if not public.feedback_manager(old.game_id) then
    new.status := old.status;
    new.hidden := old.hidden;
  end if;
  if old.author_id is distinct from v_me then
    new.kind := old.kind;
    new.title := old.title;
    new.body := old.body;
    new.device := old.device;
    new.private := old.private;
  end if;
  new.title := btrim(new.title);

  new.edited_at := old.edited_at;
  new.status_at := old.status_at;
  new.updated_at := old.updated_at;
  if new.title is distinct from old.title or new.body is distinct from old.body then
    new.edited_at := now();
    new.updated_at := now();
  end if;
  if new.status is distinct from old.status then
    new.status_at := now();
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger feedback_posts_guard before insert or update on public.feedback_posts
  for each row execute function public.feedback_posts_guard();

create function public.feedback_replies_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.author_id := v_me;
    new.official := public.feedback_manager((select game_id from public.feedback_posts where id = new.post_id));
    -- Developers answer many posts at once, so the limit is only for everyone else.
    if not new.official
      and (select count(*) from public.feedback_replies where author_id = v_me and created_at > now() - interval '1 hour') >= 30 then
      raise exception 'rate_limited' using errcode = 'P0001';
    end if;
    new.body := btrim(new.body);
    new.created_at := now();
    new.edited_at := null;
    return new;
  end if;
  new.id := old.id;
  new.post_id := old.post_id;
  new.author_id := old.author_id;
  new.official := old.official;
  new.created_at := old.created_at;
  new.body := btrim(new.body);
  new.edited_at := case when new.body is distinct from old.body then now() else old.edited_at end;
  return new;
end $$;
create trigger feedback_replies_guard before insert or update on public.feedback_replies
  for each row execute function public.feedback_replies_guard();

-- Keeps reply_count, answered and updated_at of the post up to date.
create function public.feedback_replies_count() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.feedback_posts
      set reply_count = reply_count + 1, answered = answered or new.official, updated_at = now()
      where id = new.post_id;
  else
    update public.feedback_posts
      set reply_count = greatest(reply_count - 1, 0),
          answered = exists (select 1 from public.feedback_replies r where r.post_id = old.post_id and r.official)
      where id = old.post_id;
  end if;
  return null;
end $$;
create trigger feedback_replies_count after insert or delete on public.feedback_replies
  for each row execute function public.feedback_replies_count();

create function public.feedback_votes_count() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.feedback_posts set vote_count = vote_count + 1 where id = new.post_id;
  else
    update public.feedback_posts set vote_count = greatest(vote_count - 1, 0) where id = old.post_id;
  end if;
  return null;
end $$;
create trigger feedback_votes_count after insert or delete on public.feedback_votes
  for each row execute function public.feedback_votes_count();

alter table public.feedback_posts enable row level security;
alter table public.feedback_replies enable row level security;
alter table public.feedback_votes enable row level security;

create policy "feedback posts: read" on public.feedback_posts for select
  using ((not private and not hidden) or author_id = (select auth.uid()) or public.feedback_manager(game_id));
create policy "feedback posts: add" on public.feedback_posts for insert to authenticated
  with check (author_id = (select auth.uid()));
create policy "feedback posts: change" on public.feedback_posts for update to authenticated
  using (author_id = (select auth.uid()) or public.feedback_manager(game_id));
create policy "feedback posts: delete" on public.feedback_posts for delete to authenticated
  using (author_id = (select auth.uid()) or (select public.my_role()) = 'admin');

-- Replies and votes only exist on posts the account can see (the posts policy applies inside).
create policy "feedback replies: read" on public.feedback_replies for select
  using (exists (select 1 from public.feedback_posts p where p.id = post_id));
create policy "feedback replies: add" on public.feedback_replies for insert to authenticated
  with check (author_id = (select auth.uid()) and exists (select 1 from public.feedback_posts p where p.id = post_id));
create policy "feedback replies: change" on public.feedback_replies for update to authenticated
  using (author_id = (select auth.uid()));
create policy "feedback replies: delete" on public.feedback_replies for delete to authenticated
  using (author_id = (select auth.uid())
    or exists (select 1 from public.feedback_posts p where p.id = post_id and public.feedback_manager(p.game_id)));

create policy "feedback votes: read own" on public.feedback_votes for select to authenticated
  using (user_id = (select auth.uid()));
create policy "feedback votes: add" on public.feedback_votes for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.feedback_posts p where p.id = post_id));
create policy "feedback votes: delete" on public.feedback_votes for delete to authenticated
  using (user_id = (select auth.uid()));

-- Only the columns people may write. Everything else is set by the triggers above.
revoke all on public.feedback_posts, public.feedback_replies, public.feedback_votes from anon, authenticated;
grant select on public.feedback_posts, public.feedback_replies to anon, authenticated;
grant select on public.feedback_votes to authenticated;
grant insert (game_id, kind, title, body, device, private) on public.feedback_posts to authenticated;
grant update (kind, title, body, device, private, status, hidden) on public.feedback_posts to authenticated;
grant delete on public.feedback_posts to authenticated;
grant insert (post_id, body) on public.feedback_replies to authenticated;
grant update (body) on public.feedback_replies to authenticated;
grant delete on public.feedback_replies to authenticated;
grant insert (post_id) on public.feedback_votes to authenticated;
grant delete on public.feedback_votes to authenticated;

revoke execute on function public.feedback_posts_guard() from public, anon, authenticated;
revoke execute on function public.feedback_replies_guard() from public, anon, authenticated;
revoke execute on function public.feedback_replies_count() from public, anon, authenticated;
revoke execute on function public.feedback_votes_count() from public, anon, authenticated;
revoke execute on function public.feedback_manager(uuid) from public;
grant execute on function public.feedback_manager(uuid) to anon, authenticated;
