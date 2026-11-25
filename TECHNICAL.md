# Technical notes

Use [Architecture](ARCHITECTURE.md) to find the relevant code,
[Business rules](docs/business-rules.md) to understand its behavior, and
[Action reference](docs/actions.md) to check function contracts.

## Working on a change

1. Follow [Getting started](docs/getting-started.md). Install locked dependencies
   with `npm ci`. Its `postinstall` script generates the Prisma client.
2. Find the page, manager component and action file in [Modules](docs/modules.md).
3. Keep the change within the requested scope. Preserve names, dependencies,
   folders and technologies unless the requirement explicitly calls for a change.
4. For schema work, edit `prisma/schema.prisma` and create a migration with
   `npx prisma migrate dev` against a development database. Include the migration
   with the change.
5. Use the existing Server Actions in `lib/actions/`. Validate incoming values
   and derive employee attribution from `auth()`.
6. Check authorization in the action. An ADMIN page or hidden navigation link
   does not authorize a server write.
7. Update desktop/mobile views and navigation where the behavior requires it.
   Route access is defined in `lib/permissions.ts`.
8. Run the relevant [checks](docs/testing.md) and update the affected
   documentation and changelog.

## Action contracts

Shared Zod schemas live in `lib/actions/schemas.ts`. Actions validate selected
fields with `pick`, `omit` or dedicated input objects. Sales and debt actions
validate their main inputs. Savings and jornada use their own guards.
Paginated list actions use the server-safe `lib/pagination` contract and
`createPaginationSchema` for normalization, typed filters and allowlisted sorting.
A TypeScript signature alone does not validate a runtime value.

Mutation Server Actions return the standardized `ActionResult<T>` contract
(`{ success: true, data? }` or `{ success: false, error, fieldErrors?, data? }`)
from `lib/action-result.ts`. Paginated reads return
`ActionResult<PaginatedResult<T>, PaginationError>`, with record counts separate
from monetary summaries. Client list reads use POST
Server Actions; history/session storage retains navigation state without query
parameters. See [Pagination](docs/pagination.md) for the consumer inventory,
exceptions, limits and migration rules. Non-list analytics aggregates and full
exports retain `AnalyticsResult<T>`.

Writes generally call `revalidatePath`. `AutoRefresh` updates Server Components
and notifies subscribed lists; `usePolling` runs separate client callbacks.
`trackAction` pauses `AutoRefresh` ticks while wrapped promises are pending.
After a mutation, call the affected list's `refresh()`; `router.refresh()` alone
does not reload client-owned pages.

Convert Prisma `BigInt` cent and milliunit columns to safe integers with
`lib/scaled-values.ts` and serialize dates before passing them to Client
Components. Monetary, recipe cost and analytics aggregations use exact integer
arithmetic (`lib/monetary.ts`). [Database](docs/database.md) documents these
boundaries.

## Accounts and cash shifts

Build and read `sales.source_type` through `lib/pos-source.ts`:

| Value | Meaning |
| --- | --- |
| `MESA_<n>` | Table account |
| `CL- <customerId>` | Registered customer account |
| `VL-<n>` | Open guest ticket |
| `VENTA_LIBRE` | Settled guest sale |

A product tap normally creates a sale record. Guest sales share a ticket UUID.
Checkout submits the selected sale IDs and confirmed total. One account payment
may settle several records, so record count is not ticket count or customer visits.

Use `getJornadaCashSummary` in `lib/jornada-cash.ts` for the live cut and closing
amounts. A debt collection belongs to the jornada receiving the money. It must
not also count as a direct sale of the original jornada.
Savings deposits reduce the expected cash. Withdrawals reduce the pool balance.
See [Business rules](docs/business-rules.md#5-jornadas-and-cash).

## Authentication, settings and UI

The shared `app/auth.config.ts` JWT callback uses Prisma to read the current
user activity and role on each session check. The proxy runs on the Node.js
runtime. Keep bcrypt, role-aligned credential verification and failed-attempt
lockout in `lib/auth.ts`, `lib/auth-credentials.ts` and `lib/auth-lockout.ts`,
and route/role helpers in `lib/permissions.ts`.

Business settings use `setting` and `lib/actions/settings.ts`. Only `CLABE` is
implemented as a business setting; `setting` also stores ephemeral
`TICKET_RES:<jornadaId>:<ticketNumber>` guest ticket reservations and
`AUTH_LOCKOUT:<userId>` failed-attempt counters for known accounts. Terminal
names use `lib/device-settings.ts` and browser `localStorage`.

Keep interface text in Spanish. Desktop navigation appears at the `lg`
breakpoint and above. Smaller screens use the bottom navigation and Menu sheet.
Use the shared `DataPagination` for lists. Below `lg`, its page controls stay
above the bottom navigation and disappear for empty or single-page results.
Embedded pickers use `placement="inline"`. Keep Jornada in the mobile user menu
and the desktop banner. See [Pagination](docs/pagination.md) for list state and
the exceptions for operational snapshots and full exports.

`usePaginationFocus` tracks the list or picker that owns pagination focus.
Keep `data-pagination-focus-scope` on the dashboard content, excluding the
sidebar. Restoration waits for nested dialogs to close and cancels when its
scope is removed or the route changes. See the documented
[remaining focus failures](docs/testing.md#pagination-focus-regressions) before
claiming a complete keyboard navigation pass.

## Table compiler boundaries

The four components owning TanStack Table v8 instances use function-level
`"use no memo"` directives. Its mutable table API is incompatible with automatic
memoization. This temporary integration boundary preserves updates without
turning off the incompatible-library lint rule for other code. The current
linter still reports this known API despite the opt-out, so each table owner
acknowledges that diagnostic at the call site only. Revisit the
boundary when upgrading to a compiler-compatible table API; do not manually
memoize table-derived values while the mutable adapter remains in use.
See [React's third-party integration guidance](https://react.dev/reference/react-compiler/directives/use-no-memo).

## Test scope and regression quality

Keep each regression tied to a business rule or observable UI behavior. Prefer
exact action results and persisted state over source-text regex assertions or
checks that a result merely exists. Use otherwise-valid inputs when testing a
single invalid field, so an unrelated guard cannot satisfy the assertion.

Authentication setup owns the successful ADMIN browser login. Tag POS cases
`@desktop-only` or `@mobile-only` when the UI differs; project filters select
them before hooks run. Preserve distinct role, breakpoint, payment and legacy
data coverage when consolidating cases. Known failures remain active and fail CI.

Keep latency sampling and thresholds in the dedicated benchmark runner. Ordinary
integration cases verify pagination correctness without repeated timing loops.
Source-text checks still present in older adversarial files need equivalent
runtime coverage before retirement; they are not grounds for removing real
financial, concurrency or authorization regressions.

## Keeping documentation current

| Change | Documentation to review |
| --- | --- |
| Route, screen or navigation | `docs/modules.md` |
| List contract, navigation state or pagination controls | `docs/pagination.md` |
| Validation, payments, stock or cash rules | `docs/business-rules.md` |
| Exported action/helper, signature, permission or result | `docs/actions.md` |
| Model, enum, relation or database connection | `docs/database.md` |
| Login, session or route access | `docs/auth.md`, `docs/middleware.md` |
| Runtime boundary, transaction or browser state | `ARCHITECTURE.md` |
| Environment, scripts, seed or onboarding | `README.md`, `docs/getting-started.md` |
| Test runner or platform requirements | `docs/testing.md` |
| Build or deployment | `docs/deploy.md` |
| Notable change | `CHANGELOG.md` under `Unreleased` |

Describe action checks separately from UI controls. Link to the source and
state known limits. Do not describe a proposed feature as implemented.

For documentation work, check local links, anchors, source paths, exported
action coverage and `git diff --check`. Database tests are unnecessary for prose
changes. Build applies migrations to the selected database.

The changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Keep dated checkpoints and commit links intact, with the newest entries first.
There are no release tags. The version in `package.json` does not establish a
published release or release date.
