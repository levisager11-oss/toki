-- "Already done" on Updates for your games (src/components/DevUpdates.tsx): the developer says a
-- game has an update (src/lib/gameUpdates.ts) that they added themselves, outside Toki Connect, so
-- its card leaves the game out. One row per game and update, gone with the game; the developer can
-- take it back.
create table public.game_update_marks (
  game_id uuid not null references public.games(id) on delete cascade,
  -- The update's topic, as in notify_developers().
  topic text not null check (topic ~ '^[a-z][a-z0-9_]{0,29}$'),
  created_at timestamptz not null default now(),
  primary key (game_id, topic)
);

alter table public.game_update_marks enable row level security;

-- Only the game's developer, for their own games.
create policy "game update marks: read" on public.game_update_marks for select to authenticated
  using (exists (select 1 from public.games g where g.id = game_id and g.created_by = auth.uid()));
create policy "game update marks: add" on public.game_update_marks for insert to authenticated
  with check (exists (select 1 from public.games g where g.id = game_id and g.created_by = auth.uid()));
create policy "game update marks: take back" on public.game_update_marks for delete to authenticated
  using (exists (select 1 from public.games g where g.id = game_id and g.created_by = auth.uid()));

revoke all on public.game_update_marks from anon, authenticated;
grant select, delete on public.game_update_marks to authenticated;
grant insert (game_id, topic) on public.game_update_marks to authenticated;
