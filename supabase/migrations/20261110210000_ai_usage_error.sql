-- Why an AI call failed, in the AI service's own words: admins see it in the list of calls.
alter table public.ai_usage add column error text check (error is null or char_length(error) <= 500);
