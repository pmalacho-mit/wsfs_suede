import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

const BACKEND = process.env.WSFS_BACKEND ?? "http://localhost:8099";

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    // Reachable from outside this container, because the browser that runs
    // `npm run test:browser` is in one of its own: `--forward` publishes this
    // port on that browser's localhost by pointing it at THIS machine's
    // address, which the default localhost-only bind does not answer.
    host: true,
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
