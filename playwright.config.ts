import { defineConfig, devices } from "@playwright/test";
import { testEnv } from "./tests/test-env";

const PORT = 3100;
// From the environment or .env; global setup refuses it if empty or not a test database.
export const E2E_DATABASE_URL = testEnv("E2E_DATABASE_URL") ?? "";

// Use the installed Edge on Windows. On Linux the CI path is the default; set
// CHROMIUM_EXECUTABLE_PATH (environment or .env) to use a local Chromium instead.
const chromium = process.platform === "win32"
    ? { channel: "msedge" as const }
    : { executablePath: testEnv("CHROMIUM_EXECUTABLE_PATH") ?? "/opt/pw-browsers/chromium" };
const ADMIN_STATE = "tests/e2e/.auth/admin.json";

export default defineConfig({
    testDir: "tests/e2e",
    timeout: 60_000,
    expect: { timeout: 10_000 },
    // One worker, ordered files: the specs share the seeded database.
    fullyParallel: false,
    workers: 1,
    reporter: [["list"]],
    globalSetup: "./tests/e2e/global-setup.ts",
    use: {
        baseURL: `http://localhost:${PORT}`,
        launchOptions: chromium,
    },
    projects: [
        { name: "setup", testMatch: /auth\.setup\.ts/ },
        {
            name: "desktop",
            use: { ...devices["Desktop Chrome"], storageState: ADMIN_STATE, launchOptions: chromium },
            dependencies: ["setup"],
        },
        {
            // Mobile pass over the redesigned views (expenses) and the POS.
            name: "mobile",
            use: { ...devices["Pixel 7"], storageState: ADMIN_STATE, launchOptions: chromium },
            dependencies: ["setup"],
            testMatch: /\d+-(expenses|pos|analytics)\.spec\.ts/,
        },
    ],
    webServer: {
        command: `node node_modules/next/dist/bin/next dev -p ${PORT}`,
        url: `http://localhost:${PORT}/login`,
        reuseExistingServer: false,
        timeout: 180_000,
        env: {
            DATABASE_URL: E2E_DATABASE_URL,
            VERCEL_ENV: "",
            AUTH_SECRET: "e2e-test-secret-key-0123456789",
            AUTH_TRUST_HOST: "true",
        },
    },
});
