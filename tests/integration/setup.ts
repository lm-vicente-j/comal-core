// Runs before each test file. The suites wipe every domain table, so the
// connection comes from TEST_DATABASE_URL (environment or .env), never from the
// development DATABASE_URL. An inherited DATABASE_URL is still honored, but both
// paths must name a test database. Check it and apply the schema with
// `npm run test:setup`.
import { assertTestDatabase, readDotEnv, testEnv } from "../test-env";

process.env.DATABASE_URL ||= testEnv("TEST_DATABASE_URL");
assertTestDatabase(process.env.DATABASE_URL);
process.env.VERCEL_ENV = "";

// Vitest pre-populates process.env.DEV with "1" for import.meta.env.DEV,
// shadowing `.env`. Sync DEV from `.env` so testing-only guards honor it.
const dotEnvDev = readDotEnv("DEV");
if (dotEnvDev !== undefined) {
    process.env.DEV = dotEnvDev;
}
