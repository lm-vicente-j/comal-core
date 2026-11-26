# Comal Core

Comal Core is a point-of-sale application for food businesses with one location.
It manages sales, cash shifts, inventory, debts and daily administration.

The interface is in Spanish and works in desktop and mobile browsers.
Access manages personnel, permissions, and devices.

## Features

- **Accounts:** manage tables, registered customers and guests. Guest ticket
  reservations and account IDs keep reused ticket numbers distinct across terminals.
- **Sales:** adjust quantities or cancel items within role and shift boundaries.
  Settle accounts in cash or by transfer using the selected sales and confirmed total.
  Payments record their collection time, receiving shift and collecting operator.
- **Fiado:** assign unpaid sales to a customer. Record when each debt was
  collected, who received it and the jornada that received the money.
- **Inventory and menu:** manage supplies, units and stock. Define recipes and
  prices, ensuring prices exceed recipe base costs. Disable and reactivate supplies
  and products while preserving recipes and sales history. Disabled supplies also
  block sales of products that use them. Review current recipe costs.
- **Cash shifts:** record immutable opening, interim and closing bill/coin counts.
  Review cash and transfers separately, filter count history and export CSV.
  Authorized roles see saved expected cash, differences and tolerance results.
  Closing requires resolving every unpaid account; fiado can carry to a later shift.
- **Expenses and salaries:** record expenses, salary payments, advances and
  bonuses with validated reasons and periods. Choose a payment method for each payment.
- **Access:** create the single owner during first installation, configure
  Supervisor and Service permissions, issue one-time staff PINs, and approve,
  rename, change or revoke authorized browsers.
- **Administration:** search and page through customers, staff and menu products.
  Track savings movements and goals. Configure shared bank details.
- **Reporting:** the owner and roles with operational reporting permission can view statistics and filter them by date.
  Export reports as CSV or print them. These features are in beta.

## Project status

The application is in development. [package.json](package.json) records its
current version. No release tags have been published.

The browser must reach a running application server. The server needs PostgreSQL.
Both services can run locally.

The browser cannot queue sales when the server is unavailable. The project has
no packaged offline installer or integrated backup workflow.

Payment confirmation is manual. Bank reconciliation is not implemented.
The app has no receipt printer integration or kitchen display.
Forecasts and historical recipe profit are also outside the implementation.

See [Business rules](docs/business-rules.md) for current behavior and known limits.

## Technology

| Area | Technology |
| --- | --- |
| Application framework | Next.js 16 |
| Interface | React 19 |
| Language | TypeScript |
| Business operations | Server Actions |
| Authentication | Auth.js 5 |
| Data access | Prisma 7 |
| Database | PostgreSQL |

Desktop and mobile views share the same backend.
[Architecture](ARCHITECTURE.md) explains the request flow and data boundaries.

## Requirements

- Node.js `^20.19 || ^22.12 || >=24.0`, as required by the locked Prisma packages.
- npm and a running PostgreSQL instance with ICU collation support.
- A dedicated development database and separate databases for tests.
- Bash and `psql` if you use the optional test database helper.

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/lm-vicente-j/comal-core.git
cd comal-core
```

### 2. Create a database and configure the environment

Reuse an existing local development database when it already contains the data
you need; skip the optional destructive seed. For a fresh installation, create
an empty development database. If PostgreSQL's CLI and the `postgres`
role are available:

```bash
createdb -h localhost -p 5432 -U postgres comal_pos
```

Copy the environment template:

```powershell
# PowerShell
Copy-Item .env.example .env
```

```bash
# Bash
cp .env.example .env
```

Set `DATABASE_URL` and `DIRECT_URL` to your development database in `.env`.
For a local instance, both can use the same URL. Generate three independent secrets for authentication, installation, and PIN lookup:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))" # run three times for separate values
```

Set the generated values as `AUTH_SECRET`, `INSTALLATION_SECRET`, and `PIN_LOOKUP_SECRET` in `.env`. Keep
all three server-side. `INSTALLATION_SECRET` is used only by first-owner setup at `/login`;
it is never sent to the browser. Setup requires the owner's name, email, a
password of at least 12 characters, confirmation and this secret. Creation does
not sign in automatically. An initialized or populated database never reopens
setup. The owner always signs in with email and password from any browser.

See [Getting started](docs/getting-started.md) for connection settings and
environment precedence.

### 3. Install dependencies and apply migrations

```bash
npm ci
npx prisma migrate dev
```

For a fresh installation, use an empty development database. For existing
local data, review and apply pending committed migrations with
`npx prisma migrate deploy` and skip the seed. An upgrade from an older
populated schema is not guaranteed.
Read [Schema maintenance](docs/database.md#schema-maintenance) before applying
migrations to existing data.

### 4. Create the owner or optional demo accounts

For a real installation, start the app and create the owner through the one-time
setup form. For a disposable local development database, the optional seed
creates demo accounts and sample data instead:

```bash
npx prisma db seed
```

**The seed deletes existing domain data from the configured database.** It
refuses to run when `NODE_ENV` or `VERCEL_ENV` is `production`.
Use a disposable development database and
read the [seed configuration](docs/getting-started.md#4-create-the-owner-or-optional-demo-accounts)
before running it.

| Role | Login | Credential |
| --- | --- | --- |
| Owner (`ADMIN`) | `admin@demo.com` | Password: `demopass123456` |
| Supervisor | `supervisor2` on a mobile terminal | PIN: `100002` |
| Service (`STAFF`) | `staff3` on a mobile terminal | PIN: `100003` |

Staff PINs contain six digits and are shown only once when created or
regenerated. To sign in as seeded staff, first request browser authorization and
approve the request as owner, choosing a mobile terminal. These credentials are
for local demo data only. Never run the destructive demo seed on a real installation.

### 5. Start the app

```bash
npm run dev
```

For access from another device on the local network, run
`npm run dev -- --hostname 0.0.0.0 --port 3000` and open
`http://<server-LAN-IP>:3000` from that device. PostgreSQL can remain bound to
localhost; browsers connect to the app server.

Open [localhost:3000](http://localhost:3000). On a fresh installation create
the owner first; seeded development databases can use the demo credentials above.

## Usage

1. As the owner, open **Access** to create staff accounts,
   configure Supervisor and Service permissions, and approve each staff browser.
   Share each generated PIN securely; it is displayed only once.
2. Review the active jornada (cash shift), or open one with a bill/coin count.
   Use **Contar caja** for interim counts and save a new recount with a reason
   when a correction is needed. Saved counts cannot be edited or deleted.
3. Check supplies, recipes and menu prices in Inventario and Menú.
4. Open Ventas and choose an account. Add the products to that account.
5. Use **Cerrar cuenta** to settle in cash or by transfer. Use **A deuda** to
   assign selected unpaid sales to a customer for later collection.
6. Register expenses and salary payments with their payment method. Collect
   fiado through Deudores while a jornada is open.
7. Resolve unpaid accounts, count the cash and close the jornada.

See [Modules](docs/modules.md) for screen flows and
[Business rules](docs/business-rules.md) for payment and cash calculations.

Lists use server-side pagination with 10 records per page by default and choices
of 10, 20 or 50. Below the desktop navigation breakpoint, pagination stays above
the bottom navigation and appears only when more than one page exists. Jornada
is available from the mobile user menu. [Pagination](docs/pagination.md) explains
list navigation, filters and exports.

Keyboard focus stays within the list or embedded picker when the mobile page
selector closes or the view changes between mobile and desktop. Four known
focus regressions remain during page loads and desktop size-selector changes;
their reproductions currently fail. See [Testing](docs/testing.md#pagination-focus-regressions)
for the passing checks and outstanding cases.

## Development and checks

GitHub Actions runs lint, integration tests, browser E2E, build and dependency audit for PRs
and pushes to `dev`/`main`. High/critical audit findings block CI. See
[CI checks](docs/testing.md#continuous-integration) for isolation and diagnostics.

```bash
npm run lint
npm run test:setup
npm test
npx playwright install --with-deps chromium # Linux browser setup
npm run test:e2e
npm run test:benchmarks
```

Tests use separate PostgreSQL databases and delete their fixture data. Read
[Testing](docs/testing.md) before running them. On Windows, browser tests use
Microsoft Edge. Benchmarks reset the integration database; run them separately
from integration tests.

`npm run build` applies database migrations before building the app.
It changes the selected database. See [Deployment](docs/deploy.md)
before building against a shared database.

## Documentation

| Document | Purpose |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, data flow, transactions and runtime boundaries |
| [TECHNICAL.md](TECHNICAL.md) | Development conventions and documentation maintenance |
| [CHANGELOG.md](CHANGELOG.md) | Curated changes following Keep a Changelog |
| [docs/getting-started.md](docs/getting-started.md) | Environment, setup, demo seed and scripts |
| [docs/modules.md](docs/modules.md) | Routes, screens, desktop/mobile behavior |
| [docs/pagination.md](docs/pagination.md) | Shared list contract, navigation state, controls and exports |
| [docs/business-rules.md](docs/business-rules.md) | State changes, formulas, validation and known limits |
| [docs/actions.md](docs/actions.md) | Exported domain actions, schemas and supporting helpers |
| [docs/database.md](docs/database.md) | Models, relations, dates, money and connection URLs |
| [docs/auth.md](docs/auth.md) | Login, sessions, route and action permissions |
| [docs/middleware.md](docs/middleware.md) | Request interception in `proxy.ts` |
| [docs/testing.md](docs/testing.md) | Integration and browser tests, setup and platform requirements |
| [docs/deploy.md](docs/deploy.md) | Build, migrations and deployment configuration |

## Support and contributions

Use [GitHub Issues](https://github.com/lm-vicente-j/comal-core/issues) to report a
bug or discuss a proposed change. Include reproduction steps, expected and actual
behavior, and relevant environment details. Remove credentials and customer data
from logs and examples.

For a contribution, follow [Technical notes](TECHNICAL.md), keep the change
focused, and run the checks relevant to its behavior. Update the affected
documentation when changing a rule, route, schema or action contract.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
