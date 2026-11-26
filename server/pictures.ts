// Pictures nothing uses any more (a replaced cover or avatar, pictures from an add form that was
// left, or of a game or account an admin deleted) are deleted by the nightly cleanup, so no
// uploaded picture stays around longer than needed. The browser already deletes what it can;
// this catches what it can't (only the uploader may delete a file from the browser).
import { SUPABASE_URL } from "./config.js";
import type { Db } from "./db.js";

interface Unused {
  bucket: string;
  name: string;
}

/** Deletes up to `limit` unused pictures (see public.unused_pictures). */
export async function sweepPictures(db: Db, serviceKey: string, limit = 200, fetchImpl: typeof fetch = fetch): Promise<{ pictures: number }> {
  const unused = await db.rpc<Unused[]>("unused_pictures", { p_limit: limit });
  const byBucket = new Map<string, string[]>();
  for (const u of unused ?? []) byBucket.set(u.bucket, [...(byBucket.get(u.bucket) ?? []), u.name]);
  const auth: Record<string, string> = serviceKey.startsWith("sb_") ? { apikey: serviceKey } : { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
  let pictures = 0;
  for (const [bucket, names] of byBucket) {
    const res = await fetchImpl(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}`, {
      method: "DELETE",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ prefixes: names }),
    });
    if (!res.ok) throw new Error(`storage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    pictures += names.length;
  }
  return { pictures };
}
