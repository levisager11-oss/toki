-- How many tokens the strong AI may write per Toki Connect step (thinking included), set by the
-- admin. Only what the model really writes costs money; the limit stops a model that thinks too
-- long, and is what each call reserves of the budget.
alter table public.ai_settings
  add column max_output_tokens integer not null default 32000
    check (max_output_tokens in (8000, 16000, 32000, 64000, 128000));
grant update (max_output_tokens) on public.ai_settings to authenticated;
