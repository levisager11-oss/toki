-- When a game's address (slug) changes, its old addresses keep working: old links redirect,
-- and favorites and "recently played" saved in browsers under the old slug are moved over.

alter table public.games add column old_slugs text[] not null default '{}'
  check (cardinality(old_slugs) <= 10);
create index games_old_slugs_idx on public.games using gin (old_slugs);

create function public.games_keep_old_slug() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.slug is distinct from old.slug then
    -- Newest first, at most 10, and never the current slug.
    new.old_slugs := (
      select coalesce(array_agg(s order by n), '{}')
      from (
        select s, min(n) as n
        from unnest(array[old.slug] || old.old_slugs) with ordinality as x(s, n)
        where s <> new.slug
        group by s
        order by min(n)
        limit 10
      ) y
    );
  elsif tg_op = 'UPDATE' then
    new.old_slugs := old.old_slugs; -- only the server changes this list
  else
    new.old_slugs := '{}';
  end if;
  return new;
end $$;
revoke execute on function public.games_keep_old_slug() from public, anon, authenticated;
create trigger games_keep_old_slug before insert or update on public.games
  for each row execute function public.games_keep_old_slug();
