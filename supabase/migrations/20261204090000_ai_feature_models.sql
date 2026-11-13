-- One Claude model per AI feature, all paid through Anthropic's API with the same limits.
--
-- The free AI is gone: every feature (translations, similar feedback, game suggestions, "Ask AI",
-- learning games, release notes, descriptions, summaries and Toki Connect) now uses Claude, with
-- its own model, prices and thinking level in ai_features. An empty model turns a feature off.
-- Every call goes through ai_reserve: Toki's monthly cap, developers' monthly quotas, and the
-- calls per hour from /admin/limits (key ai_<feature>; the Connect features share ai_connect).
-- Players may use translations, similar feedback, game suggestions and "Ask AI"; the rest is for
-- developers and admins.
--
-- Toki Connect has three features: "connect" (the steps that write code, also Managed Agents),
-- "connect_steps" (the easy steps: reading code and asking the developer; empty: "connect" does
-- them) and "connect_quick" (one-click "Add your game"; empty: off).

-- ---------- models per feature ----------
create table public.ai_features (
  feature text primary key check (feature in (
    'translate', 'similar', 'suggest', 'help', 'learn', 'release', 'describe', 'summary',
    'connect', 'connect_steps', 'connect_quick')),
  model text not null default '' check (char_length(model) <= 100),
  -- US dollars per million tokens
  input_price numeric(10, 4) not null default 0 check (input_price between 0 and 1000),
  output_price numeric(10, 4) not null default 0 check (output_price between 0 and 1000),
  thinking text not null default 'default' check (thinking in ('default', 'low', 'medium', 'high', 'xhigh', 'max')),
  updated_at timestamptz not null default now(),
  -- Without prices every call would cost 0 and no limit would ever stop it.
  check (model = '' or (input_price > 0 and output_price > 0))
);
insert into public.ai_features (feature, model, input_price, output_price, thinking) values
  ('translate',     'claude-haiku-5-5',  0.1, 0.5, 'low'),
  ('similar',       'claude-haiku-5-5',  0.1, 0.5, 'low'),
  ('suggest',       'claude-haiku-5-5',  0.1, 0.5, 'low'),
  ('help',          'claude-haiku-5-5',  0.1, 0.5, 'low'),
  ('learn',         'claude-haiku-5-5',  0.1, 0.5, 'low'),
  ('release',       'claude-haiku-5-5',  0.1, 0.5, 'low'),
  ('describe',      'claude-haiku-5-5',  0.1, 0.5, 'low'),
  ('summary',       'claude-haiku-5-5',  0.1, 0.5, 'low'),
  ('connect',       'claude-sonnet-5-5', 2,   10,  'default'),
  ('connect_steps', 'claude-haiku-5-5',  0.1, 0.5, 'low'),
  ('connect_quick', 'claude-sonnet-5-5', 2,   10,  'default');

create function public.ai_features_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.feature := old.feature;
  new.updated_at := now();
  return new;
end $$;
create trigger ai_features_touch before update on public.ai_features
  for each row execute function public.ai_features_touch();

alter table public.ai_features enable row level security;
create policy "ai features: admins read" on public.ai_features for select to authenticated
  using ((select public.my_role()) = 'admin');
create policy "ai features: admins change" on public.ai_features for update to authenticated
  using ((select public.my_role()) = 'admin') with check ((select public.my_role()) = 'admin');
revoke all on public.ai_features from anon, authenticated;
grant select on public.ai_features to authenticated;
grant update (model, input_price, output_price, thinking) on public.ai_features to authenticated;

-- ---------- the free AI goes ----------
drop function if exists public.ai_free_take(uuid, text);
drop function if exists public.ai_free_record(text, boolean, integer, integer);
drop function if exists public.ai_free_on();
drop table if exists public.ai_free_usage;
-- (ai_free_limits stays: it counts the calls per hour of every feature now.)

select cron.unschedule('delete-old-free-ai');
select cron.schedule('delete-old-ai-helpers', '37 3 * * *', $$
  delete from public.ai_free_limits where window_start < now() - interval '1 day';
  delete from public.ai_translations where created_at < now() - make_interval(days => public.keep_value('translations'));
  delete from public.ai_suggestions where created_at < now() - make_interval(days => public.keep_value('suggestions'));
$$);

-- One-click runs that used the free AI: they're "quick" runs now.
alter table public.connect_jobs drop constraint if exists connect_jobs_ai_check;
update public.connect_jobs set ai = 'quick' where ai = 'free';
alter table public.connect_jobs add constraint connect_jobs_ai_check check (ai in ('strong', 'quick'));

-- ---------- settings: Anthropic only, models live in ai_features ----------
alter table public.ai_settings drop constraint if exists ai_settings_check;
update public.ai_settings set provider = 'anthropic', base_url = '' where id = 1 and provider <> 'anthropic';
alter table public.ai_settings
  drop column model,
  drop column input_price,
  drop column output_price,
  drop column thinking,
  drop column free_enabled,
  drop column free_base_url,
  drop column free_model,
  drop column free_thinking,
  drop column connect_free_steps,
  drop column quick_code_ai,
  alter column provider set default 'anthropic',
  drop constraint if exists ai_settings_provider_check,
  add constraint ai_settings_provider_check check (provider = 'anthropic');

-- What the privacy policy names: Anthropic, while the AI is on.
create or replace function public.ai_hosts(s public.ai_settings) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct h order by h), '{}') from (
    select case when s.base_url = '' then 'api.anthropic.com' else public.url_host(s.base_url) end as h
      where s.enabled
  ) x where h is not null
$$;
revoke execute on function public.ai_hosts(public.ai_settings) from public, anon, authenticated;

-- ---------- usage ----------
alter table public.ai_usage drop constraint if exists ai_usage_feature_check;
alter table public.ai_usage add constraint ai_usage_feature_check check (feature in (
  'translate', 'similar', 'suggest', 'help', 'learn', 'release', 'describe', 'summary',
  'connect', 'connect_steps', 'connect_quick', 'test'));

-- Features players may use; the others need a developer (or an admin).
create function public.ai_for_players(p_feature text) returns boolean
language sql immutable set search_path = '' as $$
  select p_feature in ('translate', 'similar', 'suggest', 'help')
$$;

-- Reserves the highest possible cost of one AI call, or raises ai_disabled, ai_off (no model for
-- the feature), not_allowed, rate_limited, cap_reached or quota_reached. Returns the reservation
-- id and how to call the AI. "test" (admins) tries the model of p_test_feature. Server only.
drop function if exists public.ai_reserve(uuid, text, uuid, integer, integer);
create function public.ai_reserve(
  p_user uuid, p_feature text, p_job uuid, p_input_tokens integer, p_max_output_tokens integer, p_test_feature text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.ai_settings;
  f public.ai_features;
  v_role public.user_role;
  v_cost numeric;
  v_month timestamptz := public.ai_month_start();
  v_all numeric;
  v_mine numeric;
  v_quota numeric;
  v_limit integer;
  v_calls integer;
  v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('toki.ai_budget', 0));
  select * into s from public.ai_settings where id = 1;
  if not s.enabled then
    raise exception 'ai_disabled' using errcode = 'P0001';
  end if;
  select role into v_role from public.profiles where id = p_user;
  if v_role is null
     or p_feature is null
     or (p_feature = 'test' and v_role <> 'admin')
     or (v_role = 'player' and not public.ai_for_players(p_feature)) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  select * into f from public.ai_features where feature = case when p_feature = 'test' then p_test_feature else p_feature end;
  if f.feature is null or f.model = '' then
    raise exception 'ai_off' using errcode = 'P0001';
  end if;

  -- Calls per hour (not for tests).
  if p_feature <> 'test' then
    v_limit := public.limit_of(p_user, 'ai_' || case when p_feature like 'connect%' then 'connect' else p_feature end);
    insert into public.ai_free_limits as l (user_id, feature, window_start, calls)
      values (p_user, p_feature, now(), 1)
      on conflict (user_id, feature) do update
        set calls = case when l.window_start < now() - interval '1 hour' then 1 else l.calls + 1 end,
            window_start = case when l.window_start < now() - interval '1 hour' then now() else l.window_start end
      returning calls into v_calls;
    if v_limit is not null and v_calls > v_limit then
      raise exception 'rate_limited' using errcode = 'P0001';
    end if;
  end if;

  v_cost := (greatest(p_input_tokens, 0)::numeric * f.input_price + greatest(p_max_output_tokens, 0)::numeric * f.output_price) / 1000000;
  select coalesce(sum(cost), 0) into v_all from public.ai_usage where created_at >= v_month;
  if v_all + v_cost > s.monthly_cap then
    raise exception 'cap_reached' using errcode = 'P0001';
  end if;
  -- Developers have a monthly quota; players only the calls per hour (and Toki's cap).
  if v_role = 'creator' then
    v_quota := coalesce((select monthly_usd from public.ai_quotas where user_id = p_user), s.default_quota);
    select coalesce(sum(cost), 0) into v_mine from public.ai_usage where user_id = p_user and created_at >= v_month;
    if v_mine + v_cost > v_quota then
      raise exception 'quota_reached' using errcode = 'P0001';
    end if;
  end if;

  insert into public.ai_usage (user_id, feature, job_id, model, input_price, output_price, cost)
    values (p_user, p_feature, p_job, f.model, f.input_price, f.output_price, v_cost)
    returning id into v_id;
  return jsonb_build_object('id', v_id, 'provider', 'anthropic', 'base_url', s.base_url, 'model', f.model,
                            'thinking', f.thinking, 'max_cost', v_cost);
end $$;
revoke execute on function public.ai_reserve(uuid, text, uuid, integer, integer, text) from public, anon, authenticated;
grant execute on function public.ai_reserve(uuid, text, uuid, integer, integer, text) to service_role;

-- Which features are on (for everyone, so buttons only show when they work): "features" lists
-- them; "free" (any small helper) and "strong" (Toki Connect) stay for older pages.
create or replace function public.ai_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select jsonb_build_object(
      'features', coalesce(jsonb_agg(f.feature order by f.feature) filter (where f.feature is not null), '[]'::jsonb),
      'free', coalesce(bool_or(f.feature not like 'connect%'), false),
      'strong', coalesce(bool_or(f.feature = 'connect'), false))
    from public.ai_settings s
    left join public.ai_features f on s.enabled and f.model <> ''
    where s.id = 1
  ), '{"features": [], "free": false, "strong": false}'::jsonb)
$$;
revoke execute on function public.ai_status() from public;
grant execute on function public.ai_status() to anon, authenticated;
