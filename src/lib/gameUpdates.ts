// Updates for developers' games: things Toki can do that need a small change in the game.
//
// One entry per update, and everything follows from it: the notification developers get
// (select public.notify_developers('<topic>') once the app that knows the topic is live), the
// card on "My games" with a one-click "Update with Toki Connect" for each game it is for, and
// "Copy instructions" for an AI agent working in the game's code.
// Each entry needs its texts in src/lib/i18n.tsx: devup.<topic>.title, devup.<topic>.text and
// devup.<topic>.notif, in both languages.
import { supabase } from "./supabase";
import { api, type ConnectJob, type Feature } from "./ai";
import { integrationGuide } from "./integration";
import type { Game } from "./types";

export interface GameUpdate {
  /** The name developers are notified under: notify_developers('<topic>'). Lowercase letters, digits and "_". */
  topic: string;
  /** What Toki Connect adds for it (a feature in server/connect/agent.ts). */
  feature: Exclude<Feature, "fix">;
  /** The day it came out. Toki Connect runs before that day don't count as "updated". */
  since: string;
  /** The games it is for. */
  applies: (game: Pick<Game, "multiplayer">) => boolean;
  /** For the AI (Toki Connect's notes, and after the copied instructions): exactly what to add this time. */
  only: string;
}

/** Newest first. */
export const GAME_UPDATES: GameUpdate[] = [
  {
    topic: "host",
    feature: "multiplayer",
    since: "2026-11-10",
    applies: (g) => g.multiplayer === true,
    only: 'This time, add only `toki.onHost` from step 5 ("Let Toki open a room"), so the game opens a room by itself when Toki asks. The rest of step 5 is in the game already: keep it as it is. The script from step 1 must be the current one: replace an older copy that has no toki.onHost.',
  },
];

export const gameUpdate = (topic: string | null | undefined) => GAME_UPDATES.find((u) => u.topic === topic);

/** The texts of an update, as i18n keys. */
export const updateKeys = (topic: string) => ({
  title: `devup.${topic}.title`, text: `devup.${topic}.text`, notif: `devup.${topic}.notif`,
});

/** Instructions to paste into an AI coding agent working in the game's code. */
export const updateInstructions = (update: GameUpdate, script: string) => `${integrationGuide(script)}\n${update.only}\n`;

/**
 * Where a game stands with an update, from the developer's Toki Connect runs (newest first):
 * "run": one is going; "pr": it opened a pull request that has to be merged; "live": it put a
 * new version live (games uploaded to Toki); "already": the game had it; "failed"; "todo".
 */
export type UpdateState = { state: "todo" } | { state: "run" | "pr" | "live" | "already" | "failed"; job: ConnectJob };

export function updateState(update: GameUpdate, gameId: string, jobs: ConnectJob[]): UpdateState {
  const since = new Date(`${update.since}T00:00:00Z`).getTime();
  const job = jobs.find((j) => j.game_id === gameId && j.features.includes(update.feature) && new Date(j.created_at).getTime() >= since);
  if (!job) return { state: "todo" };
  if (job.status === "working" || job.status === "question") return { state: "run", job };
  if (job.status === "failed") return { state: "failed", job };
  return { state: job.pr_url ? "pr" : job.source === "upload" ? "live" : "already", job };
}

/** The game has no code Toki can reach: the developer picks the repository on the Connect page. */
export class NoSource extends Error {}

/**
 * Starts Toki Connect adding an update to a game, with what Toki knows about the game's code:
 * the GitHub repository and branch it follows (the change comes as a pull request), or its
 * files uploaded to Toki (the change goes live as the next version).
 */
export async function startUpdate(update: GameUpdate, game: Pick<Game, "id" | "hosted_site">, lang: "en" | "de"): Promise<ConnectJob> {
  const { data: git } = await supabase.from("game_git").select("installation_id, repo, branch").eq("game_id", game.id).maybeSingle();
  const run = { action: "start", features: [update.feature], notes: update.only, game_id: game.id, lang };
  const source = git
    ? { installation_id: (git as { installation_id: number }).installation_id, repo: (git as { repo: string }).repo, branch: (git as { branch: string }).branch }
    : game.hosted_site ? { source: "upload" } : null;
  if (!source) throw new NoSource();
  return (await api<{ job: ConnectJob }>("/api/connect", { method: "POST", body: JSON.stringify({ ...run, ...source }) })).job;
}
