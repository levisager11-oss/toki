// Which repositories a developer may use through a connected GitHub account (server/githubAccess.ts).
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { github } from "../server/github";
import { allows, connections, mayUseRepo } from "../server/githubAccess";
import { gamesForPush } from "../server/gitDeploy";
import { findRepo } from "../server/migrate";
import type { GitHubClient } from "../server/github";
import { fakeDb } from "./fakes";

describe("a connection", () => {
  it("lets its developer use what GitHub said they can reach", () => {
    const c = { repos: ["acme/Moon-Hop", "acme/site"] };
    expect(allows(c, "acme/moon-hop")).toBe(true);
    expect(allows(c, "acme/secret-game")).toBe(false);
    expect(allows({ repos: [] }, "acme/moon-hop")).toBe(false);
    expect(allows(null, "acme/moon-hop")).toBe(false);
    // Their own account (or a connection from before the list was kept): all of it.
    expect(allows({ repos: null }, "lu/anything")).toBe(true);
  });

  it("is looked up per developer and installation", async () => {
    const db = fakeDb({
      github_installations: [
        { user_id: "member", installation_id: 7, account_login: "acme", repos: ["acme/moon-hop"] },
        { user_id: "owner", installation_id: 7, account_login: "acme", repos: null },
      ],
    });
    expect(await mayUseRepo(db, "member", 7, "acme/moon-hop")).toBe(true);
    expect(await mayUseRepo(db, "member", 7, "acme/secret-game")).toBe(false);
    expect(await mayUseRepo(db, "member", 8, "acme/moon-hop")).toBe(false);
    expect(await mayUseRepo(db, "owner", 7, "acme/secret-game")).toBe(true);
    expect(await mayUseRepo(db, "stranger", 7, "acme/moon-hop")).toBe(false);
    expect(await mayUseRepo(db, "member", "7", "acme/moon-hop")).toBe(false);
    expect(await connections(db, "member")).toEqual([{ installation_id: 7, repos: ["acme/moon-hop"] }]);
  });
});

describe("connecting GitHub", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const cfg = { appId: "1", slug: "toki", clientId: "c", clientSecret: "s", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) as string };

  it("keeps, for someone else's account, only the repositories the person can reach there", async () => {
    const asked: string[] = [];
    const answers: Record<string, unknown> = {
      "https://github.com/login/oauth/access_token": { access_token: "user-token" },
      "/user": { id: 11, login: "lu" },
      "/user/installations?per_page=100": {
        installations: [
          { id: 5, app_id: 1, account: { login: "lu", id: 11 } },
          { id: 7, app_id: 1, account: { login: "acme", id: 99 } },
          { id: 8, app_id: 2, account: { login: "other-app", id: 98 } },
        ],
      },
      "/user/installations/7/repositories?per_page=100&page=1": { total_count: 1, repositories: [{ full_name: "acme/moon-hop" }] },
    };
    const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
      const path = String(url).replace("https://api.github.com", "");
      asked.push(path);
      // Everything about the person is asked with their own login, never with the app's.
      if (path.startsWith("/user")) expect(init?.headers?.authorization).toBe("Bearer user-token");
      const body = answers[path];
      return new Response(JSON.stringify(body ?? { message: "Not Found" }), { status: body ? 200 : 404 });
    }) as unknown as typeof fetch;
    const got = await github(cfg as never, fetchImpl).userInstallations("code");
    expect(got).toEqual([
      { id: 5, account: "lu", repos: null },
      { id: 7, account: "acme", repos: ["acme/moon-hop"] },
    ]);
    expect(asked).not.toContain("/user/installations/5/repositories?per_page=100&page=1");
  });
});

describe("a push from a newer installation", () => {
  const SHA = "a".repeat(40);
  const row = { game_id: "g", installation_id: 3, repo: "acme/moon-hop", branch: "main", folder: "", created_by: "dev", build: "none" };
  const push = { ref: "refs/heads/main", after: SHA, repository: { full_name: "acme/moon-hop" }, installation: { id: 7 } };

  it("only moves a game over when its developer may use the repository there", async () => {
    const may = fakeDb({ game_git: [{ ...row }], github_installations: [{ user_id: "dev", installation_id: 7, repos: ["acme/moon-hop"] }] });
    expect((await gamesForPush(may, push))?.rows).toHaveLength(1);
    const mayNot = fakeDb({ game_git: [{ ...row }], github_installations: [{ user_id: "dev", installation_id: 7, repos: ["acme/site"] }] });
    expect(await gamesForPush(mayNot, push)).toBeNull();
  });
});

describe("guessing a game's repository", () => {
  it("never names one the developer may not use", async () => {
    const gh = { repos: async () => [{ repo: "acme/moon-hop", private: true, defaultBranch: "main" }], repo: async () => ({ branches: async () => ["main"], tree: async () => [{ path: "index.html", type: "blob" }], read: async () => "<html><canvas></canvas></html>" }) } as unknown as GitHubClient;
    const game = { play_url: "https://acme.github.io/moon-hop/", slug: "moon-hop" };
    const open = await findRepo(gh, [7], game);
    const closed = await findRepo(gh, [7], game, null, () => false);
    expect(open).toMatchObject({ reached: true });
    // The name still comes from the game's address; nothing of the repository itself is read.
    expect(closed).toMatchObject({ found: null, reached: false, candidates: [] });
  });
});
