# Testing

Vitest runs pure tests without PostgreSQL and domain actions against a guarded
test database. Playwright exercises browser flows against a separate database
and app server. Authentication and revalidation are mocked in database tests;
domain database operations are real.

## Test folders and commands

All test folders have one level. Shared support files live in `tests/helpers/`.
`npm test` excludes Playwright and benchmarks; `test:adversarial` selects server
regressions, while browser adversarial files run through `test:e2e`.

| Folder | Coverage | Command |
| --- | --- | --- |
| `tests/unit/` | Pure deterministic regressions | `npm run test:unit` |
| `tests/integration/` | Functional server-action behavior with PostgreSQL | `npm run test:integration` |
| `tests/property/` | Generated domain invariants | `npm run test:property` |
| `tests/fuzz/` | Invalid inputs and numeric boundaries | `npm run test:fuzz` |
| `tests/adversarial/` | Server regressions, races and reordered operations | `npm run test:adversarial` |
| `tests/e2e/` | Browser flows, including `*.adversarial.spec.ts` | `npm run test:e2e` |
| `tests/benchmarks/` | Opt-in performance measurements | `npm run test:benchmarks` |
| `tests/helpers/` | Fixtures, setup, generators, snapshots and barriers | Imported by suites |

`npm test` runs all Vitest suites. Its `unit` project includes `tests/unit/` and
`*.unit.test.ts` files in property/fuzz. Its `database` project includes integration,
adversarial and generated `*.integration.test.ts` files. All database files run
sequentially, including when several suite types are selected. Pure checks do
not run the database readiness gate. Benchmarks share the integration database
and must run separately.

Generated checks use fast-check 4.11.0 with seed **60**, **200** pure examples
and **30** database scenarios per property. `npm run test:generated:stress` uses
**2,000** and **200** respectively. `FC_SEED` changes the seed; `FC_NUM_RUNS`
overrides the example count. Each generated database example, including shrinking,
resets and rebuilds its fixtures. State sequences have at most twelve movements.
Failures save the minimized counterexample, seed and replay path under
`ci_results/counterexamples/` and fail the runner.

Replay one named property only, using its reported path:

```bash
FC_SEED=60 FC_PATH='0:1' npm test -- -t '^customer-balance-and-cross-jornada-collections$'
npm run test:generated:stress -- --project unit
FC_NUM_RUNS=100 npm run test:property
```

In PowerShell, set variables before selecting the property:

```powershell
$env:FC_SEED = "60"
$env:FC_PATH = "0:1"
npm test -- -t '^customer-balance-and-cross-jornada-collections$'
Remove-Item Env:FC_SEED, Env:FC_PATH
```

`FC_PATH` applies to the selected property. Use the seed and path printed by its
failure, and select exactly that named property. `FC_NUM_RUNS` overrides the
standard or intensive budget for the selected generated checks. PostgreSQL
examples run sequentially and must not share their database with another runner.

The pure properties cover scaled-value round trips, proportional allocation,
independent recipe rounding, cash change and denomination totals. Database
properties exercise mixed cash/transfer movements, physical closing snapshots,
recipe consumption, customer balances and collections in later jornadas. Fuzz
adapters verify exact rejection contracts and unchanged domain snapshots;
otherwise-valid fixtures and positive controls keep unrelated guards from
satisfying an assertion.

## Reports and evidence

All generated reports and captures use the ignored `ci_results/` root. The
authentication fixture remains in ignored `tests/e2e/.auth/admin.json`.

| Output | Location | When written |
| --- | --- | --- |
| Vitest JSON | `ci_results/vitest-results.json` | CI, or an explicit JSON reporter command |
| Minimized generated failures | `ci_results/counterexamples/<property>.json` | A property/fuzz check fails |
| Browser screenshots and traces | `ci_results/browser/` | Unexpected browser failures, plus explicit attachments |
| Playwright HTML | `ci_results/html/` | CI |
| Playwright JSON | `ci_results/e2e-results.json` | CI |
| Access panel captures | `ci_results/access-screens/` | Access browser checks |
| Handover captures | `ci_results/issue-42/` | Handover browser checks |
| Benchmark measurements | `ci_results/benchmark-issue32-results.json` | The benchmark runner |

Local runs stream results to the terminal. To write the CI-style browser reports
locally, set `CI=1` before `npm run test:e2e` (`$env:CI = "1"` in PowerShell).
Vitest can write JSON explicitly without changing its selected suites:

```bash
npm test -- --reporter=default --reporter=json --outputFile=ci_results/vitest-results.json
```

Both test jobs upload only `ci_results/`, including failed runs, and retain their
artifacts for seven days. Generated results are excluded from Git, ESLint and
TypeScript discovery. Browser tests do not write screenshots into `docs/`.

**Fixtures delete records in the selected test database.** Use isolated test
databases, never development data you want to keep or production.
See [integration fixtures](../tests/helpers/database.ts) and
[browser fixtures](../tests/helpers/e2e-seed.ts).

## Prepare the databases

```bash
npm run test:setup
```

Run setup on a new machine, after schema changes, or when you need fresh fixtures.
The [helper](../scripts/test-db.sh) needs Bash and psql. It does not start
PostgreSQL. It asks before creating a missing database or resetting an existing
one. See [Test setup](#test-setup).

The test runners also perform a separate readiness check through
[`test-db-gate.ts`](../tests/helpers/test-db-gate.ts), once from each runner's global
setup:

| Database state                                         | Runner behavior                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Server unreachable, database missing or tables missing | Abort with `#:ERR:: TEST DATABASE NOT READY`, the cause and `Run: npm run test:setup`                              |
| Ready and empty                                        | Run                                                                                                                |
| Ready with rows                                        | Print `#:WARN::` and the row count, wait two seconds, then run. Ctrl+C during the wait cancels before modification |

The readiness check does not prompt, including with piped stdin. Fixtures remain
after tests, so subsequent runner invocations normally warn again.
The check verifies table presence, not column compatibility or database constraints.
After a schema change, use setup option 1 to replay all migrations. The setup
helper uses migrations rather than schema push so the single-owner index and
installation-state constraints and cash-count immutability trigger are installed
as well. Disposable fixture resets explicitly TRUNCATE `cash_count` before
deleting referenced rows. They never disable the trigger.

## Integration tests

```bash
npm run test:integration
npm test -- tests/integration/sales.test.ts
npm test -- tests/integration/analytics.test.ts
```

[`vitest.config.ts`](../vitest.config.ts) selects
the explicit projects described above. Tests run in Node. Database files run
sequentially across suite types. Database tests and hooks normally have a
30-second timeout; generated database cases declare a ten-minute budget per
Vitest case so shrinking and the intensive profile can complete.

[`database-setup.ts`](../tests/helpers/database-setup.ts) uses an inherited DATABASE_URL when
present. Otherwise it reads TEST_DATABASE_URL from the environment or `.env`.
It never loads the development DATABASE_URL from `.env`. The guarded integration
setup enables `DEV=true` for fixture-only helpers such as `resetAllLockouts`;
Vite otherwise reserves `DEV` for its own environment flag.
[`assertTestDatabase`](../tests/helpers/test-env.ts) requires a name ending in
`_test` or `_test_e2e`, and rejects other names before fixtures run.

Analytics integration tests additionally require localhost and a database name
ending in `_test` or `_test_e2e`. Analytics browser tests require localhost and
a database name ending in `_test_e2e`.
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
Run benchmarks separately with `npm run test:benchmarks`; they reset the
integration test database and must not run beside integration, property, fuzz
or adversarial database suites.
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
[`cash-counts.test.ts`](../tests/integration/cash-counts.test.ts) covers
denomination validation, atomic opening/closing records, immutable rows,
idempotent retries, tolerance snapshots and settings updates, recounts,
collector attribution, private history and CSV exports. The lock-controlled
[`cash-count-concurrency.test.ts`](../tests/adversarial/cash-count-concurrency.test.ts)
orders counts, expenses, sale creation and competing closures through real
PostgreSQL advisory-lock waiters. It verifies that closure cannot strand an
UNPAID sale and that later movements cannot rewrite an earlier snapshot.
[`cash-count-adversarial.test.ts`](../tests/adversarial/cash-count-adversarial.test.ts)
checks equivalent UUID spellings on idempotent retries.
[`adversarial-round17.test.ts`](../tests/adversarial/adversarial-round17.test.ts)
verifies cumulative safe-integer bounds on savings pool deposits, goal deadline
calendar parsing, and cache revalidation across shift and savings actions.

[`issue69-origin-race.test.ts`](../tests/adversarial/issue69-origin-race.test.ts)
uses real database operations with a scheduling barrier to convert a legacy
UNPAID sale to debt after an edit or cancellation reads its initial origin.
Both mutations must return `SALES_CHANGED` and preserve the converted sale,
line quantities, debt and customer balance. Round 16 also covers concurrent
legacy debt balance bounds, closed originating jornadas and sales cache refreshes.

Analytics specs cover ADMIN checks, filter validation, current PAID status,
historical item prices, dates, pagination, exports, missing values and CSV
handling. Cash-count settings have integration coverage in `cash-counts.test.ts`;
full JWT cookie cryptography is not tested outside `authorizeCredentials`.

## Browser tests

```bash
npx playwright install --with-deps chromium # First Linux setup
npm run test:e2e
npm run test:e2e -- tests/e2e/20-pos.spec.ts
npm run test:e2e -- tests/e2e/80-analytics.spec.ts
```

[`playwright.config.ts`](../playwright.config.ts) configures:

| Setting   | Behavior                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| Database  | E2E_DATABASE_URL from environment or `.env`. No default. Global setup rejects missing/invalid test names                  |
| Server    | Next.js development server on port 3100, with an Auth.js secret used only in tests and host trust                         |
| Execution | One worker, zero retries and shared seeded database. Global setup reseeds but does not apply schema                       |
| Login     | Setup project stores ADMIN state in `tests/e2e/.auth/admin.json`                                                          |
| Views     | Desktop plus Pixel 7 runs for Access, expenses, POS and analytics                                                         |
| Browser   | Installed Microsoft Edge on Windows. Elsewhere version-matched Playwright Chromium; CHROMIUM_EXECUTABLE_PATH overrides it |

The desktop project label does not change Windows execution to Google Chrome.
On Linux, install the locked Playwright browser and system dependencies with
`npx playwright install --with-deps chromium`, or supply a local executable
through CHROMIUM_EXECUTABLE_PATH.
Playwright starts its own server on port 3100 with the test database and refuses to reuse an existing server.
Use a separate checkout or stop another Next.js development server in the same
checkout before running the suite: both otherwise use `.next/dev`.

[`25-debtors.spec.ts`](../tests/e2e/25-debtors.spec.ts) checks cash input at
320×480 and 1280×800, including the exact safe-cent maximum
(`90071992547409.91`), overflow, zero, invalid decimals and `Infinity`.

Browser specs cover login/access, cash and transfer confirmation, debt
collection, CRUD, salary confirmation, stock/CRM filters, jornada closure and
analytics exports. These files' existence does not certify a deployment.

[`89-cash-count.spec.ts`](../tests/e2e/89-cash-count.spec.ts) exercises a
denomination-based interim count, receipt visibility, and the database rejection
of cash count updates and deletes. [`90-jornada.spec.ts`](../tests/e2e/90-jornada.spec.ts)
checks the closing open-account resolution list and fixed count controls at
320×480, 360×640 and desktop sizes, then closes and reopens a jornada using
physical denomination rows. Opening and closing receipt checks trigger a real
visibility-change RSC refresh before **Listo**, verifying receipt persistence
through the active-shift transition.
[`89-cash-count-adversarial.adversarial.spec.ts`](../tests/e2e/89-cash-count-adversarial.adversarial.spec.ts)
checks that dismissing a saved receipt restores launcher focus and permits a
fresh count, and that a rejected savings action releases controls and displays
a connection error. It also verifies that revoked cash-view permission hides
restricted fields in an open receipt after an RSC refresh, and that submitting
a capture for a now-closed shift explains the closure without saving a count.
It also signs in a real STAFF fixture and checks count-only Jornada navigation
from the desktop banner and the mobile user menu without cash-summary access.

### Cash lifecycle and POS review (2026-11-26)

[`88-cash-lifecycle.spec.ts`](../tests/e2e/88-cash-lifecycle.spec.ts) runs the
opening → interim count → POS cash payment with change → blocked closing with
an unpaid account → successful closing flow for ADMIN, SUPERVISOR and STAFF at
320×480 and 1280×800. STAFF opening and closing are explicitly delegated by the
fixture; default STAFF controls and redacted receipts are checked first.
Database assertions verify the authenticated operator, immutable count amounts,
cash expected after returning change, discrepancy and closing attribution.
Every count form must offer 50-cent coins and omit 5/10/20-cent coins.
`cash-counts.test.ts` also rejects those removed denominations on the server,
including zero quantities, before any opening, interim or closing write.

Three cash-review defects remain unresolved. Their browser tests use explicit
Playwright `test.fail` annotations immediately before the failing behavioral
assertion. An expected failure counts as a successful runner outcome; it does
not mean the application behavior is correct. A passing assertion produces an
unexpected pass and fails the run. Remove the annotation with its fix. Fixture
failures before the annotation remain ordinary test failures.

| Severity | Regression and reproduction | Coverage |
| --- | --- | --- |
| High | Open a debt cash checkout at $25, then change the debt and customer balance to $50 in another terminal. Confirm the old $25 dialog. `payAccount` accepts only IDs and method, so it settles $50 without validating the confirmed total. The fixture simulates the external committed edit using SQL; the browser performs the real collection. | `25-debtors.spec.ts`: `does not settle a debt whose amount changed after cash confirmation opened` |
| Medium | In Historial, Recontar an existing count, save and dismiss its receipt. The database has the new count, but `History` retains its initial state after `router.refresh`, leaving rows stale. | `89-cash-history-regressions.adversarial.spec.ts`: `history includes the new recount after dismissing its receipt` |
| Low | Revoke SUPERVISOR `jornada.reconcile` while retaining cash view. Today correctly hides Recuento, but Historial still offers Recontar. The action rejects saving, so this is a misleading control rather than a permission bypass. | `89-cash-history-regressions.adversarial.spec.ts`: `view-only supervisor cannot start a recount from history` |

The fourth known defect affects transfer confirmation: STAFF and SUPERVISOR
cannot read a configured business CLABE through `getSettings`. The parameterized
`104-transfer.adversarial.spec.ts` exercises both roles in POS and Deudores at
320×480 and 1280×800. Each case verifies real login, saved configuration and an
enabled transfer dialog before its `test.fail` assertion. The four known defects
therefore account for eleven expected-failure cases across these browser specs.
The review found related scopes in #35 (count history), #44 (permissions),
#27 (atomic collection) and #60 (concurrency testing), without a dedicated
issue for these reproductions. An INTERIM count may reference an OPENING
count in the same open shift; this is documented behavior, not a defect.

POS browser coverage added for #60:

| Scenario | Browser regression | Verification |
| --- | --- | --- |
| POS → debt → next-jornada collection, customer balance and collector attribution | `103-pos.adversarial.spec.ts`: `POS debt collected in the next jornada preserves attribution` | Real UI transitions plus persisted debt metadata |
| Sale/debt/payment network failure before commit and response lost after commit | `103-pos.adversarial.spec.ts`: `recovers after` cases | Real server request, injected transport failure, exact persisted row count and inventory |
| Simultaneous ticket reservations, expiration and stale selection | `103-pos.adversarial.spec.ts`: `two terminals reserve distinct tickets` | Independent contexts; SQL changes only expiration timestamps |
| Closure in another terminal during create/edit/collect | `103-pos.adversarial.spec.ts`: `another terminal closes the shift` | Actual action held until the other terminal commits; the edit case converts the account to DEBT before closure to isolate the closed-jornada guard |
| Permission revocation and PAID/DEBT role restrictions | `105-permissions.adversarial.spec.ts` | Real role login; request held across revocation/state transition; persisted amounts and quantities checked |
| Quantity edit/cancel inventory restoration and catalog deactivation | `103-pos.adversarial.spec.ts`: quantity and deactivation cases | Real POS actions and consumption snapshots |

These scenarios run at 320×480 and 1280×800 in the desktop project; explicit
viewports avoid duplicating them through the mobile project. Each scenario owns
its jornada, customer, product and ingredient, restores permission overrides and
the previously open jornada, and closes every extra browser context. Immutable
counts remain as closed fixture history; cleanup never disables their trigger.

Debt/payment retries reuse the same sale IDs after a lost response. Sale creation
has no idempotency key: recovery reloads the persisted order before continuing,
rather than replaying an indistinguishable new product order. Initial double
confirmation is exercised in all three transport flows.

The [#60 testing issue](https://github.com/lm-vicente-j/comal-core/issues/60)
tracks this coverage. Tests asserting newly discovered defects remain ordinary
failures; issue tracking alone never authorizes skipping or marking them expected.
Outgoing/incoming operator handovers and PIN confirmation from
[#42](https://github.com/lm-vicente-j/comal-core/issues/42) are implemented and
covered by [Cash handover validation](#cash-handover-validation-42).
The remaining feature-dependent browser flows belong with their implementation issues:
[#45](https://github.com/lm-vicente-j/comal-core/issues/45) for receipt/kitchen
printing, and
[#64](https://github.com/lm-vicente-j/comal-core/issues/64) for deployment origin
and first-run readiness. These scenarios remain pending implementation; they
are not failing tests of existing behavior.

Run the focused cash checks against a prepared disposable test database:

```bash
npm run test:e2e -- \
  tests/e2e/88-cash-lifecycle.spec.ts \
  tests/e2e/89-cash-count.spec.ts \
  tests/e2e/89-cash-count-adversarial.adversarial.spec.ts \
  tests/e2e/89-cash-history-regressions.adversarial.spec.ts \
  tests/e2e/90-jornada.spec.ts \
  tests/e2e/91-cash-handovers.spec.ts --project desktop
```

The desktop project also runs the explicit 320px cash-dialog cases. Use
`npm run test:e2e -- tests/e2e/20-pos.spec.ts tests/e2e/25-debtors.spec.ts`
for POS and debt collection; POS runs in both configured projects, while
Deudores sets its own mobile and desktop viewports within the desktop project.

### Cash-count adversarial validation (2026-11-25)

Cash-count regressions verify canonical UUID retry identity, immutable snapshots,
rejected savings request recovery, receipt dismissal and focus, count-only STAFF
navigation, privileged-field redaction after permission revocation, and capture
rejection after closure. Server cases live under `tests/adversarial/`; browser
cases use `89-cash-count-adversarial.adversarial.spec.ts`.

Fixtures preserve the single-owner constraint. Other-operator jornada scenarios
use Supervisor fixtures while the browser remains signed in as the owner.
Access has one dashboard main landmark; list regressions scope their selectors
to that landmark and assert visible geometry and reachability.

[`98-mobile-pagination-fixed.spec.ts`](../tests/e2e/98-mobile-pagination-fixed.spec.ts)
sets 320px and 800px viewports explicitly within the desktop project. It covers
fixed controls across the paginated modules, empty and single-page lists,
size changes and the embedded recipe picker. The separate mobile project
matches only the Access, expenses, POS and analytics filenames listed in the config.

For a focused pagination run:

```bash
npm run test:e2e -- tests/e2e/98-mobile-pagination-fixed.spec.ts --project desktop
```

### Pagination focus regressions

[`99-adversarial-5de86fc.adversarial.spec.ts`](../tests/e2e/99-adversarial-5de86fc.adversarial.spec.ts)
covers focus when a mobile size change collapses the list to one page.
[`100-adversarial-focus-round2.adversarial.spec.ts`](../tests/e2e/100-adversarial-focus-round2.adversarial.spec.ts)
covers mobile/tablet view replacement, hiding a focused mobile control on
desktop, closing the selector after resizing and returning to the recipe
supply search after its pagination disappears.

[`101-adversarial-focus-round3.adversarial.spec.ts`](../tests/e2e/101-adversarial-focus-round3.adversarial.spec.ts)
covers pending navigation, clamping, desktop selectors and focus ownership:

| Case                                                    | Expected behavior                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| Mobile next-page request with a slow response           | Focus remains in the list after the page loads                        |
| Desktop page-size change with a slow response           | Focus returns to an available list control                            |
| Next-page request clamped after records are removed     | The two remaining rows stay visible and focus returns to the list     |
| Open desktop size selector resized to the mobile layout | Closing the selector restores focus inside the list                   |
| Outside click during pending navigation                 | Completion does not reclaim focus from the user's outside interaction |

Run the pagination checks together:

```bash
npm run test:e2e -- \
  tests/e2e/98-mobile-pagination-fixed.spec.ts \
  tests/e2e/99-adversarial-5de86fc.adversarial.spec.ts \
  tests/e2e/100-adversarial-focus-round2.adversarial.spec.ts \
  tests/e2e/101-adversarial-focus-round3.adversarial.spec.ts --project desktop
```

The tests insert isolated fixture rows and delete them in cleanup. Slow
requests are delayed in the browser; the clamp case removes only its own rows.
The surviving fixture names are compared as normalized text so layout
whitespace does not invalidate the row assertions.

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
npx prisma migrate deploy
npm test
```

Then configure the separate browser database:

```powershell
$env:VERCEL_ENV = "development"
$env:E2E_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/comalpos_test_e2e"
$env:DATABASE_URL = $env:E2E_DATABASE_URL
$env:DIRECT_URL = $env:E2E_DATABASE_URL
npx prisma migrate deploy
npm run test:e2e
```

Set both connection variables for schema commands because Prisma CLI prefers
DIRECT_URL. Close the dedicated shell or restore its environment before running
development commands.

## Test setup

[`scripts/test-db.sh`](../scripts/test-db.sh) reads inherited settings first,
then `.env`:

| Variable          | Purpose                                                    |
| ----------------- | ---------------------------------------------------------- |
| LOCAL_POSTGRES    | Directory containing psql. Falls back to PATH              |
| TEST_DATABASE_URL | Integration test database                                  |
| E2E_DATABASE_URL  | Database for browser tests. Skipped by the helper if unset |

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

Closed stdin also cancels. Option 1 uses `prisma migrate reset --force`; a new
database uses `prisma migrate deploy`. The helper sets both DATABASE_URL and
DIRECT_URL for schema/seed commands, preventing the development DIRECT_URL in
`.env` from taking precedence. Migrations install the customer collation, OPEN
shift and owner uniqueness indexes, and the installation marker. Integration
specs create their own fixtures. The E2E seed is `tests/helpers/e2e-seed.ts` and requires
PIN_LOOKUP_SECRET from the environment, as described in [Authentication](auth.md).

## Choose checks for the change

| Change                                | Checks                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| Documentation                         | Local links/anchors, source paths, action coverage, formatting and `git diff --check` |
| Action or business rule               | Relevant integration files. Browser specs for changed confirmation flows              |
| UI                                    | Relevant desktop/mobile browser specs and targeted lint                               |
| Schema, authentication or permissions | Impacted checks across affected modules                                               |

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

[ci.yml](../.github/workflows/ci.yml) runs checks only in
`lm-vicente-j/comal-core`, on pull requests targeting `main`, pushes to `main`,
and manual dispatch from `main`. All paths trigger it. Each job checks the
repository and event context; checks are skipped in the private mirror.
A newer run cancels an older run for the same PR or reference.

| Check              | Command                                              | Timeout    |
| ------------------ | ---------------------------------------------------- | ---------- |
| `CI / Lint`        | `npm run lint`                                       | 10 minutes |
| `CI / Integration` | `npx prisma migrate deploy`, then `npm test`         | 20 minutes |
| `CI / Build`       | `npm run build` (includes migration deployment)      | 20 minutes |
| `CI / Audit`       | `npm audit --audit-level=high`                       | 10 minutes |
| `CI / E2E`         | `npx prisma migrate deploy`, then `npm run test:e2e` | 60 minutes |

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
interactive test database helper. No demo seed runs. Vitest keeps every database suite sequential; its pure project needs no
PostgreSQL setup. E2E installs version-matched Chromium
and Linux dependencies, then runs every configured desktop/mobile browser case.
Its global setup uses only the test seed. The job runs independently, even when
integration fails. Benchmarks remain a separate opt-in runner.

Playwright uses zero retries and rejects accidental `test.only` in CI. Results
stream to the job log; the 60-minute timeout is a ceiling, not a delay before
failures become visible. Playwright has a 55-minute suite deadline to leave time
for reporting. Unexpected failures do not stop other cases and fail the job.
The three cash-review regressions and the parameterized known CLABE
regression above are expected failures; a green job still leaves those defects unresolved.
Vitest JSON, generated counterexamples and Playwright HTML/JSON reports,
screenshots and failure traces are uploaded from `ci_results/` unless cancelled,
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

### CI regression tracking

Unannotated regression failures remain blocking. Tracking a failure in an issue
does not authorize skipping it, filtering it out or suppressing its exit status.
The documented cash-review and CLABE tests explicitly record expected failures;
keep their unresolved status visible and remove each annotation with its fix.

The initial hosted integration run on Node 24 / PostgreSQL 16 reproduced five
legacy-sale guard/revalidation failures in
[#69](https://github.com/lm-vicente-j/comal-core/issues/69). A local Node 26 run
also observed four large-dataset debtor QUERY_FAILED results; isolated reruns and
the hosted run passed those cases. That full-suite symptom and the confirmed
unsafe debtor cash input are tracked in
[#70](https://github.com/lm-vicente-j/comal-core/issues/70).

The browser suite retains the pagination/focus reproductions from #71, the
mobile POS cash-limit case from #69 and the debtor cash-limit cases from #70
as ordinary regression tests. Those issue references describe their origin,
not the status of the current commit. Record additional failures by test name
and observed behavior; do not silently exclude them or mark them expected.
The Actions job log and uploaded
E2E report provide the result for each exact commit; test counts and timing are
not release guarantees.

## Access and device validation

`06-access.spec.ts` exercises automatic authorization-dialog opening on staff
sign-in, real owner approval, returning to the matching terminal mode, PIN
clearing/re-entry, and stable heading/tab/submit/footer geometry across Owner,
Fixed and Mobile at 320, 360 and 1280 pixels. It also covers both PIN modes, permission changes
in an existing session, operator switching, and terminal revocation. It captures
the Spanish Access panels in `ci_results/access-screens/` and checks for overlapping
controls at 320, 800, and 1440 pixels. Browser fixture approval for unrelated
domain specs lives in `tests/helpers/e2e-access.ts`; the Access flow itself uses
real UI approval. See [Access validation](access-validation.md).

The security integration tests cover one-time bootstrap and migration failure
gates, the unique owner index, PIN collision retries including inactive accounts,
concurrent account lockout, persistent terminal throttling, credential and device
revocation, absolute eight-hour expiry, recovery, and independent role permissions.
They also check that `getBrowserTerminalAccess()` reads only the current
browser's authorization-cookie hash and returns its active terminal type or
null, without leaking terminal details.


### Cash handover validation (#42)

`tests/integration/cash-handovers.test.ts` covers custody, PIN verification and
persistent lockout, invalid/inactive recipients, permission revocation, count
validation, empty drawers, discrepancy notes/tolerance, immutable participant
snapshots, retry conflicts, closed jornadas, restricted history/CSV/summary,
concurrent delivery and coordination with cash movements. Successive shortage
and surplus cases verify that a previous operator’s difference is not charged
again to the next custodian.

`tests/e2e/91-cash-handovers.spec.ts` runs the real confirmation flow at 393×852
and 1440×1000. It checks six masked PIN boxes, a rejected PIN, a confirmed shortage, persisted
participants, custody refresh, history filtering and horizontal overflow.
Review captures are stored under `ci_results/issue-42/`.

Independent adversarial review found that renaming the outgoing operator could
change a saved receipt’s display name. The participant snapshot regression
freezes both names across history, CSV, closing summaries and identical retries.
This is covered by #42’s handover audit scope and related to #35’s immutable
counts; no separate matching rename issue was found.

The handover suites run within the complete database/browser configuration.
Current result scopes are recorded in the validation section below; counts for
individual features are not deployment guarantees.

## Issue #60 validation (2026-11-26)

Checks use disposable local databases and synthetic credentials. The inventory
check preserves 575 named test/describe blocks across the selected test/support
files. Shared fixtures enforce one owner, isolated browser jornadas and
trigger-safe cash-count cleanup.

| Check | Verified scope and result |
| --- | --- |
| Complete Vitest run | 479 passed across 51 files |
| Pure project with unreachable, non-test database URLs | 18 passed; no PostgreSQL dependency |
| Intensive profile | 39 verified checks with seed 60, 2,000 pure examples and 200 database examples per property |
| Seed/path replay | Reproduces the same minimized counterexample |
| POS/CLABE/permission browser suites | 57 expected outcomes, including eight known CLABE failures |
| Complete browser sweep | 219 cases executed; the suite remains blocking on the mobile defects below |
| Final round-3 mobile rerun | Three passed, including setup and the complete pagination flow; two ordinary layout failures |
| TypeScript | Passed with regenerated Next.js route types |
| Lint | No errors; one existing unused `receiver` warning in `tests/adversarial/issue69-origin-race.test.ts` |

The generated corpus treats confirmed empty counts as valid and guarantees that
invalid source/name lengths remain too long after trimming. Initial and focused
intensive reports are separate; `ci_results/generated-validation.json` records
the verified generated outcomes. Browser reports retain screenshots, traces and
measured geometry. Expected failures do not certify the affected application
behavior, and counts are not release guarantees.

### Blocking mobile regressions

These two layout defects remain ordinary failures, without `skip` or `test.fail`:

| Severity | Reproduction and observed behavior | Regression |
| --- | --- | --- |
| Low | Open POS at 320×480 while another operator owns the jornada, select Mesas and table 1. The chip row is 48px high inside its 44px wrapper. The product grid is 156px high; the failed assertion concerns chip-row bounds. | `97-adversarial-mobile-r3.adversarial.spec.ts`: `MobilePosManager preserves chip row bounds and at least one product card height on short viewports` |
| Medium | Give the operator a 50-character unbroken name, view POS as owner at 320px and open Menú de usuario. The Jornada entry has scroll width 498px inside a 294px menu, clipping the name beyond the viewport. | `97-adversarial-mobile-r3.adversarial.spec.ts`: `JornadaBanner wraps long unbroken admin names without horizontal overflow on 320px viewports` |

The pagination case in that file filters eleven fixture products, removes one,
waits for modal exit cleanup and restores it without reopening the selector.
It passes. Running the entire round-3 file still fails on the two layout cases:

```bash
npm run test:e2e -- tests/e2e/97-adversarial-mobile-r3.adversarial.spec.ts --project desktop
```

These findings concern the mobile UX area of closed
[#66](https://github.com/lm-vicente-j/comal-core/issues/66), whose body does not
include these exact reproductions. No dedicated matching issue was found in the
issue search. Coverage and unresolved status are recorded under
[#60](https://github.com/lm-vicente-j/comal-core/issues/60). The four known
cash/POS defects documented above also remain unresolved.
