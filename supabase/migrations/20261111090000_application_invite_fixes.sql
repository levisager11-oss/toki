-- Two loopholes:
-- 1. Withdrawing an application deleted it, so "at most 3 applications in 30 days" could be
--    dodged by applying and withdrawing again and again. A withdrawal now keeps the row with
--    the status 'withdrawn' (it still counts towards the limit). Pages that still delete keep
--    working: the delete becomes that update.
-- 2. An invite counted as unused again once the account that used it was deleted (used_by is
--    set to null then). An invite is now used for good once it has a used_at.

-- ---------- 1. withdrawn applications ----------
alter table public.developer_applications drop constraint if exists developer_applications_status_check;
alter table public.developer_applications add constraint developer_applications_status_check
  check (status in ('pending', 'approved', 'rejected', 'withdrawn'));

create or replace function public.developer_applications_withdraw() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Only the author deleting their own open application directly. Deleting the account
  -- (a cascade, one trigger level deeper) and the SQL editor still really delete.
  if auth.uid() is null or old.user_id is distinct from auth.uid() or old.status <> 'pending' or pg_trigger_depth() > 1 then
    return old;
  end if;
  update public.developer_applications set status = 'withdrawn' where id = old.id;
  return null;
end $$;
revoke execute on function public.developer_applications_withdraw() from public, anon, authenticated;
drop trigger if exists developer_applications_withdraw on public.developer_applications;
create trigger developer_applications_withdraw before delete on public.developer_applications
  for each row execute function public.developer_applications_withdraw();

-- ---------- 2. invites stay used ----------
create or replace function public.check_invite(p_code text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.invites where code = p_code and used_at is null)
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_code text := nullif(trim(new.raw_user_meta_data ->> 'invite'), '');
  v_username text := lower(new.raw_user_meta_data ->> 'username');
  v_role public.user_role := 'player';
begin
  if v_code is not null then
    select role into v_role from public.invites where code = v_code and used_at is null for update;
    if v_role is null then
      raise exception 'invalid_invite';
    end if;
  end if;
  insert into public.profiles (id, username, role) values (new.id, v_username, v_role);
  if v_code is not null then
    update public.invites set used_by = new.id, used_at = now() where code = v_code;
  end if;
  if v_role = 'admin' then
    update public.games set created_by = new.id where created_by is null;
  end if;
  return new;
end $$;

create or replace function public.redeem_invite(p_code text) returns public.user_role
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.user_role;
begin
  if auth.uid() is null then
    raise exception 'login_required';
  end if;
  update public.invites set used_by = auth.uid(), used_at = now()
    where code = p_code and used_at is null returning role into v_role;
  if v_role is null then
    raise exception 'invalid_invite';
  end if;
  update public.profiles set role = v_role where id = auth.uid() and role = 'player';
  return v_role;
end $$;
