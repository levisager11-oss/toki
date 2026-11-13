-- Polishing the AI features:
--
-- 1. "Learn from GitHub" (the guide for "Ask AI") runs as an Anthropic Message Batch, at half the
--    price: the batch's id and its reservation in ai_usage are kept on the game's row until the
--    guide is collected (when the developer or a player comes back). One row per game, as before.
-- 2. A new AI feature, "moderate": on /reports, admins can ask the AI for a first look at open
--    reports (remove / keep / unsure, with a short reason). An admin always decides. The answer is
--    kept on the report itself (one row, overwritten), so asking again costs nothing; reports are
--    deleted on their schedule as before. Off until an admin picks a model for it.

-- ---------- 1. learning as a batch ----------
alter table public.game_help
  add column learn_batch text check (learn_batch is null or char_length(learn_batch) <= 100),
  add column learn_usage bigint,
  add column learn_started_at timestamptz,
  -- why the last learning didn't work out (an error code), until the next one
  add column learn_error text check (learn_error is null or char_length(learn_error) <= 60);

-- ---------- 2. the "moderate" feature ----------
alter table public.ai_features drop constraint ai_features_feature_check;
alter table public.ai_features add constraint ai_features_feature_check check (feature in (
  'translate', 'similar', 'suggest', 'help', 'learn', 'release', 'describe', 'summary',
  'connect', 'connect_steps', 'connect_quick', 'moderate'));
insert into public.ai_features (feature, model, input_price, output_price, thinking)
  values ('moderate', '', 0, 0, 'low')
  on conflict (feature) do nothing;

alter table public.ai_usage drop constraint ai_usage_feature_check;
alter table public.ai_usage add constraint ai_usage_feature_check check (feature in (
  'translate', 'similar', 'suggest', 'help', 'learn', 'release', 'describe', 'summary',
  'connect', 'connect_steps', 'connect_quick', 'moderate', 'test'));

-- Calls per hour (admins have no limit; the row is needed for the feature to be reserved).
insert into public.limits (key, who, player, creator, min_value, max_value, sort)
  values ('ai_moderate', 'creator', 30, 30, 0, 10000, 69)
  on conflict (key) do nothing;

-- The AI's first look at a report.
alter table public.message_reports
  add column ai_verdict text check (ai_verdict is null or ai_verdict in ('remove', 'keep', 'unsure')),
  add column ai_reason text check (ai_reason is null or char_length(ai_reason) <= 300),
  add column ai_checked_at timestamptz;
alter table public.content_reports
  add column ai_verdict text check (ai_verdict is null or ai_verdict in ('remove', 'keep', 'unsure')),
  add column ai_reason text check (ai_reason is null or char_length(ai_reason) <= 300),
  add column ai_checked_at timestamptz;
