-- Reservations of the AI that were never settled (a function that was stopped in the middle of a
-- call) counted against the quotas for up to two days. A single call lasts five minutes at most,
-- so after half an hour one that is still open is counted as failed, at what it reserved. A
-- Toki Connect agent run (feature 'connect' with a job) reserves once for a run that can take
-- much longer, so it keeps a day. Checked every 15 minutes.
select cron.schedule('settle-old-ai-reservations', '*/15 * * * *', $$
  update public.ai_usage set status = 'failed', settled_at = now(), error = coalesce(error, 'never settled')
    where status = 'reserved'
      and created_at < now() - case when feature = 'connect' and job_id is not null then interval '1 day' else interval '30 minutes' end;
$$);
