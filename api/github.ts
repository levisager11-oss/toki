// Developers: connect Toki's GitHub App to their account, and list the repositories it can use.
// GitHub: push events of the app (games that follow a repository update by themselves).
import { waitUntil } from "@vercel/functions";
import { serviceDb } from "../server/db.js";
import { githubConfigured, serverEnv } from "../server/env.js";
import { deployCommit, gamesForPush, validSignature, type PushEvent } from "../server/gitDeploy.js";
import { github, GitHubError } from "../server/github.js";
import { hostingDeps, r2Config } from "../server/hosting.js";
import { body, context, json } from "../server/http.js";
import { withSecrets } from "../server/secrets.js";

export async function GET(request: Request) {
  const ctx = await context(request, ["admin", "creator"]);
  if (ctx instanceof Response) return ctx;
  if (!githubConfigured(ctx.env.github)) return json({ configured: false, installUrl: null, repos: [] });
  const gh = github(ctx.env.github);
  const installUrl = `https://github.com/apps/${encodeURIComponent(ctx.env.github.slug)}/installations/new`;
  // "Connect GitHub" goes to GitHub's login page: unlike the install page, it always comes back
  // to Toki, also when the app is installed already (src/lib/ai.ts).
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(ctx.env.github.clientId)}`;
  if (new URL(request.url).searchParams.get("action") !== "repos") return json({ configured: true, installUrl, authUrl });

  const installs = await ctx.db.select<{ installation_id: number; account_login: string }>(
    "github_installations",
    `user_id=eq.${ctx.user.id}&select=installation_id,account_login&order=created_at`,
  );
  const repos: { installation_id: number; account: string; repo: string; private: boolean }[] = [];
  const gone: number[] = [];
  let unreachable = false;
  await Promise.all(
    installs.map(async (i) => {
      try {
        for (const r of await gh.repos(i.installation_id)) repos.push({ installation_id: i.installation_id, account: i.account_login, repo: r.repo, private: r.private });
      } catch (e) {
        // The app was uninstalled on GitHub: forget the installation.
        if (e instanceof GitHubError && (e.status === 404 || e.status === 401)) gone.push(i.installation_id);
        // GitHub hiccuped for this account: the others still show.
        else unreachable = true;
      }
    }),
  );
  if (gone.length) await ctx.db.remove("github_installations", `user_id=eq.${ctx.user.id}&installation_id=in.(${gone.join(",")})`);
  repos.sort((a, b) => a.repo.localeCompare(b.repo));
  return json({ configured: true, installUrl, authUrl, installations: installs.filter((i) => !gone.includes(i.installation_id)), repos, unreachable });
}

/** A push to a repository: games that follow its branch get the new version (in the background). */
async function webhook(request: Request, event: string): Promise<Response> {
  const raw = await request.text();
  const base = serverEnv();
  if (!base.serviceKey) return json({ error: "not_configured" }, 503);
  const db = serviceDb(base.serviceKey);
  const { env } = await withSecrets(db, base);
  if (!validSignature(env.github.webhookSecret ?? "", raw, request.headers.get("x-hub-signature-256"))) return json({ error: "bad_signature" }, 401);
  if (event !== "push") return json({ ok: true, ignored: event });
  let ev: PushEvent;
  try {
    ev = JSON.parse(raw) as PushEvent;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const hit = await gamesForPush(db, ev);
  if (!hit) return json({ ok: true, games: 0 });
  const { config } = await r2Config(db, base.serviceKey);
  if (!config) return json({ ok: true, games: 0, hosting: "off" });
  const gh = github(env.github);
  const deps = hostingDeps(db, config);
  // GitHub waits only 10 seconds for an answer: answer now, deploy after.
  waitUntil(Promise.all(hit.rows.map((row) => deployCommit(deps, gh, row, hit.commit))));
  return json({ ok: true, games: hit.rows.length }, 202);
}

export async function POST(request: Request) {
  const event = request.headers.get("x-github-event");
  if (event) return webhook(request, event);
  const ctx = await context(request, ["admin", "creator"]);
  if (ctx instanceof Response) return ctx;
  if (!githubConfigured(ctx.env.github)) return json({ error: "not_configured" }, 503);
  const b = await body(request);
  if (b.action !== "connect" || typeof b.code !== "string" || !/^[\w-]{1,100}$/.test(b.code)) return json({ error: "bad_request" }, 400);
  try {
    // GitHub tells us, with the person's own GitHub login, which installations they can use.
    const installs = await github(ctx.env.github).userInstallations(b.code);
    await ctx.db.remove("github_installations", `user_id=eq.${ctx.user.id}`);
    if (installs.length)
      await ctx.db.insert("github_installations", installs.map((i) => ({ user_id: ctx.user.id, installation_id: i.id, account_login: i.account.slice(0, 100) })), "return=minimal");
    return json({ installations: installs.map((i) => ({ installation_id: i.id, account_login: i.account })) });
  } catch (e) {
    return json({ error: e instanceof GitHubError ? "github_error" : "error" }, 502);
  }
}
