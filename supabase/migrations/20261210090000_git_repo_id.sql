-- Uploads from GitHub Actions are tied to the repository itself, not only to its name.
--
-- A run proves which repository it belongs to with a token GitHub signs; Toki looked up the
-- game by the repository's name in it. Names can be taken again: after a developer renames or
-- deletes their GitHub account, someone else could register the old name, make a repository
-- called the same, and upload to the game. GitHub's number for a repository never changes and
-- is never given out twice. Toki remembers it from the first upload (and forgets it when the
-- game is pointed at another repository); later uploads must carry the same number.
alter table public.game_git add column repo_id bigint;
