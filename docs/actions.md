# Action and helper reference

This reference lists the exported functions in `lib/actions/` and the helpers
used by the application. Domain functions are Server Actions, not REST endpoints.
The linked source contains the full TypeScript signatures.

**Session** means `auth()` must return a user. **ADMIN** means the action checks
that role itself. Page permissions are separate. Return shapes and failure
defaults vary by function. Callers must handle the contract they use.
[Business rules](business-rules.md) explains state changes and known limits.

## Authentication: [auth_action.ts](../lib/actions/auth_action.ts)

| Function | Input, result and effect |
| --- | --- |
| `login(prevState, formData)` | Public form action. Validates a UserSchema subset. Email selects ADMIN mode, otherwise STAFF. Calls credentials login and redirects to `/pos`. Failures return `error` and, for validation, `fieldErrors` |
| `logout()` | Signs out and redirects to `/login` |

## Sales: [sales.ts](../lib/actions/sales.ts)

All functions require a session. Unauthenticated history queries return `[]`.

| Function | Input, result and effect |
| --- | --- |
| `createSale(sale_items, status, source_type, customerID, paymentMethod = "CASH")` | Items contain productID/quantity. Status is UNPAID, PAID or DEBT. Reads prices from the database and writes sale, stock and customer/debt changes in one transaction. Success includes saleId/message. Failures use error or message |
| `nextFreeSaleTicket()` | Requires an OPEN jornada. Returns `{ success: true, sourceType }` or `{ success: false, message }`. Selecting a number does not reserve it |
| `closeAccountAction(sourceType, paymentMethod = "CASH")` | Pays matching UNPAID records in the active jornada. Success includes count, which may be zero. Failures use message |
| `getSalesHistory()` | Returns all sales, newest first, with related data, numeric totals and item record counts. No pagination |
| `getTodaySalesHistory()` | Returns today's sales whose status is not CANCELLED using the server's local day, with selected relations and serialized dates/Decimals. No pagination |
| `cancelSaleAction(saleId)` | Cancels the sale and restores stock using current recipes. An open debt is also cancelled and removed from the customer's balance. Returns success/error. Some failure results omit success |
| `updateSaleQuantity(saleId, quantity, productId)` | Adjusts quantity, stock and totals. An integer quantity below one cancels the entire sale. Returns success/message |

## Debts: [debts.ts](../lib/actions/debts.ts)

All functions require a session. Mutation callers select sale IDs. Amounts come
from the database.

| Function | Input, result and effect |
| --- | --- |
| `getAllDebtors()` | Groups DEBT rows by customer, with amount, customer and sales. Returns `[]` without a session or after a caught query failure |
| `getDebtsSummary()` | Returns totalAmount, activeDebtors and todayPayments. Uses zeros without a session or after a caught query failure |
| `getDebtorHistory(id)` | Returns one debtor row or null. Invalid IDs and authorization/query failures return success/error |
| `toDebt(customerId, sales)` | Requires an OPEN jornada. Converts selected UNPAID sales and records debt creation time/jornada. Returns `msg`: SUCCESS, UNAUTHORIZED, INVALID_INPUT, NO_OPEN_JORNADA, NO_UNPAID_SALES or INTERNAL ERROR. Caught failures may also include error |
| `payAccount(customerID, sales, paymentMethod)` | Requires an OPEN jornada. Fully settles selected DEBT sales and records collection time, jornada and employee from the session. Returns `msg`: SUCCESS, UNAUTHORIZED, INVALID_INPUT, NO_OPEN_JORNADA, NO_DEBT_SALES or INTERNAL ERROR |

Debt selection does not independently verify that every sale belongs to the
given customer. Reads occur before the write transaction. See
[Debt rules](business-rules.md#4-debts-and-customer-balance) for concurrency limits.

## Customers: [customers.ts](../lib/actions/customers.ts)

| Function | Authorization | Input and result |
| --- | --- | --- |
| `getAllCustomers()` | Session | Customers by name descending. `[]` without a session or after a caught failure |
| `searchCustomers(query, limit = 20)` | Session | Search by name or alias that ignores letter case. Alphabetic id/name/alias results. `[]` without a session or after a caught failure |
| `saveCustomer(data)` | Session | Validates optional id, name and phone. Creates registration/balance defaults for new customers. Returns success/error/fieldErrors |

## Users: [users.ts](../lib/actions/users.ts)

| Function | Authorization | Input and result |
| --- | --- | --- |
| `GetAllUsers()` | Session | Alphabetic user fields with hasPassword/hasPin flags, never credential hashes. `[]` without a session or after a caught failure |
| `searchUsers(query, limit = 20)` | Session | Name/username search. Alphabetic id/name/username/registeredAt results. `[]` without a session or after a caught failure |
| `saveUser(data)` | ADMIN | Creates or updates name, role, active status and selected credential with bcrypt. Create/update fields differ. Returns success/error/fieldErrors |

## Inventory: [inventory.ts](../lib/actions/inventory.ts)

| Function | Authorization | Input and result |
| --- | --- | --- |
| `saveSupply(data)` | ADMIN | Casts numeric fields, validates SupplySchema and upserts. Returns success/error/fieldErrors |
| `getSuppliesData()` | Session | Active supplies alphabetically. `[]` without a session or after a caught failure |
| `deleteSupply(id)` | ADMIN | Validates the integer ID and sets active to false. Returns success/error |

## Products: [products.ts](../lib/actions/products.ts)

| Function | Authorization | Input and result |
| --- | --- | --- |
| `saveProduct(data)` | ADMIN | Saves validated values. Checks base cost for a supplied nonempty recipe. Preserves an omitted recipe and replaces a supplied one. Returns success/error/fieldErrors |
| `deleteProduct(id)` | ADMIN | Validates the integer ID and physically deletes the product. Relations may block deletion. Returns success/error. Denied results may omit success |
| `getProductsData()` | Session | Alphabetic products with recipes/supplies. Returns `[]` without a session or after a caught query failure |

## Expenses: [expenses.ts](../lib/actions/expenses.ts)

| Function | Authorization | Input and result |
| --- | --- | --- |
| `saveExpense(data)` | Session + OPEN jornada | Amount, category, description, Date and required payment_method (CASH/TRANSFER). No method default. Validates a BillSchema subset and derives registered_by from the session. Returns success/error/fieldErrors |
| `getExpenses(offset = 0, limit = 30)` | Session | Returns items, overall total and hasMore. Uses empty/zero values without a session. Database errors can propagate |

## Payroll: [payrolls.ts](../lib/actions/payrolls.ts)

| Function | Authorization | Input and result |
| --- | --- | --- |
| `saveSalaryPayment(data)` | ADMIN + OPEN jornada | userID, positive amount, period and required payment_method. No method default. Stores today's payDate and the active jornada. Returns success/error/fieldErrors. A caught database failure may return only success false |
| `getSalaryHistory(userID, offset = 0, limit = 30)` | Session | Items/hasMore for the selected user. Empty result for an invalid ID, absent session or caught failure |
| `getUserPayrollInfo(userID)` | Session | User name/registeredAt, or null for an invalid ID, absent session or caught failure |

Salary registration requires an open jornada. It creates a salary row, not a
separate expense row.

## Jornada: [jornada.ts](../lib/actions/jornada.ts)

| Function | Authorization | Input and result |
| --- | --- | --- |
| `hasOpenJornada()` | Session | Returns a boolean cached for the request. False without a session |
| `openJornada(openingAmount)` | ADMIN | Requires finite nonnegative cash. Returns success/error. PENDING_JORNADA includes pendingJornadaId |
| `closeJornada(jornadaId, actualClosingAmount)` | ADMIN | Requires finite nonnegative counted cash, an OPEN jornada and no UNPAID sales. Stores expected cash/transfers from getJornadaCashSummary. OPEN_ACCOUNTS includes sourceType/count/total |
| `getActiveJornadaWithStats()` | Session | Returns a result cached for the request. Null without a session. NO_JORNADA includes currentUserId. OWN_OPEN/OTHER_OPEN include the jornada and cash cut stats |
| `getJornadaEmployeeBreakdown(jornadaId)` | Session | Paid record counts/totals by placing user, descending totalSold. `[]` without a session |

## Savings: [savings.ts](../lib/actions/savings.ts)

| Function | Authorization | Input and result |
| --- | --- | --- |
| `getPoolBalance()` | Session | balance/deposited/withdrawn. Zeros without a session |
| `getRecentMovements(limit = 20, offset = 0)` | Session | items/hasMore by descending timestamp with userName. Limit comes before offset |
| `saveMovement(amount, type, description?)` | ADMIN + OPEN jornada | Positive finite amount, DEPOSIT/WITHDRAW and withdrawal balance check. Returns success/message |
| `getGoalsWithProgress()` | Session | Goals with currentAmount/progressPercent. `[]` without a session |
| `saveGoal(data)` | ADMIN | Optional id, name/targetAmount and optional deadline/description. Returns success/message |
| `cancelGoal(id)` | ADMIN | Sets CANCELLED. Returns success/message |
| `addContribution(goalId, amount, note?)` | ADMIN | Positive finite contribution. Transaction may complete an ACTIVE goal. Returns success/message |

Savings read failures can propagate. Goal contributions do not move pool money
and do not require an open jornada.

## Settings: [settings.ts](../lib/actions/settings.ts)

| Function | Authorization | Input and result |
| --- | --- | --- |
| `getSettings()` | Session | Returns clabe. Empty string without a session or after a caught failure |
| `saveSettings(data)` | ADMIN | Accepts blank CLABE or 18 digits after outer trim. Upserts the setting and returns success/error/fieldErrors |

## Analytics: [analytics.ts](../lib/actions/analytics.ts)

Every query checks ADMIN, including exports, and validates its filter at runtime.

| Function | Input and result |
| --- | --- |
| `getStatistics(input)` | from/to. Returns `AnalyticsResult<StatisticsData>` |
| `getReport(input)` | from/to/type/page?. Returns `AnalyticsResult<ReportData>` with a page of 50 rows |
| `getReportExport(input)` | Same validated input. Returns `AnalyticsResult<ReportData>` with every matching row |

`AnalyticsResult<T>` is `{ success: true, data: T }` or
`{ success: false, error, message }`. Error codes are PERMISSION_DENIED,
INVALID_FILTER and QUERY_FAILED.

Dates must be valid ISO calendar dates in order. Page defaults to 1 and must
be a positive safe integer. Digit strings are accepted. Export validates page,
then returns all rows as page 1. [Reporting rules](business-rules.md#10-statistics-and-reports-beta)
define the metrics.

## Shared schemas: [schemas.ts](../lib/actions/schemas.ts)

| Export | Purpose |
| --- | --- |
| `SaleStatusSchema` / `PaymentMethodSchema` | Accepted status/payment values. The payment schema has no default |
| `BillSchema` | Positive expense amount, Date, attribution and required payment method |
| `CustomerSchema` | Customer fields and optional related data. Writes select id/name/phone |
| `DebtorsSchema` | Debt creation time/jornada and nullable collection time/jornada/employee |
| `ProductSchema` / `RecipesSchema` | Menu price, product/supply identifiers and recipe quantities |
| `SalarySchema` | Positive payment, user/date/period and required payment method |
| `SaleItemsSchema` / `SalesSchema` | Item/sale fields. Sale payment_method is nullable |
| `SupplySchema` | Nonnegative stock, nonempty name/unit and unit cost of at least 1 |
| `UserSchema` | User fields. Login and writes select different subsets |
| `AnalyticsFilterSchema` | Valid ordered calendar dates |
| `ReportTypeSchema` | sales/products/expenses/salaries/customers/debts |
| `AnalyticsReportSchema` | Filter plus type and page |

The module exports inferred Bill, Customer, Debtors, Product, Recipes, Salary,
SaleItems, Sales, Supply and User types. Sales and debt actions also export their
own Sale/Debtor result types.

### Input validation

Sales/debt mutations validate selected IDs, item quantities, source, status and
payment method with the shared schemas. `createSale` rejects CANCELLED status.
`updateSaleQuantity` accepts integer quantities below one to request cancellation.

Save actions validate their own schema subsets. Product and customer writes use
parsed values. User writes also validate email and active field types.
Expense and salary writes require an explicit payment method. By contrast,
`createSale` and `closeAccountAction` default an omitted method to CASH before
validation.

`getDebtorHistory`, product/supply deletion and salary queries validate their
IDs. Jornada and savings use local guards instead of shared input schemas.
Pagination and search arguments are not covered by these schemas. Session or
jornada queries may run before input validation. Validation is not an ownership
or concurrency guarantee.

## Supporting helpers

### Account sources: [pos-source.ts](../lib/pos-source.ts)

| Function | Purpose |
| --- | --- |
| `freeTicketSource(ticketNumber)` / `tableSource(tableNumber)` / `customerSource(customerName)` | Build VL-/MESA_/CL- identifiers |
| `freeTicketNumber(source)` | Read a positive ticket number, or return null |
| `isFreeTicket(source)` / `isAccountSource(source)` | Classify ticket/account sources |
| `formatSourceType(source)` | Spanish label. Unknown values are preserved |
| `nextFreeTicketNumber(openTicketNumbers)` | Find the lowest unused positive number |

Constants are FREE_SALE_SOURCE, FREE_TICKET_PREFIX, TABLE_PREFIX and
CUSTOMER_PREFIX. These helpers do not reserve database identifiers.

### Cash cut: [jornada-cash.ts](../lib/jornada-cash.ts)

`getJornadaCashSummary(jornadaId, openingAmount)` returns the summary for one
jornada. The result contains:

- Sales, debt collections, expenses and salaries grouped by payment method.
- Savings outflow.
- Expected cash and transfers.
- Debt created in the jornada.
- Total pending debt.

Both `closeJornada` and `getActiveJornadaWithStats` use it. It is not a Server
Action and has no session check. Callers must authorize access.
[Cash rules](business-rules.md#5-jornadas-and-cash) define the formula.

### Analytics: [analytics.ts](../lib/analytics.ts)

| Function | Purpose |
| --- | --- |
| `businessDate(date?)` / `businessHour(date)` | Calendar date/hour in BUSINESS_TIME_ZONE |
| `shiftCalendarDate(value, days)` / `calendarDays(from, to)` | Shift calendar dates and calculate day differences |
| `isCalendarDate(value)` | Validate YYYY-MM-DD by round trip check |
| `defaultAnalyticsFilter(days = 30, now?)` | Build an inclusive recent range |
| `analyticsPeriod(filter, now?)` | Current/preceding periods and includesToday |
| `businessMidnight(value)` | Resolve calendar midnight in the business zone |
| `timestampRange(filter)` / `calendarRange(filter)` | Build timestamp/calendar date bounds |
| `compareAmounts(current, previous)` | Numeric difference/percentage. Action aggregates use Decimal |
| `saleOrigin(source)` / `paymentMethodLabel(method)` | Group origin/payment labels |
| `specified(value)` | Return "Sin especificar" for missing/blank text |
| `money(value)` | Format MXN |
| `calendarDateLabel(value)` / `businessDateTimeLabel(value)` | Format dates and business timezone timestamps |
| `formatReportCell(value, kind)` | Format text, money, integer, date, datetime or percent |
| `reportCsv(report)` | Escape CSV, neutralize formulas and add BOM/totals |
| `analyticsUrl(path, filter, extras?)` | Build query parameter links |

Constants include BUSINESS_TIME_ZONE (America/Mexico_City), REPORT_PAGE_SIZE
(50) and REPORT_NAMES. Exported types describe filters, periods, results,
comparisons, metrics, statistics and report data.

### Authentication and browser state

| Source | Exports and responsibility |
| --- | --- |
| [`lib/auth.ts`](../lib/auth.ts) | Auth.js auth/handlers/signIn/signOut |
| [`lib/auth-types.ts`](../lib/auth-types.ts) | USER_ROLES/UserRole. NormalizeUserRole maps roles other than ADMIN to STAFF |
| [`lib/permissions.ts`](../lib/permissions.ts) | ROUTE_PERMISSIONS and canAccessRoute. First matching rule based on complete path segments |
| [`lib/action-tracker.ts`](../lib/action-tracker.ts) | trackAction counts pending actions. HasPendingActions reads the count |
| [`lib/use-polling.ts`](../lib/use-polling.ts) | usePolling(callback, interval = 10000) refreshes on visible ticks/tab return |
| [`lib/device-settings.ts`](../lib/device-settings.ts) | useDeviceSettings, deviceName/setDeviceName/markHydrated, and useDeviceSettingsHydration |
| [`lib/store.ts`](../lib/store.ts) | useStore count/userName/subMenu and their setters/reset, persisted in app-storage |
| [`lib/utils.ts`](../lib/utils.ts) | cn combines conditional classes and resolves Tailwind conflicts |
| [`optimistic-sale.ts`](../app/(dashboard)/pos/optimistic-sale.ts) | makeOptimisticSale, isOptimisticSale and salesOptimisticReducer manage local sale overlays |

Route components and shared UI components are presentation entry points, not
additional domain APIs.
