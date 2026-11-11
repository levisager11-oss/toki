-- Toki Connect pull requests: whether they were merged. Toki asks GitHub when the developer opens
-- "My games" (api/connect.ts, action "prs"), so "Updates for your games" knows a game is done.
-- null: not asked yet. 'open', 'merged', or 'closed' (closed without merging).
alter table public.connect_jobs
  add column pr_state text check (pr_state is null or pr_state in ('open', 'merged', 'closed'));
grant select (pr_state) on public.connect_jobs to authenticated;
