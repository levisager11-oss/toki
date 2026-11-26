// Games whose repository holds the source, which must be built first: GitHub Actions builds
// them on every push and uploads the result to Toki (20261120090000_github_build.sql). This
// sets that up: one small workflow file in the repository, through a pull request the
// developer merges. When the Toki GitHub App may not change workflow files (apps made before it
// asked for that), the developer gets GitHub's "new file" page with the file filled in instead.
import type { Db } from "./db.js";
import { GitHubError, type GitHubClient } from "./github.js";
import { BUILD_WORKFLOW_PATH, buildWorkflow } from "../src/lib/hostingRules.js";

export interface BuildRow {
  game_id: string;
  installation_id: number;
  repo: string;
  branch: string;
}

export interface BuildSetup {
  /** The pull request that adds the build file */
  pr: string | null;
  /** GitHub's page for adding the build file by hand (the app may not change workflow files) */
  manual: string | null;
  /** The repository has the build file already */
  ready: boolean;
  /** Toki started the first build itself (the build file was there, and the app may start runs) */
  started: boolean;
  /**
   * Why there is no pull request: "install" = the developer has to accept the app's permission
   * to change workflow files on GitHub; "app" = Toki's app doesn't ask for it yet (its admins add
   * it on GitHub first); "refused" = GitHub said no for another reason (see error).
   */
  blocked?: "install" | "app" | "refused" | null;
  /** GitHub's page where that permission is given */
  permissionUrl?: string | null;
  /** GitHub's own answer when it refused the pull request */
  error?: string | null;
}

/** Marks the start of what game_git.error holds when GitHub refused the build file's pull request. */
export const PR_REFUSED = "pr_refused: ";
/** Marks the start of game_git.error when the build itself failed (the upload script says why). */
export const BUILD_FAILED = "build: ";
/** The branches Toki opens build-file pull requests from. */
const PR_BRANCH = "toki-build-";

/** GitHub's "new file" page with the build file filled in: one click on "Commit changes". */
export function manualBuildLink(repo: string, branch: string, origin: string): string {
  const q = new URLSearchParams({ filename: BUILD_WORKFLOW_PATH, value: buildWorkflow(origin, branch) });
  return `https://github.com/${repo}/new/${encodeURIComponent(branch)}?${q.toString()}`;
}

export type BuildKind = "web" | "godot";
/** Engines whose editor (and license) can't run on GitHub Actions: they need an exported web build. */
export type NoBuild = "Unity" | "GameMaker" | "Construct" | "Godot C#" | "unknown";

/**
 * What GitHub Actions can build from the repository: a web project (package.json: npm, pnpm,
 * yarn or bun, then its "build" script) or a Godot project (GDScript; Godot runs on GitHub
 * Actions). Unity, GameMaker and Construct need their own editor and license.
 */
export async function buildKind(gh: GitHubClient, row: BuildRow): Promise<{ kind: BuildKind } | { cannot: NoBuild }> {
  const repo = await gh.repo(row.installation_id, row.repo);
  const paths = (await repo.tree(row.branch).catch(() => [])).filter((e) => e.type === "blob").map((e) => e.path);
  if (paths.includes("project.godot")) {
    const cs = paths.some((p) => /\.csproj$/i.test(p) && !p.includes("/"));
    return cs ? { cannot: "Godot C#" } : { kind: "godot" };
  }
  if (paths.includes("package.json")) return { kind: "web" };
  if (paths.includes("ProjectSettings/ProjectVersion.txt")) return { cannot: "Unity" };
  if (paths.some((p) => /^[^/]+\.yyp$/i.test(p))) return { cannot: "GameMaker" };
  if (paths.some((p) => /^[^/]+\.c3proj$/i.test(p))) return { cannot: "Construct" };
  return { cannot: "unknown" };
}

/**
 * Makes the game build with GitHub Actions: marks its repository row, and adds the build file
 * to the repository (a pull request), unless it is there already or a pull request for it is
 * open. First checks that the app may change workflow files there: if not, the developer is
 * asked to allow it on GitHub (GitHub's page to add the file by hand stays as a backup). Never
 * throws for GitHub's answers: when GitHub refuses, its reason is kept and shown.
 */
export async function setUpBuild(db: Db, gh: GitHubClient, row: BuildRow, origin: string, now = new Date()): Promise<BuildSetup> {
  const repo = await gh.repo(row.installation_id, row.repo);
  const has = await repo.has(BUILD_WORKFLOW_PATH, row.branch).catch(() => false);
  const manual = manualBuildLink(row.repo, row.branch, origin);
  let out: BuildSetup = { pr: null, manual: null, ready: has, started: false, blocked: null, permissionUrl: null, error: null };
  if (has) {
    // Nothing would happen until the next push: start the first build now. Apps made before
    // Toki asked for "Actions: write" may not; the developer then gets a link to do it.
    out.started = await repo
      .runWorkflow(BUILD_WORKFLOW_PATH.split("/").pop()!, row.branch)
      .then(() => true)
      .catch((e) => {
        if (!(e instanceof GitHubError)) throw e;
        return false;
      });
  } else {
    const open = await repo.openPullFrom(PR_BRANCH, row.branch).catch(() => null);
    // Asked before trying: GitHub only says "not accessible" otherwise, and the developer can't tell why.
    const access = open ? null : await gh.buildAccess(row.installation_id).catch(() => null);
    if (open) out.pr = open;
    else if (access && !access.workflows) {
      const app = !access.appWorkflows;
      out = { ...out, manual, blocked: app ? "app" : "install", permissionUrl: app ? access.appUrl : access.installUrl };
    } else {
      try {
        out.pr = await repo.openPullRequest({
          base: row.branch,
          branch: `${PR_BRANCH}${now.getTime().toString(36)}`,
          files: { [BUILD_WORKFLOW_PATH]: buildWorkflow(origin, row.branch) },
          message: "Build the game for Toki on every push",
          title: "Build the game for Toki on every push",
          body: [
            "This adds one file, `.github/workflows/toki.yml`. On every push to `" + row.branch + "`, GitHub Actions builds the game and puts the new version on Toki.",
            "",
            "- No key or secret needed: Toki checks GitHub's own signed proof that the upload comes from this repository and branch.",
            "- The build steps live in Toki's upload script (`" + origin + "/toki-upload.mjs --build`): it installs the packages (npm, pnpm or yarn), runs `build`, finds the built game and uploads it.",
            "",
            "Merge it, and the next push (or this merge) puts the game live.",
          ].join("\n"),
        });
      } catch (e) {
        if (!(e instanceof GitHubError)) throw e;
        out = { ...out, manual, blocked: "refused", error: e.message.slice(0, 280) };
      }
    }
  }
  await db.update("game_git", `game_id=eq.${row.game_id}`, {
    build: "action",
    build_pr: out.pr ?? out.manual,
    status: "waiting",
    error: out.error ? PR_REFUSED + out.error : null,
    updated_at: now.toISOString(),
  });
  return out;
}

export interface BuildStatus {
  /** added: the build file is on the branch; pr: its pull request is open; missing: neither */
  file: "added" | "pr" | "missing";
  pr: string | null;
  /** GitHub's page to add the file by hand */
  manual: string;
  blocked: BuildSetup["blocked"];
  permissionUrl: string | null;
  /** the newest build on GitHub */
  run: { state: "queued" | "running" | "success" | "failed" | "cancelled"; url: string; sha: string; at: string } | null;
}

/**
 * How the build is doing now, asked of GitHub while the developer looks (the game's page polls
 * this): is the build file in, is its pull request open, may the app add it, and the newest run.
 */
export async function buildStatus(gh: GitHubClient, row: BuildRow & { build_pr: string | null }, origin: string): Promise<BuildStatus> {
  const repo = await gh.repo(row.installation_id, row.repo);
  const [has, run] = await Promise.all([
    repo.has(BUILD_WORKFLOW_PATH, row.branch),
    repo.latestRun(BUILD_WORKFLOW_PATH.split("/").pop()!, row.branch).catch(() => null),
  ]);
  const out: BuildStatus = { file: has ? "added" : "missing", pr: null, manual: manualBuildLink(row.repo, row.branch, origin), blocked: null, permissionUrl: null, run: null };
  if (run) {
    const state = run.status !== "completed" ? (run.status === "queued" || run.status === "waiting" || run.status === "pending" ? "queued" : "running")
      : run.conclusion === "success" ? "success" : run.conclusion === "cancelled" || run.conclusion === "skipped" ? "cancelled" : "failed";
    out.run = { state, url: run.url, sha: run.sha, at: run.at };
  }
  if (!has) {
    out.pr = await repo.openPullFrom(PR_BRANCH, row.branch).catch(() => null);
    if (out.pr) out.file = "pr";
    else {
      const access = await gh.buildAccess(row.installation_id).catch(() => null);
      if (access && !access.workflows) {
        out.blocked = access.appWorkflows ? "install" : "app";
        out.permissionUrl = access.appWorkflows ? access.installUrl : access.appUrl;
      }
    }
  }
  return out;
}
