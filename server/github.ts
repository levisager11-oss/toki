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

export interface MergedPull {
  number: number;
  title: string;
  body: string;
  /** ISO time */
  mergedAt: string;
}

export interface Installation {
  id: number;
  account: string;
  /** The repositories this person can reach there; null: all of them (their own account). See githubAccess.ts. */
  repos: string[] | null;
}

/** What the app may do in an installation, for adding the build file (see buildAccess). */
export interface BuildAccess {
  /** the installation lets the app change workflow files */
  workflows: boolean;
  /** the app itself asks for that (else the admin has to add it on GitHub first) */
  appWorkflows: boolean;
  /** GitHub's page of the installation, where its owner accepts new permissions */
  installUrl: string;
  /** GitHub's page of the app's permissions (for Toki's admins) */
  appUrl: string;
}

/** One run of a workflow, as GitHub reports it. */
export interface WorkflowRun {
  /** queued, in_progress, completed, … */
  status: string;
  /** when completed: success, failure, cancelled, … */
  conclusion: string | null;
  url: string;
  sha: string;
  at: string;
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

    /**
     * What the app may do in an installation, for the build file (server/gitBuild.ts): whether it
     * may change workflow files there, whether the app itself asks for that at all (apps made
     * before Toki asked for it don't), and where on GitHub each is changed.
     */
    async buildAccess(installationId: number): Promise<BuildAccess> {
      const jwt = appJwt(cfg.appId, cfg.privateKey);
      const [inst, app] = await Promise.all([
        call<{ permissions?: Record<string, string>; html_url?: string }>(`/app/installations/${installationId}`, jwt),
        call<{ permissions?: Record<string, string>; slug?: string; owner?: { login: string; type?: string } }>("/app", jwt),
      ]);
      const slug = app.slug || cfg.slug;
      return {
        workflows: inst.permissions?.workflows === "write",
        appWorkflows: app.permissions?.workflows === "write",
        installUrl: inst.html_url || `https://github.com/settings/installations/${installationId}`,
        appUrl: app.owner?.type === "Organization"
          ? `https://github.com/organizations/${encodeURIComponent(app.owner.login)}/settings/apps/${encodeURIComponent(slug)}/permissions`
          : `https://github.com/settings/apps/${encodeURIComponent(slug)}/permissions`,
      };
    },

    /** The permissions Toki's app asks for that it lacks on GitHub (the admin changes them there). */
    async missingAppPermissions(): Promise<string[]> {
      const app = await call<{ permissions?: Record<string, string> }>("/app", appJwt(cfg.appId, cfg.privateKey));
      const want: Record<string, string> = { contents: "write", pull_requests: "write", workflows: "write", actions: "write" };
      return Object.entries(want).filter(([k, v]) => app.permissions?.[k] !== v && !(v === "read" && app.permissions?.[k] === "write")).map(([k]) => k);
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
      const token = auth.access_token;
      const [me, list] = await Promise.all([
        call<{ id: number }>("/user", token),
        call<{ installations: { id: number; app_id?: number; account: { login: string; id?: number } }[] }>("/user/installations?per_page=100", token),
      ]);
      const mine = list.installations.filter((i) => i.app_id === undefined || String(i.app_id) === cfg.appId);
      return Promise.all(
        mine.map(async (i) => {
          // Their own account: everything the installation reaches, also what is made later.
          if (typeof me?.id === "number" && i.account.id === me.id) return { id: i.id, account: i.account.login, repos: null };
          // Someone else's (an organisation): only what this person can reach there.
          const repos: string[] = [];
          for (let page = 1; page <= 20; page++) {
            const r = await call<{ total_count: number; repositories: { full_name: string }[] }>(`/user/installations/${i.id}/repositories?per_page=100&page=${page}`, token);
            repos.push(...r.repositories.map((x) => x.full_name));
            if (r.repositories.length < 100 || repos.length >= r.total_count) break;
          }
          return { id: i.id, account: i.account.login, repos };
        }),
      );
    },

    async repos(installationId: number): Promise<{ repo: string; private: boolean; defaultBranch: string }[]> {
      const token = await installationToken(installationId);
      const out: { repo: string; private: boolean; defaultBranch: string }[] = [];
      // GitHub gives 100 at a time; accounts with more repositories need more pages.
      for (let page = 1; page <= 10; page++) {
        const r = await call<{ total_count: number; repositories: { full_name: string; private: boolean; default_branch: string }[] }>(`/installation/repositories?per_page=100&page=${page}`, token);
        out.push(...r.repositories.map((x) => ({ repo: x.full_name, private: x.private, defaultBranch: x.default_branch })));
        if (r.repositories.length < 100 || out.length >= r.total_count) break;
      }
      return out;
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
        /**
         * Where GitHub says the repository's site is: the "homepage" field (set by hand, not checked
         * by GitHub), and the custom domain of its GitHub Pages site ("cname"; GitHub lets only one
         * repository use a domain). When the app may not read the Pages settings, they are left out.
         */
        async site(): Promise<{ homepage: string | null; cname: string | null; pagesUrl: string | null }> {
          const r = await call<{ homepage?: string | null }>(`/repos/${repo}`, token);
          const pg = await call<{ cname?: string | null; html_url?: string | null }>(`/repos/${repo}/pages`, token).catch(() => null);
          return { homepage: r.homepage || null, cname: pg?.cname || null, pagesUrl: pg?.html_url || null };
        },
        /** The repository's name as GitHub has it now (it follows renames), so also a check that it can be reached. */
        async name(): Promise<string> {
          return (await call<{ full_name: string }>(`/repos/${repo}`, token)).full_name;
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
        /**
         * The newest pull requests merged into the default branch (at most 20, newest first): their
         * number, title, description and when they were merged.
         */
        async mergedPulls(): Promise<MergedPull[]> {
          const base = (await call<{ default_branch: string }>(`/repos/${repo}`, token)).default_branch;
          const r = await call<{ number: number; title: string; body: string | null; merged_at: string | null }[]>(
            `/repos/${repo}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=50`,
            token,
          );
          return r
            .filter((p) => p.merged_at)
            .map((p) => ({ number: p.number, title: p.title.trim().slice(0, 200), body: (p.body ?? "").slice(0, 4000), mergedAt: p.merged_at as string }))
            .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
            .slice(0, 20);
        },
        async read(path: string, ref: string): Promise<string> {
          return call<string>(`/repos/${repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`, token, {}, "application/vnd.github.raw+json");
        },
        /** Whether a pull request is still open, was merged, or was closed without merging. */
        async pullState(n: number): Promise<"open" | "merged" | "closed"> {
          const r = await call<{ state: string; merged_at: string | null }>(`/repos/${repo}/pulls/${n}`, token);
          return r.merged_at ? "merged" : r.state === "open" ? "open" : "closed";
        },
        /** Whether a file is on a branch (without reading the whole tree). */
        async has(path: string, ref: string): Promise<boolean> {
          return call(`/repos/${repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`, token)
            .then(() => true)
            .catch((e) => {
              if (e instanceof GitHubError && e.status === 404) return false;
              throw e;
            });
        },
        /** The newest run of a workflow on a branch, or null when it never ran (or the file isn't there). */
        async latestRun(file: string, branch: string): Promise<WorkflowRun | null> {
          const r = await call<{ workflow_runs: { status: string; conclusion: string | null; html_url: string; head_sha: string; created_at: string }[] }>(
            `/repos/${repo}/actions/workflows/${enc(file)}/runs?branch=${encodeURIComponent(branch)}&per_page=1`,
            token,
          ).catch((e) => {
            if (e instanceof GitHubError && e.status === 404) return { workflow_runs: [] };
            throw e;
          });
          const w = r.workflow_runs[0];
          return w ? { status: w.status, conclusion: w.conclusion, url: w.html_url, sha: w.head_sha, at: w.created_at } : null;
        },
        /** An open pull request into base from a branch whose name starts with prefix (one Toki made before). */
        async openPullFrom(prefix: string, base: string): Promise<string | null> {
          const r = await call<{ html_url: string; head: { ref: string } }[]>(`/repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=50`, token);
          return r.find((p) => p.head.ref.startsWith(prefix))?.html_url ?? null;
        },
        /** Starts a workflow of the repository on a branch (it must allow "workflow_dispatch"). Needs the app's "Actions: write". */
        async runWorkflow(file: string, branch: string): Promise<void> {
          await call(`/repos/${repo}/actions/workflows/${enc(file)}/dispatches`, token, { method: "POST", body: JSON.stringify({ ref: branch }) });
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
          try {
            const pr = await call<{ html_url: string }>(`/repos/${repo}/pulls`, token, {
              method: "POST",
              body: JSON.stringify({ title: p.title, head: p.branch, base: p.base, body: p.body }),
            });
            return pr.html_url;
          } catch (e) {
            // No branch left behind without its pull request.
            await call(`/repos/${repo}/git/refs/heads/${enc(p.branch)}`, token, { method: "DELETE" }).catch(() => {});
            throw e;
          }
        },
      };
    },
  };
}

export type GitHubClient = ReturnType<typeof github>;
export type RepoClient = Awaited<ReturnType<GitHubClient["repo"]>>;
