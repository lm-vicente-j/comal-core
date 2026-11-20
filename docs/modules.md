# Modules

Comal Core uses Spanish interface labels and English route paths. Route groups
such as `(dashboard)` are not part of the URL. This page describes screen access. [Action reference](actions.md) documents server permissions.

## Route map

| Screen | Route | Action source | Access |
| --- | --- | --- | --- |
| Login | `/login` | `auth_action.ts` | Guest |
| Inicio | `/` | Welcome page | Session |
| Ventas / POS | `/pos` | `sales.ts`, `customers.ts`, `debts.ts` | ADMIN, STAFF |
| Deudores | `/debtors` | `debts.ts` | ADMIN, STAFF |
| Egresos | `/expenses` | `expenses.ts` | ADMIN, STAFF |
| Inventario | `/admin/inventory` | `inventory.ts` | ADMIN |
| Menú | `/admin/menu` | `products.ts`, `inventory.ts` | ADMIN |
| CRM | `/admin/crm` | `customers.ts`, `users.ts` | ADMIN |
| Salarios | `/admin/roster` | `payrolls.ts`, `users.ts` | ADMIN |
| Ahorros | `/admin/savings` | `savings.ts` | ADMIN |
| Jornada | `/admin/jornada` | `jornada.ts` | ADMIN. STAFF sees the banner |
| Ajustes | `/admin/settings` | `settings.ts` | ADMIN |
| Estadísticas (beta) | `/admin/statistics` | `analytics.ts` | ADMIN |
| Reportes (beta) | `/admin/reports` | `analytics.ts` | ADMIN |

[Desktop](../components/layout/sidebar.tsx) and
[mobile navigation](../components/layout/mobile-nav.tsx) use the shared route
permissions. Jornada controls are reached through the banner. Mobile ADMIN
users find management links in the Menu sheet. STAFF has the three operational
links.

Optimiza is hidden. Its navigation definitions mention engine, predictions,
accuracy and supply routes under `/admin/analysis/`, but those pages do not
exist.

## Point of sale

[Desktop POS](../app/(dashboard)/pos/pos-manager.tsx) and
[mobile POS](../app/(dashboard)/pos/MobilePosManager.tsx) share Server Actions.
The operator chooses a table, registered customer (`CL- <customerId>`) or guest
account, searches products and adds items. When no products are registered,
both views display an explicit empty-catalog message; product cards wrap long
names cleanly alongside price badges. A tap normally creates an UNPAID sale and
adjusts ingredient stock. Optimistic rows appear immediately. Editing stays
disabled until the server supplies a real ID.

An account lists unpaid records from the active shift. **Cerrar cuenta** uses
the selected sales and total shown on the receipt. If another terminal changes
or closes the account, the operator can review the receipt and reopen checkout.
**A deuda** assigns selected unpaid sales to a customer. Successful settlement
returns to the guest sale view.

Guest tickets reuse the lowest available positive number. Closing a ticket
rewrites its source to VENTA_LIBRE and frees that number. Debt collection does
not rewrite the source.

Desktop cash settlement shows an receipt with items grouped by product and confirmation
button. Mobile additionally requires received cash and calculates change or
shortfall. Both use the shared CLABE/total dialog for manual transfer
confirmation. [Payment rules](business-rules.md#3-payment-confirmation) distinguish
UI controls from action checks.

New sales and closure need an OPEN jornada.
The page loads today's sales using the business timezone (`America/Mexico_City`)
plus open `UNPAID` accounts in the active jornada, excluding cancelled records.

## Debtors

Deudores groups pending debt by customer and shows the total amount, active
debtors and today's collections. Operators inspect sale details and fully
settle selected debts in cash or by transfer.

Cash requires a received amount and sufficient funds.
Transfer requires manual confirmation that the money was received.

Collection needs an OPEN jornada. The receipt counts in that jornada's cut.
The interface blocks collection without an open jornada.
It also handles NO_OPEN_JORNADA when the server rejects a request.

The operational list and beta debt report use different filters.
[Debt rules](business-rules.md#4-debts-and-customer-balance) explain them.

## Inventory and menu

Inventario lists active supplies and edits name, stock, unit and cost.
Deactivation keeps recipe references. Desktop/mobile views support name search,
stock filters and kg/g/Lt/piece units.

Menú shows products, current prices, recipe costs and utility per unit, with
server-side search and pagination. Sale prices must exceed the recipe base cost.
Desktop editing uses the **Editar Producto** panel with an **Editar insumos**
dialog to replace recipes; mobile edits preserve an omitted recipe. Product
deletion is physical and can fail when related records reference it. Current
recipe utility is not historical profit.

## CRM

CRM provides customer and user tabs with server-side search, pagination and
editors. Customers sort by registration or Spanish name and include an
optional phone number. Staff forms manage identity, role, active status and
credentials, enforcing surnames in full names, four-digit PINs for STAFF, and
explicit emails plus passwords for ADMIN (without `@demo.com` fallback
generation). Role transitions preserve login access.

The server returns flags indicating whether credentials exist instead of hashes. Customer and
user deletion is not implemented. Creation and update persist different fields. See [CRM rules](business-rules.md#7-crm-and-users).

## Expenses and salaries

Egresos displays an overall expense total and loads history in pages of 30
(clamped to `1..100` on the server), showing `"Sin descripción"` when an expense
has no description and formatting calendar dates without local timezone shift.
Its dialog records description, amount, category, business calendar date
(`America/Mexico_City`) and an explicitly chosen payment method in the active
jornada, attributed to the authenticated employee.

Salarios searches staff and loads the selected user's payment history.
ADELANTO, BONO and SUELDO use a summary followed by final confirmation.
The user must choose cash or transfer. Payment buttons are disabled without
an OPEN jornada, and server rejection updates the notice.

Salary payments belong to their jornada and reduce expected cash or transfers.
The history and confirmation show the method. There is no salary reversal action
or automatically created expense row.

## Savings and jornada

Ahorros manages pool deposits/withdrawals, recent movements and goal progress.
Deposits move cash from the drawer to the pool. Withdrawals reduce the pool
balance only. Pool movements require an OPEN jornada. Goal contributions are
separate from pool money.

Jornada shows who opened the shift and when. It separates cash from transfers.

The cash block starts with the opening amount and adds cash sales and debt
collections. It subtracts cash expenses, cash salaries and savings deposits.

The fiado block shows debt created during the shift and total pending debt.
Employee sales totals appear separately.
Transfers have no opening or counted amount.

ADMIN can open or close any jornada. Closing needs a nonnegative counted cash
amount. No UNPAID accounts may remain.

The mobile dialog keeps totals and controls reachable while scrolling.
STAFF sees the jornada status without editing controls.

## Settings

Ajustes separates business and device settings. CLABE is shared in PostgreSQL
and used for manual transfer confirmation. A blank CLABE shows a notice but
does not prevent confirmation after loading. Terminal names stay in each
browser's localStorage.

## Statistics and reports (beta)

Estadísticas shows paid amounts, units and record counts.
It compares each period with the previous period.
Breakdowns cover times, products, account sources and payment methods.
The screen also reports expenses and salaries.
It includes activity from identified customers.

Reportes provides sales, products, expenses, salaries, customers and debts.
Date shortcuts, ranges, type and page are stored in the URL. Pages contain
50 rows. CSV export and browser printing request every matching row and total. The browser may save print output as PDF.

Both screens and exports require ADMIN. [Reporting rules](business-rules.md#10-statistics-and-reports-beta)
define date handling, filters based on current status and balance limits. Optimiza,
forecasts and historical profit are not implemented.
