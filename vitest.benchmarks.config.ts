import path from "node:path";
import { defineConfig } from "vitest/config";

// Opt-in only: benchmarks reset the same database as the domain suites.
export default defineConfig({
    resolve: { alias: { "@": path.resolve(__dirname) } },
    test: {
        environment: "node",
        include: ["tests/benchmarks/**/*.test.ts"],
        globalSetup: ["tests/helpers/database-global-setup.ts"],
        setupFiles: ["tests/helpers/database-setup.ts"],
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
