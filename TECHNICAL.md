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
validate their main inputs. Savings and jornada use their own guards. The CRM
and Menu list actions use `AdminListQuerySchema` for server-side pagination.
A TypeScript signature alone does not validate a runtime value.

Results vary by action: `success/error`, `success/message`, `msg`, arrays and
paginated objects all exist. Follow the specific function's contract. Analytics
return explicit failures instead of converting a failed query into empty data.

Writes generally call `revalidatePath`. `AutoRefresh` and `usePolling` refresh
other sessions' views. `trackAction` pauses only layout refresh for wrapped
promises.

Serialize Prisma Decimal values and dates before passing them to Client
Components. Analytics aggregate with Decimal. Sale and cash calculations also
use JavaScript numbers. [Database](docs/database.md) documents these boundaries.

## Accounts and cash shifts

Build and read `sales.source_type` through `lib/pos-source.ts`:

| Value | Meaning |
| --- | --- |
| `MESA_<n>` | Table account |
| `CL- <customerId>` | Registered customer account |
| `VL-<n>` | Open guest ticket |
| `VENTA_LIBRE` | Settled guest sale |

A product tap normally creates a sale record. One account payment may settle
several records, so record count is not ticket count or customer visits.

Use `getJornadaCashSummary` in `lib/jornada-cash.ts` for the live cut and closing
amounts. A debt collection belongs to the jornada receiving the money. It must
not also count as a direct sale of the original jornada.
Savings deposits reduce the expected cash. Withdrawals reduce the pool balance.
See [Business rules](docs/business-rules.md#5-jornadas-and-cash).

## Authentication, settings and UI

The shared `app/auth.config.ts` JWT callback uses Prisma to read the current
user activity and role on each session check. The proxy runs on the Node.js
runtime. Keep bcrypt and credential provider work in `lib/auth.ts` and route
permissions in `lib/permissions.ts`.

Business settings use `setting` and `lib/actions/settings.ts`. Only `CLABE` is
implemented. Terminal names use `lib/device-settings.ts` and browser
`localStorage`.

Keep interface text in Spanish. Desktop navigation appears at the `lg`
breakpoint and above. Smaller screens use the bottom navigation and Menu sheet.

## Keeping documentation current

| Change | Documentation to review |
| --- | --- |
| Route, screen or navigation | `docs/modules.md` |
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
There are no release tags. The package version `0.2.33` does not establish a
published release or release date.
