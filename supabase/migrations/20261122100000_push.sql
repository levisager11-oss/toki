-- Push notifications for game invites: a friend who isn't on Toki right now gets the invite
-- on their phone or computer, if they turned that on for the device.
--
-- Only invites are pushed (they are rare and worth it). The browser gives each device an
-- address to send to; Toki's server (api/push.ts) sends there, signed with a key pair that is
-- made the first time and kept with the other server secrets.
--
-- Free plan: at most 5 devices per player, and devices not seen for 180 days are deleted.

create table public.push_subscriptions (
  -- the address the browser's push service gave this device
  endpoint text primary key check (endpoint ~ '^https://[^\s]+$' and char_length(endpoint) <= 1000),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- the device's public key and secret, to encrypt what is sent to it
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{40,200}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{8,100}$'),
  -- the language Toki is shown in on that device
  lang text not null default 'en' check (lang in ('en', 'de')),
  seen_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions(user_id, seen_at desc);

alter table public.push_subscriptions enable row level security;
-- No policies: players use the two functions below, the server reads with the service role.
revoke all on public.push_subscriptions from anon, authenticated;

-- Turns invites on for this device (or says it is still in use). A device belongs to whoever
-- is logged in on it now.
create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_lang text default 'en') returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'login_required' using errcode = 'P0001';
  end if;
  insert into public.push_subscriptions as s (endpoint, user_id, p256dh, auth, lang)
    values (p_endpoint, v_me, p_p256dh, p_auth, case when p_lang = 'de' then 'de' else 'en' end)
    on conflict (endpoint) do update
      set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang, seen_at = now();
  -- keep the 5 devices seen last
  delete from public.push_subscriptions where user_id = v_me and endpoint in (
    select endpoint from public.push_subscriptions where user_id = v_me order by seen_at desc, endpoint offset 5);
end $$;

create function public.remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;

revoke execute on function public.save_push_subscription(text, text, text, text) from public, anon;
revoke execute on function public.remove_push_subscription(text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.remove_push_subscription(text) to authenticated;

-- For the server, right after p_from invited p_to: what to push and where. Each invite is
-- pushed once, and not at all while the friend is on Toki anyway (they see the pop-up).
-- null when there is nothing to send.
create function public.take_invite_push(p_from uuid, p_to uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n public.notifications;
begin
  select * into n from public.notifications
    where user_id = p_to and actor_id = p_from and kind = 'game_invite'
      and created_at > now() - interval '2 minutes' and not (data ? 'pushed')
    order by id desc limit 1 for update;
  if n.id is null then
    return null;
  end if;
  update public.notifications set data = data || '{"pushed": true}' where id = n.id;
  if exists (select 1 from public.presence where user_id = p_to and last_seen > now() - interval '130 seconds')
    or not exists (select 1 from public.push_subscriptions where user_id = p_to) then
    return null;
  end if;
  return jsonb_build_object(
    'from', (select username from public.profiles where id = p_from),
    'title', n.data->>'title',
    'slug', (select slug from public.games where id = (n.data->>'game')::uuid),
    'code', n.data->>'code',
    'party', n.data->>'party',
    'devices', (select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth, 'lang', s.lang))
      from public.push_subscriptions s where s.user_id = p_to));
end $$;
revoke execute on function public.take_invite_push(uuid, uuid) from public, anon, authenticated;
grant execute on function public.take_invite_push(uuid, uuid) to service_role;

-- The server's key pair for push ("web_push"), next to its other secrets.
alter table public.server_secrets drop constraint server_secrets_name_check;
alter table public.server_secrets add constraint server_secrets_name_check
  check (name in ('ai_api_key', 'anthropic_api_key', 'free_ai_api_key', 'github_app', 'cloudflare_r2', 'web_push'));

select cron.schedule('delete-old-push-subscriptions', '13 4 * * *',
  $$delete from public.push_subscriptions where seen_at < now() - interval '180 days'$$);
