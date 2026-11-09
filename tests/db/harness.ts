// A real Postgres (PGlite, Postgres compiled to WebAssembly) with Toki's schema and migrations,
// so tests can check the row level security rules as each kind of user.
// Supabase's own parts the schema relies on (auth.users, auth.uid(), the API roles, storage,
// pg_cron) are replaced by small stand-ins that behave the same for these tests.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(import.meta.dirname, "..", "..");

const SUPABASE_STANDINS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated;
create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}',
  email_confirmed_at timestamptz
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:greatest(cardinality(string_to_array(name, '/')) - 1, 0)]
$$;

create schema cron;
create function cron.schedule(job text, sched text, command text) returns bigint language sql as $$ select 1::bigint $$;
`;

/** Every database change, in the order they were applied. */
function migrations(): string[] {
  // pg_cron isn't available here; cron.schedule above stands in for it.
  const schema = readFileSync(join(ROOT, "supabase", "schema.sql"), "utf8").replace(/create extension if not exists pg_cron;/g, "");
  const dir = join(ROOT, "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  return [schema, ...files.map((f) => readFileSync(join(dir, f), "utf8"))];
}

export type Who = { id: string } | null;

export interface TestDb {
  db: PGlite;
  /** Runs SQL as a logged-in account, or as a visitor (null). Returns the rows. */
  as<T = Record<string, unknown>>(who: Who, sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs SQL with full rights, like the SQL editor. */
  admin<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Creates an account with a profile. */
  user(role?: "player" | "creator" | "admin"): Promise<{ id: string; username: string }>;
  /** Creates a game owned by this account. */
  game(owner: { id: string }): Promise<{ id: string; slug: string }>;
}

let n = 0;

export async function testDb(): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(SUPABASE_STANDINS);
  for (const sql of migrations()) await db.exec(sql);

  const admin = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const as = async <T>(who: Who, sql: string, params: unknown[] = []) => {
    await db.exec(`set role ${who ? "authenticated" : "anon"}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [who?.id ?? ""]);
    try {
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub', '', false)");
    }
  };

  return {
    db,
    as,
    admin,
    async user(role = "player") {
      const id = crypto.randomUUID();
      const username = `user_${++n}`;
      await admin("insert into auth.users (id, raw_user_meta_data) values ($1, $2)", [id, { username }]);
      if (role !== "player") await admin("update public.profiles set role = $2 where id = $1", [id, role]);
      return { id, username };
    },
    async game(owner) {
      const slug = `game-${++n}`;
      const [g] = await admin<{ id: string }>(
        "insert into public.games (slug, title, category, play_url, created_by) values ($1, $1, 'arcade', 'https://example.com', $2) returning id",
        [slug, owner.id],
      );
      return { id: g.id, slug };
    },
  };
}
