// Boards: a game's high-score lists besides its main one. What a list of boards may hold, and
// which board a score from the game goes to. No imports, so the server (toki.json, Toki Connect)
// uses it too. The database has the same rules: supabase/migrations/20261129090000_boards.sql.

/** Boards besides the main one. */
export const MAX_BOARDS = 10;
/** What a game calls toki.score(points, id) with: letters, digits, "_", "-" and ".", at most 32. */
export const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
export const BOARD_NAME_MAX = 40;
/** The main board's id: toki.score(points) goes there. */
export const MAIN = "";

export interface Board {
  /** "" for the main board */
  id: string;
  name: string;
  name_de: string | null;
  score_order: "high" | "low";
  score_format: "points" | "time";
}

/** A board as toki.json or Toki Connect give it; for the main board ("") only the names count. */
export type BoardInput = Pick<Board, "id" | "name" | "name_de"> & Partial<Pick<Board, "score_order" | "score_format">>;

const cut = (s: string, n: number) => [...s].slice(0, n).join("");
const clean = (v: unknown, max: number) => (typeof v === "string" ? cut(v.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim(), max) : "");

/**
 * A list of boards (from toki.json, or proposed by Toki Connect), checked: entries without a usable
 * id or name and repeated ids are left out, long names are cut, at most 10 (plus the main board's
 * name, as an entry with id ""). An order or format that isn't given stays out, so a toki.json
 * that leaves it out doesn't change it on Toki.
 */
export function readBoards(raw: unknown): BoardInput[] {
  if (!Array.isArray(raw)) return [];
  const out: BoardInput[] = [];
  const seen = new Set<string>();
  let extra = 0;
  for (const b of raw) {
    if (!b || typeof b !== "object") continue;
    const o = b as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const name = clean(o.name, BOARD_NAME_MAX);
    if (seen.has(id)) continue;
    if (id === MAIN) {
      if (!name) continue;
      seen.add(id);
      out.push({ id, name, name_de: clean(o.name_de, BOARD_NAME_MAX) || null });
      continue;
    }
    if (!BOARD_ID.test(id) || !name || extra >= MAX_BOARDS) continue;
    seen.add(id);
    extra++;
    const board: BoardInput = { id, name, name_de: clean(o.name_de, BOARD_NAME_MAX) || null };
    if (o.score_order === "high" || o.score_order === "low") board.score_order = o.score_order;
    if (o.score_format === "points" || o.score_format === "time") board.score_format = o.score_format;
    out.push(board);
  }
  return out;
}

/** What's wrong with the boards the developer typed in the form (not the main one), as an i18n key; null when they can be saved. */
export function boardProblem(list: Pick<Board, "id" | "name">[]): "boards.err.tooMany" | "boards.err.id" | "boards.err.sameId" | "boards.err.name" | null {
  if (list.length > MAX_BOARDS) return "boards.err.tooMany";
  const seen = new Set<string>();
  for (const b of list) {
    if (!BOARD_ID.test(b.id)) return "boards.err.id";
    if (seen.has(b.id)) return "boards.err.sameId";
    seen.add(b.id);
    if (!b.name.trim()) return "boards.err.name";
  }
  return null;
}

/** An id made from a name ("Hard mode!" → "hard-mode"), not one of the taken ones. */
export function boardIdFromName(name: string, taken: string[]): string {
  const base = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/, "") || "board";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * The board a score from the game goes to (toki.score(points, board)): "" for none (the main
 * board), the id when it can be one, null when it can't (then the score is ignored).
 */
export function sentBoard(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return MAIN;
  const id = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
  return typeof id === "string" && BOARD_ID.test(id) ? id : null;
}

/** A board's name in the player's language (German falls back to English); the main board's own name, or `main`. */
export function boardLabel(b: { id: string; name?: string | null; name_de?: string | null }, lang: "en" | "de", main: string): string {
  const name = (lang === "de" && b.name_de) || b.name;
  return name || (b.id === MAIN ? main : b.id);
}

/**
 * All of a game's boards, the main one first (with the game's order, format and the name its
 * developer gave it), then the others in their order.
 */
export function allBoards(
  game: { score_order?: "high" | "low"; score_format?: "points" | "time"; board_name?: string | null; board_name_de?: string | null },
  extra: Board[],
): Board[] {
  return [
    { id: MAIN, name: game.board_name ?? "", name_de: game.board_name_de ?? null, score_order: game.score_order ?? "high", score_format: game.score_format ?? "points" },
    ...extra.filter((b) => b.id !== MAIN),
  ];
}
