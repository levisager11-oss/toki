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
}

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
 * to the repository (a pull request), unless it is there already. Never throws for GitHub's
 * answers: when the pull request can't be made, the developer gets the page to add it by hand.
 */
export async function setUpBuild(db: Db, gh: GitHubClient, row: BuildRow, origin: string, now = new Date()): Promise<BuildSetup> {
  const repo = await gh.repo(row.installation_id, row.repo);
  const tree = await repo.tree(row.branch).catch(() => []);
  const has = tree.some((e) => e.path === BUILD_WORKFLOW_PATH);
  let out: BuildSetup = { pr: null, manual: null, ready: has };
  if (!has) {
    try {
      const pr = await repo.openPullRequest({
        base: row.branch,
        branch: `toki-build-${now.getTime().toString(36)}`,
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
      out = { pr, manual: null, ready: false };
    } catch (e) {
      // Usually: the app may not change workflow files. GitHub's own page does it with one click.
      if (!(e instanceof GitHubError)) throw e;
      out = { pr: null, manual: manualBuildLink(row.repo, row.branch, origin), ready: false };
    }
  }
  await db.update("game_git", `game_id=eq.${row.game_id}`, {
    build: "action",
    build_pr: out.pr ?? out.manual,
    status: "waiting",
    error: null,
    updated_at: now.toISOString(),
  });
  return out;
}
