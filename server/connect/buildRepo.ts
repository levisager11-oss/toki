// Toki Connect on a game uploaded to Toki: the live version's files stand in for a repository.
// Its change becomes the game's next version (most files copied inside Cloudflare R2, the changed
// ones written), which goes live at once; the version before stays 30 days to roll back.
import type { TreeEntry } from "../github.js";
import { finishUpload, startUpload, type Deps, type HostUser } from "../hosting.js";
import type { RepoAccess } from "./agent.js";

export async function buildRepo(deps: Deps, user: HostUser, gameId: string): Promise<RepoAccess> {
  const [live] = await deps.db.select<{ id: string }>("game_builds", `game_id=eq.${gameId}&status=eq.live&select=id&limit=1`);
  if (!live) throw new Error("no_live_build");
  const prefix = `b/${live.id}/`;
  let listed: { path: string; size: number }[] | null = null;
  const list = async () => (listed ??= (await deps.store.list(prefix)).map((o) => ({ path: o.key.slice(prefix.length), size: o.size })));

  return {
    defaultBranch: async () => "live",
    tree: async (): Promise<TreeEntry[]> => (await list()).map((f) => ({ path: f.path, type: "blob", size: f.size })),
    read: async (path) => {
      if (!(await list()).some((f) => f.path === path)) throw new Error(`no file ${path}`);
      return deps.store.getText(prefix + path);
    },
    async openPullRequest(p) {
      const files = await list();
      const sizes = new Map(files.map((f) => [f.path, f.size]));
      for (const [path, text] of Object.entries(p.files)) sizes.set(path, Buffer.byteLength(text));
      const start = await startUpload(deps, user, { game_id: gameId, files: [...sizes].map(([path, size]) => ({ path, size })) });
      const to = `b/${start.build_id}/`;
      const queue = [...sizes.keys()];
      await Promise.all(
        Array.from({ length: 16 }, async () => {
          for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
            if (path in p.files) await deps.store.put(to + path, p.files[path], contentType(path));
            else await deps.store.copy(prefix + path, to + path);
          }
        }),
      );
      await finishUpload(deps, user, { build_id: start.build_id });
      return ""; // no pull request: the new version is live
    },
  };
}

const contentType = (path: string) =>
  /\.html?$/i.test(path) ? "text/html; charset=utf-8" : /\.m?js$/i.test(path) ? "text/javascript; charset=utf-8" : /\.json$/i.test(path) ? "application/json" : /\.css$/i.test(path) ? "text/css" : "text/plain; charset=utf-8";
