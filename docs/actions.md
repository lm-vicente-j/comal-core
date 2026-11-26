# Action and helper reference

This reference lists the exported functions in `lib/actions/` and the helpers
used by the application. Domain functions are Server Actions, not REST endpoints.
The linked source contains the full TypeScript signatures.

**Session** means `auth()` must return a user. **Owner** means an action requires
the unique `ADMIN`. **Capability** means it checks the current role permission.
Page permissions are separate. Mutation Server Actions return
the standardized `ActionResult<T>` shape (`{ success: true, data? }` or
`{ success: false, error, fieldErrors?, data? }`) defined in
[action-result.ts](../lib/action-result.ts). Read queries return their domain
types; paginated reads use `ActionResult<PaginatedResult<T>, PaginationError>`.
See [Pagination](pagination.md) for the shared POST input/result contract,
navigation state, limits and audited exceptions.
[Business rules](business-rules.md) explains state changes and known limits.

Monetary inputs and outputs use safe integer cents, even when a field is named
`amount`, `price` or `unitCost`. Supply quantities use integer milliunits;
sale item quantities are whole counts. Forms handle conversion to display units.

## Authentication: [auth_action.ts](../lib/actions/auth_action.ts)

| Function                     | Input, result and effect                                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login(prevState, formData)` | Public form action. Owner email/password or staff six-digit PIN credentials. The server derives role and fixed/mobile mode from the account and authorized terminal. Redirects successful login to `/pos`; failures return an error |
| `logout()`                   | Signs out and redirects to `/login`                                                                                                                                                                                                 |

First-owner setup uses `getSetupStatus()` and `createInitialOwner(formData)` in
[`setup.ts`](../lib/actions/setup.ts). It requires the server-only installation
secret, creates the sole owner only when persisted first-installation state
allows it, and does not create a session. Terminal linking and management are in
[`terminal.ts`](../lib/actions/terminal.ts): browser requests expire after ten
minutes and can be approved, listed, renamed, retyped or revoked. Role
permission reads/writes live in [`security.ts`](../lib/actions/security.ts) and
are owner-only.

`getBrowserTerminalAccess()` in `terminal.ts` is a public, cookie-scoped read.
It returns `ActionResult<{ type: "FIXED" | "MOBILE" | null }>` for the active
terminal matching this browser's HttpOnly token hash. It neither authorizes a
terminal nor returns identifiers/tokens, and does not replace login checks.
The login client uses it to open the authorization dialog before staff sign-in.

## Sales: [sales.ts](../lib/actions/sales.ts)

All functions require a session. Unauthenticated history queries return `[]`.

| Function                                                                                                                               | Input, result and effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSale(sale_items, status, source_type, customerID, paymentMethod = "CASH", reservationToken?, ticketSaleIds?, ticketAccountId?)` | Items contain product ID and quantity. Reads prices from the database and writes the sale, stock, guest ticket reservation and customer/debt changes in one transaction. Uses the reservation token for a new guest ticket and the ticket account ID or existing sale IDs to identify an open ticket. Returns `ActionResult` with `data: { saleId, ticketAccountId? }`                                                                                                                                                                                                                                  |
| `nextFreeSaleTicket()`                                                                                                                 | Requires an OPEN jornada. Serialized with a PostgreSQL transaction-scoped advisory lock; persists a 15-minute reservation in `setting` and returns `ActionResult<{ sourceType, reservationToken }>`. First `createSale` atomically consumes the reservation                                                                                                                                                                                                                                                                                                                                             |
| `releaseTicketReservationAction(sourceType, reservationToken)`                                                                         | Requires an OPEN jornada, a valid canonical `VL-<n>` source, and matching `reservationToken`. Releases an active reservation only when no UNPAID sales exist on that ticket (`TICKET_HAS_SALES` / `RESERVATION_MISMATCH` / `INVALID_INPUT`). Returns `ActionResult`                                                                                                                                                                                                                                                                                                                                     |
| `closeAccountAction(sourceType, paymentMethod = "CASH", saleIds, expectedTotal)`                                                       | Requires selected sale IDs and their confirmed total. Pays those UNPAID records in the active jornada and moves settled guest sales to `VENTA_LIBRE`. Returns `ActionResult<{ count }>` or failure with `NO_SALES_TO_CLOSE`, `DIFFERENT_JORNADA`, or `SALES_CHANGED`                                                                                                                                                                                                                                                                                                                                    |
| `getSalesHistory()`                                                                                                                    | Returns all sales, newest first, with numeric totals and item record counts. Staff roles receive limited customer fields and user ID/name. The owner receives customer details and user directory fields. User credential hashes are never returned                                                                                                                                                                                                                                                                                                                                                     |
| `getTodaySalesHistory()`                                                                                                               | Returns today's sales and open UNPAID sales for the active jornada whose status is not CANCELLED using the business timezone (America/Mexico_City), with selected relations, serialized dates and safe-integer cent totals. No pagination                                                                                                                                                                                                                                                                                                                                                               |
| `cancelSaleAction(saleId)`                                                                                                             | Cancels the sale, locks affected supplies, restores stock using the item's recorded consumption snapshot (or current recipes when `consumptionRecorded` is false), and refreshes the affected sales, catalog and customer views after commit. PAID sales are immutable for every role, including the owner (`CANNOT_CANCEL_PAID_SALE`). Cancelling DEBT sales requires owner authorization. Sales in a closed jornada cannot be cancelled. An open debt is also cancelled and removed from the customer's balance. Returns `ActionResult`                                                               |
| `updateSaleQuantity(saleId, quantity, productId)`                                                                                      | Adjusts quantity, locks affected supplies, updates stock using the item's recorded consumption snapshot (or current recipes when `consumptionRecorded` is false), recalculates totals, and refreshes the affected sales, catalog and customer views after commit. Requires a positive integer quantity; invalid quantities return INVALID_INPUT. PAID sales are immutable for every role, including the owner (`CANNOT_MODIFY_PAID_SALE`). Modifying DEBT sales requires owner authorization. Sales in a closed jornada, cancelled sales and collected debts cannot be modified. Returns `ActionResult` |

Sale creation, cancellation and quantity edits refresh `/pos`, `/admin/inventory`,
`/admin/menu` and `/admin/jornada` after commit. Customer sales also refresh
`/admin/crm`; `/debtors` is refreshed only when debt records change.

Direct PAID creation and `closeAccountAction` set `paidAt`, `paidJornadaId` and
`collectedBy` on the server after acquiring the active jornada lock. Creation
fields remain unchanged. Debt collection mirrors its canonical debtor metadata
onto the sale; direct-receipt queries exclude debt-linked sales.

Edits and cancellations lock the originating jornada before the sale. Legacy
debt sales use `debtors.createdJornadaId` when `sales.jornadaId` is absent.
A closed origin returns `JORNADA_CLOSED`; a concurrent change of origin returns
`SALES_CHANGED` without changing the sale. Customer balance validation and
updates hold the customer row lock.

## Debts: [debts.ts](../lib/actions/debts.ts)

All functions require a session. Mutation callers select sale IDs. Amounts come
from the database.

| Function                                       | Input, result and effect                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getAllDebtors(options)`                       | Authenticated POST list of customers whose debt rows and linked sales both have DEBT status. Returns the common paginated result with minimal DTOs, stable name/ID ordering, page-scoped aggregation and explicit errors                               |
| `getDebtsSummary()`                            | Returns totalAmount, activeDebtors and todayPayments using database sums and counts. Requires matching sale/debt statuses. Uses zeros without a session or after a caught query failure                                                                |
| `getCustomerDebtAccounts(customerId)`          | Returns `ActionResult<CustomerDebtAccount[]>` for the customer's DEBT rows linked to DEBT sales. Validates customerId and requires a session                                                                                                           |
| `getSaleOrderItems(saleId)`                    | Returns `ActionResult<SaleOrderItem[]>`. Validates saleId and requires both the sale and its debt row to have DEBT status                                                                                                                              |
| `getDebtorHistory(id)`                         | Returns `ActionResult` containing one debtor row or null. Invalid IDs and authorization/query failures return a failure result                                                                                                                         |
| `toDebt(customerId, sales, expectedTotal?)`    | Requires an OPEN jornada. Converts selected UNPAID sales and records debt creation time/jornada. Returns `ActionResult` (`JORNADA_CLOSED` for a selection from a closed shift or `SALES_CHANGED` when a supplied total no longer matches)              |
| `payAccount(customerID, sales, paymentMethod)` | Requires an OPEN jornada. Fully settles selected DEBT sales and records collection time, jornada and employee from the session. Returns `ActionResult` (errors: `UNAUTHORIZED`, `INVALID_INPUT`, `NO_OPEN_JORNADA`, `NO_DEBT_SALES`, `INTERNAL ERROR`) |

Both actions reject duplicate IDs and partially eligible selections with
`INVALID_INPUT`. `toDebt` accepts anonymous sales or sales assigned to the
requested customer. `payAccount` requires every selected sale and its DEBT row
to match that customer. A missing debt row or customer mismatch returns
`INVALID_INPUT`. No eligible sales returns `NO_UNPAID_SALES` or `NO_DEBT_SALES`.
Eligible sales, ownership and balance updates are checked in the write
transaction under the active shift lock. See [Debt rules](business-rules.md#4-debts-and-customer-balance).

## Customers: [customers.ts](../lib/actions/customers.ts)

| Function                             | Authorization      | Input and result                                                                                                                                                                                                 |
| ------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getAllCustomers()`                  | Session            | Customers by name descending. Staff roles receive id, customerName, alias, lastConsumption and registeredDate; the owner receives complete records. `[]` without a session or after a caught failure             |
| `getCustomerPage(query)`             | `customers.manage` | Paginates customer results with search by name or alias and ordering by registration or Spanish name. Returns the common paginated action result with `items`, record `total`, page metadata and explicit errors |
| `searchCustomers(query, limit = 20)` | Session            | Search by name or alias that ignores letter case. Clamps limit (1..100). Alphabetic id/name/alias results. `[]` without a session or after a caught failure                                                      |
| `saveCustomer(data)`                 | `customers.manage` | Validates optional id, name, optional alias (trimmed, max 30 chars) and phone. Creates registration/balance defaults for new customers. Returns `ActionResult`                                                   |

## Users: [users.ts](../lib/actions/users.ts)

| Function                         | Authorization | Input and result                                                                                                                                                                             |
| -------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GetAllUsers()`                  | Owner         | Alphabetic user fields with credential-presence flags, never hashes. Includes role and active status                                                                                         |
| `getStaffPage(query)`            | Owner         | Paginates user directory results with search. Includes credential-presence flags. Returns the common paginated action result with `items`, record `total`, page metadata and explicit errors |
| `searchUsers(query, limit = 20)` | Owner         | Name/username search. Clamps limit (1..100). Alphabetic id/name/username/registeredAt results. Returns `[]` without owner authorization                                                      |
| `createStaff(input)`             | Owner         | Creates a Supervisor or Service account, generates a unique username and six-digit PIN, and returns the PIN once in the action result                                                        |
| `regenerateStaffPin(userId)`     | Owner         | Generates and returns a replacement six-digit PIN once; invalidates existing sessions                                                                                                        |
| `saveUser(data)`                 | Owner         | Updates an existing staff name, role or active status. Owner invariants are enforced; role and active changes invalidate sessions                                                            |

## Inventory: [inventory.ts](../lib/actions/inventory.ts)

| Function                      | Authorization      | Input and result                                                                                                                                                                              |
| ----------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `saveSupply(data)`            | `inventory.manage` | Parses strict integer fields, validates SupplySchema, creates new supplies or atomically updates active supplies by ID, and revalidates inventory and menu. Returns success/error/fieldErrors |
| `getSuppliesData()`           | Session            | Active supplies alphabetically. Staff roles receive id, name, measureUnit, currentStock and active; the owner receives complete records. `[]` without a session or after a caught failure     |
| `getSupplyPage(options)`      | `inventory.manage` | Common paginated action result. `filters.status` accepts `active` (default), `inactive` or `all`; search, status and stock filters precede counting/paging                                    |
| `setSupplyActive(id, active)` | `inventory.manage` | Validates an integer ID and boolean state. Preserves stock, recipes and consumption history. Revalidates inventory, menu and POS. Inactive ingredients block new recipes and sales            |
| `deleteSupply(id)`            | `inventory.manage` | Validates the integer ID and sets active to false. Returns success/error                                                                                                                      |

## Products: [products.ts](../lib/actions/products.ts)

| Function                       | Authorization    | Input and result                                                                                                                                                                                                                                      |
| ------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `saveProduct(data)`            | `catalog.manage` | Saves validated values. Requires price > recipe base cost. Preserves omitted recipes and replaces supplied ones. Revalidates `/pos`, `/admin/inventory` and `/admin/menu`. Returns success/error/fieldErrors                                          |
| `deleteProduct(id)`            | `catalog.manage` | Validates the integer ID and physically deletes the product. Relations may block deletion. Revalidates `/pos`, `/admin/inventory` and `/admin/menu`. Returns `ActionResult`                                                                           |
| `setProductActive(id, active)` | `catalog.manage` | Validates an integer ID and boolean state. Preserves recipes and sales history. Revalidates menu and POS                                                                                                                                              |
| `getProductsData()`            | Session          | Alphabetic active products with recipes/supplies, excluding products with inactive ingredients. Staff roles receive limited supply fields; the owner receives complete supply records. Returns `[]` without a session or after a caught query failure |
| `getProductPage(query)`        | `catalog.manage` | Paginates menu products with name search, supported sort fields and `filters.status`: `active` (default), `inactive` or `all`. Returns the common paginated action result with `items`, record `total`, page metadata and explicit errors             |

## Expenses: [expenses.ts](../lib/actions/expenses.ts)

| Function               | Authorization                              | Input and result                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `saveExpense(data)`    | Session + OPEN jornada                     | Amount, category, description, Date and required payment_method (CASH/TRANSFER). No method default. Validates a BillSchema subset, normalizes date to the business calendar date (America/Mexico_City), and derives registered_by from the session. Returns success/error/fieldErrors with sanitized errors |
| `getExpenses(options)` | `expenses.create` or `reports.operational` | Common paginated result, newest dates/IDs first. Personnel without report permission see only their own expenses, total and latest category; report readers see all expenses                                                                                                                                |

## Payroll: [payrolls.ts](../lib/actions/payrolls.ts)

| Function                       | Authorization        | Input and result                                                                                                                                                                                                    |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `saveSalaryPayment(data)`      | Owner + OPEN jornada | Validates positive user ID, positive amount, period (reason max 50 code points, total max 65 with prefix) and required payment method. Stores today's payDate and active jornada. Returns success/error/fieldErrors |
| `getSalaryHistory(options)`    | Owner                | Common paginated action result; required `filters.userId`, newest payment dates/IDs first. Explicit validation/authorization/query errors                                                                           |
| `getPayrollUsersPage(options)` | Owner                | Minimal employee picker DTOs using the common paginated result                                                                                                                                                      |
| `getUserPayrollInfo(userID)`   | Owner                | User id/name/username/registeredAt, or null for an invalid ID, absent user/session or caught failure                                                                                                                |

Salary registration requires an open jornada. It creates a salary row, not a
separate expense row.

## Jornada: [jornada.ts](../lib/actions/jornada.ts)

| Function                                                           | Authorization                                 | Input and result                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hasOpenJornada()`                                                 | Session                                       | Returns a boolean cached for the request. False without a session                                                                                                                                                                                                                   |
| `getOpenJornadaId()`                                               | Session                                       | Returns the active jornada ID or null, sharing the request cache with `hasOpenJornada`                                                                                                                                                                                              |
| `openJornada(input: CashCountInput)`                               | `jornada.open`                                | Validates UUID idempotency key and complete denomination breakdown, derives integer-cent opening amount, then atomically opens the jornada and saves its OPENING count/cash snapshot. A zero total needs `confirmEmpty: true`. Returns the saved `CashCountView`                    |
| `recordCashCount(jornadaId, input)`                                | `jornada.reconcile`                           | Saves an immutable INTERIM count and server cash snapshot at the transaction cutoff. `recountOfId` links an earlier count in the same jornada and requires a reason in `note`. Duplicate request IDs only replay an identical payload by the same operator. Returns `CashCountView` |
| `closeJornada(jornadaId, input: CashCountInput)`                   | `jornada.close`                               | Saves an immutable CLOSING count and closes in one transaction. Requires an OPEN jornada and no UNPAID sales; `OPEN_ACCOUNTS` includes `data: { openAccounts }`. Returns the saved count and revalidates the shift routes                                                           |
| `getCashCountHistory(options)` / `exportCashCountHistory(filters)` | Session; own records or `jornada.viewCash`    | Paginated/filterable count history and a server CSV export. Staff results are scoped to their own counts; privileged users may filter by jornada, operator and type                                                                                                                 |
| `getJornadaCollectionsByEmployee(jornadaId)`                       | `jornada.viewCash`                            | Collections attributed to the authenticated collector and receiving jornada, grouped by employee and payment method                                                                                                                                                                 |
| `getJornadaClosingSummary(jornadaId)`                              | Session; own count data or `jornada.viewCash` | Returns saved counts and authorized jornada closing/collection summary. Historical jornadas without count rows remain without synthetic records                                                                                                                                     |
| `getActiveJornadaWithStats()`                                      | Current jornada capability                    | Returns a result cached for the request. Cash summary fields are limited by current authorization. NO_JORNADA includes currentUserId. OWN_OPEN/OTHER_OPEN include jornada status and authorized cash stats                                                                          |
| `getJornadaEmployeeBreakdown(jornadaId)`                           | `jornada.viewCash`                            | Paid record counts/totals by placing user, descending totalSold. Returns an empty list without authorization                                                                                                                                                                        |

`CashCountInput` is defined in [`cash-count.ts`](../lib/cash-count.ts):

```ts
type CashCountInput = {
  requestId: string; // UUID retry key
  denominations: { kind: "BILL" | "COIN"; valueCents: number; quantity: number }[];
  note?: string;
  recountOfId?: number;
  confirmEmpty?: boolean;
};
```

`parseCashCountInput` rejects unknown fields, unsupported/duplicate denominations,
negative or fractional quantities and unsafe totals. Total may not exceed
100,000,000,000,000 cents; zero requires `confirmEmpty: true`. Notes are trimmed
and limited to 1,000 characters. Recount IDs must be positive PostgreSQL Int IDs.
The MXN catalog supports bills of 20/50/100/200/500/1000 pesos and coins of
0.05/0.10/0.20/0.50/1/2/5/10/20 pesos; bill and coin entries of the same value
are distinct. Zero-quantity denominations may be omitted.
A new INTERIM may reference a prior OPENING or INTERIM in the same open shift,
with a required note. Opening and closing reject recount references.

Saving computes and freezes expected cash, difference and configured tolerance
on the server under the cash-movement lock. Outside tolerance, `note` is required
before any record is saved or discrepancy amounts are returned. `CashCountView`
contains serialized receipt fields; expected/difference/result/summary fields
are omitted without `jornada.viewCash`. Owner-only payroll and savings components
are masked in Supervisor snapshots.

History accepts flat `{ page?, pageSize?, jornadaId?, operatorId?, type? }`
options, defaults to page 1/size 20, caps size at 50 and clamps pages using
canonical pagination metadata in a RepeatableRead snapshot. CSV accepts the
matching filters, exports all authorized records and neutralizes spreadsheet
formulas. Own-record scoping also applies to direct action calls and exports.

## Savings: [savings.ts](../lib/actions/savings.ts)

| Function                                   | Authorization                                                   | Input and result                                                                                                                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getPoolBalance()`                         | Owner                                                           | balance/deposited/withdrawn. Zeros without owner authorization                                                                                                                                                                             |
| `getRecentMovements(options)`              | Owner                                                           | Common paginated action result, descending timestamp/ID, serialized amounts and userName                                                                                                                                                   |
| `saveMovement(amount, type, description?)` | `savings.deposit` for DEPOSIT; owner for WITHDRAW; OPEN jornada | Positive safe-integer amount, DEPOSIT/WITHDRAW, atomic withdrawal balance check, and cumulative pool/jornada safe-integer bounds checks. Revalidates `/admin/savings`, `/(dashboard)` layout, and `/admin/jornada`. Returns `ActionResult` |
| `getGoalsWithProgress(options)`            | Owner                                                           | Common paginated action result. `filters.status` is ACTIVE (default), inactive or all. All contributions count toward each visible goal                                                                                                    |
| `saveGoal(data)`                           | Owner                                                           | Optional id, name/targetAmount and optional deadline (`Date`, trimmed `YYYY-MM-DD`, or strict UTC ISO string in years 1900..9999)/description. Returns `ActionResult`                                                                      |
| `cancelGoal(id)`                           | Owner                                                           | Sets CANCELLED. Returns `ActionResult`                                                                                                                                                                                                     |
| `addContribution(goalId, amount, note?)`   | Owner                                                           | Valid goal ID and positive safe-integer cents. Locks the goal; the transaction may complete an ACTIVE goal. Returns `ActionResult`                                                                                                         |

Savings read failures can propagate. Goal contributions do not move pool money
and do not require an open jornada.

## Settings: [settings.ts](../lib/actions/settings.ts)

| Function             | Authorization | Input and result                                                                                                                                  |
| -------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getSettings()`      | Owner         | Returns CLABE and cash-count tolerance in cents (zero by default). Empty/default values without owner authorization or after a caught failure     |
| `saveSettings(data)` | Owner         | Accepts partial CLABE and/or nonnegative safe-integer `cashCountToleranceCents` up to 100,000,000,000,000 cents; preserves omitted settings and returns success/error/fieldErrors |

## Analytics: [analytics.ts](../lib/actions/analytics.ts)

Every query and export checks `reports.operational` and validates its filter at runtime. Delegated reports exclude payroll and private savings movements; the owner retains payroll reports.

| Function                 | Input and result                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getStatistics(input)`   | from/to. Returns `AnalyticsResult<StatisticsData>`                                                                                                                            |
| `getReport(options)`     | Common paginated POST action result with `filters: { from, to, type }`, optional page/pageSize, period-wide summary, columns and notices. Groups are formed before pagination |
| `getReportExport(input)` | Validated from/to/type. Returns `AnalyticsResult<ReportData>` with every matching row and totals, without pagination fields                                                   |

Statistics and exports use `AnalyticsResult<T>`: `{ success: true, data: T }` or
`{ success: false, error, message }`. Error codes are PERMISSION_DENIED,
INVALID_FILTER and QUERY_FAILED. Paginated `getReport` uses the shared list
result and its UNAUTHENTICATED/FORBIDDEN/INVALID_INPUT/QUERY_FAILED errors.

Dates must be valid, ordered ISO calendar dates within the 366-day range limit.
Paginated reports use shared page normalization: page 1 and size 10 by default,
with a maximum size of 50. Digit strings are accepted; malformed or nonpositive
page values fall back to 1. Exports accept from/to/type and return all matching
rows without page metadata. [Reporting rules](business-rules.md#10-statistics-and-reports-beta)
define the metrics.

## Shared schemas: [schemas.ts](../lib/actions/schemas.ts)

| Export                                     | Purpose                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SaleStatusSchema` / `PaymentMethodSchema` | Accepted status/payment values. The payment schema has no default                                                                                        |
| `BillSchema`                               | Positive expense amount, Date, attribution and required payment method                                                                                   |
| `CustomerSchema`                           | Customer fields and optional related data. Writes select id/name/alias/phone                                                                             |
| `DebtorListItemSchema`                     | Minimal debtor list fields, nullable customer names/aliases/dates and numeric amount                                                                     |
| `DebtorsSchema`                            | Debt creation time/jornada and nullable collection time/jornada/employee                                                                                 |
| `ProductSchema` / `RecipesSchema`          | Name (3-40 characters), positive price, positive supply IDs and nonnegative recipe quantities                                                            |
| `SalarySchema`                             | Positive payment, user/date, nonempty period with at most 50 Unicode code points for the reason (up to 65 including prefix), and required payment method |
| `SaleItemsSchema` / `SalesSchema`          | Item/sale fields. Sale payment_method is nullable                                                                                                        |
| `SupplySchema`                             | Nonnegative stock and recipe quantities, nonempty name/unit and positive unit cost                                                                       |
| `UserSchema`                               | Name (3-50 chars with surname), role (`ADMIN`, `SUPERVISOR`, `STAFF`), owner email/password, six-digit staff PIN and active status                       |
| `AnalyticsFilterSchema`                    | Valid ordered calendar dates within a maximum span of 366 days                                                                                           |
| `ReportTypeSchema`                         | sales/products/expenses/salaries/customers/debts                                                                                                         |
| `ReportFilterSchema`                       | Ordered from/to dates plus a supported report type; used for complete exports                                                                            |
| `AnalyticsReportSchema`                    | Common pagination schema with typed from/to/type filters; page 1, size 10, maximum 50                                                                    |

The module exports inferred Bill, Customer, Debtors, Product, Recipes, Salary,
SaleItems, Sales, Supply and User types. Sales and debt actions also export their
own Sale/Debtor result types.

### Input validation

Sales/debt mutations validate selected IDs, item quantities, source, status and
payment method with the shared schemas. `createSale` rejects CANCELLED status.
`updateSaleQuantity` requires a positive integer quantity. The POS decrement from one
uses `cancelSaleAction` to cancel the entire sale.

Save actions validate their own schema subsets. Product and customer writes use
parsed values. User writes also validate email and active field types.
Expense and salary writes require an explicit payment method. By contrast,
`createSale` and `closeAccountAction` default an omitted method to CASH before
validation.

`getDebtorHistory`, product/supply deletion and salary queries validate their
IDs. Jornada and savings use local guards instead of shared input schemas.
Pagination, search and list filters are validated with `createPaginationSchema`.
Session or jornada queries may run before input validation. Validation is not an ownership
or concurrency guarantee.

## Supporting helpers

### Pagination: [lib/pagination](../lib/pagination/index.ts)

| Export                                                                  | Purpose                                                               |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `PaginationOptions`, `PaginatedResult`, `PageResult`, `PaginationError` | Shared inputs, metadata, action result and error types                |
| `createPaginationSchema(config)`                                        | Normalize page/size and validate search, filters and allowed ordering |
| `getPaginationMeta(total, options)`                                     | Validate the count, clamp the page and calculate totalPages/hasMore   |
| `getPaginationOffset({ page, pageSize })`                               | Calculate a nonnegative safe-integer offset                           |
| `emptyPage(pageSize?)`                                                  | Create canonical empty result metadata                                |
| `escapeListSearch(search)`                                              | Escape backslash, percent and underscore in literal list searches     |

Defaults are page 1 and size 10. `PAGE_SIZE_OPTIONS` is 10/20/50; `MAX_PAGE_SIZE`
is 50. Client state, loading and controls live in `components/pagination`.
See [Pagination](pagination.md) for browser history and refresh behavior.

### Account sources: [pos-source.ts](../lib/pos-source.ts)

| Function                                                                                     | Purpose                                       |
| -------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `freeTicketSource(ticketNumber)` / `tableSource(tableNumber)` / `customerSource(customerId)` | Build VL-/MESA_/CL- identifiers               |
| `freeTicketNumber(source)`                                                                   | Read a positive ticket number, or return null |
| `isFreeTicket(source)` / `isAccountSource(source)`                                           | Classify ticket/account sources               |
| `formatSourceType(source)`                                                                   | Spanish label. Unknown values are preserved   |
| `nextFreeTicketNumber(openTicketNumbers)`                                                    | Find the lowest unused positive number        |

Constants are FREE_SALE_SOURCE, FREE_TICKET_PREFIX, TABLE_PREFIX and
CUSTOMER_PREFIX. These helpers do not reserve database identifiers.

### Cash cut: [jornada-cash.ts](../lib/jornada-cash.ts)

`getJornadaCashSummary(jornadaId, openingAmount)` returns the summary for one
jornada. The result contains:

- Sales, debt collections, expenses and salaries grouped by payment method.
- Savings deposits from the drawer (`savingsOut`). Withdrawals affect only the
  savings balance.
- Expected cash and transfers.
- Debt created in the jornada.
- Total pending debt.

All count mutations and `getActiveJornadaWithStats` use it.
`paidSalesForJornadaWhere(jornadaId)` provides the shared direct-payment
receiving-shift filter, using the original jornada only when `paidJornadaId` is
null. Callers separately require PAID status and exclude debt-linked sales.
Cash balance bounds use the same receiving-shift filter.
It is not a Server
Action and has no session check. Callers must authorize access.
[Cash rules](business-rules.md#5-jornadas-and-cash) define the formula.

### Analytics: [analytics.ts](../lib/analytics.ts)

| Function                                                    | Purpose                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `businessDate(date?)` / `businessHour(date)`                | Calendar date/hour in BUSINESS_TIME_ZONE                                        |
| `shiftCalendarDate(value, days)` / `calendarDays(from, to)` | Shift calendar dates and calculate day differences                              |
| `isCalendarDate(value)`                                     | Validate YYYY-MM-DD by round trip check                                         |
| `defaultAnalyticsFilter(days = 30, now?)`                   | Build an inclusive recent range                                                 |
| `analyticsPeriod(filter, now?)`                             | Current/preceding periods and includesToday                                     |
| `businessMidnight(value)`                                   | Resolve calendar midnight in the business zone                                  |
| `timestampRange(filter)` / `calendarRange(filter)`          | Build timestamp/calendar date bounds                                            |
| `compareAmounts(current, previous)`                         | Integer-cent difference and percentage comparison                               |
| `saleOrigin(source)` / `paymentMethodLabel(method)`         | Group origin/payment labels                                                     |
| `specified(value)`                                          | Return "Sin especificar" for missing/blank text                                 |
| `money(value)`                                              | Format MXN                                                                      |
| `calendarDateLabel(value)` / `businessDateTimeLabel(value)` | Format dates and business timezone timestamps                                   |
| `toBusinessCalendarDate(date?)`                             | Normalize Date instant to UTC midnight of business calendar date for `@db.Date` |
| `formatReportCell(value, kind)`                             | Format text, money, integer, date, datetime or percent                          |
| `reportCsv(report)`                                         | Escape CSV, neutralize formulas and add BOM/totals                              |

Constants include BUSINESS_TIME_ZONE (America/Mexico_City) and REPORT_NAMES.
Page-size defaults and limits live in `lib/pagination`. Exported types describe filters, periods, results,
comparisons, metrics, statistics and report data.

### Authentication and browser state

| Source                                                                    | Exports and responsibility                                                                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`lib/auth.ts`](../lib/auth.ts)                                           | Auth.js auth/handlers/signIn/signOut and the authorizeCredentials re-export                                                                                                          |
| [`lib/auth-credentials.ts`](../lib/auth-credentials.ts)                   | credentialsSchema, authorizeCredentials and isAccountLockedOut; role-aligned bcrypt verification                                                                                     |
| [`lib/auth-lockout.ts`](../lib/auth-lockout.ts)                           | Persistent account attempts, process-local unknown identifiers and testing-only reset helpers                                                                                        |
| [`lib/auth-types.ts`](../lib/auth-types.ts)                               | User roles and session authentication mode; unknown roles are rejected                                                                                                               |
| [`lib/permissions.ts`](../lib/permissions.ts)                             | Route rules, capability catalog, role defaults and configuration helpers                                                                                                             |
| [`lib/action-tracker.ts`](../lib/action-tracker.ts)                       | trackAction counts pending actions; hasPendingActions reads the count                                                                                                                |
| [`lib/use-polling.ts`](../lib/use-polling.ts)                             | usePolling(callback, interval = 10000) refreshes on visible ticks/tab return                                                                                                         |
| [`lib/device-settings.ts`](../lib/device-settings.ts)                     | useDeviceSettings, deviceName/setDeviceName/markHydrated, and useDeviceSettingsHydration                                                                                             |
| [`lib/store.ts`](../lib/store.ts)                                         | useStore count/userName/subMenu and their setters/reset, persisted in app-storage                                                                                                    |
| [`lib/utils.ts`](../lib/utils.ts)                                         | cn combines conditional classes and resolves Tailwind conflicts                                                                                                                      |
| [`lib/monetary.ts`](../lib/monetary.ts)                                   | `roundHalfEven`, `recipeCostCents` and `allocateCents` for exact `BigInt` cent/milliunit arithmetic                                                                                  |
| [`lib/scaled-values.ts`](../lib/scaled-values.ts)                         | `toSafeInteger`, `parseCents`, `parseMilliunits`, `formatCents`, `formatCurrencyCents` and `formatMilliunits` for safe integer boundary conversion and currency/quantity formatting  |
| [`optimistic-sale.ts`](<../app/(dashboard)/pos/optimistic-sale.ts>)       | makeOptimisticSale, isOptimisticSale and salesOptimisticReducer manage local sale overlays                                                                                           |
| [`use-pos-sale-queue.ts`](<../app/(dashboard)/pos/use-pos-sale-queue.ts>) | usePosSaleQueue queues sequential POS product taps, tracks pending optimistic sales until server confirmation, and enforces a 1-second per-product cooldown after 3 consecutive taps |

Route components and shared UI components are presentation entry points, not
additional domain APIs.

`getRecipeSupplyPage(query)` in `inventory.ts` authorizes `catalog.manage` and
returns the bounded supply data needed by the recipe picker. It does not grant
stock editing. `getSupplyPage` and supply writes retain `inventory.manage`.
