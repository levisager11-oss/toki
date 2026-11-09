-- Thinking levels: "xhigh" and "max" for the free AI too, and a thinking level for the strong AI
-- (Anthropic: sent as output_config.effort; "off" counts as "low" there, since the newest Claude
-- models can't turn thinking off). ai_reserve now also returns the strong AI's level.
alter table public.ai_settings drop constraint ai_settings_free_thinking_check;
alter table public.ai_settings add constraint ai_settings_free_thinking_check
  check (free_thinking in ('default', 'off', 'low', 'medium', 'high', 'xhigh', 'max'));
alter table public.ai_settings
  add column thinking text not null default 'default'
    check (thinking in ('default', 'off', 'low', 'medium', 'high', 'xhigh', 'max'));
grant update (thinking) on public.ai_settings to authenticated;

create or replace function public.ai_reserve(p_user uuid, p_feature text, p_job uuid, p_input_tokens integer, p_max_output_tokens integer)
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
  return jsonb_build_object('id', v_id, 'provider', s.provider, 'base_url', s.base_url, 'model', s.model, 'thinking', s.thinking, 'max_cost', v_cost);
end $$;
revoke execute on function public.ai_reserve(uuid, text, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.ai_reserve(uuid, text, uuid, integer, integer) to service_role;
