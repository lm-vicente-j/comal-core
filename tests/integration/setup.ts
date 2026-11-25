// Runs before each test file. The suites wipe every domain table, so the
// connection comes from TEST_DATABASE_URL (environment or .env), never from the
// development DATABASE_URL. An inherited DATABASE_URL is still honored, but both
// paths must name a test database. Check it and apply the schema with
// `npm run test:setup`.
import { assertTestDatabase, testEnv } from "../test-env";

process.env.DATABASE_URL ||= testEnv("TEST_DATABASE_URL");
assertTestDatabase(process.env.DATABASE_URL);
process.env.VERCEL_ENV = "";
// Independent fixture-only secrets. Production configuration has no fallback.
process.env.PIN_LOOKUP_SECRET ||= "integration-only-pin-secret-0123456789";
process.env.INSTALLATION_SECRET ||= "integration-only-install-secret-0123456789";

// This module runs only inside the guarded integration runner. Enable the
// lockout-reset fixture helper explicitly: Vite reserves DEV for its own flag.
process.env.DEV = "true";
