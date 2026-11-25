-- Reservations of the AI that were never settled (a run that was killed in the middle of a call)
-- counted against the quotas for up to two days. A call lasts five minutes at most, so after
-- half an hour a reservation that is still open is counted as failed. Checked every 15 minutes.
select cron.schedule('settle-old-ai-reservations', '*/15 * * * *', $$
  update public.ai_usage set status = 'failed', settled_at = now(), error = coalesce(error, 'never settled')
    where status = 'reserved' and created_at < now() - interval '30 minutes';
$$);
