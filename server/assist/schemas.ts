// The shape of each helper's JSON answer, for Anthropic's structured outputs: with a schema the
// answer is always valid JSON of that shape, so "the AI's answer didn't work out" is rare. The
// readers in prompts.ts and scan.ts still check every value (lengths, numbers from the list).
import { CATEGORIES } from "../../src/lib/types.js";

type Schema = Record<string, unknown>;

const str: Schema = { type: "string" };
const int: Schema = { type: "integer" };
const bool: Schema = { type: "boolean" };
const list = (items: Schema): Schema => ({ type: "array", items });
const enumOf = (values: readonly string[]): Schema => ({ type: "string", enum: [...values] });
/** An object whose fields are all required and nothing else is allowed (what structured outputs need). */
const obj = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const SCHEMAS = {
  translate: obj({ t: list(str) }),
  similar: obj({ same: list(int) }),
  release: obj({ title: str, notes: str }),
  describe: obj({ en: str, de: str }),
  suggest: obj({ picks: list(obj({ n: int, why: str })) }),
  improve: obj({
    tasks: list(obj({ kind: enumOf(["bug", "idea"]), title: str, what: str, posts: list(int) })),
    skipped: list(obj({ n: int, why: enumOf(["unclear", "spam", "off_topic", "answered", "unsafe", "other"]) })),
  }),
  scan: obj({
    title: str,
    description: str,
    description_de: str,
    category: enumOf(CATEGORIES),
    engine: str,
    controls: str,
    controls_de: str,
    leaderboard: bool,
    score_order: enumOf(["high", "low"]),
    score_format: enumOf(["points", "time"]),
    multiplayer: bool,
    saves_elsewhere: bool,
  }),
  moderate: obj({
    verdicts: list(obj({ n: int, verdict: enumOf(["remove", "keep", "unsure"]), reason: str })),
  }),
} satisfies Record<string, Schema>;
