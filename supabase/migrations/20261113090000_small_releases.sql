-- Small updates: a quick fix (1.2.1) next to the main version (1.2). Main versions stay
-- the big cards; small ones are listed compactly under the main version they follow.

alter table public.game_releases add column small boolean not null default false;

grant insert (small) on public.game_releases to authenticated;
grant update (small) on public.game_releases to authenticated;
