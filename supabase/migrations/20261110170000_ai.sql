-- AI features: settings (admins), spending limits, a usage log, and Toki Connect (GitHub).
--
-- The AI runs on the server (Vercel functions in api/), which holds the API key and talks to the
-- database with the service role. Every AI call first reserves its highest possible cost
-- (ai_reserve) and afterwards settles the real cost (ai_settle). Reserving happens under one lock,
-- so neither a developer's monthly quota nor the monthly cap for all of Toki can be exceeded, even
-- by requests at the same time. Admins have no quota of their own; the cap applies to everyone.

-- ---------- settings (one row) ----------
create table public.ai_settings (
  id integer primary key default 1 check (id = 1),
  enabled boolean not null default false,
  -- 'openai_compatible': any endpoint that speaks the OpenAI chat completions API.
  -- More providers (Anthropic) are added later.
  provider text not null default 'openai_compatible' check (provider in ('openai_compatible')),
  base_url text not null default '' check (base_url = '' or (base_url ~ '^https://[^\s]+$' and char_length(base_url) <= 300)),
  model text not null default '' check (char_length(model) <= 100),
  -- US dollars per million tokens
  input_price numeric(10, 4) not null default 0 check (input_price between 0 and 1000),
  output_price numeric(10, 4) not null default 0 check (output_price between 0 and 1000),
  -- US dollars per calendar month (UTC)
  monthly_cap numeric(10, 2) not null default 20 check (monthly_cap between 0 and 1000),
  default_quota numeric(10, 2) not null default 5 check (default_quota between 0 and 1000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  -- Without prices every call would cost 0 and no limit would ever stop it.
  check (not enabled or (base_url <> '' and model <> '' and input_price > 0 and output_price > 0))
);
insert into public.ai_settings (id) values (1);

create function public.ai_settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.id := 1;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), old.updated_by);
  return new;
end $$;
create trigger ai_settings_guard before update on public.ai_settings
  for each row execute function public.ai_settings_guard();

-- ---------- quotas (only where an admin changed the default) ----------
create table public.ai_quotas (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  monthly_usd numeric(10, 2) not null check (monthly_usd between 0 and 1000),
  updated_at timestamptz not null default now()
);

-- ---------- usage log ----------
create table public.ai_usage (
  id bigint generated always as identity primary key,
  -- kept (as null) when the account is deleted, so the month's cost still counts
  user_id uuid references public.profiles(id) on delete set null,
  feature text not null check (feature in ('connect', 'test')),
  job_id uuid,
  model text not null default '',
  -- reserved: waiting for the answer, cost is the highest possible; done/failed: real cost
  status text not null default 'reserved' check (status in ('reserved', 'done', 'failed')),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  -- prices when the call was made (US dollars per million tokens)
  input_price numeric(10, 4) not null,
  output_price numeric(10, 4) not null,
  cost numeric(12, 6) not null check (cost >= 0),
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index ai_usage_month_idx on public.ai_usage(created_at);
create index ai_usage_user_idx on public.ai_usage(user_id, created_at);

-- Start of the current month (UTC): limits count from here.
create function public.ai_month_start() returns timestamptz
language sql stable set search_path = '' as $$
  select date_trunc('month', now() at time zone 'utc') at time zone 'utc'
$$;

-- Reserves the highest possible cost of one AI call for an account, or raises ai_disabled,
-- not_allowed (players), cap_reached or quota_reached. Returns the reservation id and the
-- settings to call the AI with. Server only.
create function public.ai_reserve(p_user uuid, p_feature text, p_job uuid, p_input_tokens integer, p_max_output_tokens integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.ai_settings;
  v_role public.user_role;
  v_cost numeric;
  v_month timestamptz := public.ai_month_start();
  v_all numeric;
  v_mine numeric;
  v_quota numeric;
  v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('toki.ai_budget', 0));
  select * into s from public.ai_settings where id = 1;
  if not s.enabled then
    raise exception 'ai_disabled' using errcode = 'P0001';
  end if;
  select role into v_role from public.profiles where id = p_user;
  if v_role is null or v_role = 'player' or (p_feature = 'test' and v_role <> 'admin') then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  v_cost := (greatest(p_input_tokens, 0)::numeric * s.input_price + greatest(p_max_output_tokens, 0)::numeric * s.output_price) / 1000000;

  select coalesce(sum(cost), 0) into v_all from public.ai_usage where created_at >= v_month;
  if v_all + v_cost > s.monthly_cap then
    raise exception 'cap_reached' using errcode = 'P0001';
  end if;
  if v_role <> 'admin' then
    v_quota := coalesce((select monthly_usd from public.ai_quotas where user_id = p_user), s.default_quota);
    select coalesce(sum(cost), 0) into v_mine from public.ai_usage where user_id = p_user and created_at >= v_month;
    if v_mine + v_cost > v_quota then
      raise exception 'quota_reached' using errcode = 'P0001';
    end if;
  end if;

  insert into public.ai_usage (user_id, feature, job_id, model, input_price, output_price, cost)
    values (p_user, p_feature, p_job, s.model, s.input_price, s.output_price, v_cost)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'provider', s.provider, 'base_url', s.base_url, 'model', s.model, 'max_cost', v_cost);
end $$;

-- Replaces a reservation with the real cost of the call. Returns that cost. Server only.
create function public.ai_settle(p_id bigint, p_input_tokens integer, p_output_tokens integer, p_ok boolean)
returns numeric
language sql security definer set search_path = '' as $$
  update public.ai_usage
    set input_tokens = greatest(p_input_tokens, 0),
        output_tokens = greatest(p_output_tokens, 0),
        cost = (greatest(p_input_tokens, 0)::numeric * input_price + greatest(p_output_tokens, 0)::numeric * output_price) / 1000000,
        status = case when p_ok then 'done' else 'failed' end,
        settled_at = now()
    where id = p_id and status = 'reserved'
    returning cost
$$;

-- For developers: whether the AI can be used, and what they spent this month of how much.
create function public.my_ai_budget() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'enabled', s.enabled,
    'spent', coalesce((select sum(cost) from public.ai_usage where user_id = auth.uid() and created_at >= public.ai_month_start()), 0),
    'quota', case when p.role = 'admin' then null
                  when p.role = 'player' then 0
                  else coalesce((select monthly_usd from public.ai_quotas where user_id = auth.uid()), s.default_quota) end,
    'cap_reached', coalesce((select sum(cost) from public.ai_usage where created_at >= public.ai_month_start()), 0) >= s.monthly_cap
  )
  from public.ai_settings s left join public.profiles p on p.id = auth.uid()
  where s.id = 1
$$;

-- For the admin dashboard: this month's spending, in total and per account.
create function public.ai_month_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_month timestamptz := public.ai_month_start();
begin
  if public.my_role() is distinct from 'admin' then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'month_start', v_month,
    'spent', (select coalesce(sum(cost), 0) from public.ai_usage where created_at >= v_month),
    'reserved', (select coalesce(sum(cost), 0) from public.ai_usage where created_at >= v_month and status = 'reserved'),
    'calls', (select count(*) from public.ai_usage where created_at >= v_month),
    'users', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', u.user_id, 'username', p.username, 'role', p.role,
               'spent', u.spent, 'calls', u.calls, 'quota', q.monthly_usd) order by u.spent desc)
      from (select user_id, sum(cost) as spent, count(*) as calls from public.ai_usage
            where created_at >= v_month group by user_id) u
      left join public.profiles p on p.id = u.user_id
      left join public.ai_quotas q on q.user_id = u.user_id
    ), '[]'::jsonb)
  );
end $$;

-- ---------- Toki Connect ----------
-- GitHub App installations an account may use. Only the server adds them, after GitHub confirmed
-- (with the person's own GitHub login) that they have access to the installation.
create table public.github_installations (
  user_id uuid not null references public.profiles(id) on delete cascade,
  installation_id bigint not null,
  account_login text not null check (char_length(account_login) between 1 and 100),
  created_at timestamptz not null default now(),
  primary key (user_id, installation_id)
);

-- One run of Toki Connect: the AI reads a game's repository, may ask the developer questions,
-- and opens a pull request that adds Toki saves and/or high scores.
create table public.connect_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  game_id uuid references public.games(id) on delete set null,
  installation_id bigint not null,
  repo text not null check (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' and char_length(repo) <= 200),
  features text[] not null check (cardinality(features) between 1 and 2 and features <@ array['saves', 'scores']),
  notes text not null default '' check (char_length(notes) <= 1000),
  status text not null default 'working' check (status in ('working', 'question', 'done', 'failed')),
  -- what the developer sees: [{"from": "ai" | "developer", "text": ..., "questions": [...]}]
  messages jsonb not null default '[]' check (jsonb_typeof(messages) = 'array' and pg_column_size(messages) <= 200000),
  -- the AI's working memory between steps (files read, plan); server only
  state jsonb not null default '{}' check (pg_column_size(state) <= 2000000),
  pr_url text check (pr_url is null or (pr_url ~ '^https://github\.com/' and char_length(pr_url) <= 300)),
  error text check (error is null or char_length(error) <= 500),
  -- while a server step works on the job, others wait
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index connect_jobs_user_idx on public.connect_jobs(user_id, created_at desc);
-- One run at a time per account.
create unique index connect_jobs_one_active on public.connect_jobs(user_id) where status in ('working', 'question');

-- ---------- who sees and changes what ----------
alter table public.ai_settings enable row level security;
alter table public.ai_quotas enable row level security;
alter table public.ai_usage enable row level security;
alter table public.github_installations enable row level security;
alter table public.connect_jobs enable row level security;

create policy "ai settings: admins read" on public.ai_settings for select to authenticated
  using ((select public.my_role()) = 'admin');
create policy "ai settings: admins change" on public.ai_settings for update to authenticated
  using ((select public.my_role()) = 'admin') with check ((select public.my_role()) = 'admin');
create policy "ai quotas: admins" on public.ai_quotas for all to authenticated
  using ((select public.my_role()) = 'admin') with check ((select public.my_role()) = 'admin');
create policy "ai usage: own or admin" on public.ai_usage for select to authenticated
  using (user_id = (select auth.uid()) or (select public.my_role()) = 'admin');
create policy "github installations: own" on public.github_installations for select to authenticated
  using (user_id = (select auth.uid()));
create policy "github installations: remove own" on public.github_installations for delete to authenticated
  using (user_id = (select auth.uid()));
create policy "connect jobs: own or admin" on public.connect_jobs for select to authenticated
  using (user_id = (select auth.uid()) or (select public.my_role()) = 'admin');

revoke all on public.ai_settings, public.ai_quotas, public.ai_usage, public.github_installations, public.connect_jobs from anon, authenticated;
grant select on public.ai_settings to authenticated;
grant update (enabled, base_url, model, input_price, output_price, monthly_cap, default_quota) on public.ai_settings to authenticated;
grant select, insert, update, delete on public.ai_quotas to authenticated;
grant select on public.ai_usage to authenticated;
grant select, delete on public.github_installations to authenticated;
-- not the AI's working memory or the lease
grant select (id, user_id, game_id, installation_id, repo, features, notes, status, messages, pr_url, error, created_at, updated_at)
  on public.connect_jobs to authenticated;

revoke execute on function public.ai_settings_guard() from public, anon, authenticated;
revoke execute on function public.ai_reserve(uuid, text, uuid, integer, integer) from public, anon, authenticated;
revoke execute on function public.ai_settle(bigint, integer, integer, boolean) from public, anon, authenticated;
revoke execute on function public.my_ai_budget() from public, anon;
revoke execute on function public.ai_month_overview() from public, anon;
grant execute on function public.ai_reserve(uuid, text, uuid, integer, integer) to service_role;
grant execute on function public.ai_settle(bigint, integer, integer, boolean) to service_role;
grant execute on function public.my_ai_budget() to authenticated;
grant execute on function public.ai_month_overview() to authenticated;
