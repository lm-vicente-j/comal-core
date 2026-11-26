# Modules

The interface uses Spanish labels and English route paths. Access manages
personnel, permissions, and devices; CRM manages customers. Route groups
such as `(dashboard)` are not part of the URL. This page describes screen access. [Action reference](actions.md) documents server permissions.

## Route map

| Screen                                    | Route               | Action source                            | Access                                                  |
| ----------------------------------------- | ------------------- | ---------------------------------------- | ------------------------------------------------------- |
| Login                                     | `/login`            | `auth_action.ts`                         | Guest                                                   |
| Inicio                                    | `/`                 | Welcome page                             | Session                                                 |
| Ventas / POS                              | `/pos`              | `sales.ts`, `customers.ts`, `debts.ts`   | Signed-in roles, by capability                          |
| Deudores                                  | `/debtors`          | `debts.ts`                               | Signed-in roles, by capability                          |
| Egresos                                   | `/expenses`         | `expenses.ts`                            | Signed-in roles, by capability                          |
| Inventario                                | `/admin/inventory`  | `inventory.ts`                           | `inventory.manage`                                      |
| Menú                                      | `/admin/menu`       | `products.ts`, `inventory.ts`            | `catalog.manage`                                        |
| CRM                                       | `/admin/crm`        | `customers.ts`, `users.ts`               | `customers.manage`; staff administration is owner-only  |
| Salarios                                  | `/admin/roster`     | `payrolls.ts`, `users.ts`                | `payrolls.manage` (owner-only)                          |
| Ahorros                                   | `/admin/savings`    | `savings.ts`                             | Deposit capability; withdrawal and goals are owner-only |
| Jornada                                   | `/admin/jornada`    | `jornada.ts`                             | Open, close, reconcile and view-cash capabilities       |
| Ajustes                                   | `/admin/settings`   | `settings.ts`                            | Owner-only business configuration                       |
| Access (Personal, Permisos, Dispositivos) | `/admin/access`     | `users.ts`, `security.ts`, `terminal.ts` | Owner-only                                              |
| Estadísticas (beta)                       | `/admin/statistics` | `analytics.ts`                           | `reports.operational`                                   |
| Reportes (beta)                           | `/admin/reports`    | `analytics.ts`                           | `reports.operational`                                   |

[Desktop](../components/layout/sidebar.tsx) and
[mobile navigation](../components/layout/mobile-nav.tsx) use the shared route
permissions. Operators with open/close permissions can reach Jornada from the
desktop banner or mobile topbar menu. Staff with reconcile permission also get
a **Contar caja** link for an open shift and a **Historial de caja** link when
no shift is open; these entry points do not expose expected cash. Users with
`jornada.viewCash` may see the expected cash for an active own jornada. Below
`lg`, all jornada states appear only in the mobile topbar menu. Jornada banners
below the title appear only on desktop. The mobile user menu shows Jornada status to
staff and includes **Switch operator / sign out** for every role. The switch
clears the previous operator's local session data. Mobile users only see links
their current role can access.

Below `lg`, all paginated modules keep their pagination bar fixed above the
bottom navigation while records scroll. The bar is hidden for empty or
single-page lists. Employee and recipe-supply pickers keep pagination inside
their own selector. Lists default to 10 records per page, with choices of 10,
20 or 50. Search, filters, page and tab are stored in browser history and
`sessionStorage`, without query parameters. See [Pagination](pagination.md).

Mobile selector closure and responsive view changes restore focus within the
list or picker. Pending requests, desktop size selectors and outside interaction
have dedicated [focus regressions](testing.md#pagination-focus-regressions).

Optimiza is hidden. Its navigation definitions mention engine, predictions,
accuracy and supply routes under `/admin/analysis/`, but those pages do not
exist.

## Login

Owner, Fixed and Mobile use a stable compact form. Mobile uses the white panel,
rounded font and orange title/submit style. An unauthorized staff sign-in opens
**Autorizar dispositivo** as a dialog; a discreet link also opens it. Pending
requests survive dismissal and owner approval returns to the approved terminal
mode. PIN fields clear after an attempt. Owner login and first-owner setup
remain available without browser authorization.

## Point of sale

[Desktop POS](<../app/(dashboard)/pos/pos-manager.tsx>) and
[mobile POS](<../app/(dashboard)/pos/MobilePosManager.tsx>) share Server Actions.
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

The payment dialog loads its selected debt amounts when opened. A reproduced
defect allows collection to settle a changed database amount without validating
the total shown in that dialog. The cash-change display can therefore be stale.
See [Testing](testing.md#cash-lifecycle-and-pos-review-2026-11-26).

Collection needs an OPEN jornada. The receipt counts in that jornada's cut.
The interface blocks collection without an open jornada.
It also handles NO_OPEN_JORNADA when the server rejects a request.

The operational list and beta debt report use different filters.
[Debt rules](business-rules.md#4-debts-and-customer-balance) explain them.

## Inventory and menu

Inventario lists active supplies and edits name, stock, unit and cost.
Desktop/mobile views support name search, stock and activity filters, and
kg/g/Lt/piece units. Deactivate or reactivate supplies with confirmation.
Deactivation keeps recipe references and blocks new sales of dependent products.

Menú shows products, current prices, recipe costs and utility per unit, with
server-side search and pagination. Mobile controls stay above the bottom
navigation while the product list scrolls. Sale prices must exceed recipe base cost.
Desktop editing uses the **Editar Producto** panel with an **Editar insumos**
dialog to replace recipes; mobile edits preserve an omitted recipe. Activity
filters show active, inactive or all products. Deactivation and reactivation
preserve recipes and sales history. Inactive ingredients remain visible in
existing recipes and are marked as inactive. Current recipe utility is not
historical profit.

## CRM

Customer creation and editing require the `customers.manage` capability in the
Server Action as well as on the CRM page. CRM manages customers with server-side search and pagination,
fixed mobile controls, silent background refresh and editors. Customers sort by
registration or Spanish name, search by name or alias, display the `Alias`
column/field, and include optional alias (up to 30 characters) and phone
number fields. Owner access controls manage staff identity, active status, role
and one-time six-digit PIN generation. The unique owner cannot be deleted,
deactivated or demoted through staff administration. Staff PINs are not shown
again after creation or regeneration.

The server returns flags indicating whether credentials exist instead of hashes,
and restricts user directory queries to the owner.
Customer and user deletion is not implemented. Customer updates preserve an
omitted alias or phone. See [CRM rules](business-rules.md#7-crm-and-users).

The Access page uses the system color palette and groups controls under
**Personal**, **Permisos** and **Dispositivos**. Every change requires a system
confirmation dialog: creating personnel; changing a person's name, role or
status; renewing a PIN; saving role permissions; authorizing, renaming, changing
the type of or revoking a device. Canceling leaves the data unchanged. Compact
actions sit beside their fields, and device revocation uses a red revoke icon.
Permission confirmations list the changed permissions and their target states.
Failed changes keep the dialog open with an error and allow retry or cancellation.

## Expenses and salaries

Egresos displays a paginated history. Users with expense permission but without
operational-report access see only their own recorded expenses and totals.
Authorized reporting roles see the overall expense total and history. The record
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

Jornada has Hoy and Historial tabs. Hoy keeps the cash and transfer summaries,
sales totals by placing employee, and collections by receiving employee. A
savings deposit control is available to users with `savings.deposit` and
reduces expected drawer cash. Opening, interim and closing counts use a compact
denomination grid with quantities and subtotals, starting at 50-cent coins.
Expected amounts and differences appear in saved receipts only for users with
`jornada.viewCash`.
Staff may reconcile and see their own receipts without seeing expected cash.
Historial filters immutable counts by jornada, operator and type, provides
server CSV export, and opens the saved shift summary on demand. Recounts create
a new interim record with a required reason and a link to the prior count.

The owner can open or close any jornada. Supervisor may be granted those
capabilities; Service starts without them. Counts are denomination-based and
append-only. The owner sets a cash discrepancy tolerance in business settings.
Closing is blocked while UNPAID accounts remain; DEBT may be collected in a
later jornada. The employee who placed a sale remains its sales attribution;
debt collection is attributed to the authenticated collector and receiving
jornada. A difference is not assigned to the opener or counter.

The mobile dialog keeps totals and controls reachable while scrolling. Saved
opening and closing receipts stay visible until **Listo** or explicit dismissal,
including when server revalidation or background refresh changes Jornada state.
Revoked cash-view permission hides expected/difference fields after refresh.
Dismissal restores keyboard focus to the launcher or the Jornada panel, and
a capture whose shift closed elsewhere explains that the jornada is closed.
Operators without jornada capabilities see status without editing controls.

Two history defects remain: a saved recount may not appear until filtering or
reloading, and **Recontar** remains visible to a Supervisor without reconcile
permission even though the server rejects saving. The
[review record](testing.md#cash-lifecycle-and-pos-review-2026-11-26) documents
both reproductions and their expected-failure tests.

## Settings

Ajustes separates business and device settings. CLABE and the owner-configured
cash count tolerance are shared in PostgreSQL. A blank CLABE shows a notice but
does not prevent manual transfer confirmation. Authorized terminal names and
types are managed by the owner; a local browser label is only a display preference.

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

Both screens and exports require the `reports.operational` capability.
[Reporting rules](business-rules.md#10-statistics-and-reports-beta)
define date handling, filters based on current status and balance limits. Optimiza,
forecasts and historical profit are not implemented.
