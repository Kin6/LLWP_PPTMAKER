import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    setupFiles: ["./tests/setup-dom.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
    },
  },
});
