// Reading a little of a public web page (its title and some text) for the free AI: a game's page
// for its description, or the links in a developer application. Only public https sites, never
// local or private addresses, short time limits, and at most 200 KB of each page.
import { isCheckableUrl } from "../embed-check.js";
import type { PageInfo } from "./prompts.js";

const MAX_BYTES = 200_000;

async function fetchPublic(url: string, fetchImpl: typeof fetch): Promise<Response | null> {
  const signal = AbortSignal.timeout(8000);
  for (let hops = 0; hops <= 5; hops++) {
    if (!isCheckableUrl(url)) return null;
    const res = await fetchImpl(url, { redirect: "manual", headers: { "user-agent": "TokiAssist/1.0", accept: "text/html" }, signal });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!next) return res;
    await res.body?.cancel();
    url = new URL(next, url).toString();
  }
  return null;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

const decode = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");

/** The page's title, its description and visible text (without scripts and styles), shortened. */
export function pageText(html: string): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const meta = (name: string) =>
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i").exec(html)?.[1] ??
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i").exec(html)?.[1] ??
    "";
  const description = decode(meta("description") || meta("og:description")).trim();
  const body = decode(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  return { title, text: [description, body].filter(Boolean).join("\n").slice(0, 1500) };
}

export async function readPage(url: string, fetchImpl: typeof fetch = fetch): Promise<PageInfo> {
  try {
    const res = await fetchPublic(url, fetchImpl);
    if (!res || !res.ok || !/html|text/i.test(res.headers.get("content-type") ?? "text/html")) {
      await res?.body?.cancel().catch(() => {});
      return { url, ok: false, title: "", text: "" };
    }
    return { url, ok: true, ...pageText(await readCapped(res)) };
  } catch {
    return { url, ok: false, title: "", text: "" };
  }
}

/** The https links in a text, without duplicates. */
export function linksIn(text: string, max = 3): string[] {
  const found = text.match(/https:\/\/[^\s<>"')\]]+/gi) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, "")))].slice(0, max);
}
