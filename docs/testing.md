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
present. Otherwise it reads TEST_DATABASE_URL from the environment or `.env`.
It never loads the development DATABASE_URL from `.env`. It also reads `DEV`
from `.env` so testing-only helpers such as `resetAllLockouts` can run when
`DEV="true"`.
[`assertTestDatabase`](../tests/test-env.ts) requires a name ending in
`_test` or `_test_e2e`, and rejects other names before fixtures run.

Analytics integration tests additionally require localhost and one of
`comalpos_test`, `comal_pagination_test` or `comal_issue67_test`. Analytics browser
tests accept `comalpos_test_e2e` or `comal_pagination_test_e2e` on localhost.
Development database names remain rejected.

Integration coverage includes guest ticket reservations and account IDs,
sale ID and total validation at checkout, business-timezone history,
shift and cash movement concurrency, debts, expenses, customers, users,
products, inventory, payroll, savings, analytics, authentication security
([`auth-security.test.ts`](../tests/integration/auth-security.test.ts): role
enforcement, bcrypt verification, persistent account lockout and user directory privacy),
and HTTP security headers / error sanitization / query range clamping
([`security-headers.test.ts`](../tests/integration/security-headers.test.ts)).
[`debts.test.ts`](../tests/integration/debts.test.ts) covers debtor mutations,
actions security, and pagination regression under load (1,000 active customers
and 3,000 debts) with deterministic ordering, limits, and summary checks.
Isolated performance benchmarks (5,000 active customers and 15,000 debts)
are located in [`tests/benchmarks/debts-benchmark.test.ts`](../tests/benchmarks/debts-benchmark.test.ts).
Run the existing benchmarks separately with `npm run test:benchmarks`; they
reset the integration test database and must not run alongside integration tests.
Pagination tests use the [common POST contract](pagination.md), including
normalization, limits, filters, stable ordering and explicit authorization
errors. Browser specs cover the corresponding controls and local navigation.
[`catalog-availability.test.ts`](../tests/integration/catalog-availability.test.ts)
covers reversible product/supply status, availability filters, recipe and sale
validation, and preserved consumption snapshots. Browser coverage in
[`102-catalog-availability.spec.ts`](../tests/e2e/102-catalog-availability.spec.ts)
exercises status changes and inactive supply controls on desktop and mobile.
[`jornada-cash.test.ts`](../tests/integration/jornada-cash.test.ts) covers
collections in the same jornada and in a later jornada. It checks both payment
methods. It also checks expenses, salaries, savings and closing amounts.
Separate checks verify how later collections affect an earlier jornada.
[`adversarial-round17.test.ts`](../tests/integration/adversarial-round17.test.ts)
verifies cumulative safe-integer bounds on savings pool deposits, goal deadline
calendar parsing, and cache revalidation across shift and savings actions.

Analytics specs cover ADMIN checks, filter validation, current PAID status,
historical item prices, dates, pagination, exports, missing values and CSV
handling. There is no settings integration spec or full JWT cookie cryptography
test outside `authorizeCredentials`.

## Browser tests

```bash
npx playwright install --with-deps chromium # First Linux setup
npm run test:e2e
npm run test:e2e -- tests/e2e/20-pos.spec.ts
npm run test:e2e -- tests/e2e/80-analytics.spec.ts
```

[`playwright.config.ts`](../playwright.config.ts) configures:

| Setting | Behavior |
| --- | --- |
| Database | E2E_DATABASE_URL from environment or `.env`. No default. Global setup rejects missing/invalid test names |
| Server | Next.js development server on port 3100, with an Auth.js secret used only in tests and host trust |
| Execution | One worker, zero retries and shared seeded database. Global setup reseeds but does not apply schema |
| Login | Setup project stores ADMIN state in `tests/e2e/.auth/admin.json` |
| Views | Desktop plus Pixel 7 runs for expenses, POS and analytics |
| Browser | Installed Microsoft Edge on Windows. Elsewhere version-matched Playwright Chromium; CHROMIUM_EXECUTABLE_PATH overrides it |

The desktop project label does not change Windows execution to Google Chrome.
On Linux, install the locked Playwright browser and system dependencies with
`npx playwright install --with-deps chromium`, or supply a local executable
through CHROMIUM_EXECUTABLE_PATH.
Playwright starts its own server on port 3100 with the test database and refuses to reuse an existing server.
Use a separate checkout or stop another Next.js development server in the same
checkout before running the suite: both otherwise use `.next/dev`.

Browser specs cover login/access, cash and transfer confirmation, debt
collection, CRUD, salary confirmation, stock/CRM filters, jornada closure and
analytics exports. These files' existence does not certify a deployment.

[`98-mobile-pagination-fixed.spec.ts`](../tests/e2e/98-mobile-pagination-fixed.spec.ts)
sets 320px and 800px viewports explicitly within the desktop project. It covers
fixed controls across the paginated modules, empty and single-page lists,
size changes and the embedded recipe picker. The separate mobile project
matches only the expenses, POS and analytics filenames listed in the config.

For a focused pagination run:

```bash
npm run test:e2e -- tests/e2e/98-mobile-pagination-fixed.spec.ts --project desktop
```

### Pagination focus regressions

[`99-adversarial-5de86fc.spec.ts`](../tests/e2e/99-adversarial-5de86fc.spec.ts)
covers focus when a mobile size change collapses the list to one page.
[`100-adversarial-focus-round2.spec.ts`](../tests/e2e/100-adversarial-focus-round2.spec.ts)
covers mobile/tablet view replacement, hiding a focused mobile control on
desktop, closing the selector after resizing and returning to the recipe
supply search after its pagination disappears.

Together with spec 98, these checks passed 30 tests in local Chromium,
including authentication setup:

```bash
npm run test:e2e -- \
  tests/e2e/98-mobile-pagination-fixed.spec.ts \
  tests/e2e/99-adversarial-5de86fc.spec.ts \
  tests/e2e/100-adversarial-focus-round2.spec.ts --project desktop
```

[`101-adversarial-focus-round3.spec.ts`](../tests/e2e/101-adversarial-focus-round3.spec.ts)
contains four failing reproductions tracked in
[#71](https://github.com/lm-vicente-j/comal-core/issues/71). They are active tests, so the full browser
suite is not green:

| Case | Observed failure |
| --- | --- |
| Mobile next-page request with a slow response | Focus stays on `body` after the next page loads |
| Desktop page-size change with a slow response | Focus stays on `body` after the selector is enabled again |
| Next-page request clamped to one page after records are removed | Pagination disappears and focus stays on `body` |
| Open desktop size selector resized to the mobile navigation layout | Closing the selector leaves focus on `body` |

Run those reproductions separately:

```bash
npm run test:e2e -- tests/e2e/101-adversarial-focus-round3.spec.ts --project desktop
```

The tests insert isolated fixture rows and delete them in cleanup. The slow
requests are delayed in the browser; the clamp case removes only its own rows.

When testing pagination layout, check that the last record and its actions
remain reachable above the fixed bar. Check keyboard focus when a selector
closes or disappears, including after a size change. A visible navigation bar
alone does not prove the list remains usable.

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
npx prisma db execute --file prisma/migrations/20261125000000_unique_open_jornada/migration.sql
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
npx prisma db execute --file prisma/migrations/20261125000000_unique_open_jornada/migration.sql
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
fixtures. The helper also applies the Spanish customer collation and the
partial unique index for OPEN jornadas, which `db push` alone does not provide.
The E2E seed is `tests/e2e/seed.ts`.

## Choose checks for the change

| Change | Checks |
| --- | --- |
| Documentation | Local links/anchors, source paths, action coverage, formatting and `git diff --check` |
| Action or business rule | Relevant integration files. Browser specs for changed confirmation flows |
| UI | Relevant desktop/mobile browser specs and targeted lint |
| Schema, authentication or permissions | Impacted checks across affected modules |

Prepare test databases before a first run or schema change.
`npm run lint` runs ESLint. `npm run build` applies migrations before building. Do not use it to check documentation.

## Regression quality and cleanup

Authentication setup exercises the successful ADMIN login and shares its session.
The authentication spec covers rejection and guest redirects. Desktop/mobile-only
POS cases use project tags, so mismatched cases never navigate or run hooks.
Cash validation includes empty/insufficient Enter handling and recovery in one
scenario. POS teardown cancels only new, still-unpaid fixture sales, restores their
recorded ingredient consumption and releases their new reservations, even after
failure. It preserves paid/debt records and does not change the failed outcome.
Pagination regressions select the named Edit action independently of activity
buttons. Browser checks exercise actual Menu editor state instead of inspecting
static markup; customer tests verify ADMIN editing and unchanged records after
guest/STAFF attempts. The meaningless timing loop in the integration pagination
suite is replaced by the dedicated benchmark runner's measured P95 checks.

Pure source-text checks remain in older adversarial files where equivalent runtime
coverage has not yet been established. Their regex checks do not substitute for
browser or persisted-state verification. Preserve recognized failing reproductions.

## Continuous integration

[ci.yml](../.github/workflows/ci.yml) runs on pull requests targeting `dev` or
`main`, pushes to either branch, and manual dispatch. All paths trigger it.
A newer run cancels an older run for the same PR or reference.

| Check | Command | Timeout |
| --- | --- | --- |
| `CI / Lint` | `npm run lint` | 10 minutes |
| `CI / Integration` | `npx prisma migrate deploy`, then `npm test` | 20 minutes |
| `CI / Build` | `npm run build` (includes migration deployment) | 20 minutes |
| `CI / Audit` | `npm audit --audit-level=high` | 10 minutes |
| `CI / E2E` | `npx prisma migrate deploy`, then `npm run test:e2e` | 60 minutes |

Each job uses Ubuntu 24.04, Node 24.x and its bundled npm. It performs its own
`npm ci --no-audit --no-fund`, including Prisma client generation. Only npm's
package download cache is shared, keyed by the lockfile. Generated clients,
Next.js outputs and databases are not shared between jobs.

Integration, build and E2E each start a health-checked PostgreSQL 16 Bookworm service
with ICU support on localhost:5432. Integration uses `comalpos_test`, allowed by
the analytics safety guard. Its DATABASE_URL, DIRECT_URL and TEST_DATABASE_URL
point to that service. A runner-only ignored `.env` sets `DEV=true` for Vitest's
testing helper guards. Build uses its own empty `comal_build` database and a
CI-only AUTH_SECRET. E2E uses `comalpos_test_e2e`; its runtime, migration and
E2E URLs all point to its own service. VERCEL_ENV is empty in these jobs. These credentials are
public disposable fixtures, not deployment secrets.

CI applies the full committed migration history rather than `db push` or the
interactive test database helper. No demo seed runs. Integration retains the
single-worker database isolation rules. E2E installs version-matched Chromium
and Linux dependencies, then runs every configured desktop/mobile browser case.
Its global setup uses only the test seed. The job runs independently, even when
integration fails. Benchmarks remain a separate opt-in runner.

Playwright uses zero retries and rejects accidental `test.only` in CI. Results
stream to the job log; the 60-minute timeout is a ceiling, not a delay before
failures become visible. Playwright has a 55-minute suite deadline to leave time
for reporting. Known failures do not stop other cases or become successful checks.
HTML/JSON reports, screenshots and failure traces are uploaded unless cancelled,
retained for seven days. They contain only synthetic fixture credentials/data.
The browser job starts `next dev`; production compilation has its own build job.

Lint errors block; warnings remain visible without blocking. Audit includes
development dependencies and blocks high/critical findings. Low/moderate
findings remain visible. Installation, registry/network and migration errors
fail their job; no control uses `continue-on-error` or automatic audit fixes.
Build also needs network access for Next.js Google fonts.

Inspect the failed step in the corresponding check's Actions log. Migration
failures precede tests/build; test safety errors usually indicate a wrong URL
or database name. Reproduce with the commands above using disposable local
databases. Never substitute a shared or production connection.

The five check names above can be required by branch protection after the
workflow has run successfully. This change does not configure branch rules,
deploy, or gate the existing private mirror workflow. A green build validates
fresh installations, not upgrades of populated production databases.

### Current CI blockers

Known failures are not waived: CI must remain red whenever these tests fail.
Tracking a failure in an issue does not authorize skipping it, filtering it out,
or suppressing its exit status.

The initial hosted integration run on Node 24 / PostgreSQL 16 reproduced five
legacy-sale guard/revalidation failures in
[#69](https://github.com/lm-vicente-j/comal-core/issues/69). A local Node 26 run
also observed four large-dataset debtor QUERY_FAILED results; isolated reruns and
the hosted run passed those cases. That full-suite symptom and the confirmed
unsafe debtor cash input are tracked in
[#70](https://github.com/lm-vicente-j/comal-core/issues/70).

The browser suite includes the pagination/focus reproductions in #71, the
mobile POS cash-limit reproduction in #69 and the debtor cash-limit
reproductions in #70. Keep these tests active. Additional current
failures should be recorded with their test names and observed behavior rather
than excluded or changed to expected failures. The Actions job log and uploaded
E2E report provide the result for each exact commit; test counts and timing are
not release guarantees.
