// Push notifications for game invites (server/push.ts).
// GET: the server's public key, which a browser needs to subscribe a device.
// POST {to}: right after the logged-in player invited this friend, the invite is pushed to the
// friend's devices. Only an invite that is really there is pushed, and each one once
// (take_invite_push), so this can't be used to send anything else to anyone.
import { serviceDb } from "../server/db.js";
import { serverEnv } from "../server/env.js";
import { body, context, isUuid, json } from "../server/http.js";
import { pushInvite, pushKeys } from "../server/push.js";

export async function GET() {
  const env = serverEnv();
  if (!env.serviceKey) return json({ error: "not_configured" }, 503);
  try {
    return json({ key: (await pushKeys(serviceDb(env.serviceKey), env)).publicKey });
  } catch {
    return json({ error: "error" }, 500);
  }
}

export async function POST(request: Request) {
  const ctx = await context(request, ["admin", "creator", "player"]);
  if (ctx instanceof Response) return ctx;
  const b = await body(request);
  if (!isUuid(b.to)) return json({ error: "bad_request" }, 400);
  try {
    return json({ sent: await pushInvite(ctx.db, ctx.env, ctx.user.id, b.to) });
  } catch {
    return json({ error: "error" }, 500);
  }
}
