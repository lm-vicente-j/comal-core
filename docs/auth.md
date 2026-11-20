# Authentication and permissions

Comal Core uses Auth.js 5 with a Credentials provider.
[`lib/auth.ts`](../lib/auth.ts) verifies credentials,
[`app/auth.config.ts`](../app/auth.config.ts) configures sessions and route
authorization, and [`app/api/auth/route.ts`](../app/api/auth/route.ts) exposes
the authentication handlers.

## Login

| Mode | Identifier | Credential |
| --- | --- | --- |
| ADMIN | Trimmed valid email | Password |
| STAFF | Trimmed nonempty username | Exactly four numeric PIN digits |

The provider finds the user, verifies role alignment (ADMIN requires stored role ADMIN; STAFF requires stored role STAFF), and compares the credential with bcrypt. Admin users cannot authenticate via the STAFF PIN path. It rejects a missing credential, failed comparison, mismatched role or user whose `active` value is false. Choosing ADMIN in the form does not grant that role.

The provider prefers an exact identifier match and accepts a case-insensitive
match when it identifies a single account. For known accounts, PostgreSQL stores
failed attempts by user ID so the five-attempt, 15-minute lockout applies across
server instances. Successful authentication clears the account's failed attempts.

The [login action](../lib/actions/auth_action.ts) validates a UserSchema subset,
chooses ADMIN mode when email is present and STAFF otherwise, then redirects
successful login to `/pos`. Logout redirects to `/login`.

## Sessions

Sessions use encrypted JWT cookies. They last eight hours, as defined by
`AUTH_SESSION_MAX_AGE`.

The JWT stores the user ID in `token.sub`. On each JWT callback, the shared
configuration reads the user's current activity and role from the database.
It stores the normalized role in `token.role`. The session callback copies
these values to `session.user`. Both callbacks support the legacy `token.id`
field when needed.

Any role other than ADMIN normalizes to STAFF.

Set `AUTH_SECRET` as described in [Getting started](getting-started.md).
Login checks the current credential and active status. A missing or invalid ID,
missing user, inactive user or database failure prevents session authorization.
A null `active` value remains accepted. Role changes and deactivation take
effect on the next session check.

## Page permissions

[`lib/permissions.ts`](../lib/permissions.ts) defines the rules used by request
interception, the desktop sidebar and mobile navigation.

| Path prefix and descendants | Roles |
| --- | --- |
| `/admin` | ADMIN |
| `/pos` | ADMIN, STAFF |
| `/expenses` | ADMIN, STAFF |
| `/debtors` | ADMIN, STAFF |

The first matching rule wins. Prefixes match whole segments: `/admin/menu`
matches `/admin`, while `/administrator` does not. Authenticated paths with no
matching rule are allowed by the ACL, although a page may not exist there.

Guests must sign in for paths covered by the proxy matcher.
[Request interception](middleware.md) explains the matcher and redirects.

## Action permissions

Actions authorize calls independently of page access. Hiding a link or putting
a page under `/admin` does not replace a check in the action.

| Operation | Action check |
| --- | --- |
| Sales, debt conversion/collection and expenses | Session. Selected writes also require an OPEN jornada |
| Customer creation/update | Session, even though CRM is an ADMIN page |
| User reads/writes, product and supply writes | ADMIN |
| Salary payments and jornada open/close | ADMIN. Salary payments also need an OPEN jornada |
| Savings and settings writes | ADMIN. Pool movements also need an OPEN jornada |
| Statistics, reports and exports | ADMIN on every query |
| Most other reads/searches | Session |

[Action reference](actions.md) lists each function's exact result and failure
defaults. Employee attribution for sales, expenses, savings and debt collection
comes from the session.

Runtime schemas check input shapes, not every ownership or state relationship.
[Business rules](business-rules.md) documents those checks and their limits.
