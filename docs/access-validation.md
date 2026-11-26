# Access validation

Authentication and device checks use synthetic accounts in isolated test
databases. Business database operations are real. Browser setup signs in the
owner once; access scenarios perform real PIN/password sign-in and owner device
approval. Shared helpers for other domain tests do not replace those flows.

## Coverage

| Boundary | Suites | Assertions |
| --- | --- | --- |
| Credentials and throttling | `tests/integration/auth-security.test.ts`, `pin-collisions.test.ts` | Bcrypt verification, PIN collision retries, persistent account and terminal locks, concurrent failures |
| One-time setup | `tests/integration/setup-security.test.ts` | Empty fully migrated installation, owner uniqueness, atomic bootstrap and closed setup |
| Sessions | `tests/integration/session-lifecycle.test.ts` | Credential/device revocation, current activity and role, absolute expiry |
| Capabilities | `tests/integration/role-permissions.test.ts` | Independent grants, owner-only authority and persisted-state protection |
| Recovery | `tests/integration/owner-recovery.test.ts` | Existing-owner maintenance, credential version and audit preservation |
| Adversarial access | `tests/adversarial/access-adversarial.test.ts` | Link-request deduplication, rate limits and migration readiness |
| Browser access | `tests/e2e/05-auth.spec.ts`, `06-access.spec.ts` | Real owner login, wrong credentials, browser approval, revocation, role changes, PIN clearing and responsive geometry |
| Open-request permission changes | `tests/e2e/105-permissions.adversarial.spec.ts` | Held requests across revocation and PAID/DEBT transitions, role-specific responses and unchanged unauthorized amounts/quantities |

ADMIN can edit debt in an open jornada; paid sales remain immutable for every
role. Creating credit and collecting debt use separate capabilities. Supervisor
and Service opening/closing require their individual grants. The current
custodian's PIN-confirmed handover does not switch the browser session.

## Fixtures and execution

`tests/helpers/database.ts` supplies database auth fixtures and resets. The
browser approval helper is `tests/helpers/e2e-access.ts`; Access itself exercises
owner approval through the UI. Other-operator fixtures use Supervisor accounts,
preserving the single-owner constraint.

```bash
npm test -- tests/integration/auth-security.test.ts tests/integration/role-permissions.test.ts tests/adversarial/access-adversarial.test.ts
npm run test:e2e -- tests/e2e/05-auth.spec.ts tests/e2e/06-access.spec.ts tests/e2e/105-permissions.adversarial.spec.ts
```

Prepare the separate integration and E2E databases before database-backed runs.
Files sharing a database execute sequentially. See [Testing](testing.md) for
complete commands, guards, standard/intensive profiles and known failures.

## Evidence and limits

Access panel captures use `ci_results/access-screens/`. Browser screenshots,
traces, HTML/JSON and explicit attachments use `ci_results/`; CI uploads that
root and retains results for seven days. Screenshots are generated artifacts.

The complete [validation record](testing.md#issue-60-validation-2026-11-26)
records 479 passing Vitest tests, 39 verified intensive checks and two ordinary
mobile layout failures. The configured-CLABE cases for staff collectors remain
expected failures. Those unresolved cases are not successful application
behavior, and the test counts do not certify a deployment.
