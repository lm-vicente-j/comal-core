# Deployment

Comal Core can run on your own Next.js server.
The guide also covers deployment with Vercel and Supabase. The repository has no Docker setup or
deployment CI workflow. For development, use [Getting started](getting-started.md).

## Install and build

```bash
npm ci
npm run build
npm start
```

Installation generates the Prisma client through `postinstall`.
The build command runs `npx prisma migrate deploy && next build`: it needs a
reachable migration database and can change that database's schema. A failed
migration stops the build. The demo seed is not run.

Use `npm start` to serve the completed build on your own server.
Vercel manages its runtime separately.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Runtime Prisma/pg connection |
| `DIRECT_URL` | Prisma CLI migration connection. Defaults to `DATABASE_URL` |
| `AUTH_SECRET` | Secret for JWT session encryption |
| `AUTH_TRUST_HOST` | Host trust setting when required by hosting or proxy configuration |

In the documented Supabase pattern, runtime uses a transaction pooler
(typically port 6543), while migrations use a session/direct connection
(typically port 5432). Use the provider's actual connection strings.
[Database](database.md) explains which process reads each URL.

Configure production and preview environments separately. Preview builds also
apply migrations to their configured database. Use Node.js within the engine
ranges in `package-lock.json`.

## Existing database upgrades

Review migrations before building against an existing database. In particular,
[`20261028120000_cash_cut_payment_methods_and_debt_tracking`](../prisma/migrations/20261028120000_cash_cut_payment_methods_and_debt_tracking/migration.sql)
adds required columns without a data backfill. It fails if `bill`, `salary` or
`debtors` already contains rows. Converting `sales.payment_method` to an enum
also fails for values other than CASH/TRANSFER.

The repository does not provide an automatic upgrade path for those records.
Prepare a migration plan that preserves existing data before deploying to a populated
database. The destructive demo seed is not a production migration tool.

## Runtime behavior

Each app instance can open four database connections. Account for all running
instances when sizing connection capacity.

Visible terminals check for shared changes every 10 seconds.
They use polling rather than WebSockets.
CLABE is shared in the database. Terminal labels stay in each browser.
Authenticated ADMIN reports query current data when requested.

For local hosting, browsers must reach the app server through the local network.
The server needs PostgreSQL. Local hosting does not add recovery when a
connection fails. It does not add automatic backups.

Bank reconciliation is not implemented. Jornadas do not close automatically.
The app has no receipt printer integration.

## Verify the deployment

Check these flows in the intended environment:

1. ADMIN and STAFF login, including page access for each role.
2. Opening a jornada, recording a sale and registering an expense.
3. Cash and manual transfer confirmation, including the configured CLABE.
4. Recipe stock changes, fiado collection and salary payment methods.
5. Cash/transfer totals at closing and ADMIN report export.

Confirm the migrations reached the intended database. Use deployment credentials,
not demo or database for browser tests accounts. The limits documented in
[Business rules](business-rules.md) also apply in production.
