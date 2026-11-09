-- Fixes from a review of the AI features:
-- - The free AI can have its own key (free_ai_api_key), so the strong AI's key is never sent to a
--   different endpoint.
-- - Reservations that were never settled (a run that crashed or was left behind) don't stay
--   "reserved" for ever: after a day they count as failed, at the amount that was reserved.
alter table public.server_secrets drop constraint server_secrets_name_check;
alter table public.server_secrets add constraint server_secrets_name_check
  check (name in ('ai_api_key', 'anthropic_api_key', 'free_ai_api_key', 'github_app'));

select cron.schedule('settle-old-ai-reservations', '47 3 * * *', $$
  update public.ai_usage set status = 'failed', settled_at = now(), error = coalesce(error, 'never settled')
    where status = 'reserved' and created_at < now() - interval '1 day';
$$);
