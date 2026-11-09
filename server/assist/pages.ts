// Reading a little of a public web page (its title and some text) for the free AI: a game's page
// for its description, or the links in a developer application. Only public https sites, never
// local or private addresses, short time limits, and at most 200 KB of each page.
import { lookup } from "node:dns/promises";
import { isCheckableUrl } from "../embed-check.js";
import type { PageInfo } from "./prompts.js";

const MAX_BYTES = 200_000;

/** Addresses of local or private networks (also IPv4 inside IPv6). */
export function privateAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("::ffff:");
}

export type Lookup = (host: string) => Promise<string[]>;
const dnsLookup: Lookup = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** A public https address whose name leads only to public addresses (not to a local or private network). */
async function publicUrl(url: string, resolve: Lookup): Promise<boolean> {
  if (!isCheckableUrl(url)) return false;
  try {
    const addresses = await resolve(new URL(url).hostname);
    return addresses.length > 0 && !addresses.some(privateAddress);
  } catch {
    return false;
  }
}

async function fetchPublic(url: string, fetchImpl: typeof fetch, resolve: Lookup, accept = "text/html"): Promise<Response | null> {
  const signal = AbortSignal.timeout(8000);
  for (let hops = 0; hops <= 5; hops++) {
    if (!(await publicUrl(url, resolve))) return null;
    const res = await fetchImpl(url, { redirect: "manual", headers: { "user-agent": "TokiAssist/1.0", accept }, signal });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!next) return res;
    await res.body?.cancel();
    url = new URL(next, url).toString();
  }
  return null;
}

async function readCapped(res: Response, max = MAX_BYTES): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

/** A public page's text (HTML or JSON), at most `max` bytes; null when it can't be read. */
export async function fetchText(url: string, opts: { accept?: string; max?: number } = {}, fetchImpl: typeof fetch = fetch, resolve: Lookup = dnsLookup): Promise<{ url: string; text: string } | null> {
  try {
    const res = await fetchPublic(url, fetchImpl, resolve, opts.accept);
    if (!res || !res.ok) {
      await res?.body?.cancel().catch(() => {});
      return null;
    }
    return { url: res.url || url, text: await readCapped(res, opts.max ?? MAX_BYTES) };
  } catch {
    return null;
  }
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

export async function readPage(url: string, fetchImpl: typeof fetch = fetch, resolve: Lookup = dnsLookup): Promise<PageInfo> {
  try {
    const res = await fetchPublic(url, fetchImpl, resolve);
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
