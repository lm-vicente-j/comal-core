import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "@": path.resolve(__dirname) };
const pure = ["tests/unit/**/*.test.ts", "tests/property/**/*.unit.test.ts", "tests/fuzz/**/*.unit.test.ts"];

export default defineConfig({
    test: {
        // Every database suite shares one disposable database, even across types.
        fileParallelism: false,
        allowOnly: !process.env.CI,
        reporters: process.env.CI ? ["default", "json"] : ["default"],
        outputFile: process.env.CI ? "ci_results/vitest-results.json" : undefined,
        projects: [
            { resolve: { alias }, test: { name: "unit", environment: "node", include: pure } },
            {
                resolve: { alias },
                test: {
                    name: "database",
                    environment: "node",
                    include: ["tests/integration/**/*.test.ts", "tests/adversarial/**/*.test.ts", "tests/property/**/*.integration.test.ts", "tests/fuzz/**/*.integration.test.ts"],
                    globalSetup: ["tests/helpers/database-global-setup.ts"],
                    setupFiles: ["tests/helpers/database-setup.ts"],
                    testTimeout: 30_000,
                    hookTimeout: 30_000,
                },
            },
        ],
    },
});
