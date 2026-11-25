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
| Jornada | `/admin/jornada` | `jornada.ts` | ADMIN. STAFF sees status in the mobile user menu |
| Ajustes | `/admin/settings` | `settings.ts` | ADMIN |
| Estadísticas (beta) | `/admin/statistics` | `analytics.ts` | ADMIN |
| Reportes (beta) | `/admin/reports` | `analytics.ts` | ADMIN |

[Desktop](../components/layout/sidebar.tsx) and
[mobile navigation](../components/layout/mobile-nav.tsx) use the shared route
permissions. ADMIN opens Jornada from the desktop banner or the mobile topbar
menu; below `lg`, all jornada states appear only in the mobile topbar menu,
including the expected cash balance for an active own jornada. Jornada banners
below the title appear only on desktop. The mobile user menu shows Jornada status to
STAFF and includes **Cerrar sesión** for both roles. Mobile ADMIN users find
other management links in the Menu sheet. STAFF has the three operational links.

Below `lg`, all paginated modules keep their pagination bar fixed above the
bottom navigation while records scroll. The bar is hidden for empty or
single-page lists. Employee and recipe-supply pickers keep pagination inside
their own selector. Lists default to 10 records per page, with choices of 10,
20 or 50. Search, filters, page and tab are stored in browser history and
`sessionStorage`, without query parameters. See [Pagination](pagination.md).

Mobile selector closure and responsive view changes restore focus within the
list or picker. Pending requests and desktop size selectors have documented
[focus limitations](pagination.md#keyboard-focus-and-known-limits).

Optimiza is hidden. Its navigation definitions mention engine, predictions,
accuracy and supply routes under `/admin/analysis/`, but those pages do not
exist.

## Point of sale

[Desktop POS](../app/(dashboard)/pos/pos-manager.tsx) and
[mobile POS](../app/(dashboard)/pos/MobilePosManager.tsx) share Server Actions.
The operator chooses a table, registered customer (`CL- <customerId>`) or guest
account, searches products and adds items. On mobile, the title, account
controls, search field and bottom navigation stay visible while the product
catalog scrolls, and the bottom charge bar appears above the navigation bar
only when an open account is selected. When no products are registered,
both views display an explicit empty-catalog message; product cards wrap long
names cleanly alongside price badges. Product taps enqueue sequential UNPAID
sales that adjust ingredient stock; optimistic rows appear immediately and stay
visible until their server records arrive. Tapping the same product 3 times in a
row disables only that product button for 1 second while the queue continues
processing. Account switching, checkout, and line editing stay disabled until
pending sales finish and receive real IDs.

An account lists unpaid records from the active shift. **Cerrar cuenta** keeps
its receipt items and total synchronized with live account updates while open
and freezes the selected sales and total when confirming cash or transfer
payment. **A deuda** assigns selected unpaid sales to a customer. Successful
settlement returns to the guest sale view.

Guest tickets reuse the lowest available positive number and reserve it
atomically in PostgreSQL (`pg_advisory_xact_lock`, 15-minute TTL) across
terminals before items are added. A persistent account ID distinguishes open
tickets if their numbers are reused. Paid guest sales move to `VENTA_LIBRE`.

Desktop cash settlement shows a receipt with items grouped by product, an
optional informational received-cash input with live change/shortfall display
that does not block confirmation, and a confirmation button. Mobile requires
received cash and calculates change or shortfall. Both use the shared
CLABE/total dialog for manual transfer confirmation. [Payment rules](business-rules.md#3-payment-confirmation) distinguish
UI controls from action checks.

New sales and closure need an OPEN jornada.
The page loads today's sales using the business timezone (`America/Mexico_City`)
plus open `UNPAID` accounts in the active jornada, excluding cancelled records.

## Debtors

Deudores groups pending debt by customer and shows the total amount, active
debtors and today's collections. Operators inspect sale details and fully
settle selected debts in cash or by transfer. Mobile Deudores keeps the summary
cards and search bar fixed while the table scrolls above a pinned mobile
pagination bar.

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
server-side search and pagination. Mobile controls stay above the bottom
navigation while the product list scrolls. Sale prices must exceed recipe base cost.
Desktop editing uses the **Editar Producto** panel with an **Editar insumos**
dialog to replace recipes; mobile edits preserve an omitted recipe. Product
deletion is physical and can fail when related records reference it. Current
recipe utility is not historical profit.

## CRM

CRM provides customer and user tabs with server-side search and pagination,
fixed mobile controls, silent background refresh and editors. Customers sort by
registration or Spanish name, search by name or alias, display the `Alias`
column/field, and include optional alias (up to 30 characters) and phone
number fields. Staff forms manage identity, role, active status and
credentials, enforcing surnames in full names, four-digit numeric dot-masked PINs
validated on the frontend for STAFF, and explicit emails plus passwords for ADMIN
(without `@demo.com` fallback generation). Role transitions preserve login access.

The server returns flags indicating whether credentials exist instead of hashes,
and restricts user directory queries (`GetAllUsers`, `searchUsers`) to ADMIN.
Customer and user deletion is not implemented. Customer updates preserve an
omitted alias or phone. See [CRM rules](business-rules.md#7-crm-and-users).

## Expenses and salaries

Egresos displays an overall expense total and a paginated history. The record
count follows the list query; the total amount and latest category cover all
expenses. Missing descriptions appear as `*NO DESC`. Calendar dates retain
their date when displayed.
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

Ahorros paginates pool movements and goals separately. The goal list can show
active, inactive or all goals; pool totals include all movements.
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
Breakdowns cover times, products, account sources and payment methods, with
fixed mobile pagination on the customer breakdown table.
The screen also reports expenses and salaries.
It includes activity from identified customers.

Reportes provides sales, products, expenses, salaries, customers and debts.
Date ranges, type and page use the shared local navigation state. Pages default
to 10 records or groups and permit up to 50. CSV export and browser printing
request every matching row and the full period totals. The browser may save
print output as PDF.

Both screens and exports require ADMIN. [Reporting rules](business-rules.md#10-statistics-and-reports-beta)
define date handling, filters based on current status and balance limits. Optimiza,
forecasts and historical profit are not implemented.
