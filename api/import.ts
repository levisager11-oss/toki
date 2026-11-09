// Developers: "Fill in from a link" on the game form (an itch.io page, a GitHub repository or the
// page where the game runs). Logic: server/importer.ts.
import { body, context, json } from "../server/http.js";
import { importGame } from "../server/importer.js";

export async function POST(request: Request) {
  const ctx = await context(request, ["admin", "creator"]);
  if (ctx instanceof Response) return ctx;
  const b = await body(request);
  const url = typeof b.url === "string" ? b.url.trim().slice(0, 500) : "";
  if (!url) return json({ error: "bad_url" }, 400);
  try {
    const out = await importGame(url);
    return "error" in out ? json(out, out.error === "bad_url" ? 400 : 422) : json(out);
  } catch {
    return json({ error: "unreachable" }, 502);
  }
}
