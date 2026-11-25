# Comal Core

Comal Core is a point-of-sale application for food businesses with one location.
It manages sales, cash shifts, inventory, debts and daily administration.

The interface is in Spanish. It works in desktop and mobile browsers.

## Features

- **Accounts:** manage tables, registered customers and guests. Guest ticket
  reservations and account IDs keep reused ticket numbers distinct across terminals.
- **Sales:** adjust quantities or cancel items within role and shift boundaries.
  Settle accounts in cash or by transfer using the selected sales and confirmed total.
- **Fiado:** assign unpaid sales to a customer. Record when each debt was
  collected, who received it and the jornada that received the money.
- **Inventory and menu:** manage supplies, units and stock. Define recipes and
  prices, ensuring prices exceed recipe base costs. Disable and reactivate supplies
  and products while preserving recipes and sales history. Disabled supplies also
  block sales of products that use them. Review current recipe costs.
- **Cash shifts:** review cash and transfers separately. Check the movement
  breakdown and compare expected cash with the closing count.
- **Expenses and salaries:** record expenses, salary payments, advances and
  bonuses with validated reasons and periods. Choose a payment method for each payment.
- **Administration:** search and page through customers, staff and menu products.
  Require surnames and role-specific credentials while preserving login access
  when a user's role changes.
  Track savings movements and goals. Configure shared bank details and a name for each terminal.
- **Reporting:** ADMIN can view statistics and filter them by date.
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

Create an empty development database. If PostgreSQL's CLI and the `postgres`
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
For a local instance, both can use the same URL. Generate a secret and copy its
output into `AUTH_SECRET`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

See [Getting started](docs/getting-started.md) for connection settings and
environment precedence.

### 3. Install dependencies and apply migrations

```bash
npm ci
npx prisma migrate dev
```

Use an empty development database. The committed migrations support a fresh
installation; an upgrade from an older populated schema is not guaranteed.
Read [Schema maintenance](docs/database.md#schema-maintenance) before applying
migrations to existing data.

### 4. Create demo accounts

An empty database has no login account. The optional seed creates accounts and
sample data:

```bash
npx prisma db seed
```

**The seed deletes existing domain data from the configured database.** It
refuses to run when `NODE_ENV` or `VERCEL_ENV` is `production`.
Use a disposable development database and
read the [seed configuration](docs/getting-started.md#4-create-demo-accounts)
before running it.

| Role | Login | Credential |
| --- | --- | --- |
| ADMIN | `admin@demo.com` | Password: `demopass123` (no PIN) |
| STAFF | An active seeded user, such as `staff2` | PIN: `1234` |

These credentials are for local demo data only.

### 5. Start the app

```bash
npm run dev
```

Open [localhost:3000](http://localhost:3000) and sign in.

## Usage

1. As ADMIN, review the active jornada (cash shift), or open one if none exists.
2. Check supplies, recipes and menu prices in Inventario and Menú.
3. Open Ventas and choose an account. Add the products to that account.
4. Use **Cerrar cuenta** to settle in cash or by transfer. Use **A deuda** to
   assign selected unpaid sales to a customer for later collection.
5. Register expenses and salary payments with their payment method. Collect
   fiado through Deudores while a jornada is open.
6. Resolve unpaid accounts, count the cash and close the jornada.

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
