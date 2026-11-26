# Changelog

This file records notable Comal Core changes using
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Dated entries are development checkpoints reconstructed from commit dates.
They may group several related commits. They are not published releases.
The repository has no release tags. Package version `0.7.2` does not establish
a release date. Record new work under Unreleased until a release or checkpoint
is defined.

## [Unreleased]

### Added

- fast-check 4.11.0 properties for monetary precision, recipe costs, physical
  closing snapshots, customer balances and collections across jornadas (#60).
- Server-action fuzzing with boundary and malformed inputs, valid controls,
  persisted-state snapshots, minimized counterexamples and seed/path replay.
- PostgreSQL-lock-controlled adversarial coverage for checkout, debt conversion,
  double collection, closures and expired ticket reservations.
- Browser coverage for network failures before commit and lost responses,
  simultaneous terminals, permission revocation, inventory restoration and
  collection attribution at 320×480 and 1280×800.
- Configured-CLABE regressions for STAFF and SUPERVISOR in POS and Deudores,
  plus ordinary blocking regressions for short-screen POS chips and long
  operator names in the mobile Jornada menu.

- Accountable cash handovers with denomination counts, incoming operator PIN
  confirmation through six masked digit boxes, persistent lockout, immutable
  participant snapshots and outgoing
  difference attribution. Accepted cash establishes the next custodian’s baseline;
  handovers appear in restricted history, closing summaries and CSV (#42).
- Mobile and desktop handover browser coverage and review screenshots.

- Browser regressions for debt checkout after an amount change, stale cash-count
  history after a recount, and recount controls without permission. These three
  known defects use documented expected-failure assertions pending fixes.
- Browser coverage for opening, interim counts, POS cash change and closing as
  ADMIN, SUPERVISOR and delegated STAFF at 320×480 and 1280×800, with persisted
  amount and operator checks.
- Add append-only denomination-based opening, interim, recount and closing cash counts with idempotent requests, cutoff snapshots, privileged discrepancy receipts, owner-configured tolerance, filtered history/CSV and collection attribution by receiving employee and jornada (#34, #35).
- Add compact Hoy/Historial jornada views, mobile count dialogs and a savings-deposit control for authorized operators.
- Add the `CashCountType` enum, append-only `cash_count` schema, request/lookup indexes and restrictive relations; the SQL trigger rejects UPDATE/DELETE, including direct database writes.
- Preserve nullable sale `paidAt`, `paidJornadaId` and `collectedBy` metadata separately from sale creation, with legacy receiving-shift fallback and no fabricated historical counts.

- Unique owner recovery, configurable Supervisor and Service permissions, and immutable PAID sales for every role (#44).
- Owner-managed personnel PINs and authorized fixed/mobile browser devices, including request throttling and session invalidation when credentials or device access change (#43).
- One-time owner registration on an empty, fully migrated installation, protected by the installation secret and a persistent initialization marker (#63).

- Independent GitHub Actions checks for lint, PostgreSQL integration tests,
  migration-backed build, high/critical dependency auditing and full browser E2E
  on dev/main PRs and pushes (#36), with isolated disposable databases and no
  deployment credentials. Browser reports and failure traces are retained for
  seven days; recognized failures remain blocking.

- Reversible product and supply deactivation in desktop/mobile Menu and Inventory, with activity filters and preserved recipes and sales history. Disabled ingredients block new recipes, sales and quantity increases; the POS catalog includes only available products (#67).
- Browser regression coverage for responsive pagination focus, nested recipe pickers, slow page loads and desktop size selectors.
- Informational cash-received input and change/shortfall display in the desktop POS Cerrar cuenta dialog (`lib/cash-change.ts`, `components/Sales-input-client.tsx`).
- Optional customer `Alias` field in desktop and mobile CRM create/edit forms, `Alias` column/card display, and alias search in CRM pagination.
- Integration test suite and performance benchmarks under high volume (1,000 to 5,000 active debtors, 15,000 debts, and skew scenario) for the Debtors module pagination and summary cards (closes #32).
- Business rule reference and catalog of exported actions and helpers.
- Cash cut breakdowns for cash and transfers, including expenses, salaries and
  debt collections. Closing stores expectedTransferAmount alongside expected cash.
- Debt creation and collection history: createdAt, createdJornadaId, paidAt,
  paidJornadaId and collectedBy.
- Salary payments linked to the open jornada.
- Shared Zod input checks for sales, debts, customers, users, products, supplies
  and salary queries. Malformed values return INVALID_INPUT or field errors.
- Shared cash calculation in `lib/jornada-cash.ts` and integration coverage for
  debt collections across jornadas.
- Apache License 2.0.

### Fixed

- Keep mobile pagination regression fixtures scoped to their own products,
  select the current navigation label and wait for modal exit cleanup.
- Use Supervisor fixtures for another operator's jornada, preserving the
  single-owner constraint in round-3 mobile checks.

- Reconcile the Markdown guides with current handover rules, the permission
  matrix, participant schema, migration order, setup and deployment checks, and
  custody/session boundaries in the architecture. Clarify outgoing difference
  attribution and the owner's independent shift-control authority.
- Complete the role-permission and browser-authorization action references;
  document expense authorization/category validation, scoped summaries,
  owner-only salary reporting and server-managed terminal names.

- Reject jornada closure on the server while UNPAID accounts remain, serializing the check with sales and cash movements.
- Keep saved opening and closing count receipts available until dismissal while server revalidation and background refresh update the Jornada screen. Apply current cash-view permissions to open receipts, restore keyboard focus on dismissal and explain stale closed-shift failures.

- Keep one dashboard main landmark on Access and use a Supervisor fixture for
  another operator's open shift, preserving the single-owner constraint and
  existing browser assertions.

- Restore list focus after delayed pagination and page-size changes or closing
  a resized desktop selector. Cancel deferred focus restoration after outside
  interaction, and verify the remaining rows after page clamping (#71).

- Reject debtor cash received above the safe integer-cent limit and cover the
  exact limit, overflow, zero and invalid numeric input on desktop and mobile (#70).

- Serialize legacy debt sale changes with their originating shift and customer
  balance, reject concurrent origin changes, refresh affected sales views after
  commit, and enforce safe integer-cent cash limits in mobile POS (#69).

### Changed

- Organize tests into unit, integration, property, fuzz, adversarial, E2E and
  benchmark folders with shared fixtures in `tests/helpers/`.
- Separate Vitest's PostgreSQL-free `unit` project from its sequential `database`
  project; add commands per suite and the opt-in `test:generated:stress` profile.
- Store test reports, counterexamples, benchmark JSON, screenshots and traces
  under `ci_results/`; both test jobs upload that root with seven-day retention.
- Keep three cash-review regressions and the parameterized CLABE defect as
  explicit expected failures. The two mobile layout defects remain blocking.
- Document test setup, generated budgets, replay, CI diagnostics and current
  validation across the guides; set the package and lockfile version to `0.7.2`.

- Align the 14 documentation files with cash-count denominations, role-specific
  workflows, reproduced defects, browser coverage, explicit seed
  environment loading and expected-failure reporting.
- Cash counts accept coins from 50 cents through 20 pesos. Opening, interim and
  closing forms and server validation share that catalog; 5/10/20-cent coins
  are rejected even with zero quantities. Saved historical counts stay intact.
- Move staff browser authorization into a compact sign-in dialog, with automatic prompting for unauthorized devices, resumable pending requests and a return to the approved sign-in mode. Use the established white/orange mobile login style, clear PIN input after attempts and keep form geometry stable across Owner, Fixed and Mobile modes.
- Access groups Personal, Permisos and Dispositivos, with system confirmation for every mutation, compact actions and a red device revocation icon (#44, #43).

- Consolidated duplicate login and mobile cash regressions, selected POS cases
  by project before setup, replaced selected source/markup checks with browser
  behavior assertions, and kept latency sampling in the benchmark runner.
- Documented capability-controlled customer creation/editing, Playwright-managed Chromium,
  and the five-job CI workflow. Customer edit regressions verify denied writes
  preserve stored data.

- Make PAID sales immutable for every user, including ADMIN. Backend cancellation and quantity edits reject paid sales before changing items, totals or inventory; DEBT and UNPAID permissions remain unchanged.
- Align the documentation with shared POST pagination, mobile navigation, integer-cent action inputs, test setup and fresh-database migration limits.
- Restore keyboard focus within the same list or picker when mobile pagination closes, disappears or changes responsive view, including nested recipe selectors.
- Keep mobile pagination fixed above the bottom navigation across all paginated modules, with reserved space for the last record and local controls for embedded pickers. Hide mobile controls for empty or single-page lists.
- Show all Jornada states only in the user menu below `lg`; keep the status banner on desktop.
- Unify paginated lists on a shared validated contract and responsive controls, with POST Server Actions, local browser navigation state, 10-record defaults and a 50-record limit.
- Keep record counts separate from financial summaries and export complete filtered reports.
- Apply the pagination contract to Debtors, CRM, Menu, Inventory, Expenses, Payroll, Savings and Reports/Statistics; retain POS and Jornada as documented exceptions.
- Put Jornada and Cerrar sesión in the mobile topbar menu. Administrators can open Jornada details, and Staff can view its status.
- Move the mobile login up on shorter screens, tighten the title spacing, and link to the GitHub repository below the form.
- Flatten the login panel and add placeholders for the Administrator and Staff fields, including a dash in each empty PIN slot.
- Give the mobile login a white background, a larger title, and a centered role selector. Stack the Staff labels above their fields and match the Administrator field dimensions.
- Store monetary values as `BIGINT` integer cents (`*Cents`) and supply/recipe quantities as `BIGINT` integer milliunits (`*Milliunits`) across PostgreSQL, Prisma, seed, Server Actions, UI forms/views and tests, with exact `BigInt` arithmetic in `lib/monetary.ts`, safe-integer boundary conversion and signed currency formatting in `lib/scaled-values.ts`, cumulative safe-integer guards across sales/debts/expenses/payrolls, and adversarial regression tests (closes #61).
- Standardize mutation Server Action responses across `lib/actions/` on `ActionResult<T>` (`{ success: true, data? }` / `{ success: false, error, fieldErrors?, data? }`) via `lib/action-result.ts` (closes #51).
- Queue POS product taps sequentially on desktop and mobile so consecutive additions run without blocking product cards, applying a 1-second cooldown only to a product tapped 3 times in a row.
- Require `DEV="true"` in `.env` for testing-only helpers (`resetAllLockouts`) and sync `DEV` from `.env` in integration test setup.
- Enforce frontend numeric-only validation and dot masking on staff PIN inputs in Login and CRM, and set `agentRules: false` in `next.config.ts`.
- Use Next.js 16.4.6 with `experimental.agentUpgrade` disabled, React 19.3.1, TypeScript 6.0.3, Vitest 5.1.1, Playwright 1.65.1, Lucide React 1.77.0, React Day Picker 10.0.2, and updated UI and runtime dependencies (closes #65).
- Update project documentation, architecture, actions, and business rules using fixwrite.
- Rename the project to Comal Core and update repository links.
- Set the package version to `0.2.1`.
- Include fiado collections in the jornada receiving the money, without counting
  the original sale again.
- Deduct cash expenses and salaries from the drawer.
- Require an OPEN jornada for debt creation, debt collection and salary payments.
- Require an explicit payment method for expenses and salaries, without a default.
- Store debtors.paidAt as a timestamp and sales.payment_method as PaymentMethod.
- Make bill.payment_method, salary.payment_method, salary.jornadaId and
  debtors.createdJornadaId required. The migration has no backfill and fails on
  existing rows in the affected tables. Null sale methods no longer count as cash.
- Save parsed product/customer values and validate user email/active field types.
- Cancel an open debtor row and reduce customer balance when its sale is cancelled.
- Read CHROMIUM_EXECUTABLE_PATH from the environment or `.env`.
  Platforms other than Windows use version-matched Playwright Chromium unless
  an explicit executable override is supplied.
- Rewrite the README for installation and usage.
- Clarify action contracts and cash rules in the developer guides.
- Document migration limits and deployment behavior.
- Read test database URLs from the environment or `.env` instead of hardcoded
  values using port 5433. Reject names without a `_test` or `_test_e2e` suffix before
  fixtures delete data.
- Check database readiness before either test suite. A connection failure or
  missing database stops the run. Missing schema also stops it. The error is
  `#:ERR:: TEST DATABASE NOT READY` and includes setup instructions.
- Warn before running tests against a populated database. Wait two seconds
  before continuing. Ctrl+C cancels before modification. Test execution never
  prompts.
- Provide `npm run test:setup`. The helper uses LOCAL_POSTGRES
  to find psql and no longer starts a PostgreSQL cluster. It offers to create
  missing databases and asks whether to reset, reuse or cancel existing ones.
- Preserve linked historical checkpoints and clarify that demo/test fixtures
  delete data, build applies migrations, and runtime/CLI use separate connections.

### Fixed

- Browser fixture cleanup after failed POS cases and named Edit selectors in
  pagination regressions, preventing cascading or ambiguous-locator failures.

- Explicit component-level React Compiler boundaries for the mutable TanStack
  Table v8 integration in CRM, Inventory, Menu and Debtors.

- Stable CRM reset callbacks and complete effect dependencies when changing tabs.
- Unused imports, variables and type-only runtime schema construction.
- Existing lint errors through typed action DTOs, Prisma fixture inputs,
  narrowed errors and React lifecycle corrections, without weakening lint rules.

- Add pinned `MobilePagination` controls (`components/pagination/mobile-pagination.tsx`) with quick page selection and visible scrollbars across mobile Menú, CRM, Deudores, Estadísticas, and Reportes views, update `useAdminList` to preserve totals while loading, clamp out-of-range pages, retry failed loads, and refresh on `AutoRefresh` ticks, route open-jornada status and expected cash exclusively through the mobile topbar menu on viewports below `lg`, and show the mobile POS bottom bar only when an open account is selected (closes #66).
- Enforce a single open jornada with a partial unique index (`jornada_one_open_idx`) and `P2002` fallback, serialize savings pool movements with PostgreSQL advisory locks and cumulative safe-integer bounds checks, lock goal updates, cancellations, and contributions with `FOR UPDATE`, validate goal deadlines strictly without rollover or offset shifts, close shifts atomically inside a single transaction, revalidate shift and savings routes, and add regression coverage in `tests/adversarial/adversarial-round17.test.ts` (closes #20).
- Snapshot per-unit ingredient consumption in `sale_item_consumptions` (`sale_items.consumptionRecorded`) when creating sales so `cancelSaleAction` and `updateSaleQuantity` reverse or adjust the original consumed supplies even after menu recipe edits, lock touched supplies in ascending ID order before stock bounds checks, enforce paid-sale employee breakdown bounds when `payment_method` is null, and revalidate `/pos`, `/admin/inventory`, and `/debtors` after transaction commit (closes #30).
- Keep the mobile POS title, account controls, search field and bottom navigation visible while scrolling the product catalog.
- Cancel stale alert dismissal timers in desktop CRM (`app/(dashboard)/admin/crm/crm-manager.tsx`) so consecutive customer or staff saves keep their success notice visible.
- Preserve visible CRM list rows without loading flicker or data replacement when background `AutoRefresh` or silent refreshes return unchanged data.
- Permanently prune retired optimistic POS queue entries once committed or superseded by a newer server snapshot so concurrent item cancellations never resurrect gray rows or lock the POS UI.
- Keep the desktop Cerrar cuenta dialog receipt and total synchronized with live account updates while open, snapshotting the checkout when confirming cash or transfer payment.
- Keep optimistic POS sale rows visible until their confirmed server records arrive, preventing pending lines from disappearing between creation and revalidation.
- Require the selected sale IDs and the confirmed total at POS checkout. Reject stale selections or sales from another shift, and preserve the receipt while the operator reviews it.
- Keep guest ticket accounts tied to a persistent ID when a ticket number is reused. Serialize shift changes, payments, cash movements and related balance updates.
- Paginate CRM and Menu on the server, apply Spanish customer name ordering, and refresh the edited page before a record can be reopened. Retry failed list queries.
- Share login lockouts for known accounts across server instances, preserve compatible legacy credentials, and isolate Preview runtime and migrations from production databases.
- Handle missing expense descriptions and historical dates, and use the Mexico City calendar for the default expense date.
- Reserve guest ticket numbers (`VL-<n>`) atomically across terminals using PostgreSQL-persisted reservations (`setting`) with `pg_advisory_xact_lock`, token validation, 15-minute TTL expiration, and POS desktop/mobile lifecycle integration (#29).
- Close admin PIN login gaps by enforcing stored role alignment in credentials providers, adding a 5-attempt / 15-minute failed-login lockout, removing the default PIN from seeded admins, restricting `GetAllUsers`/`searchUsers` to ADMIN, and redacting user directory fields in STAFF `getSalesHistory` reads (#19).
- Prevent unsafe sale cancellations and quantity edits by making PAID sales
  immutable for every role, restricting DEBT changes to ADMIN, blocking edits on
  closed jornadas, cancelled sales and paid debts, and synchronizing open
  debtor/customer balances on quantity edits (#13).
- Align `getTodaySalesHistory` and `saveExpense` dates with business timezone midnight (`America/Mexico_City`) while keeping active-jornada `UNPAID` accounts visible across midnight and formatting expense dates without local timezone drift (#12).
- Add HTTP security headers in `next.config.ts`, sanitize server action error responses, and clamp pagination/search limits to safe bounds (`1..100`) (#17).
- Close POS accounts using the specific `saleIds` shown on screen so concurrent additions are not settled unexpectedly (#11).
- Detect and surface shift changes (`DIFFERENT_JORNADA`) during POS cash checkout instead of silently succeeding with count zero (#58).
- Enforce central `isAdmin()` role checks on administration-only jornada and sales data reads (#16).
- Require an explicit email for one-time owner creation and block demo seeding
  in production (#18).
- Identify registered customer POS accounts by customer ID (`CL- <customerId>`) instead of customer name to prevent account collisions (#10).
- Expose desktop pagination controls (`TablePagination`) in CRM (customers and staff) and Menu tables (#25).
- Fix the desktop menu product editor title (`Editar Producto`) and add direct ingredient editing access (`Editar insumos`) (#53).
- Adjust POS product card layout and price badges for multiline wrapping of long product names (#54).
- Show an explicit empty-catalog message in desktop and mobile POS when no products are registered (#52).
- Display a placeholder for expenses with a missing or empty description (#57).
- Require at least one surname in full user names for validation and username generation.
- Enforce six-digit numeric PINs for staff and passwords for the unique owner;
  invalidate existing staff sessions after role or credential changes.
- Enforce product sale prices strictly greater than recipe base costs rounded to two decimal places, limit product names to 40 characters, and revalidate the menu page.
- Expand the salary period column to 65 characters and validate that payment reasons do not exceed 50 Unicode code points (up to 65 with prefix).
- Paginate debtors on the server with customer grouping, native SQL summary aggregations, and lazy-loaded breakdown.
- Deduct savings deposits from expected cash and apply withdrawals only to the
  savings balance.
- Reject eligible debt creation or collection batches when their customer ownership does not match.
- Reload user activity and role on every session check so deactivation and role
  changes take effect for existing sessions.
- Restrict customer contact and balance fields and supply costs in STAFF reads.
- Enforce uniqueness of non-NULL user email and username values in the database.

- Check preserved recipe costs when editing product prices, reject negative recipe
  quantities, and allow positive fractional unit costs in inventory.
- Require positive integer sale quantities and explicitly cancel a sale when its POS quantity is decremented from one.
- Refresh inventory and the dashboard banner after product deletion and savings movements.
- Preserve goal deadline dates across time zones and validate the complete salary period against the 50-character limit.
- Accept nullable fields in expense and salary history records.

- Keep the cash settlement dialog open when closing an account fails.
- Keep the POS product catalog current while preserving the active search.
- Return an empty array when the product query fails.

### Removed

- Committed screenshots under `docs/UI_Screenshots/`. Browser captures are CI
  artifacts; the Access coverage guide is `docs/access-validation.md`.

## [2026-10-01] - 2026-10-01

### Added

- Descriptive statistics restricted to ADMIN.
- Date filters and comparisons with the previous period.
- Breakdowns for sales, products, expenses, salaries and customer activity.
- Sales, products, expenses, salaries, customers and reports of pending debt with
  pages of 50 rows, complete CSV export and browser printing.
- Manual confirmation of transfer receipt with shared CLABE/total dialog in desktop
  and mobile POS and Deudores.
- Analytics integration/browser coverage, including mobile views and exports.

## [2026-09-30] - 2026-09-30

### Added

- Required confirmation of received cash and change calculation in mobile POS.
- Confirmation of received cash and change in Deudores and salary registration in two steps.
- Inventory stock filters, grams as a unit option and CRM registration/name ordering.

### Fixed

- Keep mobile payment totals and buttons reachable during scrolling.
- Prevent Enter in the mobile cash input from recording payment.
- Show insufficient/invalid cash errors and keep jornada closing controls visible.
- Require a nonblank expense description and show it alongside category in history.

## [2026-09-14] - 2026-09-14

### Added

- Split developer documentation into architecture, technical notes, changelog and
  setup/auth/database/module/testing/deployment references.

### Changed

- Replace the previous committed SQL dump with Prisma schema/migration guidance.

## [2026-09-12] - 2026-09-12

### Fixed

- Truncate the POS A deuda customer label so it stays in the action row.

## [2026-07-31] - 2026-07-31

### Added

- Dedicated mobile POS and jornada summary.
- Reusable guest tickets and one Cerrar cuenta flow for all account types.
- Optimistic product taps, line quantity changes and removal.

### Changed

- Load POS data in parallel and reduce transferred fields.
- Deduplicate jornada queries per render and pause layout refresh during tracked actions.

### Fixed

- Remove duplicate reloads after POS writes and clear the account view after settlement.

## [2026-07-24] - 2026-07-24

### Added

- Business/device settings tabs, shared CLABE and terminal name saved in each browser.
- Account receipt and customer search on the server in POS.

### Changed

- Run Prisma migration deployment as part of build.
- Separate runtime and migration database connection URLs.

## [2026-07-21] - 2026-07-21

### Added

- Real UNPAID table/customer lifecycle with jornada close blocked by open accounts.
- Session checks on domain actions and sale and expense attribution from the session.
- Shared refresh across sessions.
- Jornada notice for STAFF, without editing controls.
- Management views for mobile browsers.
- Integration coverage for mutations, browser CRUD flows and incremental history.
- Expense registration in a dialog.

### Fixed

- Scope account closure to the active jornada and exclude unpaid/cancelled sales
  from expected cash.
- Keep credential hashes on the server.
- Strengthen user, customer and product actions.
- Bind menu price inputs.
- Stabilize history ordering.
- Reject product prices below base cost when a recipe is supplied.
- Fix native scrolling and interactions on small screens in mobile POS.

### Removed

- Replaced BannerRefresher component.

## [2026-07-18] - 2026-07-18

### Added

- Auth.js JWT credentials login with sessions lasting eight hours.
- Centralized route permissions, mobile navigation and login loading feedback.

### Fixed

- Hide the mobile Menu entry when a role has no additional options.
- Allow numeric inventory/menu inputs to be cleared.

## [2026-06-04] - 2026-06-04

### Changed

- Update application dependencies.

## [2026-05-27] - 2026-05-27

### Added

- Jornada cash shift records and open/close workflow.
- Savings pool movements and goals.
- Cash/transfer payment methods and inventory soft deletion.

### Fixed

- Sales summaries and POS product filters.

## [2026-04-14] - 2026-04-14

### Added

- Shared Zod schemas/action validation, form feedback and mobile inventory.
- Expense category and receipt path fields.

### Fixed

- CRM password updates and PIN controls for each role.
- Optional login fields, expense submission and inventory/menu number handling.

## [2026-03-24] - 2026-03-24

### Added

- CRM for customers and users with data stored in the database and debt collection.
- Conversion of POS sales to debt, customer consumption tracking and debtor sale uniqueness.
- Sale status enum and persisted sidebar selection.

### Fixed

- POS sale creation/today history, debt totals/details and menu edit field mapping.
- Inventory listing/number casts and CRM form/tab behavior.

## [2026-01-27] - 2026-01-27

### Added

- POS, debtors, inventory, menu, CRM, expenses, login and interface access by role.
- App layout/sidebar navigation and Prisma generation on install.

## [2025-12-30] - 2025-12-30

### Added

- Initial application generated from Create Next App.

[Unreleased]: https://github.com/lm-vicente-j/comal-core/compare/37173f0...HEAD
[2026-10-01]: https://github.com/lm-vicente-j/comal-core/compare/33cdbce...37173f0
[2026-09-30]: https://github.com/lm-vicente-j/comal-core/compare/d7b19c2...33cdbce
[2026-09-14]: https://github.com/lm-vicente-j/comal-core/compare/8703fbc...d7b19c2
[2026-09-12]: https://github.com/lm-vicente-j/comal-core/compare/2636e7e...8703fbc
[2026-07-31]: https://github.com/lm-vicente-j/comal-core/compare/bd4edb1...2636e7e
[2026-07-24]: https://github.com/lm-vicente-j/comal-core/compare/1f1b24e...bd4edb1
[2026-07-21]: https://github.com/lm-vicente-j/comal-core/compare/b35dffb...1f1b24e
[2026-07-18]: https://github.com/lm-vicente-j/comal-core/compare/aee78b2...b35dffb
[2026-06-04]: https://github.com/lm-vicente-j/comal-core/compare/9a23bca...aee78b2
[2026-05-27]: https://github.com/lm-vicente-j/comal-core/compare/08bd728...9a23bca
[2026-04-14]: https://github.com/lm-vicente-j/comal-core/compare/20f96c1...08bd728
[2026-03-24]: https://github.com/lm-vicente-j/comal-core/compare/06824ac...20f96c1
[2026-01-27]: https://github.com/lm-vicente-j/comal-core/compare/166ccf1...06824ac
[2025-12-30]: https://github.com/lm-vicente-j/comal-core/commit/166ccf1
