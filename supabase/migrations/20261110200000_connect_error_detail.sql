-- What the AI service or GitHub answered when a Toki Connect run failed, so the run's page can
-- show it (the error column only holds a code for the page's own texts).
alter table public.connect_jobs add column error_detail text check (error_detail is null or char_length(error_detail) <= 500);
grant select (error_detail) on public.connect_jobs to authenticated;
