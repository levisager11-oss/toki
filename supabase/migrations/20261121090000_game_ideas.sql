-- Game ideas: "Missing a game you want?" on the home page.
--
-- * Any logged-in account (players and developers) proposes a game idea.
-- * All developers (creators and admins) see every idea and discuss it. Whoever proposed
--   an idea sees their own, and takes part in its discussion. Nobody else sees it.
-- * One developer claims an idea ("I'll build this"), can give it back, and marks it as done
--   with the finished game. Admins can do this for any idea.
-- * Claiming, giving back and finishing only happen through the functions below, so two
--   developers can't claim the same idea.
-- * Admins can hide the box on the home page (site_settings.idea_banner).
-- * Free plan: ideas nobody picked are deleted after 180 days without activity, finished
--   ones 180 days after they were done. An account proposes at most 3 a day, 10 in 30 days.

-- ---------- settings for all of Toki (one row) ----------
create table public.site_settings (
  id integer primary key default 1 check (id = 1),
  -- the "Missing a game you want?" box on the home page
  idea_banner boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.site_settings (id) values (1);

create function public.site_settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.id := 1;
  new.updated_at := now();
  return new;
end $$;
create trigger site_settings_guard before update on public.site_settings
  for each row execute function public.site_settings_guard();

alter table public.site_settings enable row level security;
create policy "site settings: read" on public.site_settings for select using (true);
create policy "site settings: admins change" on public.site_settings for update to authenticated
  using ((select public.my_role()) = 'admin') with check ((select public.my_role()) = 'admin');
revoke all on public.site_settings from anon, authenticated;
grant select on public.site_settings to anon, authenticated;
grant update (idea_banner) on public.site_settings to authenticated;

-- ---------- ideas ----------
create table public.game_ideas (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 3 and 100),
  body text not null default '' check (char_length(body) <= 2000),
  -- the developer who builds it (back to nobody when their account is deleted)
  claimed_by uuid references public.profiles(id) on delete set null,
  claimed_at timestamptz,
  -- set once the game is on Toki
  done_at timestamptz,
  game_id uuid references public.games(id) on delete set null,
  status text generated always as (
    case when done_at is not null then 'done' when claimed_by is not null then 'claimed' else 'open' end
  ) stored,
  reply_count integer not null default 0 check (reply_count >= 0),
  created_at timestamptz not null default now(),
  -- last activity: proposed, claimed, given back, done or a reply
  updated_at timestamptz not null default now()
);
create index game_ideas_updated_idx on public.game_ideas(updated_at desc);
create index game_ideas_author_idx on public.game_ideas(author_id, created_at desc);
create index game_ideas_claimed_by_idx on public.game_ideas(claimed_by);
create index game_ideas_game_idx on public.game_ideas(game_id);

create table public.game_idea_replies (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references public.game_ideas(id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index game_idea_replies_idea_idx on public.game_idea_replies(idea_id, created_at);
create index game_idea_replies_author_idx on public.game_idea_replies(author_id, created_at desc);

-- New ideas: the server sets everything but the words. Requests without a user (SQL editor) pass.
create function public.game_ideas_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    return new;
  end if;
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  if (select count(*) from public.game_ideas where author_id = v_me and created_at > now() - interval '1 day') >= 3
    or (select count(*) from public.game_ideas where author_id = v_me and created_at > now() - interval '30 days') >= 10 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  new.author_id := v_me;
  new.title := btrim(new.title);
  new.body := btrim(new.body);
  new.claimed_by := null;
  new.claimed_at := null;
  new.done_at := null;
  new.game_id := null;
  new.reply_count := 0;
  new.created_at := now();
  new.updated_at := now();
  return new;
end $$;
create trigger game_ideas_guard before insert on public.game_ideas
  for each row execute function public.game_ideas_guard();

create function public.game_idea_replies_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    return new;
  end if;
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  if (select count(*) from public.game_idea_replies where author_id = v_me and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  new.author_id := v_me;
  new.body := btrim(new.body);
  new.created_at := now();
  return new;
end $$;
create trigger game_idea_replies_guard before insert on public.game_idea_replies
  for each row execute function public.game_idea_replies_guard();

-- Keeps reply_count and the last activity of the idea up to date.
create function public.game_idea_replies_count() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.game_ideas set reply_count = reply_count + 1, updated_at = now() where id = new.idea_id;
  else
    update public.game_ideas set reply_count = greatest(reply_count - 1, 0) where id = old.idea_id;
  end if;
  return null;
end $$;
create trigger game_idea_replies_count after insert or delete on public.game_idea_replies
  for each row execute function public.game_idea_replies_count();

alter table public.game_ideas enable row level security;
alter table public.game_idea_replies enable row level security;

create policy "game ideas: read" on public.game_ideas for select to authenticated
  using (author_id = (select auth.uid()) or (select public.my_role()) in ('creator', 'admin'));
create policy "game ideas: add" on public.game_ideas for insert to authenticated
  with check (author_id = (select auth.uid()));
-- Whoever proposed it, as long as no developer has picked it. Admins always.
create policy "game ideas: delete" on public.game_ideas for delete to authenticated
  using ((author_id = (select auth.uid()) and claimed_by is null and done_at is null)
    or (select public.my_role()) = 'admin');

-- Replies only exist on ideas the account can see (the ideas policy applies inside).
create policy "game idea replies: read" on public.game_idea_replies for select to authenticated
  using (exists (select 1 from public.game_ideas i where i.id = idea_id));
create policy "game idea replies: add" on public.game_idea_replies for insert to authenticated
  with check (author_id = (select auth.uid()) and exists (select 1 from public.game_ideas i where i.id = idea_id));
create policy "game idea replies: delete" on public.game_idea_replies for delete to authenticated
  using (author_id = (select auth.uid()) or (select public.my_role()) = 'admin');

-- Only the columns people may write. Everything else is set by the triggers and functions.
revoke all on public.game_ideas, public.game_idea_replies from anon, authenticated;
grant select, delete on public.game_ideas, public.game_idea_replies to authenticated;
grant insert (title, body) on public.game_ideas to authenticated;
grant insert (idea_id, body) on public.game_idea_replies to authenticated;

-- ---------- notifications ----------
-- game_idea: data.event says what happened: 'new' (to developers), 'reply', 'claimed',
-- 'released' (given back) or 'done'.
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'fb_reply', 'fb_status', 'friend_request', 'friend_accept', 'group_add', 'score_beaten', 'game_invite', 'dev_news',
  'game_idea'));

-- A new idea reaches every developer.
create function public.notify_game_idea_new() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.notify(p.id, 'game_idea', new.author_id,
      jsonb_build_object('event', 'new', 'idea', new.id, 'title', new.title))
    from public.profiles p
    where p.role in ('creator', 'admin') and p.id <> new.author_id;
  return null;
end $$;
create trigger notify_game_idea_new after insert on public.game_ideas
  for each row execute function public.notify_game_idea_new();

-- A reply reaches whoever proposed the idea, and the developer building it.
create function public.notify_game_idea_reply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  i public.game_ideas;
  v_data jsonb;
begin
  select * into i from public.game_ideas where id = new.idea_id;
  v_data := jsonb_build_object('event', 'reply', 'idea', i.id, 'title', i.title);
  perform public.notify(i.author_id, 'game_idea', new.author_id, v_data);
  if i.claimed_by is distinct from i.author_id then
    perform public.notify(i.claimed_by, 'game_idea', new.author_id, v_data);
  end if;
  return null;
end $$;
create trigger notify_game_idea_reply after insert on public.game_idea_replies
  for each row execute function public.notify_game_idea_reply();

-- ---------- claim, give back, done ----------
-- Errors: login_required, banned, not_developer, not_found, taken (someone else has it, or
-- it's done), not_yours, bad_game (not a game of the developer who builds the idea).

create function public.claim_game_idea(p_idea uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  i public.game_ideas;
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  if not public.not_banned() then
    raise exception 'banned' using errcode = 'P0001';
  end if;
  if coalesce(public.my_role() not in ('creator', 'admin'), true) then
    raise exception 'not_developer' using errcode = 'P0001';
  end if;
  -- Two developers at the same moment: the second one finds it taken.
  update public.game_ideas set claimed_by = v_me, claimed_at = now(), updated_at = now()
    where id = p_idea and claimed_by is null and done_at is null
    returning * into i;
  if i.id is null then
    if exists (select 1 from public.game_ideas where id = p_idea) then
      raise exception 'taken' using errcode = 'P0001';
    end if;
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform public.notify(i.author_id, 'game_idea', v_me,
    jsonb_build_object('event', 'claimed', 'idea', i.id, 'title', i.title));
end $$;

-- The developer gives the idea back (or an admin takes it from them): it's open again.
create function public.release_game_idea(p_idea uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  i public.game_ideas;
  v_data jsonb;
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  select * into i from public.game_ideas where id = p_idea for update;
  if i.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if i.claimed_by is null or i.done_at is not null
    or (i.claimed_by <> v_me and public.my_role() is distinct from 'admin') then
    raise exception 'not_yours' using errcode = 'P0001';
  end if;
  update public.game_ideas set claimed_by = null, claimed_at = null, updated_at = now() where id = p_idea;
  v_data := jsonb_build_object('event', 'released', 'idea', i.id, 'title', i.title);
  perform public.notify(i.author_id, 'game_idea', v_me, v_data);
  if i.claimed_by is distinct from i.author_id then
    perform public.notify(i.claimed_by, 'game_idea', v_me, v_data);
  end if;
end $$;

-- The game is on Toki: the idea is done and links to it.
create function public.finish_game_idea(p_idea uuid, p_game uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  i public.game_ideas;
  v_title text;
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  select * into i from public.game_ideas where id = p_idea for update;
  if i.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if i.claimed_by is null or i.done_at is not null
    or (i.claimed_by <> v_me and public.my_role() is distinct from 'admin') then
    raise exception 'not_yours' using errcode = 'P0001';
  end if;
  select title into v_title from public.games
    where id = p_game and created_by = i.claimed_by;
  if v_title is null then
    raise exception 'bad_game' using errcode = 'P0001';
  end if;
  update public.game_ideas set done_at = now(), game_id = p_game, updated_at = now() where id = p_idea;
  perform public.notify(i.author_id, 'game_idea', i.claimed_by,
    jsonb_build_object('event', 'done', 'idea', i.id, 'title', i.title, 'game', p_game));
end $$;

revoke execute on function public.site_settings_guard() from public, anon, authenticated;
revoke execute on function public.game_ideas_guard() from public, anon, authenticated;
revoke execute on function public.game_idea_replies_guard() from public, anon, authenticated;
revoke execute on function public.game_idea_replies_count() from public, anon, authenticated;
revoke execute on function public.notify_game_idea_new() from public, anon, authenticated;
revoke execute on function public.notify_game_idea_reply() from public, anon, authenticated;
revoke execute on function public.claim_game_idea(uuid) from public, anon;
revoke execute on function public.release_game_idea(uuid) from public, anon;
revoke execute on function public.finish_game_idea(uuid, uuid) from public, anon;
grant execute on function public.claim_game_idea(uuid) to authenticated;
grant execute on function public.release_game_idea(uuid) to authenticated;
grant execute on function public.finish_game_idea(uuid, uuid) to authenticated;

-- ---------- free plan: old ideas go away ----------
select cron.schedule('delete-old-game-ideas', '23 4 * * *', $$
  delete from public.game_ideas
  where (claimed_by is null and done_at is null and updated_at < now() - interval '180 days')
     or done_at < now() - interval '180 days'
$$);
