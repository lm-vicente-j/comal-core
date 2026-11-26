# Deployment

Comal Core can run on your own Next.js server or on Vercel with PostgreSQL.
This guide includes the Vercel/Supabase connection pattern. The repository has
no application Docker setup or deployment CI workflow. Repository checks use
disposable PostgreSQL service containers, including an isolated browser-test job. For development, use
[Getting started](getting-started.md).

## Install and build

```bash
npm ci
npm run build
npm start
```

Installation generates the Prisma client through `postinstall`.
Use a PostgreSQL build with ICU support for the CRM's Spanish collation.
The build command runs `npx prisma migrate deploy && next build`: it needs a
reachable migration database and can change that database's schema. A failed
migration stops the build. The demo seed is not run.

Use `npm start` to serve the completed build on your own server.
Vercel manages its runtime separately.

## Security headers

[next.config.ts](../next.config.ts) attaches these headers to all routes
(`/:path*`):

| Header | Value | Purpose |
| --- | --- | --- |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Enforces HTTPS connections |
| `X-Frame-Options` | `DENY` | Prevents clickjacking by disabling frame embedding |
| `X-Content-Type-Options` | `nosniff` | Blocks MIME type sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage on cross-origin requests |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Restricts browser device capabilities |
| `X-DNS-Prefetch-Control` | `on` | Controls DNS prefetching |

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Runtime Prisma/pg connection |
| `DIRECT_URL` | Prisma CLI migration connection. Defaults to `DATABASE_URL` |
| `PREVIEW_DATABASE_URL` | Vercel Preview runtime connection to an isolated database |
| `PREVIEW_DIRECT_URL` | Vercel Preview migration connection. Defaults to `PREVIEW_DATABASE_URL` |
| `AUTH_SECRET` | Secret for JWT session encryption |
| `PIN_LOOKUP_SECRET` | Independent server HMAC key of at least 32 characters for PIN lookup; retain across deployments |
| `INSTALLATION_SECRET` | Server-only secret required by one-time first-owner setup |
| `AUTH_TRUST_HOST` | Host trust setting when required by hosting or proxy configuration |

In the documented Supabase pattern, runtime uses a transaction pooler
(typically port 6543), while migrations use a session/direct connection
(typically port 5432). Use the provider's actual connection strings.
[Database](database.md) explains which process reads each URL.

Configure `DATABASE_URL` and `DIRECT_URL` for the Production target in Vercel.
Configure the `PREVIEW_` variables only for Preview, using credentials that can access
only the isolated preview database. Both the app and Prisma migrations use the
`PREVIEW_` variables when `VERCEL_ENV=preview`. Set `PREVIEW_DIRECT_URL` when the
runtime connection uses a transaction pooler. Use Node.js within the engine
ranges in `package-lock.json`. The demo seed (`prisma/seed.ts`) is strictly blocked in
production environments (`NODE_ENV=production` or `VERCEL_ENV=production`).

Set `INSTALLATION_SECRET` to a strong, unique server environment value before the
first owner setup. Do not expose it through a `NEXT_PUBLIC_` variable. After
migrations finish, the first owner enters this secret at `/login` with a name,
email and password of at least 12 characters. Setup creates one owner and does
not sign in automatically. Eligibility is persisted; deleting users or a
database outage does not reopen setup. The owner always signs in with email and
password. Use the server-side owner recovery command to reset the existing
owner's credentials with `npx tsx scripts/recover-owner.ts`; the command verifies
the existing initialized installation, increments the credential version and
writes an audit record. It does not create another account or reset installation
state.

Staff use unique six-digit personal PINs. Each staff browser must request owner
approval and be registered as a fixed or mobile terminal before staff can sign
in. Use HTTPS in deployment so terminal authorization cookies remain secure.
Plain HTTP is supported in development on localhost or the local network;
production terminal cookies require HTTPS.

## Existing database upgrades

The committed migrations support fresh installations on an empty database.
An upgrade from an older populated schema is not guaranteed. Review the SQL
and plan any required data conversion before running the build against it.

The CRM name-ordering migration requires PostgreSQL built with ICU support.
The guest ticket migration assigns account IDs to existing open guest sales.

Review migrations before building against an existing database. In particular,
[`20261028120000_cash_cut_payment_methods_and_debt_tracking`](../prisma/migrations/20261028120000_cash_cut_payment_methods_and_debt_tracking/migration.sql)
adds required columns without a data backfill. It fails if `bill`, `salary` or
`debtors` already contains rows. Converting `sales.payment_method` to an enum
also fails for values other than CASH/TRANSFER.

The [cash-count migration](../prisma/migrations/20261125140000_cash_counts_collection_attribution/migration.sql)
adds nullable sales payment metadata and a new append-only `cash_count` table,
its enum, foreign keys, indexes and mutation-blocking trigger. It leaves old
sales metadata null and does not synthesize historical counts. Legacy direct
payments fall back to their original jornada when `paidJornadaId` is null.
Apply the SQL migration: schema push alone does not install the immutable trigger.

The repository does not provide an automatic upgrade path for those records.
Prepare a migration plan that preserves existing data before deploying to a populated
database. The destructive demo seed is not a production migration tool.

## Runtime behavior

Each app instance can open four database connections. Account for all running
instances when sizing connection capacity.

Visible terminals check for shared changes every 10 seconds.
They use polling rather than WebSockets.
CLABE and cash-count tolerance are shared in the database. Terminal labels stay
in each browser. Saved counts retain the tolerance in effect at their cutoff;
changing settings does not recalculate past counts.
Authenticated operators with the operational reports capability query current data when requested.

For local hosting, browsers must reach the app server through the local network.
The server needs PostgreSQL. Local hosting does not add recovery when a
connection fails. It does not add automatic backups.

Bank reconciliation is not implemented. Jornadas do not close automatically.
The app has no receipt printer integration.

## Verify the deployment

Check these flows in the intended environment:

1. Owner email/password login and first-owner setup on a fresh disposable database.
2. Staff login with six-digit PINs from owner-authorized fixed and mobile browsers.
3. Review role permissions and confirm direct server requests enforce them.
4. Opening a jornada with a denomination count, recording a sale and registering an expense.
5. Cash and manual transfer confirmation, including the configured CLABE.
6. Recipe stock changes, fiado collection and salary payment methods.
7. Saving an interim count, requiring a note outside tolerance and verifying role-limited receipts/history/CSV.
8. Rejecting count updates/deletes and jornada closure with UNPAID accounts, then resolving accounts and saving a closing count.
9. Collection time, receiving jornada and operator attribution, with debts excluded from direct sales to avoid duplicate receipts.

Confirm the migrations reached the intended database. Use deployment credentials,
not demo or browser-test accounts. The limits documented in
[Business rules](business-rules.md) also apply in production.

## Repository mirroring

[mirror-private.yml](../.github/workflows/mirror-private.yml) copies public
`main` to a private repository on pushes to `main` or manual runs. Configure
`PRIVATE_MIRROR_REPO` as `owner/repo` and `PRIVATE_MIRROR_TOKEN` in GitHub Actions
secrets. The workflow skips mirroring when either value is missing. It does not
run checks, build the application or deploy it.

## CI build boundary

The repository checks workflow builds against its own disposable PostgreSQL
service, with no deployment secrets. It validates fresh migrations and Next.js
compilation; it does not publish artifacts or deploy. See
[CI checks](testing.md#continuous-integration). Production migration and upgrade
precautions above still apply. Mirroring remains independent of check results.
