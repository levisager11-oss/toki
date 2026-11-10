-- "Move to Toki": a game that ran at a link elsewhere moves onto Toki (server/migrate.ts). Toki
-- downloads it from that link and hosts it. Players' progress is kept in their browser under the
-- old address, which the new address can't read. So Toki remembers the old address for a while:
-- the first time a player who played the game on Toki before opens it after the move, Toki opens
-- the old address hidden and takes the progress the game's save script hands over there
-- (src/lib/movedSaves.ts), before the game starts at its new address.
--
-- * games.moved_from: the game's address before it moved (null: it never moved, or moved back).
-- * games.moved_at: when it moved. Progress is picked up from the old address for 180 days.
-- Only the server sets both, like hosted_site.

alter table public.games
  add column moved_from text check (moved_from is null or (moved_from ~ '^https://' and char_length(moved_from) <= 500)),
  add column moved_at timestamptz;

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
  -- the hosting address and the address before a move are only set by the server
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.hosted_site := null;
      new.moved_from := null;
      new.moved_at := null;
    else
      new.hosted_site := old.hosted_site;
      new.moved_from := old.moved_from;
      new.moved_at := old.moved_at;
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;
