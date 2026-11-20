// Which repositories a developer may use through a connected GitHub account.
//
// An installation of the Toki app reaches every repository it was given. That is more than what
// each person who connected it may use: GitHub lists an installation for anyone who can reach
// one of its repositories (a member of an organisation, say). So when someone connects GitHub,
// Toki asks GitHub, with that person's own login, which of the installation's repositories they
// can reach, and keeps that list (github_installations.repos). On their own account it is all of
// them, also the ones made later: there the list stays empty (null).
import type { Db } from "./db.js";

export interface Connection {
  installation_id: number;
  /** null: every repository the installation reaches (their own account, or a connection from before Toki kept the list) */
  repos: string[] | null;
}

/** Whether this connection lets its developer use the repository ("owner/name"; GitHub ignores case). */
export function allows(c: Pick<Connection, "repos"> | null | undefined, repo: string): boolean {
  if (!c) return false;
  if (c.repos === null || c.repos === undefined) return true;
  const want = repo.toLowerCase();
  return c.repos.some((r) => r.toLowerCase() === want);
}

/** The developer's connections. */
export async function connections(db: Db, userId: string): Promise<Connection[]> {
  const rows = await db.select<{ installation_id: number; repos: string[] | null }>("github_installations", `user_id=eq.${userId}&select=installation_id,repos`);
  return rows.map((r) => ({ installation_id: Number(r.installation_id), repos: r.repos ?? null }));
}

/** Whether the developer may use this repository through this installation. */
export async function mayUseRepo(db: Db, userId: string, installation: unknown, repo: string): Promise<boolean> {
  if (typeof installation !== "number" || !Number.isSafeInteger(installation)) return false;
  const [row] = await db.select<{ installation_id: number; repos: string[] | null }>(
    "github_installations",
    `user_id=eq.${userId}&installation_id=eq.${installation}&select=installation_id,repos`,
  );
  return allows(row ? { repos: row.repos ?? null } : null, repo);
}
