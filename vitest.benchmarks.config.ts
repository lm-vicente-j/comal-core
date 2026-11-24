import { defineConfig } from "vitest/config";
import integrationConfig from "./vitest.config";

// Existing benchmarks run separately: they share and reset the integration DB.
export default defineConfig({
    ...integrationConfig,
    test: { ...integrationConfig.test, include: ["tests/benchmarks/**/*.test.ts"] },
});
