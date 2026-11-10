-- Games whose repository holds their source, which must be built first (Vite and the like):
-- GitHub Actions builds them on every push and puts the result on Toki. The repository gets one
-- small file, .github/workflows/toki.yml (Toki opens a pull request for it). The build itself
-- runs Toki's upload script (public/toki-upload.mjs --build), so it can get better without
-- changing anyone's repository. The upload proves where it comes from with GitHub's own signed
-- token for the run (OIDC: repository and branch), so no key has to be copied anywhere: only a
-- game that follows that repository and branch here accepts it (server/actionsAuth.ts).
--
-- * game_git.build: 'none' = Toki takes the files from the repository as they are (as before);
--   'action' = GitHub Actions builds the game and uploads it, so push events are left alone.
-- * game_git.build_pr: the pull request that adds the build file, or GitHub's page for adding
--   it by hand (when the Toki app may not change workflow files).

alter table public.game_git
  add column build text not null default 'none' check (build in ('none', 'action')),
  add column build_pr text check (build_pr is null or (build_pr ~ '^https://github\.com/' and char_length(build_pr) <= 8000));
