// What Toki asks GitHub to create when an admin sets up Toki Connect: a public app that can read
// a repository's code and open pull requests, and tells Toki about pushes (so games that follow
// a repository update by themselves), and add the build file (.github/workflows/toki.yml) for
// games whose repository holds their source.
export function githubManifest(origin: string, name = "Toki Connect") {
  return {
    name,
    url: origin,
    description: "Adds Toki saves and high scores to your web game and opens a pull request.",
    redirect_url: `${origin}/admin/ai`,
    callback_urls: [`${origin}/connect/github`],
    request_oauth_on_install: true,
    setup_on_update: false,
    public: true,
    hook_attributes: { url: `${origin}/api/github`, active: true },
    // workflows: to add the build file for games that must be built first (server/gitBuild.ts)
    default_permissions: { contents: "write", pull_requests: "write", metadata: "read", workflows: "write" },
    default_events: ["push"],
  };
}
