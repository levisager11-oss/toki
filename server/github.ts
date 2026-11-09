// GitHub, as the Toki GitHub App: read a game's repository and open a pull request in it.
// Uses GitHub's REST API with fetch and Node's crypto, no extra packages.
import { createSign } from "node:crypto";
import type { ServerEnv } from "./env.js";

const API = "https://api.github.com";
const HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "Toki-Connect" };

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** The short-lived token that identifies Toki's GitHub App (signed with its private key). */
export function appJwt(appId: string, privateKey: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // A minute back for clock differences; GitHub allows at most 10 minutes.
  const body = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64url(signature)}`;
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
}

export interface Installation {
  id: number;
  account: string;
}

export function github(cfg: ServerEnv["github"], fetchImpl: typeof fetch = fetch) {
  async function call<T>(path: string, token: string, init: RequestInit = {}, accept?: string): Promise<T> {
    const res = await fetchImpl(path.startsWith("http") ? path : `${API}${path}`, {
      ...init,
      headers: { ...HEADERS, ...(accept ? { accept } : {}), authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 200);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        /* not JSON */
      }
      throw new GitHubError(`GitHub ${res.status}: ${message}`, res.status);
    }
    if (accept === "application/vnd.github.raw+json") return text as T;
    return (text ? JSON.parse(text) : null) as T;
  }

  /** A token for one installation (about an hour long), limited to the repositories it was given. */
  async function installationToken(installationId: number): Promise<string> {
    const r = await call<{ token: string }>(`/app/installations/${installationId}/access_tokens`, appJwt(cfg.appId, cfg.privateKey), { method: "POST" });
    return r.token;
  }

  return {
    /** A token that can only read one repository (for an agent's copy; it can't push). */
    async readOnlyToken(installationId: number, repo: string): Promise<string> {
      const r = await call<{ token: string }>(`/app/installations/${installationId}/access_tokens`, appJwt(cfg.appId, cfg.privateKey), {
        method: "POST",
        body: JSON.stringify({ repositories: [repo.split("/")[1]], permissions: { contents: "read", metadata: "read" } }),
      });
      return r.token;
    },

    installUrl: (state: string) => `https://github.com/apps/${encodeURIComponent(cfg.slug)}/installations/new?state=${encodeURIComponent(state)}`,

    /**
     * The installations of this app that a GitHub user can use, checked with the user's own login
     * (the code GitHub sends back after installing). This is what proves an installation is theirs.
     */
    async userInstallations(code: string): Promise<Installation[]> {
      const res = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": HEADERS["user-agent"] },
        body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }),
        signal: AbortSignal.timeout(30_000),
      });
      const auth = (await res.json()) as { access_token?: string; error?: string };
      if (!auth.access_token) throw new GitHubError(`GitHub login: ${auth.error ?? res.status}`, 401);
      const list = await call<{ installations: { id: number; app_id?: number; account: { login: string } }[] }>("/user/installations?per_page=100", auth.access_token);
      return list.installations
        .filter((i) => i.app_id === undefined || String(i.app_id) === cfg.appId)
        .map((i) => ({ id: i.id, account: i.account.login }));
    },

    async repos(installationId: number): Promise<{ repo: string; private: boolean; defaultBranch: string }[]> {
      const token = await installationToken(installationId);
      const r = await call<{ repositories: { full_name: string; private: boolean; default_branch: string }[] }>("/installation/repositories?per_page=100", token);
      return r.repositories.map((x) => ({ repo: x.full_name, private: x.private, defaultBranch: x.default_branch }));
    },

    /** Reading and changing one repository with the installation's token. */
    async repo(installationId: number, repo: string) {
      const token = await installationToken(installationId);
      const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
      return {
        async branches(): Promise<string[]> {
          const r = await call<{ name: string }[]>(`/repos/${repo}/branches?per_page=100`, token);
          return r.map((b) => b.name);
        },
        /** The newest commit of a branch: its id and the first line of its message. */
        async head(branch: string): Promise<{ sha: string; message: string }> {
          const r = await call<{ sha: string; commit: { message: string } }>(`/repos/${repo}/commits/${encodeURIComponent(branch)}`, token);
          return { sha: r.sha, message: r.commit.message.split("\n")[0].trim().slice(0, 200) };
        },
        /** The repository's files at a commit, as a .tar.gz (at most maxBytes). */
        async tarball(ref: string, maxBytes: number): Promise<Uint8Array> {
          const res = await fetchImpl(`${API}/repos/${repo}/tarball/${encodeURIComponent(ref)}`, {
            headers: { ...HEADERS, authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(120_000),
          });
          if (!res.ok || !res.body) throw new GitHubError(`GitHub ${res.status}: tarball`, res.status);
          const reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > maxBytes) {
              await reader.cancel().catch(() => {});
              throw new GitHubError("repo_too_big", 413);
            }
            chunks.push(value);
          }
          return Buffer.concat(chunks);
        },
        async defaultBranch(): Promise<string> {
          return (await call<{ default_branch: string }>(`/repos/${repo}`, token)).default_branch;
        },
        async tree(branch: string): Promise<TreeEntry[]> {
          const r = await call<{ tree: TreeEntry[] }>(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token);
          return r.tree;
        },
        /** First lines of the newest commit messages on the default branch, since a time if given. */
        async commits(since?: string): Promise<string[]> {
          const q = `per_page=60${since ? `&since=${encodeURIComponent(since)}` : ""}`;
          const r = await call<{ commit: { message: string } }[]>(`/repos/${repo}/commits?${q}`, token);
          return r.map((c) => c.commit.message.split("\n")[0].trim()).filter(Boolean);
        },
        async read(path: string, ref: string): Promise<string> {
          return call<string>(`/repos/${repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`, token, {}, "application/vnd.github.raw+json");
        },
        /** One commit with all changed files on a new branch, then a pull request. Returns its link. */
        async openPullRequest(p: { base: string; branch: string; files: Record<string, string>; title: string; body: string; message: string }): Promise<string> {
          const ref = await call<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${enc(p.base)}`, token);
          const parent = await call<{ tree: { sha: string } }>(`/repos/${repo}/git/commits/${ref.object.sha}`, token);
          const tree = await call<{ sha: string }>(`/repos/${repo}/git/trees`, token, {
            method: "POST",
            body: JSON.stringify({
              base_tree: parent.tree.sha,
              tree: Object.entries(p.files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
            }),
          });
          const commit = await call<{ sha: string }>(`/repos/${repo}/git/commits`, token, {
            method: "POST",
            body: JSON.stringify({ message: p.message, tree: tree.sha, parents: [ref.object.sha] }),
          });
          await call(`/repos/${repo}/git/refs`, token, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${p.branch}`, sha: commit.sha }) });
          const pr = await call<{ html_url: string }>(`/repos/${repo}/pulls`, token, {
            method: "POST",
            body: JSON.stringify({ title: p.title, head: p.branch, base: p.base, body: p.body }),
          });
          return pr.html_url;
        },
      };
    },
  };
}

export type GitHubClient = ReturnType<typeof github>;
export type RepoClient = Awaited<ReturnType<GitHubClient["repo"]>>;
