import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const resolvePath = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolvePath("./src"),
      "@web": resolvePath("./src/web"),
      "@domain": resolvePath("./src/domain/index.ts"),
    },
  },
  server: {
    port: 5173,
    // The API is a separate process; proxying keeps the browser on one origin
    // so relative fetches behave identically in dev and in a static build.
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  build: {
    outDir: resolvePath("./dist/web"),
    emptyOutDir: true,
  },
});
