// Reads a game site's response headers to tell whether Toki can show it in its game frame.
export interface EmbedCheck {
  reachable: boolean;
  status: number;
  /** false when X-Frame-Options or CSP frame-ancestors forbid other sites from showing the page */
  framable: boolean;
  /** false when the headers Toki's cross-origin isolation needs are missing */
  isolation: boolean;
}

export function checkHeaders(h: Headers, tokiOrigin: string): Omit<EmbedCheck, "reachable" | "status"> {
  const xfo = (h.get("x-frame-options") ?? "").toLowerCase();
  const csp = (h.get("content-security-policy") ?? "").toLowerCase();
  const ancestors = /frame-ancestors([^;]*)/.exec(csp)?.[1].trim().split(/\s+/).filter(Boolean);
  const host = new URL(tokiOrigin).host;
  const ancestorsOk =
    !ancestors || ancestors.some((a) => a === "*" || a === "https:" || a === tokiOrigin || a.endsWith(host) || (a.startsWith("https://*.") && host.endsWith(a.slice(9))));
  const framable = !/deny|sameorigin/.test(xfo) && ancestorsOk;
  const coep = (h.get("cross-origin-embedder-policy") ?? "").toLowerCase();
  const corp = (h.get("cross-origin-resource-policy") ?? "").toLowerCase();
  const isolation = /require-corp|credentialless/.test(coep) && corp === "cross-origin";
  return { framable, isolation };
}

/** Only public https sites: no IP addresses or local names. */
export function isCheckableUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
    if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return false;
    return !/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host);
  } catch {
    return false;
  }
}
