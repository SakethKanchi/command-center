import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolvePath = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));

// No `@vitejs/plugin-react` here on purpose: vitest bundles its own Vite, and
// mixing that with the top-level Vite 6 plugin instance is both a type error
// and a runtime conflict. JSX is transformed by esbuild from the
// `jsx: react-jsx` setting in tsconfig, which is all Testing Library needs.
export default defineConfig({
  resolve: {
    alias: {
      "@": resolvePath("./src"),
      "@server": resolvePath("./src/server"),
      "@web": resolvePath("./src/web"),
      "@domain": resolvePath("./src/domain/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "evals/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    // Server tests open a real on-disk SQLite file per suite, so `node` is the
    // right default; only the component tests need a DOM.
    environment: "node",
    environmentMatchGlobs: [["src/web/**", "jsdom"]],
    setupFiles: ["./src/web/test-setup.ts"],
    restoreMocks: true,
  },
});
