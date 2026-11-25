import { execFileSync } from "node:child_process";
import { E2E_DATABASE_URL } from "../../playwright.config";
import { testEnv } from "../test-env";
import { ensureTestDatabaseReady } from "../test-db-gate";

// Reseeds the e2e database once before the whole run, after checking it is ready
// and, if it holds data, that the user was warned about the overwrite.
export default async function globalSetup() {
    await ensureTestDatabaseReady(E2E_DATABASE_URL);
    execFileSync(process.execPath, ["--import", "tsx", "tests/e2e/seed.ts"], {
        stdio: "inherit",
        env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL, VERCEL_ENV: "", PIN_LOOKUP_SECRET: testEnv("PIN_LOOKUP_SECRET") ?? "e2e-only-pin-lookup-secret-0123456789" },
    });
}
