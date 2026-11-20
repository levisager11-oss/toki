import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { gameSlug, ISOLATION_HEADERS, needsIsolation } from "./server/isolation";

// Like middleware.ts in production: only game pages of games that need cross-origin isolation
// get the isolation headers, so local testing behaves the same.
function isolation(): Plugin {
  const handler = (req: { url?: string }, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    const slug = gameSlug(new URL(req.url ?? "/", "http://x").pathname);
    if (!slug) return next();
    needsIsolation(slug).then((on) => {
      if (on) for (const [k, v] of Object.entries(ISOLATION_HEADERS)) res.setHeader(k, v);
      next();
    });
  };
  return {
    name: "toki-isolation",
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

// The libraries change far less often than Toki itself. In files of their own they stay in the
// browser's cache across Toki's updates (a returning visitor only loads Toki's own code again),
// and the browser loads them next to it, not as one big file.
function libraries(id: string): string | undefined {
  if (!id.includes("/node_modules/")) return;
  if (/\/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run\/router)\//.test(id)) return "react";
  if (/\/node_modules\/(@supabase\/[^/]+|tslib)\//.test(id)) return "supabase";
}

export default defineConfig({
  plugins: [react(), isolation()],
  build: { rollupOptions: { output: { manualChunks: libraries } } },
});
