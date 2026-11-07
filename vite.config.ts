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

export default defineConfig({
  plugins: [react(), isolation()],
});
