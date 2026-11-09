-- Free plan: two logs that grew forever now get cleaned up every night.
--  * Toki Connect runs that ended (done or failed) more than 90 days ago.
--  * AI cost rows older than 400 days (the AI page only shows this month and the last runs).
--    Rows still waiting to be settled are kept.

create or replace function public.cleanup_old_logs()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.connect_jobs
    where status in ('done', 'failed') and updated_at < now() - interval '90 days';
  delete from public.ai_usage
    where status <> 'reserved' and created_at < now() - interval '400 days';
$$;

revoke execute on function public.cleanup_old_logs() from public, anon, authenticated;

select cron.schedule('delete-old-logs', '11 4 * * *', $$ select public.cleanup_old_logs(); $$);
