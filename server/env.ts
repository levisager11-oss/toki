// Secret settings for the AI and GitHub server code, from Vercel's environment variables.
// They never reach the browser. `process` may not exist everywhere, so read it carefully.
const env = () => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export interface ServerEnv {
  /** Key for the OpenAI-compatible endpoint set in the admin dashboard. */
  aiKey: string;
  /** Key for Anthropic's API. */
  anthropicKey: string;
  /** Key for the free AI's endpoint, when it isn't the strong AI's OpenAI-compatible endpoint. */
  freeAiKey: string;
  /** Supabase secret key (sb_secret_…) or the older service_role key: skips row level security. */
  serviceKey: string;
  github: { appId: string; slug: string; privateKey: string; clientId: string; clientSecret: string };
}

export function serverEnv(): ServerEnv {
  const e = env();
  return {
    aiKey: e.AI_API_KEY ?? "",
    anthropicKey: e.ANTHROPIC_API_KEY ?? "",
    freeAiKey: e.FREE_AI_API_KEY ?? "",
    serviceKey: e.SUPABASE_SECRET_KEY || e.SUPABASE_SERVICE_ROLE_KEY || "",
    github: {
      appId: e.GITHUB_APP_ID ?? "",
      slug: e.GITHUB_APP_SLUG ?? "",
      // Vercel keeps line breaks, but a key pasted with "\n" written out works too.
      privateKey: (e.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
      clientId: e.GITHUB_APP_CLIENT_ID ?? "",
      clientSecret: e.GITHUB_APP_CLIENT_SECRET ?? "",
    },
  };
}

export const githubConfigured = (g: ServerEnv["github"]) => !!(g.appId && g.slug && g.privateKey && g.clientId && g.clientSecret);
