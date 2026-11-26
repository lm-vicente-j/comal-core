# Authentication and permissions

Comal Core uses Auth.js 5 with credentials backed by PostgreSQL. The owner account is created once during first setup. Staff accounts use personal six-digit PINs, and each browser used by staff must be authorized by the owner.

Set three independent server secrets: `AUTH_SECRET` for sessions,
`INSTALLATION_SECRET` for bootstrap, and `PIN_LOOKUP_SECRET` for the PIN HMAC
index. Generate each from at least 32 random bytes. Keep the PIN lookup secret
stable; changing it requires regenerating personnel PINs. None belongs in a
`NEXT_PUBLIC_` variable or in source control.

## First installation and owner login

An operator sets `INSTALLATION_SECRET` in the server environment before opening the application. `/login` offers owner setup only after migrations have completed, while the persisted installation state is eligible, and while there is no owner. Setup requires the person's name, email, a password of at least 12 characters and at most 72 UTF-8 bytes, confirmation, and the installation secret. Passwords use bcrypt cost 12. Setup creates exactly one active `ADMIN` in a transaction and does not sign that person in. The next step is the normal owner login with email and password.

The installation state is persistent. Deleting users or losing access to a database does not make setup available again. Do not expose `INSTALLATION_SECRET` to browser code or commit its value. To recover access, run `npx tsx scripts/recover-owner.ts` on the server. The command prompts for the existing owner's email and replacement password, verifies the initialized installation and sole owner, invalidates current sessions and audits the recovery. It does not create a new account or reset setup state.

| Role / mode | Login fields | Browser requirement |
| --- | --- | --- |
| Owner (`ADMIN`) | Email and password | Any browser |
| Fixed terminal staff (`SUPERVISOR`, `STAFF`) | Personal six-digit PIN | Owner-authorized fixed terminal |
| Mobile terminal staff (`SUPERVISOR`, `STAFF`) | Username and personal six-digit PIN | Owner-authorized mobile terminal |

Role comes from the account. Login forms cannot choose or elevate a role. Owner login is always email and password; owners do not use PINs.

## Staff and terminal access

The owner creates staff users with one of the two supported roles. The application generates a unique six-digit PIN and displays it only in the successful creation or regeneration result. Share it securely with that staff member. The PIN is stored as a bcrypt hash; an HMAC lookup index keyed by `PIN_LOOKUP_SECRET` allows unique lookup without storing the PIN in clear text. PIN uniqueness includes inactive accounts.

A new staff browser asks to link itself. The request expires after ten minutes and remains tied to that browser. The owner reviews pending requests and approves one by assigning a name and terminal type (`FIXED` or `MOBILE`). Authorization is stored as a server-side token hash and an `HttpOnly` browser cookie. If cookies are cleared, the browser must request authorization again. The browser's local terminal label is only a display preference; it does not grant access or determine terminal type.

Attempting staff sign-in from an unauthorized browser opens the authorization
dialog. The dialog can also be opened through the small link below the staff
form. It shows the request code, pending status and owner approval; Continue
returns to the matching Fixed or Mobile sign-in form. Closing and reopening the
dialog preserves a pending request. Owner sign-in does not require this dialog,
and incorrect personnel credentials on an authorized browser remain a sign-in
error rather than starting another authorization request. All three sign-in
modes reserve the same form and feedback height, keeping the heading, tabs,
submit button and footer in place when switching modes. PIN input is cleared
after an attempt so it can be entered again after authorization.

Link requests have a persistent limit per IP address: four new requests are accepted, and the fifth starts a 15-minute block. Retrying an existing pending request reuses it without consuming another request. Browsers sharing a public IP share this limit.

The owner can rename, change the type of, or revoke an authorized terminal. A type change or revocation invalidates staff sessions tied to that terminal. Deactivating a staff user or regenerating their PIN also invalidates their existing sessions. Five failed PIN attempts lock an account for 15 minutes. PIN-only fixed-terminal login also has terminal-based throttling.

Staff can switch operators by signing out and entering the next person's credentials. Switching clears local data belonging to the previous operator; persisted orders remain on the server. Sessions expire eight hours after authentication and are not extended by activity. There is no inactivity timeout.

Use HTTPS in deployed environments so terminal authorization cookies stay
secure. In development mode, local HTTP works on localhost and a reachable LAN
address. Production authorization cookies require HTTPS.

## Sessions and current authorization

Sessions use encrypted JWT cookies with an eight-hour maximum lifetime. The session carries the account ID, role, authentication mode, authorized terminal ID when applicable, credential version, and authentication time. Each protected request checks the account's current status, role, permissions and credential version. Permission, role, PIN and active-status changes therefore affect existing sessions on the next request.

Unknown roles are rejected rather than silently mapped to a lower-privilege role. A missing or invalid account, inactive account, revoked terminal, stale credential version, or database failure prevents authorization.

## Roles and configurable permissions

The owner is the only `ADMIN` and has all delegable capabilities. The owner can configure the listed delegable permissions for `SUPERVISOR` and `STAFF`. Defaults are enabled or disabled as shown. Owner-only capabilities cannot be delegated, and roles cannot be customized or assigned per-user permissions.

| Capability | Owner | Supervisor | Service |
| --- | --- | --- | --- |
| Take orders, sell and collect payment | Yes | Yes | Yes |
| View orders and debts for service | Yes | Yes | Yes |
| Edit or cancel pending sales | Yes | Yes, configurable | Yes, configurable |
| Edit or cancel sales with outstanding debt | Yes | No | No |
| Record expenses | Yes | Yes, configurable | Yes, configurable |
| Collect debts | Yes | Yes, configurable | Yes, configurable |
| Open a cash shift | Yes | Yes, configurable | No, configurable |
| Close a cash shift | Yes | Yes, configurable | No, configurable |
| Enter cash counts (`jornada.reconcile`) | Yes | Yes, configurable | Yes, configurable |
| Confirm handoffs (capability reserved for #42) | Yes | Yes, configurable | Yes, configurable |
| View expected cash, differences and history | Yes | Yes, configurable | No |
| Deposit cash into savings | Yes | Yes, configurable | No |
| Withdraw savings and manage goals | Yes | No | No |
| View and export operational reports | Yes | Yes, configurable | No |
| Manage catalog | Yes | No, configurable | No |
| Manage inventory | Yes | No, configurable | No |
| Manage customers | Yes | No, configurable | No |
| Manage payroll, users, roles and permissions | Yes | No | No |
| Authorize terminals and configure the business | Yes | No | No |
| Edit or cancel paid sales | No | No | No |

Catalog, inventory, and customers have independent permissions. Opening and closing cash shifts also have separate permissions. Operational reports exclude payroll and private savings movements. Savings movement history, withdrawals and goal management remain owner-only.

Cash-count controls are available to roles with `jornada.reconcile`. Service
users can access their own count receipts and history, without expected cash,
differences, tolerance results or other operators' records. Administration and
Supervision with `jornada.viewCash` can inspect those results; payroll and
private savings breakdown fields remain owner-only. Open count receipts also
apply refreshed permissions: revoking `jornada.viewCash` hides their expected
amount and difference while preserving the operator's counted receipt. Handoff controls remain
pending the workflow in #42.

Permissions do not override business rules: closed cash shifts, paid sales, balance validation, and inventory restrictions keep their protections.

“Configurable” means the owner can change that role's initial setting. Configurable capabilities begin enabled where the table says “Yes, configurable” and disabled where it says “No, configurable.” Plain “Yes” capabilities are always available to that role. Plain “No” capabilities are owner-only.

## Page and action checks

Page access, navigation visibility, and server actions use the same capability catalog, but UI visibility is not authorization. Every protected read and write must check permission on the server, including exports and sensitive fields. Route rules in [`lib/permissions.ts`](../lib/permissions.ts) and server checks are maintained separately so direct requests cannot bypass the action checks.

See [Action reference](actions.md) for exported action contracts and [Request interception](middleware.md) for request handling.
