-- The repositories a developer may use through a connected GitHub account.
--
-- An installation of the Toki app reaches every repository it was given, but GitHub lists it
-- for everyone who can reach one of them (members of an organisation, say). Toki allowed all
-- of the installation's repositories to each of them: reading a private repository they can't
-- see on GitHub, or putting it online as a game. Now Toki keeps, per connection, what GitHub
-- says that person can reach (asked with their own GitHub login when they connect).
-- null: all of them (the person's own account, or a connection made before this; those get
-- their list the next time the developer connects GitHub).
alter table public.github_installations
  add column repos text[] check (repos is null or cardinality(repos) <= 2000);
