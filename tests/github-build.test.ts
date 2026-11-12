// Games whose repository holds their source: GitHub Actions builds them and uploads without a key
// (GitHub's signed token says which repository and branch the run is for).
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIONS_AUDIENCE, ACTIONS_ISSUER, gameForAction, looksLikeJwt, verifyActionToken } from "../server/actionsAuth";
import { buildKind, manualBuildLink, setUpBuild } from "../server/gitBuild";
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
      ],
      games: [{ id: "g1", created_by: "dev" }, { id: "g2", created_by: "dev" }],
      profiles: [{ id: "dev", username: "lu", role: "creator" }],
    });
  const claims = (c: Partial<{ repository: string; ref: string }>) => ({ repository: "lu/Debt-Drifter", ref: "refs/heads/main", sha: "a".repeat(40), ...c });

  it("is the game that follows the run's repository and branch and is built by GitHub Actions", async () => {
    expect(await gameForAction(db(), claims({}))).toEqual({ game_id: "g1", user: { id: "dev", username: "lu", role: "creator" } });
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
  const db = () => fakeDb({ game_git: [{ game_id: "g1", repo: "lu/moon-hop", branch: "main", build: "none" }] });
  const client = (o: { has: boolean; run?: () => Promise<void> }) => {
    const calls: string[] = [];
    const gh = {
      repo: async () => ({
        tree: async () => (o.has ? [{ path: ".github/workflows/toki.yml", type: "blob" }] : []),
        runWorkflow: async (file: string, branch: string) => {
          calls.push(`run ${file} on ${branch}`);
          await o.run?.();
        },
        openPullRequest: async () => {
          calls.push("pr");
          return "https://github.com/lu/moon-hop/pull/3";
        },
      }),
    } as unknown as GitHubClient;
    return { gh, calls };
  };

  it("starts the first build when the build file is in the repository already", async () => {
    const { gh, calls } = client({ has: true });
    expect(await setUpBuild(db(), gh, row, "https://www.playtoki.app")).toEqual({ pr: null, manual: null, ready: true, started: true });
    expect(calls).toEqual(["run toki.yml on main"]);
  });

  it("leaves the first build to the developer when GitHub doesn't let the app start it", async () => {
    const { gh } = client({ has: true, run: async () => { throw new GitHubError("GitHub 403: Resource not accessible by integration", 403); } });
    expect(await setUpBuild(db(), gh, row, "https://www.playtoki.app")).toEqual({ pr: null, manual: null, ready: true, started: false });
  });

  it("opens a pull request with the build file when it is missing, and starts nothing", async () => {
    const { gh, calls } = client({ has: false });
    expect(await setUpBuild(db(), gh, row, "https://www.playtoki.app")).toEqual({ pr: "https://github.com/lu/moon-hop/pull/3", manual: null, ready: false, started: false });
    expect(calls).toEqual(["pr"]);
  });
});
