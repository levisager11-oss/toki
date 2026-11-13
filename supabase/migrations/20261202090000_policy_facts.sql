-- The privacy policy follows Toki's settings by itself: when an admin switches AI on or off, or
-- changes the AI service, the policy's page says so right away and its date moves.
--  * ai_settings.policy_changed_at: when something the policy names last changed (AI on or off,
--    or the address of the AI service).
--  * policy_facts(): what the policy's page needs, for everyone: whether AI is on, the addresses
--    of the AI services in use (only their host names, never keys or models), and that date.

alter table public.ai_settings add column policy_changed_at timestamptz;

-- "https://api.example.com/v1" -> "api.example.com"
create function public.url_host(p_url text) returns text
language sql immutable set search_path = '' as $$
  select lower(substring(p_url from '^https://([^/:?#]+)'))
$$;

-- The hosts of the AI services that get players' text right now.
create function public.ai_hosts(s public.ai_settings) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct h order by h), '{}') from (
    select case when s.provider = 'anthropic' and s.base_url = '' then 'api.anthropic.com' else public.url_host(s.base_url) end as h
      where s.enabled
    union all
    select public.url_host(s.free_base_url) where s.free_enabled
  ) x where h is not null
$$;

create or replace function public.ai_settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.id := 1;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), old.updated_by);
  -- The date only moves with what the policy names, not with prices or models.
  new.policy_changed_at := old.policy_changed_at;
  if public.ai_hosts(new) is distinct from public.ai_hosts(old) then
    new.policy_changed_at := now();
  end if;
  return new;
end $$;

create function public.policy_facts() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('ai_hosts', to_jsonb(public.ai_hosts(s)), 'changed_at', s.policy_changed_at)
       from public.ai_settings s where s.id = 1),
    '{"ai_hosts": [], "changed_at": null}'::jsonb)
$$;
revoke execute on function public.url_host(text), public.ai_hosts(public.ai_settings) from public, anon, authenticated;
revoke execute on function public.policy_facts() from public;
grant execute on function public.policy_facts() to anon, authenticated;
