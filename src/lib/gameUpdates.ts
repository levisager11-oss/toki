// Updates for developers' games: things Toki can do that need a small change in the game.
//
// One entry per update, and everything follows from it: the notification developers get
// (select public.notify_developers('<topic>') once the app that knows the topic is live), and
// the card on "My games": for each game, one "Update with Toki Connect" that adds every update
// the game is missing in one run, and "Copy instructions" with all of them for an AI agent
// working in the game's code.
// Each entry needs its texts in src/lib/i18n.tsx: devup.<topic>.title, devup.<topic>.short,
// devup.<topic>.text and devup.<topic>.notif, in both languages.
import { supabase } from "./supabase";
import { api, githubRepos, type ConnectJob, type Feature } from "./ai";
import { integrationGuide } from "./integration";
import snippet from "../../public/toki-save.js?raw";
import type { Game } from "./types";

export interface GameUpdate {
  /** The name developers are notified under: notify_developers('<topic>'). Lowercase letters, digits and "_". */
  topic: string;
  /** What Toki Connect adds for it (a feature in server/connect/agent.ts). */
  feature: Exclude<Feature, "fix">;
  /**
   * When it went live (an ISO time, UTC). Toki Connect runs from before then didn't know about
   * it, so they don't count as "updated".
   */
  since: string;
  /** The games it is for. */
  applies: (game: Pick<Game, "multiplayer">) => boolean;
  /**
   * For the AI (Toki Connect's notes, and after the copied instructions): exactly what to add
   * for this update, as the end of "This time, add only …". Keep it short: the notes of a run
   * that adds every update at once must fit in 1000 characters (see updateNotes).
   */
  add: string;
}

/** Newest first. */
export const GAME_UPDATES: GameUpdate[] = [
  {
    topic: "boards",
    feature: "boards",
    since: "2026-11-11T17:00:00Z",
    // Any game with a score can have more lists (one per level, mode or difficulty).
    applies: () => true,
    add: '"More lists" from step 4: send scores to the game\'s other high-score lists on Toki with `toki.score(points, "id")` where the code knows which list a score belongs to, and keep sending the main score with `toki.score(points)`. If the game has no other lists on Toki yet, propose some as that part says.',
  },
  {
    topic: "achievements",
    feature: "achievements",
    since: "2026-11-11T15:53:00Z",
    // Every game can have achievements.
    applies: () => true,
    add: 'step 6 ("Achievements"): call `toki.achievement` with the ids of the game\'s achievements on Toki where the player earns them. If the game has none on Toki yet, propose some as step 6 says.',
  },
  {
    topic: "name",
    feature: "multiplayer",
    since: "2026-11-11T04:47:00Z",
    applies: (g) => g.multiplayer === true,
    add: '`toki.onName` from step 5 ("Use the name from Toki"): use the name Toki gives as the player\'s name in rooms instead of asking for it.',
  },
  {
    topic: "host",
    feature: "multiplayer",
    since: "2026-11-10T22:01:00Z",
    applies: (g) => g.multiplayer === true,
    add: '`toki.onHost` from step 5 ("Let Toki open a room"), so the game opens a room by itself when Toki asks.',
  },
];

export const gameUpdate = (topic: string | null | undefined) => GAME_UPDATES.find((u) => u.topic === topic);

/** The texts of an update, as i18n keys. */
export const updateKeys = (topic: string) => ({
  title: `devup.${topic}.title`, short: `devup.${topic}.short`, text: `devup.${topic}.text`, notif: `devup.${topic}.notif`,
});

/** The version of the script games use ("v9"), from its first line. */
export const scriptVersion = (script: string) => /\bv(\d+)\b/.exec(script.split("\n", 1)[0])?.[0] ?? "";

/**
 * For the AI: what to add this time, for one update or several at once (all a game is missing).
 * Toki Connect takes it as the run's notes, which hold at most 1000 characters.
 */
export function updateNotes(updates: GameUpdate[], script: string = snippet): string {
  const what = updates.length === 1 ? updates[0].add : `these:\n${updates.map((u) => `- ${u.add}`).join("\n")}`;
  const version = scriptVersion(script);
  return `This time, add only ${what}\nLeave everything else as it is in the game. The script from step 1 must be the current one${version ? ` (its first line says ${version})` : ""}: replace an older copy.`;
}

/** Features Toki Connect adds for these updates, each once. */
export const updateFeatures = (updates: GameUpdate[]) => [...new Set(updates.map((u) => u.feature))];

/** Instructions to paste into an AI coding agent working in the game's code: every update it is missing. */
export const updateInstructions = (updates: GameUpdate | GameUpdate[], script: string) =>
  `${integrationGuide(script)}\n${updateNotes(Array.isArray(updates) ? updates : [updates], script)}\n`;

/** The updates named in a link (?update=host,name), in the order of GAME_UPDATES. */
export const updatesFrom = (topics: string | null | undefined) => {
  const want = new Set((topics ?? "").split(","));
  return GAME_UPDATES.filter((u) => want.has(u.topic));
};

/**
 * Where a game stands with an update, from the developer's Toki Connect runs (newest first):
 * "run": one is going; "pr": it opened a pull request that has to be merged; "merged": that pull
 * request was merged; "live": it put a new version live (games uploaded to Toki); "already": the
 * game had it; "closed": its pull request was closed without merging; "failed"; "todo".
 */
export type UpdateState =
  | { state: "todo" }
  | { state: "run" | "pr" | "merged" | "closed" | "live" | "already" | "failed"; job: ConnectJob };

/** The game has the update: nothing left to do for it. */
export const isDone = (s: UpdateState) => s.state === "merged" || s.state === "live" || s.state === "already";

export function updateState(update: GameUpdate, game: { id: string; repo?: string | null }, jobs: ConnectJob[]): UpdateState {
  const since = new Date(update.since).getTime();
  // A run for this game, or one on its repository that wasn't told the game (started on the Connect page).
  const repo = game.repo?.toLowerCase();
  const ours = (j: ConnectJob) => j.game_id === game.id || (!j.game_id && !!repo && j.repo.toLowerCase() === repo);
  const job = jobs.find((j) => ours(j) && j.features.includes(update.feature) && new Date(j.created_at).getTime() >= since);
  if (!job) return { state: "todo" };
  if (job.status === "working" || job.status === "question") return { state: "run", job };
  if (job.status === "failed") return { state: "failed", job };
  if (job.pr_url) return { state: job.pr_state === "merged" ? "merged" : job.pr_state === "closed" ? "closed" : "pr", job };
  return { state: job.source === "upload" ? "live" : "already", job };
}

/** A game and an update, as one key ("<game id>:<topic>"). */
export const markKey = (gameId: string, topic: string) => `${gameId}:${topic}`;

/**
 * The updates the developer marked "Already done" for these games: they added them themselves,
 * outside Toki Connect. As markKey keys.
 */
export async function updateMarks(gameIds: string[]): Promise<Set<string>> {
  if (!gameIds.length) return new Set();
  const { data, error } = await supabase.from("game_update_marks").select("game_id, topic").in("game_id", gameIds);
  if (error) throw error;
  return new Set(((data ?? []) as { game_id: string; topic: string }[]).map((r) => markKey(r.game_id, r.topic)));
}

/** Marks an update as already in a game ("Already done"), or takes that back. */
export async function setUpdateMark(gameId: string, topic: string, done: boolean): Promise<void> {
  const { error } = done
    ? await supabase.from("game_update_marks").insert({ game_id: gameId, topic })
    : await supabase.from("game_update_marks").delete().eq("game_id", gameId).eq("topic", topic);
  // Marked already (e.g. in another tab): that's what was wanted.
  if (error && !(done && error.code === "23505")) throw error;
}

/** The repository each game follows (games that follow none are left out). */
export async function gameRepos(gameIds: string[]): Promise<Record<string, { repo: string; branch: string }>> {
  if (!gameIds.length) return {};
  const { data } = await supabase.from("game_git").select("game_id, repo, branch").in("game_id", gameIds);
  return Object.fromEntries(((data ?? []) as { game_id: string; repo: string; branch: string }[]).map((r) => [r.game_id, { repo: r.repo, branch: r.branch }]));
}

/**
 * Toki can't reach the game's code with the logged-in account: the developer picks the
 * repository on the Connect page (where they can also connect GitHub).
 */
export class NoSource extends Error {}

/**
 * The GitHub connection of the logged-in account that can reach this repository. Not the one
 * the game follows its repository with: that may belong to another account (e.g. an older one
 * of the same developer), and Toki Connect only works with the account's own connections.
 */
export function ownConnection(repos: { installation_id: number; repo: string }[] | undefined, repo: string): number | null {
  const r = repos?.find((x) => x.repo.toLowerCase() === repo.toLowerCase());
  return r ? r.installation_id : null;
}

/** Where the Connect page starts these updates for a game, when they can't be started in one click. */
export const updateConnectPath = (updates: GameUpdate | GameUpdate[], gameId: string) =>
  `/connect?update=${(Array.isArray(updates) ? updates : [updates]).map((u) => u.topic).join(",")}&game=${gameId}`;

/**
 * Starts Toki Connect adding updates to a game (all it is missing, in one run), with what Toki
 * knows about the game's code: the GitHub repository and branch it follows (the change comes as
 * a pull request), or its files uploaded to Toki (the change goes live as the next version).
 */
export async function startUpdate(updates: GameUpdate[], game: Pick<Game, "id" | "hosted_site">, git: { repo: string; branch: string } | undefined, lang: "en" | "de"): Promise<ConnectJob> {
  const run = { action: "start", features: updateFeatures(updates), notes: updateNotes(updates), game_id: game.id, lang };
  let source: Record<string, unknown>;
  if (git) {
    const installation = ownConnection((await githubRepos().catch(() => null))?.repos, git.repo);
    if (installation === null) throw new NoSource();
    source = { installation_id: installation, repo: git.repo, branch: git.branch };
  } else if (game.hosted_site) {
    source = { source: "upload" };
  } else {
    throw new NoSource();
  }
  return (await api<{ job: ConnectJob }>("/api/connect", { method: "POST", body: JSON.stringify({ ...run, ...source }) })).job;
}
