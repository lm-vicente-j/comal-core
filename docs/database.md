# Database

[`prisma/schema.prisma`](../prisma/schema.prisma) defines the PostgreSQL schema.
Prisma 7 generates the client in `app/generated/prisma`, which Git ignores.
The [runtime client](../lib/prisma.ts) uses `@prisma/adapter-pg` with a maximum
of four connections per app instance.

## Runtime and migration connections

| Variable               | Reader                          | Purpose                                                |
| ---------------------- | ------------------------------- | ------------------------------------------------------ |
| `DATABASE_URL`         | Runtime client and demo seed    | Application queries and writes                         |
| `DIRECT_URL`           | `prisma.config.ts`              | CLI migrations, schema push and introspection          |
| `PREVIEW_DATABASE_URL` | Vercel Preview runtime and seed | Preview queries and writes                             |
| `PREVIEW_DIRECT_URL`   | Vercel Preview Prisma CLI       | Preview migrations, defaults to `PREVIEW_DATABASE_URL` |

Outside Vercel Preview, Prisma CLI loads `.env` through `dotenv/config` and uses
`DATABASE_URL` when `DIRECT_URL` is unset. Inherited shell settings take precedence. Next.js can
also load `.env.local`. Verify that app and CLI target the intended database.

In the documented Vercel/Supabase pattern, runtime uses a transaction pooler
(typically port 6543) and migrations use a session/direct connection (typically
5432). Use the provider's actual URLs. Both variables can point to the same
database locally.

`npm run build` applies `prisma migrate deploy` before building the app.
A missing DIRECT_URL can use the fallback, but a connection unsuitable for
migrations can still stop the build.

Restart the development server after changing connection settings. The
development singleton reuses its Prisma client across page refreshes.

## Models and relationships

| Model                    | Purpose and constraints                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                  | Login identity, current role, bcrypt password/PIN, PIN lookup HMAC and credential version. Referenced by sales, expenses, salaries, jornadas, savings and debt collectors |
| `installationState`      | Persistent one-time first-owner setup status; deleting user rows does not reopen setup                                                                                    |
| `rolePermission`         | Persisted capability override keyed by role and capability                                                                                                                |
| `terminal`               | Authorized browser name/type, token hash, active state and credential version                                                                                             |
| `terminalRequest`        | Browser link request, token hash, status, expiry and approved terminal reference                                                                                          |
| `terminalSession`        | Association between a staff session and the terminal that authenticated it                                                                                                |
| `securityAudit`          | Owner and security events with actor, subject, metadata and timestamp                                                                                                     |
| `authRateLimit`          | Persistent rate-limit state for authentication and terminal-link requests                                                                                                 |
| `customer`               | Name/phone/alias, registration/consumption dates and stored debt balance                                                                                                  |
| `products`               | Unique name, limited to 40 characters, current price, recipes and active flag (default true)                                                                              |
| `supplies`               | Stock, cost, unit and active flag (default true) for reversible deactivation                                                                                              |
| `recipes`                | Product/supply pair with quantity used. Composite primary key (productID, supplyID)                                                                                       |
| `sales`                  | Total, current status, source, customer, placing user and creation jornada; `paidJornadaId` and `collectedBy` preserve direct-payment receipt attribution                 |
| `sale_items`             | Product, integer quantity, historical unit price, subtotal and consumption snapshot flag                                                                                  |
| `sale_item_consumptions` | Historical per-unit supply quantity consumed for a sale item at creation                                                                                                  |
| `debtors`                | Unique saleID, customer, amount/status, creation time/jornada and collection time/jornada/employee                                                                        |
| `bill`                   | Expense amount/category/description/date, payment method, registering user and optional jornada                                                                           |
| `salary`                 | User, amount/date, period description (up to 65 characters), payment method and required jornada                                                                          |
| `jornada`                | Opening/closing users and times, status, opening/expected/counted cash and expected transfers                                                                             |
| `cash_count`             | Append-only opening/interim/closing denomination count, operator, cutoff, request idempotency key, expected amount, difference, tolerance and cash summary                |
| `savings_movement`       | DEPOSIT/WITHDRAW amount, registering user and optional jornada                                                                                                            |
| `savings_goal`           | Target, deadline, status and contributions                                                                                                                                |
| `goal_contribution`      | Goal contribution. Deleted when its parent goal is deleted                                                                                                                |
| `setting`                | Shared key/value configuration with key primary key and update time                                                                                                       |

Many domain foreign keys use NoAction behavior. A referenced product may not
be deletable. The menu and inventory use reversible deactivation, preserving
recipes and historical references. Each product/supply pair can appear only once
in a recipe.

## Enums and required fields

| Enum                  | Values                        |
| --------------------- | ----------------------------- |
| `SaleStatus`          | UNPAID, PAID, DEBT, CANCELLED |
| `PaymentMethod`       | TRANSFER, CASH                |
| `JornadaStatus`       | OPEN, CLOSED                  |
| `SavingsMovementType` | DEPOSIT, WITHDRAW             |
| `GoalStatus`          | ACTIVE, COMPLETED, CANCELLED  |
| `CashCountType`       | OPENING, INTERIM, CLOSING     |

Sales, expenses and salaries use the PaymentMethod enum. Expense and salary
methods are required. `sales.payment_method` is nullable. New unpaid/debt sales
start without a method, and settlement assigns one. Cancellation can retain
the previous method, so cash cut queries also filter sale status.

`salary.jornadaId` and `debtors.createdJornadaId` are required.
`users.role` remains a nullable string, not a database enum. Supported values are
`ADMIN` (the unique owner), `SUPERVISOR` and `STAFF`; unknown values are rejected
by authentication. `TerminalType` supports `FIXED` and `MOBILE`, and
`TerminalRequestStatus` supports `PENDING`, `APPROVED`, `REJECTED` and `EXPIRED`.

## Money and historical data

PostgreSQL stores monetary amounts as `BIGINT` integer cents (`*Cents` columns)
and supply stock or recipe quantities as `BIGINT` integer milliunits
(`*Milliunits` columns, representing three decimal places of `supplies.measureUnit`).
Sale item quantities are integers. Item `unitPriceCents` and `subtotalCents` are
saved when a sale is created. Later menu price changes do not rewrite them.
Sale item ingredient consumption (`sale_item_consumptions`) is snapshotted at sale
creation when `sale_items.consumptionRecorded` is true; recipe definitions, supply
costs and names remain current data.

Server Actions convert stored `BigInt` values to safe integers at the application
boundary through `lib/scaled-values.ts`, keeping existing action field names. Recipe
costing, cash cuts and analytics aggregate with exact integer arithmetic
(`lib/monetary.ts`). Forms accept up to two decimal places for MXN and three for
supply quantities. Monetary CSV exports format pesos. Mobile POS
and debt dialogs calculate change in integer cents, and do not persist received
cash or change.

`customer.currentBalanceCents` is a stored value updated by debt actions, including
cancellation of an open debt. It is not a view recalculated from debtor rows.
[Business rules](business-rules.md) explains reconciliation limits.

## Date semantics

| Fields                                                       | Storage and interpretation                                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `sales.createdAt`                                            | Timestamp(6). Analytics groups dates in America/Mexico_City                                                                             |
| `bill.date`, `salary.payDate`                                | Nullable calendar dates without time of day                                                                                             |
| `debtors.createdAt`, `debtors.paidAt`                        | Timestamp(6). Debt collection time; `paidJornadaId` and `collectedBy` are null until collection                                         |
| `sales.paidAt`, `sales.paidJornadaId`, `sales.collectedBy`   | Direct payment time, receiving jornada and authenticated collector; null `paidJornadaId` preserves legacy fallback to `sales.jornadaId` |
| `customer.lastConsumption`, `registeredDate`                 | Nullable calendar dates                                                                                                                 |
| Jornada times, savings times/deadlines and user registration | DateTime. Defaults/nullability are defined in the schema                                                                                |

`cash_count.cutoffAt` is a Timestamp(6) assigned after acquiring the jornada
lock. It identifies the consistent cash snapshot saved with the count.

Direct payment records the paid timestamp, receiving jornada and authenticated
collector on the sale while retaining `placedBy` as its original sales
attribution. Debt collection preserves the sale's original date/jornada and
records the received payment time, jornada and employee on the debtor row,
mirroring that metadata onto the paid sale. The debtor row remains the canonical
source for debt receipts, and cash queries exclude debt-linked direct sales. Sales
analytics based on dates still filter by sale creation time, not collection time,
and cannot reconstruct historical balances.

The POS today query uses Mexico City day boundaries and includes unpaid sales
in the active shift across midnight.

## Collection and cash-count schemas

### Sale payment metadata

| Field | SQL / Prisma type | Rule |
| --- | --- | --- |
| `paidAt` | nullable `TIMESTAMP(6)` / `DateTime?` | Server payment timestamp; original `createdAt` remains unchanged |
| `paidJornadaId` | nullable `INTEGER` / `Int?` | Receiving jornada, FK to `jornada.id`; null legacy values use `sales.jornadaId` for direct receipts |
| `collectedBy` | nullable `INTEGER` / `Int?` | Authenticated collecting user, FK to `users.id`; separate from `placedBy` |

The receiving-jornada lookup has `sales_paidJornadaId_idx`. Collection FKs use
NO ACTION on update/delete. Payment actions set all three fields in their
transaction; caller input cannot assign another collector. Existing rows are
not backfilled. Date-based sales reporting continues to use `createdAt`.

### Immutable `cash_count`

| Field | SQL / Prisma type | Rule |
| --- | --- | --- |
| `id` | `SERIAL` / `Int` | Primary key |
| `jornadaId`, `operatorId` | `INTEGER` / `Int` | Required shift and authenticated counter |
| `type` | `CashCountType` | OPENING, INTERIM or CLOSING |
| `cutoffAt` | `TIMESTAMP(6)` / `DateTime` | Server cutoff after acquiring the shift lock |
| `denominations` | `JSONB` / `Json` | Validated `{kind, valueCents, quantity}` entries, integer cents and quantities |
| `note` | nullable `VARCHAR(1000)` / `String?` | Required outside saved tolerance and for a recount |
| `recountOfId` | nullable `INTEGER` / `Int?` | Self-reference to a prior OPENING or INTERIM count in the same open jornada; the new row is INTERIM |
| `requestId` | `UUID` / `String` | Unique retry key, normalized to lowercase before hashing |
| `payloadHash` | `VARCHAR(64)` / `String` | SHA-256 binds normalized input to type, operator and jornada context |
| `countedAmountCents`, `expectedAmountCents` | `BIGINT` / `BigInt` | Physical count and server-calculated expected cash |
| `differenceCents` | `BIGINT` / `BigInt` | Counted minus expected cash |
| `toleranceCents` | `BIGINT` / `BigInt` | Configuration frozen at cutoff |
| `cashSummary` | `JSONB` / `Json` | Cash/transfer component snapshot in integer cents |

Shift, operator and recount FKs use RESTRICT on update/delete. Lookup indexes
cover `(jornadaId, cutoffAt)`, `(operatorId, cutoffAt)` and `(type, cutoffAt)`;
`requestId` has a unique index. Counts and history use cutoff/ID ordering.

The SQL function `prevent_cash_count_mutation()` and the
`CASH_COUNT_IMMUTABLE` BEFORE UPDATE OR DELETE trigger raise SQLSTATE `55000`.
This protects Prisma and direct SQL row writes. Corrections insert a linked
INTERIM record and never rewrite the original count or opening fund.
Input validation, permissions and same-open-shift recount eligibility are
server-action rules; Prisma types alone do not enforce them.

Only authorized view-cash results include expected amount, difference, tolerance,
result and summary. STAFF receives their own counted denomination receipts.
Supervisor summaries mask payroll and private savings components. Stored JSON
is server data and must be filtered before serialization to clients.

## Accounts, indexes and settings

Accounts use `source_type` strings: `MESA_<n>`, `CL- <customerId>`, `VL-<n>` and `VENTA_LIBRE`.
The field is limited to 30 characters and is not unique. There is no separate
account table. Guest sales store a `ticketAccountId` UUID shared by sales on the
same open ticket. Empty reservations live in `setting` under
`TICKET_RES:<jornadaId>:<ticketNumber>` keys.

User email and username are nullable and unique. Multiple NULL values are
allowed for each field.

Indexes cover sale jornada and customer/date, sale item sale/product, debt
customer/status and creation/collection jornadas, bill/salary jornada, jornada
status/open time, savings jornada/date and contribution goal. A partial unique
index (`jornada_one_open_idx`) allows at most one `OPEN` jornada at a time.

`cash_count` stores denomination quantities as JSON and all monetary snapshots
as integer cents. `requestId` is unique and `payloadHash` binds an idempotent
retry to its original jornada, operator, type and payload. PostgreSQL rejects
UPDATE and DELETE on cash counts; foreign keys use RESTRICT so linked jornadas,
operators and prior recounts cannot be removed. Opening, interim and closing
counts are saved atomically with their cutoff and server cash snapshot. Legacy
jornadas have no synthesized cash count rows.

Shared CLABE is stored under the `CLABE` key and the count tolerance (integer
cents, default zero) under `CASH_COUNT_TOLERANCE_CENTS` in `setting`. The table
also stores ephemeral
`TICKET_RES:<jornadaId>:<ticketNumber>` guest ticket reservations. Terminal
names stay in browser `localStorage`. The `AUTH_LOCKOUT:<userId>` keys hold
failed login attempts for known accounts.

CRM name sorting uses the PostgreSQL ICU collation `comal_customer_name_es`,
with the customer ID as a tie-breaker. The migrations add this collation and
assign a shared ticket UUID to the lines of each existing open guest ticket.

## Schema maintenance

The committed migrations support fresh installations on an empty database.
They do not guarantee upgrades from older populated schemas. Review their SQL
and prepare any required data conversion before applying them to existing data.

| Task                  | Command or source                                                                     |
| --------------------- | ------------------------------------------------------------------------------------- |
| Development migration | `npx prisma migrate dev` against the development database                             |
| Deployment            | `npx prisma migrate deploy` applies committed migrations                              |
| Test schema           | `npm run test:setup` applies the schema and custom SQL to isolated test databases     |
| Demo data             | `prisma/seed.ts` destructively replaces domain data in DATABASE_URL                   |
| Sequence repair       | `prisma/sequence_fix.ts` resets selected ID sequences manually. Build does not run it |

The [cash cut migration](../prisma/migrations/20261028120000_cash_cut_payment_methods_and_debt_tracking/migration.sql)
adds required methods to bill/salary, a required salary jornada and a required
debt creation jornada, without filling existing rows. It fails if those tables
contain data. The sales payment method cast also rejects values outside
CASH/TRANSFER.

The [collection and cash-count migration](../prisma/migrations/20261125140000_cash_counts_collection_attribution/migration.sql)
is additive: nullable payment fields, the count enum/table, FKs, indexes and
immutability trigger. It preserves existing data and leaves historical counts
absent. Legacy direct receipts use their original jornada only when the new
receiving-jornada field is null. Apply committed migrations rather than schema
push so the trigger is installed. The demo seed is not an upgrade step.

The user identifier migration fails if existing non-NULL email or username
values are duplicated. Resolve duplicates manually; no automatic resolution
policy is provided. If the migration fails, use normal Prisma migration recovery
before deploying it again.

The repository does not supply a general data-preserving upgrade plan. The
destructive demo seed does not replace one. When using `prisma db push` for
tests, also apply custom SQL including the Spanish collation, unique indexes,
installation constraints and cash-count immutability trigger;
[Testing](testing.md) lists the commands.

`prisma/migrations/` records schema history.
[CHANGELOG.md](../CHANGELOG.md) records application changes.
