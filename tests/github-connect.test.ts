// Connecting GitHub: the links Toki sends people to, the check of GitHub's answer, and reading
// accounts with many repositories.
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubConnectLink, githubInstallLink, githubManage, githubStateCheck } from "../src/lib/ai";
import { github } from "../server/github";

describe("connecting GitHub", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
      removeItem: (k: string) => void delete store[k],
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const INFO = { authUrl: "https://github.com/login/oauth/authorize?client_id=Iv1.abc", installUrl: "https://github.com/apps/toki-connect/installations/new" };
  const stateOf = (link: string) => new URL(link).searchParams.get("state");

  it("goes to GitHub's login page, which also comes back when the app is installed already", () => {
    const link = githubConnectLink(INFO, "/edit/moon-hop#move");
    expect(link.startsWith("https://github.com/login/oauth/authorize?client_id=Iv1.abc&state=")).toBe(true);
    expect(githubStateCheck(stateOf(link))).toEqual({ ok: true, back: "/edit/moon-hop#move" });
    // An older server that doesn't know the login page yet: the install page, as before.
    expect(githubConnectLink({ installUrl: INFO.installUrl }).startsWith(`${INFO.installUrl}?state=`)).toBe(true);
    expect(githubInstallLink(INFO.installUrl).startsWith(`${INFO.installUrl}?state=`)).toBe(true);
  });

  it("only accepts GitHub's answer to a visit started here, once, within half an hour", () => {
    const state = stateOf(githubConnectLink(INFO, "/add"));
    expect(githubStateCheck("someone-elses")).toEqual({ ok: false, back: "/add" });
    expect(githubStateCheck(null)).toEqual({ ok: false, back: "/add" });
    expect(githubStateCheck(state).ok).toBe(true);
    expect(githubStateCheck(state).ok).toBe(false);
    vi.useFakeTimers();
    const late = stateOf(githubConnectLink(INFO));
    vi.advanceTimersByTime(31 * 60_000);
    expect(githubStateCheck(late)).toEqual({ ok: false, back: null });
  });

  it("reads the repositories again when the developer comes back from GitHub's page for choosing them", () => {
    vi.useFakeTimers();
    const win = new EventTarget();
    const opened: string[] = [];
    vi.stubGlobal("window", Object.assign(win, { open: (u: string) => void opened.push(u) }));
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", doc);
    const back = vi.fn();
    const stop = githubManage(INFO.installUrl, back);
    expect(opened).toEqual([INFO.installUrl]);
    win.dispatchEvent(new Event("focus")); // the click itself: too soon
    expect(back).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    win.dispatchEvent(new Event("focus"));
    doc.dispatchEvent(new Event("visibilitychange")); // the same return
    expect(back).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(5000);
    win.dispatchEvent(new Event("focus"));
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe("an account with many repositories", () => {
  it("is read page by page", async () => {
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const pages: string[] = [];
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("/access_tokens")) return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      const page = Number(new URL(u).searchParams.get("page"));
      pages.push(u);
      const n = page === 1 ? 100 : 30;
      const repositories = Array.from({ length: n }, (_, i) => ({ full_name: `lu/game-${page}-${i}`, private: false, default_branch: "main" }));
      return new Response(JSON.stringify({ total_count: 130, repositories }), { status: 200 });
    }) as unknown as typeof fetch;
    const gh = github({ appId: "1", slug: "toki-connect", privateKey: pem, clientId: "cid", clientSecret: "cs" }, fetchImpl);
    const repos = await gh.repos(7);
    expect(repos).toHaveLength(130);
    expect(pages).toHaveLength(2);
    expect(repos[129].repo).toBe("lu/game-2-29");
  });
});
