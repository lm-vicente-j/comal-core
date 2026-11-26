# Access validation

Validated locally on 2026-11-25 against disposable PostgreSQL databases on port 5544. The existing development database and pre-existing uncommitted files were preserved. Publication and issue closure follow the user's explicit instruction after local validation.

## Checks

| Check | Result |
| --- | --- |
| Complete integration suite | 41 files, 394 tests passed |
| Final adversarial regression subset | 3 files, 24 tests passed |
| Access, authentication and CRM E2E | 18 tests passed |
| Final confirmation flow E2E rerun | 9 existing tests passed on desktop and mobile |
| Domain E2E regression | 76 passed initially; one desktop ticket test failed during source updates |
| Stable Access and ticket E2E rerun | 10 tests passed, including the previously failing ticket case on desktop and mobile |
| Production build | Passed; `/login` is dynamic |
| TypeScript | Passed |
| Lint | No errors; existing unused `receiver` warning in `tests/integration/issue69-origin-race.test.ts:71` |
| Production browser smoke | Owner setup, no automatic login, setup remains closed, fixed and mobile PIN login, rename preserves session, revocation denies access |
| Production panel geometry | No overlapping controls or controls outside the viewport at 320, 393, 800 and 1440px; equal mobile tab font sizes |

## Independent adversarial review

Two GPT-6 Luna reviewers with fresh task-specific contexts reviewed authentication/setup/devices and permissions/data boundaries. The parent reproduced and judged findings, added regression tests, and applied fixes. Reviewers did not execute the tests; the parent executed the checks above.

| Round | Authentication, setup and devices | Permissions |
| --- | --- | --- |
| 1 | Incomplete migration bootstrap bypass and expired linking poll affecting an approved device reproduced and fixed | No confirmed defect |
| 2 | No confirmed defect; independent session revocation coverage added | Fixed baseline sales permission mismatch reproduced and fixed; debt-sale and paid-sale role coverage added |
| 3 | No confirmed defect after adjudication; link-request quota and reset coverage added | No confirmed defect after adjudication |

The baseline sales permission mismatch falls under existing issue [#44](https://github.com/lm-vicente-j/comal-core/issues/44). Base ordering, sales and checkout remain enabled for every role, including when a stale disabled override exists. Debt collection remains independently configurable.

Rejected findings were checked against the agreed plan: creating credit during checkout is distinct from editing an existing debt sale; Service shift opening/closing are configurable and initially disabled; limiting public linking requests is required. These were not implementation defects.

The final review found no confirmed outstanding defects in its scope; this is not a guarantee that every possible defect has been excluded.

The combined changes were validated on local `main`. The confirmation follow-up had two review passes: the first identified missing permission summaries and dialogs closing on failed mutations; the second found no confirmed outstanding defects after both were corrected. The complete 394-test integration suite passed again after the dialog changes.

## Real browser screenshots

All screenshots are direct Playwright Chromium captures. Files ending in `-production.png` show the final production build running locally, without the development indicator.

- [Initial owner setup](access-screens/setup-desktop.png)
- [Personnel on tablet](access-screens/staff-800-production.png)
- [Personnel on mobile](access-screens/staff-393-production.png)
- [Role permissions on desktop](access-screens/permissions-1440-production.png)
- [Devices on tablet](access-screens/devices-800-production.png)
- [Devices on mobile](access-screens/devices-393-production.png)
- [Fixed device sign-in](access-screens/fixed-sign-in-production.png)
- [Mobile device sign-in](access-screens/mobile-sign-in-production.png)
- [Revoke confirmation on mobile](access-screens/confirmation-revoke-393-production.png)
- [Role-permission confirmation](access-screens/confirmation-permissions-800-production.png)

The Access UI is in Spanish, uses the system palette, and provides compact icon actions beside inputs. CRM continues to manage customers. Repository documentation and the roles/permissions table are in English.

## Confirmation dialogs

Every Access mutation requires confirmation. The dialog captures the proposed change, lists changed permission values, prevents repeated submissions, and keeps action errors visible for retry or cancellation. Device revocation uses a red icon and destructive confirmation action. Existing browser tests were adapted for the confirmations; no additional test cases were added after the user's instruction to run only the existing tests. Two independent reviewers rechecked the dialog changes and reported no confirmed remaining defects after the permission-summary and error-handling fixes.
