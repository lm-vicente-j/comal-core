# Getting started

This guide starts a local development instance of Comal Core. You need npm,
a running PostgreSQL instance and Node.js `^20.19 || ^22.12 || >=24.0`, matching
the locked Prisma packages.

For a production build, use [Deployment](deploy.md). For database fields and
migration limits, use [Database](database.md).

## 1. Create a development database

Create an empty database named `comal_pos`, or put your chosen name in both
connection URLs. With PostgreSQL's CLI and the `postgres` role available:

```bash
createdb -h localhost -p 5432 -U postgres comal_pos
```

Use your installation's credentials. The template's local URL is
`postgresql://postgres:postgres@localhost:5432/comal_pos`.

## 2. Configure the environment

Copy the template:

```powershell
# PowerShell
Copy-Item .env.example .env
```

```bash
# Bash
cp .env.example .env
```

Generate a secret and copy the output into `AUTH_SECRET` in `.env`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

| Variable | When needed | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Required | Runtime and demo seed database |
| `DIRECT_URL` | Optional locally. Configure for deployment | Prisma CLI connection. Defaults to `DATABASE_URL` |
| `AUTH_SECRET` | Required | Auth.js JWT session encryption |
| `AUTH_TRUST_HOST` | Depends on hosting/proxy setup | Auth.js host trust. Enabled for the Playwright server |
| `TEST_DATABASE_URL` | Integration tests | Isolated database. Name must end in `_test` |
| `E2E_DATABASE_URL` | Browser tests | Separate database. Name must end in `_test_e2e` |
| `LOCAL_POSTGRES` | Optional test helper setting | Directory containing `psql`. Otherwise the helper uses `PATH` |
| `CHROMIUM_EXECUTABLE_PATH` | Optional for browser tests outside Windows | Chromium path. Defaults to `/opt/pw-browsers/chromium` |

For local development, `DATABASE_URL` and `DIRECT_URL` can point to the same
database. [Database connections](database.md#runtime-and-migration-connections)
explains the separate runtime and migration URLs used in deployment.

Use `.env` for shared app/CLI settings. `prisma.config.ts` loads that file through
`dotenv/config`. It does not load `.env.local`. Next.js can load `.env.local`,
and inherited shell values can override file settings. Check that the app and
CLI target the intended database. Keep credentials out of Git.

## 3. Install and migrate

```bash
npm ci
npx prisma migrate dev
```

The install's `postinstall` script generates the ignored
`app/generated/prisma` client. The migration command applies committed migrations
and may offer to create another if the schema differs. Use a development database.

The cash cut migration adds required payment methods and jornada references
without filling existing rows. It fails when the affected tables contain data.
For a new setup, use an empty database. For an existing installation, review
[Schema maintenance](database.md#schema-maintenance) before applying it.

## 4. Create demo accounts

An empty database has no login account. The optional demo seed creates accounts
and sample records:

```bash
npx prisma db seed
```

**This command deletes existing domain records from the configured database.**
It refuses to run when `NODE_ENV` or `VERCEL_ENV` is `production`. If run in a
Preview environment, it requires `PREVIEW_DATABASE_URL`. Use a disposable
database. The seed generates a large random dataset and runs separately from
the build.

The [seed](../prisma/seed.ts) reads these variables from `.env` or the shell:

| Variables | Defaults |
| --- | --- |
| `SEED_USERS` / `SEED_CUSTOMERS` / `SEED_SUPPLIES` | 25 / 5,000 / 80 |
| `SEED_JORNADAS` / `SEED_SALES` / `SEED_BILLS` | 365 / 100,000 / 3,000 |
| `SEED_SAVINGS_MOVS` / `SEED_SAVINGS_GOALS` | 1,000 / 10 |
| `SEED_CONTRIB_PER_GOAL` / `SEED_SALARY_PERIODS` | 20 / 24 |
| `SEED_CHUNK_SALES` / `SEED_CHUNK_ITEMS` | 2,000 / 5,000 |
| `SEED_START_DATE` / `SEED_END_DATE` | 2025-05-27 / 2026-05-27 |

Keep counts compatible with the script's generated relationships. The menu and
base supplies are predefined.

| Login mode | Identifier | Credential |
| --- | --- | --- |
| ADMIN | `admin@demo.com` | Password `demopass123` |
| STAFF | `staff2`, `staff3`, etc., when active | PIN `1234` |

The seeded admin also has username `admin` and PIN `1234`, but the ADMIN form
uses email/password. Some seeded staff are inactive and cannot sign in. These
credentials are for local demos only.

One generated jornada remains OPEN. The default data ends in May 2026, so a
report for a recent period may be empty. Choose dates within the seeded range when
examining analytics.

## 5. Run the app

```bash
npm run dev
```

Open [localhost:3000](http://localhost:3000), sign in and enter `/pos`.
[Modules](modules.md) describes the remaining screens.

## Scripts

| Command | Behavior |
| --- | --- |
| `npm run dev` | Starts the Next.js development server |
| `npm run build` | Applies migrations, then builds Next.js |
| `npm start` | Serves an existing production build |
| `npm run lint` | Runs ESLint |
| `npm test` | Runs Vitest against a real test database |
| `npm run test:e2e` | Runs Playwright with its own database and a server on port 3100 |
| `npm run test:setup` | Checks test databases, offers to create missing ones, and asks before resetting existing ones |

Run `npm run test:setup` before the first tests and after schema changes.
[Testing](testing.md) explains database isolation.
It describes the overwrite warning and the two seconds before tests continue.
It also covers the interactive setup helper.

[`prisma/sequence_fix.ts`](../prisma/sequence_fix.ts) repairs selected ID sequences
manually. It is not a setup step. The demo seed resets its inserted tables'
sequences itself.
