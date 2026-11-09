-- Toki Connect with Claude Managed Agents (needs the strong AI on Anthropic): instead of Toki
-- sending files to the AI step by step, an agent works in its own copy of the repository on
-- Anthropic's servers (it can read everything, run the build or tests), then hands its changes
-- back; Toki checks them and opens the pull request as before.
--
-- Off by default. Every run has a hard dollar cap (agent_budget), enforced by Anthropic, and the
-- same amount is reserved from the developer's quota and Toki's monthly cap before it starts.
alter table public.ai_settings
  add column agent_enabled boolean not null default false,
  add column agent_budget numeric(10, 2) not null default 1.00 check (agent_budget between 0.10 and 50),
  -- set by the server: the agent and environment it created once, and which settings they have
  add column agent_id text check (agent_id is null or char_length(agent_id) <= 100),
  add column agent_version integer,
  add column agent_config text check (agent_config is null or char_length(agent_config) <= 64),
  add column environment_id text check (environment_id is null or char_length(environment_id) <= 100),
  add constraint ai_settings_agent_check check (not agent_enabled or provider = 'anthropic');
grant update (agent_enabled, agent_budget) on public.ai_settings to authenticated;

-- Which way a run works: "steps" (Toki sends files to the AI) or "agent" (Managed Agents).
alter table public.connect_jobs
  add column engine text not null default 'steps' check (engine in ('steps', 'agent'));
grant select (engine) on public.connect_jobs to authenticated;

-- Replaces a reservation with a cost in dollars (an agent run reports its cost, not tokens).
-- Returns that cost. Server only.
create function public.ai_settle_amount(p_id bigint, p_cost numeric, p_ok boolean)
returns numeric
language sql security definer set search_path = '' as $$
  update public.ai_usage
    set cost = greatest(coalesce(p_cost, 0), 0),
        status = case when p_ok then 'done' else 'failed' end,
        settled_at = now()
    where id = p_id and status = 'reserved'
    returning cost
$$;
revoke execute on function public.ai_settle_amount(bigint, numeric, boolean) from public, anon, authenticated;
grant execute on function public.ai_settle_amount(bigint, numeric, boolean) to service_role;
