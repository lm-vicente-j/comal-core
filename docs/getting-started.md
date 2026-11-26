# Getting started

Use this guide to run Comal Core locally. You need npm, PostgreSQL with ICU
collation support and Node.js `^20.19 || ^22.12 || >=24.0`, as required by the
locked Prisma packages.

For a production build, use [Deployment](deploy.md). For database fields and
migration limits, use [Database](database.md).

## 1. Create a development database

If a local development database already has the data you need, reuse it and
skip the destructive seed in step 4. Review pending migrations before applying
them. For a fresh setup, create an empty database named `comal_pos`, or put your
chosen name in both connection URLs. With PostgreSQL's CLI and the `postgres` role available:

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

Generate three independent secrets for authentication, installation, and PIN lookup:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Set the values as `AUTH_SECRET`, `INSTALLATION_SECRET`, and `PIN_LOOKUP_SECRET` in `.env`. Keep all three on the
server. The installation secret authorizes the one-time owner setup form; it is
not exposed to the browser. The owner setup requires a name, email, password of
at least 12 characters, confirmation, and the secret. It creates one active
owner but does not log in automatically. The owner always uses email and
password and can sign in from any browser. An initialized or populated database
never becomes eligible for setup again.

| Variable | When needed | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Required | Runtime and demo seed database |
| `DIRECT_URL` | Optional locally. Configure for deployment | Prisma CLI connection. Defaults to `DATABASE_URL` |
| `PREVIEW_DATABASE_URL` / `PREVIEW_DIRECT_URL` | When `VERCEL_ENV=preview` | Isolated Preview runtime and migration connections |
| `AUTH_SECRET` | Required | Auth.js JWT session encryption |
| `PIN_LOOKUP_SECRET` | Required for personnel PINs | Independent HMAC key of at least 32 characters; keep stable or regenerate all personnel PINs |
| `INSTALLATION_SECRET` | Required for first-owner setup | Server-only authorization for one-time owner creation; keep it out of browser variables and source control |
| `AUTH_TRUST_HOST` | Depends on hosting/proxy setup | Auth.js host trust. Enabled for the Playwright server |
| `DEV` | Integration tests | Enables testing-only helper functions (such as `resetAllLockouts`). Keep unset or `"false"` in production |
| `TEST_DATABASE_URL` | Integration tests | Isolated database. Name must end in `_test` |
| `E2E_DATABASE_URL` | Browser tests | Separate database. Name must end in `_test_e2e` |
| `LOCAL_POSTGRES` | Optional test helper setting | Directory containing `psql`. Otherwise the helper uses `PATH` |
| `CHROMIUM_EXECUTABLE_PATH` | Optional for browser tests outside Windows | Override for a local Chromium executable; otherwise uses Playwright-managed Chromium |

For local development, `DATABASE_URL` and `DIRECT_URL` can point to the same
database. [Database connections](database.md#runtime-and-migration-connections)
explains the separate runtime and migration URLs used in deployment.

Use `.env` for shared app/CLI settings. `prisma.config.ts` loads that file through
`dotenv/config`. It does not load `.env.local`. Next.js can load `.env.local`,
and inherited shell values can override file settings. Check that the app and
CLI target the intended database. Keep credentials out of Git.

If your local configuration is only in `.env.local`, load it explicitly for
Prisma CLI commands, for example:

```bash
node --env-file=.env.local node_modules/prisma/build/index.js migrate deploy
```

This applies committed migrations without seeding.

Restart the development server after changing database connection settings so
the cached Prisma client uses the new connection.

## 3. Install and migrate

```bash
npm ci
npx prisma migrate dev
```

The install's `postinstall` script generates the ignored
`app/generated/prisma` client. The migration command applies committed migrations
and may offer to create another if the schema differs. Use a development database.

The committed migrations support a fresh installation on an empty database.
They do not guarantee an upgrade from an older populated schema. For example,
the cash cut migration adds required fields without filling existing rows.
Review [Schema maintenance](database.md#schema-maintenance) before applying
migrations to existing data.

## 4. Create the owner or optional demo accounts

For a real installation, start the app and create the owner through the one-time
setup form. On a disposable development database, the optional demo seed creates
accounts and sample records instead:

```bash
npx prisma db seed
```

**This command deletes existing domain records from the configured database.**
It refuses to run when `NODE_ENV` or `VERCEL_ENV` is `production`. If run in a
Preview environment, it requires `PREVIEW_DATABASE_URL`. Use a disposable
database. The seed generates a large random dataset and runs separately from
the build.

The seed needs the same `PIN_LOOKUP_SECRET` as the application. When using only
`.env.local`, load it explicitly and invoke the seed directly:

```bash
node --env-file=.env.local --import tsx prisma/seed.ts
```

This runs the destructive demo seed on that file's selected database. It does
not apply migrations. A Prisma 7 schema reset also requires a separate seed
step; neither migration deployment nor the application build loads demo data.

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
| Owner (`ADMIN`) | `admin@demo.com` | Password `demopass123456` |
| Supervisor | `supervisor2` | PIN `100002` |
| Service (`STAFF`) | `staff3` | PIN `100003` |

Staff PINs contain six digits and appear only once at account creation or PIN
regeneration. Before staff sign-in, request terminal authorization in that
browser and approve it as the owner. Choose a mobile terminal for the username
and PIN login mode. Some seeded users may be inactive. These credentials are
for local demos only. Never run the destructive seed on a real installation.

The seed populates collection metadata on generated PAID sales. It does not
fabricate denomination counts for historical jornadas. Its destructive reset
uses TRUNCATE for immutable count rows before rebuilding domain fixtures.

One generated jornada remains OPEN. The default data ends in May 2026, so a
report for a recent period may be empty. Choose dates within the seeded range when
examining analytics.

After seeding, check migration state with `npx prisma migrate status`, using the
same environment as the seed. Query record counts separately. With defaults,
expect 25 users with one
owner, 5,000 customers, 45 products, 80 supplies and 365 jornadas with one OPEN.
Sale-item and debt counts vary because generation is random. `cash_count` stays
empty until operators save physical counts. The browser-test seed is a separate,
smaller fixture and must use its own test database.

When exercising cash counts, start at the 50-cent denomination. Test opening,
reconciliation and closing separately; STAFF opening and closing need explicit
delegation and do not expose expected cash. See the
[cash lifecycle checks](testing.md#cash-lifecycle-and-pos-review-2026-11-26).
For a handover, sign in as the current custodian and use **Entregar caja**.
Select another active Service or Supervisor account and have that person
confirm through six masked PIN boxes. The owner can deliver while holding custody and always retains counting and
closing capabilities, but cannot receive a PIN-based handover. Confirmation leaves the signed-in
session unchanged. See [Handover checks](testing.md#cash-handover-validation-42).

## 5. Run the app

```bash
npm run dev
```

Open [localhost:3000](http://localhost:3000). Create the owner on a fresh
installation, or use demo credentials on a seeded development database. Staff
browsers need owner approval before sign-in.

For access from other devices on the local network:

```bash
npm run dev -- --hostname 0.0.0.0 --port 3000
```

Open `http://<server-LAN-IP>:3000` from another device. Keep PostgreSQL local to
the server; the browser only needs the app port. In development mode terminal
authorization cookies support local HTTP; deployed environments require HTTPS.
An unauthorized staff sign-in opens **Autorizar dispositivo** as a dialog.
Owner approval returns to the corresponding Fixed or Mobile form.

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
| `npm run test:benchmarks` | Runs benchmarks separately; resets the integration test database |
| `npm run test:setup` | Checks test databases, offers to create missing ones, and asks before resetting existing ones |

Run `npm run test:setup` before the first tests and after schema changes.
[Testing](testing.md) explains database isolation, the interactive setup helper
and the runners' two-second warning before deleting existing test data.

[`prisma/sequence_fix.ts`](../prisma/sequence_fix.ts) repairs selected ID sequences
manually. It is not a setup step. The demo seed resets its inserted tables'
sequences itself.
