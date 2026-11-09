// Developers: connect Toki's GitHub App to their account, and list the repositories it can use.
import { githubConfigured } from "../server/env.js";
import { github, GitHubError } from "../server/github.js";
import { body, context, json } from "../server/http.js";

export async function GET(request: Request) {
  const ctx = await context(request, ["admin", "creator"]);
  if (ctx instanceof Response) return ctx;
  if (!githubConfigured(ctx.env.github)) return json({ configured: false, installUrl: null, repos: [] });
  const gh = github(ctx.env.github);
  const installUrl = `https://github.com/apps/${encodeURIComponent(ctx.env.github.slug)}/installations/new`;
  if (new URL(request.url).searchParams.get("action") !== "repos") return json({ configured: true, installUrl });

  const installs = await ctx.db.select<{ installation_id: number; account_login: string }>(
    "github_installations",
    `user_id=eq.${ctx.user.id}&select=installation_id,account_login&order=created_at`,
  );
  const repos: { installation_id: number; account: string; repo: string; private: boolean }[] = [];
  const gone: number[] = [];
  for (const i of installs) {
    try {
      for (const r of await gh.repos(i.installation_id)) repos.push({ installation_id: i.installation_id, account: i.account_login, repo: r.repo, private: r.private });
    } catch (e) {
      // The app was uninstalled on GitHub: forget the installation.
      if (e instanceof GitHubError && (e.status === 404 || e.status === 401)) gone.push(i.installation_id);
      else throw e;
    }
  }
  if (gone.length) await ctx.db.remove("github_installations", `user_id=eq.${ctx.user.id}&installation_id=in.(${gone.join(",")})`);
  return json({ configured: true, installUrl, installations: installs.filter((i) => !gone.includes(i.installation_id)), repos });
}

export async function POST(request: Request) {
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
