-- Secrets for the AI and GitHub that admins set up on Toki itself (instead of in Vercel's
-- settings): the AI endpoint's key and the Toki GitHub App's credentials.
-- The server encrypts them before storing (AES-256-GCM, with a key derived from the Supabase
-- secret key, which only the server has), and nobody but the server (service role) can read the
-- table. Environment variables in Vercel, if set, still win over these.
create table public.server_secrets (
  name text primary key check (name in ('ai_api_key', 'github_app')),
  value text not null check (char_length(value) <= 20000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
alter table public.server_secrets enable row level security;
-- No policies: visitors and accounts can't read or write it at all.
revoke all on public.server_secrets from anon, authenticated;
