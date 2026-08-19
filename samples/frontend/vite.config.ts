import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

const BACKEND = process.env.WSFS_BACKEND ?? "http://localhost:8099";

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    // The sample talks to the sample backend from the same origin, so nothing
    // here needs CORS and the browser sends the session cookie it would send
    // in a real deployment.
    proxy: {
      "/wsfs": { target: BACKEND, changeOrigin: true },
      "/projects": { target: BACKEND, changeOrigin: true },
    },
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["pyodide"] },
});
