# Phase 11 E2E and Stabilization Report

**Run date:** 2026-10-28  
**Scope:** Integration testing and stabilization only

## Test environment and data safety

- The real-route integration run connected only to `aicte_fdr_portal_test`. No writes, deletes, collection drops, or resets were performed against `aicte_fdr_portal`.
- At run time, no `server/.env.test` or separate test database credential was configured. For this run only, the database path in the locally configured URI was replaced in memory with `aicte_fdr_portal_test` and passed as `MONGODB_TEST_URI`; no operation targeted the original database. The URI value and credentials were not printed. For repeat runs, use a test-only database account and the ignored `server/.env.test` created from [server/.env.test.example](../server/.env.test.example).
- The integration fixture uses generated `@example.test` accounts, synthetic institutions/FDR data and a generated PDF. Cleanup is scoped to the current run's IDs and unique synthetic identifiers. The E2E fixture database was checked after the final run and no generated fixture records remained.
- Uploaded integration documents use a temporary private directory outside the repository. The test removes that directory after completion.
- The test provider is deterministic and local; `SARVAM_API_KEY` is removed from the E2E process and no document is sent to Sarvam. Reminder scheduling is explicitly disabled.
- `server/.env`, `server/.env.test`, client environment files, `node_modules`, and build output are ignored by Git. No credentials or financial documents were added to source control.

## Baseline before Phase 11 changes

| Check | Baseline result |
|---|---|
| Frontend tests | 3 passed |
| Backend tests | 74 passed |
| Frontend production build | Passed |
| `git diff --check` | Passed |
| Database check | Not run against the configured default database; database checks were reserved for the dedicated test database to avoid accidental access to existing data. |

## Final verification

| Command/check | Result |
|---|---|
| `client: npm test` | **3 passed, 0 failed** |
| `client: npm run build` | **Passed** |
| `server: npm test` | **74 passed, 0 failed** |
| `server: npm run db:check:test` | **Passed** schema smoke test and connection to `aicte_fdr_portal_test` |
| `server: npm run test:e2e` | **1 integration scenario passed, 0 failed** |
| `git diff --check` | **Passed** |
| Test-script syntax checks | **Passed** |
| Backend startup and `/api/health` | **HTTP 200** with the test database connected |

The database-check and E2E commands were run with `MONGODB_TEST_URI` and `JWT_TEST_SECRET` supplied in the test process. The URI targeted only the dedicated test database.

## Real HTTP integration coverage

The Phase 11 E2E scenario starts the Express app and uses actual HTTP requests and MongoDB persistence. It covered:

- Public institution registration, normalized account login, current-user response, invalid login and unauthenticated-route rejection.
- Institution A FDR creation, private PDF storage, pagination/search/status filtering, rejected invalid update, safe document download and response-field/path checks.
- Institution B cross-tenant record and download denial, forbidden reviewer route access, invalid signature and oversized upload rejection.
- OCR submission, status polling, extracted field comparison, and verification that extracted values do not replace the institution-submitted FDR data. A deterministic local provider was used.
- Forensic analysis and report-history retrieval, including a non-authenticity status/limitations check.
- Reviewer correction request, institution resubmission, review completion and persisted review history.
- Replacement FDR linkage while preserving the original record.
- Release/refund request review, with the FDR remaining financially active and no claim of a bank transfer.
- Notification unread count/read operation, institution and administrative dashboard summaries, administrative report query, CSV response, and persisted audit events.
- Reminder scheduling disabled for the test run.

The pre-existing backend suite also exercises OCR provider failure/malformed responses, reminder calculations, role checks, workflow transitions, CSV formula escaping, and notification scoping.

## Frontend/browser integration status

The three rendered React tests passed, but they use mocked API responses and are not counted as browser-to-backend E2E coverage. A one-off attempt to submit the registration form in the shared browser did not complete because the browser interaction timed out; it is not reported as a passing browser test. The browser automation package is not part of this repository's test setup.

The real HTTP E2E suite verifies the frontend-facing API contracts, but a full browser-driven React-to-Express workflow remains to be verified manually. To do so:

1. Configure `server/.env.test` from [server/.env.test.example](../server/.env.test.example) with test-only credentials for `aicte_fdr_portal_test`.
2. In `server/`, run `npm run start:test`; confirm `/api/health` reports a connection to the test database.
3. Configure `client/.env` with `VITE_API_BASE_URL=http://localhost:3011/api`, then run `npm run dev` in `client/`.
4. Register a synthetic institution, log in, upload a generated synthetic PDF, and inspect its FDR detail, OCR and forensic panels.
5. Verify an institution user cannot access another institution's record or official review pages. Use a reviewer/admin seeded only in the isolated test database to check review navigation and a permitted decision.
6. Stop the test server to remove its temporary document-storage directory. Remove only the test records created for the manual run.

## Optional live OCR and deployment

- **Live Sarvam OCR:** Not performed. The successful OCR workflow above used the deterministic test provider and is not live-provider verification.
- **Production deployment:** Not performed.
- **Production storage:** Deployment still requires a persistent, private document volume or storage adapter; local temporary/prototype storage is not production-ready.

## Outstanding issues

- Complete the browser-driven frontend-to-live-backend manual steps above. The current browser interaction attempt did not finish, so the React UI's end-to-end contract is not certified by this report.
- Run the optional live Sarvam smoke test separately only with an authorized, valid provider credential and the synthetic sample.
- Verify deployment-specific CORS, TLS, test/production environment variables, scheduler topology, and persistent private document storage before launch.
- `server/.env.test` must be configured locally before the documented test-database commands can run independently. Do not copy production credentials or point it at `aicte_fdr_portal`.
