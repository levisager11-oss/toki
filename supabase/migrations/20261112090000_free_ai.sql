-- Two AI slots: the "free AI" (an OpenAI-compatible endpoint where tokens cost nothing, e.g. a
-- school's) for small, frequent tasks, next to the existing settings, which become the "strong
-- AI" with prices, quotas and the monthly cap (Toki Connect, bug fixes).
--
-- The free AI has no prices. Instead, each account may only make so many free calls an hour per
-- feature (ai_free_take), so nobody can flood the endpoint, and calls are counted per day and
-- feature (one row each, overwritten) for the admin page.

-- ---------- settings ----------
alter table public.ai_settings
  add column free_enabled boolean not null default false,
  add column free_base_url text not null default ''
    check (free_base_url = '' or (free_base_url ~ '^https://[^\s]+$' and char_length(free_base_url) <= 300)),
  add column free_model text not null default '' check (char_length(free_model) <= 100),
  -- Toki Connect lets the free AI do the easy steps (reading files, asking the developer), and
  -- only the step that writes code uses the strong AI.
  add column connect_free_steps boolean not null default true,
  add constraint ai_settings_free_check check (not free_enabled or (free_base_url <> '' and free_model <> ''));
grant update (free_enabled, free_base_url, free_model, connect_free_steps) on public.ai_settings to authenticated;

-- An OpenAI-compatible endpoint that is set up already becomes the free AI as well.
update public.ai_settings
  set free_base_url = base_url, free_model = model, free_enabled = enabled
  where provider = 'openai_compatible' and base_url <> '' and model <> '';

-- Whether the free AI features are on, for the pages (to show their buttons). Anyone may ask.
create function public.ai_free_on() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select free_enabled from public.ai_settings where id = 1), false)
$$;
revoke execute on function public.ai_free_on() from public;
grant execute on function public.ai_free_on() to anon, authenticated;

-- ---------- limits per account ----------
create table public.ai_free_limits (
  user_id uuid not null references public.profiles(id) on delete cascade,
  feature text not null check (char_length(feature) <= 20),
  window_start timestamptz not null default now(),
  calls integer not null default 0 check (calls >= 0),
  primary key (user_id, feature)
);
alter table public.ai_free_limits enable row level security;
revoke all on public.ai_free_limits from anon, authenticated;

-- Takes one free call for an account, or raises free_off, not_allowed or rate_limited.
-- Features for developers (release notes, game descriptions, summaries) need a developer;
-- "test" needs an admin. Server only.
create function public.ai_free_take(p_user uuid, p_feature text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.user_role;
  v_limit integer;
  v_calls integer;
begin
  if not public.ai_free_on() then
    raise exception 'free_off' using errcode = 'P0001';
  end if;
  select role into v_role from public.profiles where id = p_user;
  v_limit := case p_feature
    when 'translate' then 120
    when 'similar' then 30
    when 'suggest' then 10
    when 'release' then 30
    when 'describe' then 30
    when 'summary' then 30
    when 'connect' then 60
    when 'test' then 30
  end;
  if v_role is null or v_limit is null
     or (p_feature in ('release', 'describe', 'summary', 'connect') and v_role = 'player')
     or (p_feature = 'test' and v_role <> 'admin') then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;
  insert into public.ai_free_limits as l (user_id, feature, window_start, calls)
    values (p_user, p_feature, now(), 1)
    on conflict (user_id, feature) do update
      set calls = case when l.window_start < now() - interval '1 hour' then 1 else l.calls + 1 end,
          window_start = case when l.window_start < now() - interval '1 hour' then now() else l.window_start end
    returning calls into v_calls;
  if v_calls > v_limit then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
end $$;

-- ---------- calls per day ----------
create table public.ai_free_usage (
  day date not null default ((now() at time zone 'utc')::date),
  feature text not null check (char_length(feature) <= 20),
  calls integer not null default 0 check (calls >= 0),
  failed integer not null default 0 check (failed >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  primary key (day, feature)
);
alter table public.ai_free_usage enable row level security;
create policy "ai free usage: admins read" on public.ai_free_usage for select to authenticated
  using ((select public.my_role()) = 'admin');
revoke all on public.ai_free_usage from anon, authenticated;
grant select on public.ai_free_usage to authenticated;

-- Counts one free call. Server only.
create function public.ai_free_record(p_feature text, p_ok boolean, p_input_tokens integer, p_output_tokens integer) returns void
language sql security definer set search_path = '' as $$
  insert into public.ai_free_usage as u (day, feature, calls, failed, input_tokens, output_tokens)
    values ((now() at time zone 'utc')::date, left(p_feature, 20), 1, case when p_ok then 0 else 1 end,
            greatest(p_input_tokens, 0), greatest(p_output_tokens, 0))
    on conflict (day, feature) do update
      set calls = u.calls + 1,
          failed = u.failed + excluded.failed,
          input_tokens = u.input_tokens + excluded.input_tokens,
          output_tokens = u.output_tokens + excluded.output_tokens
$$;

-- ---------- saved answers (server only) ----------
-- Translations, so the same text is translated once. "ref" is the post's, reply's, message's
-- or game's id; "hash" is the source text's, so an edited text is translated again.
create table public.ai_translations (
  kind text not null check (kind in ('post', 'reply', 'message', 'game')),
  ref text not null check (char_length(ref) <= 40),
  lang text not null check (lang in ('en', 'de')),
  hash text not null check (char_length(hash) <= 64),
  text text not null check (char_length(text) <= 9000),
  created_at timestamptz not null default now(),
  primary key (kind, ref, lang)
);
alter table public.ai_translations enable row level security;
revoke all on public.ai_translations from anon, authenticated;

-- "You might like" games for an account, one row each, made again once a day at most.
create table public.ai_suggestions (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  lang text not null check (lang in ('en', 'de')),
  -- what the suggestions were based on (liked and played games), to notice changes
  basis text not null check (char_length(basis) <= 64),
  games jsonb not null check (jsonb_typeof(games) = 'array' and pg_column_size(games) <= 4000),
  created_at timestamptz not null default now()
);
alter table public.ai_suggestions enable row level security;
revoke all on public.ai_suggestions from anon, authenticated;

-- ---------- "Fix this bug" (Toki Connect with the strong AI) ----------
alter table public.connect_jobs drop constraint connect_jobs_features_check;
alter table public.connect_jobs add constraint connect_jobs_features_check check (
  (cardinality(features) between 1 and 2 and features <@ array['saves', 'scores'])
  or features = array['fix']);
alter table public.connect_jobs
  add column feedback_id uuid references public.feedback_posts(id) on delete set null;
create index connect_jobs_feedback_idx on public.connect_jobs(feedback_id) where feedback_id is not null;
grant select (feedback_id) on public.connect_jobs to authenticated;

-- ---------- cleanup (free plan) ----------
select cron.schedule('delete-old-free-ai', '37 3 * * *', $$
  delete from public.ai_free_limits where window_start < now() - interval '1 day';
  delete from public.ai_free_usage where day < (now() at time zone 'utc')::date - 60;
  delete from public.ai_translations where created_at < now() - interval '30 days';
  delete from public.ai_suggestions where created_at < now() - interval '7 days';
$$);

revoke execute on function public.ai_free_take(uuid, text) from public, anon, authenticated;
revoke execute on function public.ai_free_record(text, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.ai_free_take(uuid, text) to service_role;
grant execute on function public.ai_free_record(text, boolean, integer, integer) to service_role;
