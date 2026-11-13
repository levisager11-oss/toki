-- More of the privacy policy follows Toki's settings by itself:
--  * its date also moves when an admin changes a deletion time on /admin/limits;
--  * it only says that Cloudflare stores and runs uploaded games while there are such games, and
--    its date moves when the first game is uploaded to Toki (or the last one leaves).
-- site_settings.policy_changed_at is when one of those last changed; policy_facts() gives the
-- later of it and the AI settings' date.

alter table public.site_settings
  add column policy_changed_at timestamptz,
  -- whether any game is uploaded to Toki (kept here so the date moves only when that changes)
  add column games_hosted boolean not null default false;
update public.site_settings set games_hosted = exists (select 1 from public.games where hosted_site is not null);

create function public.policy_touch_keep() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.site_settings set policy_changed_at = now() where id = 1;
  return null;
end $$;
create trigger keep_times_policy after update on public.keep_times
  for each row when (new.value is distinct from old.value) execute function public.policy_touch_keep();

create function public.policy_touch_hosting() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_hosted boolean := exists (select 1 from public.games where hosted_site is not null);
begin
  update public.site_settings set games_hosted = v_hosted, policy_changed_at = now()
    where id = 1 and games_hosted is distinct from v_hosted;
  return null;
end $$;
create trigger games_policy after insert or delete or update of hosted_site on public.games
  for each statement execute function public.policy_touch_hosting();
revoke execute on function public.policy_touch_keep(), public.policy_touch_hosting() from public, anon, authenticated;

create or replace function public.policy_facts() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'ai_hosts', coalesce((select to_jsonb(public.ai_hosts(s)) from public.ai_settings s where s.id = 1), '[]'::jsonb),
    'games_hosted', coalesce((select games_hosted from public.site_settings where id = 1), false),
    'changed_at', greatest(
      (select policy_changed_at from public.ai_settings where id = 1),
      (select policy_changed_at from public.site_settings where id = 1)))
$$;
