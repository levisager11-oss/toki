// Games whose repository holds their source: GitHub Actions builds them and uploads without a key
// (GitHub's signed token says which repository and branch the run is for).
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIONS_AUDIENCE, ACTIONS_ISSUER, gameForAction, looksLikeJwt, verifyActionToken } from "../server/actionsAuth";
import { buildKind, buildStatus, manualBuildLink, setUpBuild } from "../server/gitBuild";
import { GitHubError } from "../server/github";
import { gamesForPush } from "../server/gitDeploy";
import { buildWorkflow } from "../src/lib/hostingRules";
import type { GitHubClient } from "../server/github";
import { fakeDb } from "./fakes";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS = { keys: [{ ...(publicKey.export({ format: "jwk" }) as object), kid: "k1", alg: "RS256", use: "sig" }] };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const NOW = Date.parse("2026-11-20T10:00:00Z");
function token(claims: Record<string, unknown>, o: { key?: KeyObject; kid?: string } = {}) {
  const head = b64({ alg: "RS256", kid: o.kid ?? "k1", typ: "JWT" });
  const body = b64({ iss: ACTIONS_ISSUER, aud: ACTIONS_AUDIENCE, exp: NOW / 1000 + 300, nbf: NOW / 1000 - 10, repository: "lu/Debt-Drifter", ref: "refs/heads/main", sha: "a".repeat(40), event_name: "push", ...claims });
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(o.key ?? privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

describe("GitHub's token for an Actions run", () => {
  const check = (t: string) => verifyActionToken(t, { jwks: JWKS, now: NOW });

  it("is accepted when GitHub signed it for Toki", async () => {
    expect(looksLikeJwt(token({}))).toBe(true);
    expect(looksLikeJwt("toki_abc")).toBe(false);
    expect(await check(token({}))).toEqual({ repository: "lu/Debt-Drifter", ref: "refs/heads/main", sha: "a".repeat(40), event_name: "push" });
  });

  it("is refused when signed by someone else, meant for another site, from elsewhere or expired", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    await expect(check(token({}, { key: other }))).rejects.toThrow(/bad signature/);
    await expect(check(token({}, { kid: "nope" }))).rejects.toThrow(/unknown key/);
    await expect(check(token({ aud: "someone-else" }))).rejects.toThrow(/not meant for Toki/);
    await expect(check(token({ iss: "https://evil.example" }))).rejects.toThrow(/not from GitHub Actions/);
    await expect(check(token({ exp: NOW / 1000 - 3600 }))).rejects.toThrow(/expired/);
    await expect(check(token({ sha: "nope" }))).rejects.toThrow(/incomplete/);
  });
});

describe("which game a run may upload to", () => {
  const db = () =>
    fakeDb({
      game_git: [
        { game_id: "g1", repo: "lu/debt-drifter", branch: "main", build: "action" },
        { game_id: "g2", repo: "lu/moon-hop", branch: "main", build: "none" },
        { game_id: "g3", repo: "lu/space_shooter", branch: "main", build: "action" },
      ],
      games: [{ id: "g1", created_by: "dev" }, { id: "g2", created_by: "dev" }, { id: "g3", created_by: "dev" }],
      profiles: [{ id: "dev", username: "lu", role: "creator" }],
    });
  const claims = (c: Partial<{ repository: string; ref: string }>) => ({ repository: "lu/Debt-Drifter", ref: "refs/heads/main", sha: "a".repeat(40), ...c });

  it("is the game that follows the run's repository and branch and is built by GitHub Actions", async () => {
    expect(await gameForAction(db(), claims({}))).toEqual({ game_id: "g1", user: { id: "dev", username: "lu", role: "creator" } });
  });

  it("is tied to the repository that first uploaded, not to whoever has its name later", async () => {
    const d = db();
    const first = claims({});
    expect(await gameForAction(d, { ...first, repository_id: "501" })).toMatchObject({ game_id: "g1" });
    // The same repository, renamed back and forth or not: still its number.
    expect(await gameForAction(d, { ...first, repository_id: "501" })).toMatchObject({ game_id: "g1" });
    // Someone registered the name again: another repository, another number.
    expect(await gameForAction(d, { ...first, repository_id: "777" })).toBeNull();
    expect(await gameForAction(d, first)).toBeNull();
  });

  it("reads the repository's number from GitHub's token", async () => {
    const check = (t: string) => verifyActionToken(t, { jwks: JWKS, now: NOW });
    expect((await check(token({ repository_id: "501" }))).repository_id).toBe("501");
    expect((await check(token({}))).repository_id).toBeUndefined();
    expect((await check(token({ repository_id: "5 or 1" }))).repository_id).toBeUndefined();
  });

  it("also finds a repository with an underscore in its name", async () => {
    expect(await gameForAction(db(), claims({ repository: "lu/space_shooter" }))).toMatchObject({ game_id: "g3" });
    // "_" stands for any character in the search, never in the answer.
    expect(await gameForAction(db(), claims({ repository: "lu/space-shooter" }))).toBeNull();
    expect(await gameForAction(db(), claims({ repository: "lu/debt_drifter" }))).toBeNull();
  });

  it("is none for other branches, pull requests, other repositories, or games Toki reads as they are", async () => {
    expect(await gameForAction(db(), claims({ ref: "refs/heads/dev" }))).toBeNull();
    expect(await gameForAction(db(), claims({ ref: "refs/pull/3/merge" }))).toBeNull();
    expect(await gameForAction(db(), claims({ repository: "evil/debt-drifter" }))).toBeNull();
    expect(await gameForAction(db(), claims({ repository: "lu/moon-hop" }))).toBeNull();
  });
});

describe("setting up the build", () => {
  const repo = (files: string[]) =>
    ({ repo: async () => ({ tree: async () => files.map((path) => ({ path, type: "blob" })) }) }) as unknown as GitHubClient;
  const row = { game_id: "g", installation_id: 7, repo: "lu/x", branch: "main" };

  it("knows what GitHub Actions can build", async () => {
    expect(await buildKind(repo(["package.json", "src/main.ts"]), row)).toEqual({ kind: "web" });
    expect(await buildKind(repo(["project.godot", "player.gd"]), row)).toEqual({ kind: "godot" });
    expect(await buildKind(repo(["project.godot", "Game.csproj"]), row)).toEqual({ cannot: "Godot C#" });
    expect(await buildKind(repo(["ProjectSettings/ProjectVersion.txt"]), row)).toEqual({ cannot: "Unity" });
    expect(await buildKind(repo(["Game.yyp"]), row)).toEqual({ cannot: "GameMaker" });
    expect(await buildKind(repo(["README.md"]), row)).toEqual({ cannot: "unknown" });
  });

  it("writes a build file that needs no key and runs Toki's script", () => {
    const yml = buildWorkflow("https://www.playtoki.app", "main");
    expect(yml).toContain('branches: ["main"]');
    expect(yml).toContain("id-token: write");
    expect(yml).toContain('node "$RUNNER_TEMP/toki-upload.mjs" --build');
    expect(yml).not.toMatch(/secrets\./);
    const link = new URL(manualBuildLink("lu/x", "main", "https://www.playtoki.app"));
    expect(link.pathname).toBe("/lu/x/new/main");
    expect(link.searchParams.get("filename")).toBe(".github/workflows/toki.yml");
    expect(link.searchParams.get("value")).toBe(yml);
  });

  it("leaves games built by GitHub Actions alone on pushes (they upload by themselves)", async () => {
    const db = fakeDb({ game_git: [
      { game_id: "a", installation_id: 7, repo: "lu/x", branch: "main", folder: "", build: "action" },
      { game_id: "b", installation_id: 7, repo: "lu/x", branch: "main", folder: "", build: "none" },
    ] });
    const hit = await gamesForPush(db, { ref: "refs/heads/main", after: "c".repeat(40), repository: { full_name: "lu/x" }, installation: { id: 7 } });
    expect(hit?.rows.map((r) => r.game_id)).toEqual(["b"]);
  });
});

describe("the upload script's --build", () => {
  const script = join(__dirname, "..", "public", "toki-upload.mjs");
  const run = (dir: string) => {
    try {
      return { ok: true, out: execFileSync("node", [script, "--build", "--dry-run"], { cwd: dir, encoding: "utf8", stdio: "pipe", env: { ...process.env, GITHUB_ACTIONS: "" } }) };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  it("takes a game that needs no building as it is", () => {
    const dir = mkdtempSync(join(tmpdir(), "toki-static-"));
    writeFileSync(join(dir, "index.html"), "<script src='game.js'></script>");
    writeFileSync(join(dir, "game.js"), "go()");
    const r = run(dir);
    expect(r.ok).toBe(true);
    expect(r.out).toContain("2 files");
  });

  it("says plainly when an engine needs its own editor to export", () => {
    const dir = mkdtempSync(join(tmpdir(), "toki-unity-"));
    mkdirSync(join(dir, "ProjectSettings"));
    writeFileSync(join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0");
    const r = run(dir);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/Unity project.*own editor/);
  });
});

describe("setting up the build", () => {
  const row = { game_id: "g1", installation_id: 7, repo: "lu/moon-hop", branch: "main" };
  const tables = () => ({ game_git: [{ game_id: "g1", repo: "lu/moon-hop", branch: "main", build: "none" } as Record<string, unknown>] });
  const db = () => fakeDb(tables());
  const ACCESS = { workflows: true, appWorkflows: true, installUrl: "https://github.com/settings/installations/7", appUrl: "https://github.com/settings/apps/toki/permissions" };
  const client = (o: { has: boolean; run?: () => Promise<void>; open?: string | null; access?: Partial<typeof ACCESS>; pr?: () => Promise<string>; latest?: unknown }) => {
    const calls: string[] = [];
    const gh = {
      buildAccess: async () => {
        calls.push("access");
        return { ...ACCESS, ...o.access };
      },
      repo: async () => ({
        has: async (path: string) => o.has && path === ".github/workflows/toki.yml",
        openPullFrom: async (prefix: string) => (o.open && prefix === "toki-build-" ? o.open : null),
        latestRun: async () => o.latest ?? null,
        runWorkflow: async (file: string, branch: string) => {
          calls.push(`run ${file} on ${branch}`);
          await o.run?.();
        },
        openPullRequest: async () => {
          calls.push("pr");
          return o.pr ? o.pr() : "https://github.com/lu/moon-hop/pull/3";
        },
      }),
    } as unknown as GitHubClient;
    return { gh, calls };
  };
  const base = { pr: null, manual: null, ready: false, started: false, blocked: null, permissionUrl: null, error: null };
  const manual = manualBuildLink("lu/moon-hop", "main", "https://www.playtoki.app");

  it("starts the first build when the build file is in the repository already", async () => {
    const { gh, calls } = client({ has: true });
    expect(await setUpBuild(db(), gh, row, "https://www.playtoki.app")).toEqual({ ...base, ready: true, started: true });
    expect(calls).toEqual(["run toki.yml on main"]);
  });

  it("leaves the first build to the developer when GitHub doesn't let the app start it", async () => {
    const { gh } = client({ has: true, run: async () => { throw new GitHubError("GitHub 403: Resource not accessible by integration", 403); } });
    expect(await setUpBuild(db(), gh, row, "https://www.playtoki.app")).toEqual({ ...base, ready: true, started: false });
  });

  it("opens a pull request with the build file when it is missing, and starts nothing", async () => {
    const { gh, calls } = client({ has: false });
    expect(await setUpBuild(db(), gh, row, "https://www.playtoki.app")).toEqual({ ...base, pr: "https://github.com/lu/moon-hop/pull/3" });
    expect(calls).toEqual(["access", "pr"]);
  });

  it("keeps the pull request that's open already instead of opening another", async () => {
    const { gh, calls } = client({ has: false, open: "https://github.com/lu/moon-hop/pull/2" });
    expect(await setUpBuild(db(), gh, row, "https://www.playtoki.app")).toEqual({ ...base, pr: "https://github.com/lu/moon-hop/pull/2" });
    expect(calls).toEqual([]);
  });

  it("asks the developer to allow workflow files on GitHub first, instead of trying", async () => {
    const { gh, calls } = client({ has: false, access: { workflows: false } });
    const tb = tables();
    expect(await setUpBuild(fakeDb(tb), gh, row, "https://www.playtoki.app")).toEqual({ ...base, manual, blocked: "install", permissionUrl: ACCESS.installUrl });
    expect(calls).toEqual(["access"]);
    expect(tb.game_git[0]).toMatchObject({ build: "action", build_pr: manual, status: "waiting", error: null });
  });

  it("says when Toki's app itself doesn't ask for workflow files yet (its admins add it)", async () => {
    const { gh } = client({ has: false, access: { workflows: false, appWorkflows: false } });
    expect(await setUpBuild(db(), gh, row, "https://www.playtoki.app")).toMatchObject({ blocked: "app", permissionUrl: ACCESS.appUrl, manual });
  });

  it("keeps GitHub's reason when it refuses the pull request", async () => {
    const { gh } = client({ has: false, pr: async () => { throw new GitHubError("GitHub 403: Resource not accessible by integration", 403); } });
    const tb = tables();
    expect(await setUpBuild(fakeDb(tb), gh, row, "https://www.playtoki.app")).toEqual({ ...base, manual, blocked: "refused", error: "GitHub 403: Resource not accessible by integration" });
    expect(tb.game_git[0].error).toBe("pr_refused: GitHub 403: Resource not accessible by integration");
  });

  it("reports how the build is doing: the file, the pull request, the permission and the newest run", async () => {
    const r = { ...row, build_pr: null };
    const origin = "https://www.playtoki.app";
    expect(await buildStatus(client({ has: false, open: "https://github.com/lu/moon-hop/pull/2" }).gh, r, origin)).toMatchObject({ file: "pr", pr: "https://github.com/lu/moon-hop/pull/2", blocked: null, run: null });
    expect(await buildStatus(client({ has: false, access: { workflows: false } }).gh, r, origin)).toMatchObject({ file: "missing", blocked: "install", permissionUrl: ACCESS.installUrl });
    const latest = (status: string, conclusion: string | null) => ({ status, conclusion, url: "https://github.com/lu/moon-hop/actions/runs/1", sha: "b".repeat(40), at: "2026-11-26T10:00:00Z" });
    expect((await buildStatus(client({ has: true, latest: latest("in_progress", null) }).gh, r, origin)).run?.state).toBe("running");
    expect((await buildStatus(client({ has: true, latest: latest("queued", null) }).gh, r, origin)).run?.state).toBe("queued");
    expect((await buildStatus(client({ has: true, latest: latest("completed", "success") }).gh, r, origin))).toMatchObject({ file: "added", run: { state: "success" } });
    expect((await buildStatus(client({ has: true, latest: latest("completed", "failure") }).gh, r, origin)).run?.state).toBe("failed");
  });
});

describe("the upload script in GitHub Actions", () => {
  it("tells Toki why the build failed, with GitHub's proof", async () => {
    const got: { path: string; auth: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        got.push({ path: req.url ?? "", auth: req.headers.authorization ?? "", body });
        res.setHeader("content-type", "application/json");
        res.end(req.url?.startsWith("/token") ? JSON.stringify({ value: "proof-from-github" }) : JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), "toki-fail-"));
    mkdirSync(join(dir, "ProjectSettings"));
    writeFileSync(join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0");
    const env = {
      ...process.env, TOKI_KEY: "", GITHUB_ACTIONS: "true", TOKI_URL: `http://127.0.0.1:${port}`,
      ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/token?x=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token",
    };
    const script = join(__dirname, "..", "public", "toki-upload.mjs");
    const failed = await promisify(execFile)("node", [script, "--build"], { cwd: dir, env }).then(() => false, () => true);
    server.close();
    expect(failed).toBe(true);
    expect(got[0]).toMatchObject({ auth: "Bearer runner-token" });
    expect(got[0].path).toContain("audience=toki-upload");
    expect(got[1]).toMatchObject({ path: "/api/hosting", auth: "Bearer proof-from-github" });
    expect(JSON.parse(got[1].body)).toMatchObject({ action: "build_failed", reason: expect.stringMatching(/Unity project.*own editor/) });
  });
});
