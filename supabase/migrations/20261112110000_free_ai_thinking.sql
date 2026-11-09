-- How much the free AI may think before answering: "default" (the model decides), "off"
-- (fastest), "low", "medium" or "high". Less thinking answers faster, so long tasks (learning a
-- game from GitHub) finish in time. Endpoints that don't support it ignore it.
alter table public.ai_settings
  add column free_thinking text not null default 'default'
    check (free_thinking in ('default', 'off', 'low', 'medium', 'high'));
grant update (free_thinking) on public.ai_settings to authenticated;
