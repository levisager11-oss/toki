-- Anthropic as a second AI provider, next to OpenAI-compatible endpoints.
-- With Anthropic the endpoint address is optional (empty: the official API), and its key is
-- stored separately, so switching providers doesn't need the other key again.
alter table public.ai_settings drop constraint ai_settings_provider_check;
alter table public.ai_settings add constraint ai_settings_provider_check check (provider in ('openai_compatible', 'anthropic'));
alter table public.ai_settings drop constraint ai_settings_check;
alter table public.ai_settings add constraint ai_settings_check
  check (not enabled or ((provider = 'anthropic' or base_url <> '') and model <> '' and input_price > 0 and output_price > 0));
grant update (provider) on public.ai_settings to authenticated;

alter table public.server_secrets drop constraint server_secrets_name_check;
alter table public.server_secrets add constraint server_secrets_name_check check (name in ('ai_api_key', 'anthropic_api_key', 'github_app'));
