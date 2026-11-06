import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Same isolation headers as production (vercel.json) so embedded Godot/Unity games behave the same locally.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
});
