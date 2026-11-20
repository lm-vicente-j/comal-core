# Testing

Vitest exercises domain actions against PostgreSQL. Playwright exercises browser
flows against a separate database and app server. Authentication and revalidation
are mocked in integration tests. Domain database operations are real.

**Fixtures delete records in the selected test database.** Use isolated test
databases, never development data you want to keep or production.
See [integration fixtures](../tests/integration/helpers.ts) and
[browser fixtures](../tests/e2e/seed.ts).

## Prepare the databases

```bash
npm run test:setup
```

Run setup on a new machine, after schema changes, or when you need fresh fixtures.
The [helper](../scripts/test-db.sh) needs Bash and psql. It does not start
PostgreSQL. It asks before creating a missing database or resetting an existing
one. See [Test setup](#test-setup).

The test runners also perform a separate readiness check through
[`test-db-gate.ts`](../tests/test-db-gate.ts), once from each runner's global
setup:

| Database state | Runner behavior |
| --- | --- |
| Server unreachable, database missing or tables missing | Abort with `#:ERR:: TEST DATABASE NOT READY`, the cause and `Run: npm run test:setup` |
| Ready and empty | Run |
| Ready with rows | Print `#:WARN::` and the row count, wait two seconds, then run. Ctrl+C during the wait cancels before modification |

The readiness check does not prompt, including with piped stdin. Fixtures remain
after tests, so subsequent runner invocations normally warn again.
The check verifies table presence, not column compatibility. After a schema
change, use setup option 1 to recreate the schema.

## Integration tests

```bash
npm test
npm test -- tests/integration/sales.test.ts
npm test -- tests/integration/analytics.test.ts
```

[`vitest.config.ts`](../vitest.config.ts) selects
`tests/integration/**/*.test.ts`. Tests run in Node.
Files run sequentially. Tests and hooks have a timeout of 30 seconds.

[`setup.ts`](../tests/integration/setup.ts) uses an inherited DATABASE_URL when
present. Otherwise it reads TEST_DATABASE_URL from the environment or `.env`. It never loads the development DATABASE_URL from `.env`.
[`assertTestDatabase`](../tests/test-env.ts) requires a name ending in
`_test` or `_test_e2e`, and rejects other names before fixtures run.

Analytics integration tests additionally require the local `comalpos_test`
database. Use that name for the full suite. The broader suffix check alone is
not enough for that block.

Integration coverage includes sales (including `saleIds`-scoped closing), jornadas, debts, expenses, customers, users, products, inventory, payroll, savings, analytics, HTTP security headers / error sanitization / query range clamping ([`security-headers.test.ts`](../tests/integration/security-headers.test.ts)).
[`debts.test.ts`](../tests/integration/debts.test.ts) covers debtor mutations,
actions security, and pagination regression under load (1,000 active customers
and 3,000 debts) with deterministic ordering, limits, and summary checks.
Isolated performance benchmarks (5,000 active customers and 15,000 debts)
are located in [`tests/benchmarks/debts-benchmark.test.ts`](../tests/benchmarks/debts-benchmark.test.ts).
[`jornada-cash.test.ts`](../tests/integration/jornada-cash.test.ts) covers
collections in the same jornada and in a later jornada. It checks both payment
methods. It also checks expenses, salaries, savings and closing amounts.
Separate checks verify how later collections affect an earlier jornada.

Analytics specs cover ADMIN checks, filter validation, current PAID status,
historical item prices, dates, pagination, exports, missing values and CSV
handling. There is no settings integration spec or test of real
credentials/session cryptography.

## Browser tests

```bash
npm run test:e2e
npm run test:e2e -- tests/e2e/20-pos.spec.ts
npm run test:e2e -- tests/e2e/80-analytics.spec.ts
```

[`playwright.config.ts`](../playwright.config.ts) configures:

| Setting | Behavior |
| --- | --- |
| Database | E2E_DATABASE_URL from environment or `.env`. No default. Global setup rejects missing/invalid test names |
| Server | Next.js development server on port 3100, with a Auth.js secret used only in tests and host trust |
| Execution | One worker and shared seeded database. Global setup reseeds but does not apply schema |
| Login | Setup project stores ADMIN state in `tests/e2e/.auth/admin.json` |
| Views | Desktop plus Pixel 7 runs for expenses, POS and analytics |
| Browser | Installed Microsoft Edge on Windows. Elsewhere CHROMIUM_EXECUTABLE_PATH or `/opt/pw-browsers/chromium` |

The desktop project label does not change Windows execution to Google Chrome.
Other platforms need an installed Chromium at the configured path.
Playwright starts its own server on port 3100 with the test database and refuses to reuse an existing server.

Browser specs cover login/access, cash and transfer confirmation, debt
collection, CRUD, salary confirmation, stock/CRM filters, jornada closure and
analytics exports. These files' existence does not certify a deployment.

## Windows or an existing PostgreSQL server

The examples below assume localhost:5432 and the template's postgres
credentials. Adapt them to your installation. Create the test databases once:

```bash
createdb -h localhost -p 5432 -U postgres comalpos_test
createdb -h localhost -p 5432 -U postgres comalpos_test_e2e
```

In a dedicated PowerShell session, apply the integration schema and run tests:

```powershell
$env:VERCEL_ENV = "development"
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/comalpos_test"
$env:DIRECT_URL = $env:DATABASE_URL
npx prisma db push
npx prisma db execute --file prisma/migrations/20261121121000_add_spanish_customer_collation/migration.sql
npm test
```

Then configure the separate browser database:

```powershell
$env:VERCEL_ENV = "development"
$env:E2E_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/comalpos_test_e2e"
$env:DATABASE_URL = $env:E2E_DATABASE_URL
$env:DIRECT_URL = $env:E2E_DATABASE_URL
npx prisma db push
npx prisma db execute --file prisma/migrations/20261121121000_add_spanish_customer_collation/migration.sql
npm run test:e2e
```

Set both connection variables for schema commands because Prisma CLI prefers
DIRECT_URL. Close the dedicated shell or restore its environment before running
development commands.

## Test setup

[`scripts/test-db.sh`](../scripts/test-db.sh) reads inherited settings first,
then `.env`:

| Variable | Purpose |
| --- | --- |
| LOCAL_POSTGRES | Directory containing psql. Falls back to PATH |
| TEST_DATABASE_URL | Integration test database |
| E2E_DATABASE_URL | Database for browser tests. Skipped by the helper if unset |

For each database, it checks the name and server connection. An invalid name
stops with `#:ERR:: REFUSING TO USE`. An unreachable server stops with
`#:ERR:: POSTGRES SERVER UNREACHABLE`.

If the database is missing, it prints `#:ERR:: TEST DATABASE NOT FOUND` and asks
whether to create it. Answering yes creates it, applies the schema and, for E2E,
runs its seed. Any other answer or closed stdin stops with
`#:ERR:: DATABASE NOT CREATED` and exit status 1.

If it exists, the helper offers three choices:

1. Delete all data and recreate the schema. Also reseed the E2E database.
2. Leave the database unchanged. Later test execution can still delete data.
3. Cancel without modification.

Closed stdin also cancels. Option 1 uses
`prisma db push --force-reset --url <test database>`. The helper sets both
DATABASE_URL and DIRECT_URL for schema/seed commands, preventing the development
DIRECT_URL in `.env` from taking precedence. Integration specs create their own
fixtures. The E2E seed is `tests/e2e/seed.ts`.

## Choose checks for the change

| Change | Checks |
| --- | --- |
| Documentation | Local links/anchors, source paths, action coverage, formatting and `git diff --check` |
| Action or business rule | Relevant integration files. Browser specs for changed confirmation flows |
| UI | Relevant desktop/mobile browser specs and targeted lint |
| Schema, authentication or permissions | Impacted checks across affected modules |

Prepare test databases before a first run or schema change.
`npm run lint` runs ESLint. `npm run build` applies migrations before building. Do not use it to check documentation.
