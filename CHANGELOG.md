# Changelog

This file records notable Comal Core changes using
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Dated entries are development checkpoints reconstructed from commit dates.
They may group several related commits. They are not published releases.
The repository has no release tags. Package version `0.2.28` does not establish
a release date. Record new work under Unreleased until a release or checkpoint
is defined.

## [Unreleased]

### Added

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

### Changed

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
  Platforms other than Windows default to `/opt/pw-browsers/chromium`.
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
- Rename `npm run test:db` to `npm run test:setup`. The helper uses LOCAL_POSTGRES
  to find psql and no longer starts a PostgreSQL cluster. It offers to create
  missing databases and asks whether to reset, reuse or cancel existing ones.
- Preserve linked historical checkpoints and clarify that demo/test fixtures
  delete data, build applies migrations, and runtime/CLI use separate connections.

### Fixed

- Paginate CRM and Menu on the server, apply Spanish customer name ordering, and refresh the edited page before a record can be reopened. Retry failed list queries.
- Handle missing expense descriptions and historical dates, and use the Mexico City calendar for the default expense date.
- Require an explicit email for administrator creation or promotion and block demo seeding in production (#18).
- Identify registered customer POS accounts by customer ID (`CL- <customerId>`) instead of customer name to prevent account collisions (#10).
- Expose desktop pagination controls (`TablePagination`) in CRM (customers and staff) and Menu tables (#25).
- Fix the desktop menu product editor title (`Editar Producto`) and add direct ingredient editing access (`Editar insumos`) (#53).
- Adjust POS product card layout and price badges for multiline wrapping of long product names (#54).
- Show an explicit empty-catalog message in desktop and mobile POS when no products are registered (#52).
- Display a `"Sin descripción"` placeholder for expenses with a missing or empty description (#57).
- Require at least one surname in full user names for validation and username generation.
- Enforce four-digit numeric PINs for staff and passwords for admins; preserve login access when switching roles.
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
