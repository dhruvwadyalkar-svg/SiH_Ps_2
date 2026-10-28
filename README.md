# AICTE FDR Management Portal

A prototype backend for an AICTE-style Security Deposit / Fixed Deposit Receipt (FDR) management portal. Phase 1 created the Express foundation and Phase 2 adds the MongoDB Atlas connection and schema layer. This project is not an official AICTE service.

## Prerequisites

- Node.js (v18 or later)
- npm
- Git
- MongoDB Atlas account with a cluster and database user

## MongoDB Atlas setup requirements

1. Create a MongoDB Atlas cluster and database user.
2. Allow network access from your local IP or use a trusted connection option.
3. Copy the Atlas connection string for the application database.
4. Store the connection string in the local environment only using `server/.env` or a shell export; do not commit real credentials.

## Required environment variables

Create `server/.env` from the example file:

```powershell
cd server
Copy-Item .env.example .env
```

Then update the values in `.env`:

```dotenv
PORT=3000
FRONTEND_ORIGIN=http://localhost:5173
MONGODB_URI=mongodb+srv://<db_username>:<db_password>@cluster.example.mongodb.net/aicte_fdr_portal?retryWrites=true&w=majority
JWT_SECRET=<generate-a-random-secret-at-least-32-characters>
JWT_EXPIRES_IN=15m
ADMIN_NAME=
ADMIN_EMAIL=
ADMIN_PASSWORD=
SARVAM_API_KEY=
```

Set `JWT_SECRET` to a new random value of at least 32 characters. `JWT_EXPIRES_IN` defaults to `15m` and may be configured up to `1h`. Set the three `ADMIN_*` values only when provisioning the initial AICTE administrator. Never commit `.env` or real credentials.
`FDR_STORAGE_DIR` optionally overrides the private local document directory; by default documents are kept under `server/private/uploads/fdr`, outside any publicly served directory. `FDR_MAX_UPLOAD_BYTES` defaults to `10485760` (10 MiB) and accepts values from 1 byte to 100 MiB.
Set `SARVAM_API_KEY` from your Sarvam dashboard in the local `server/.env` to enable Document AI. Never place the key in source control or frontend code. The OCR endpoints return a safe service-not-configured error when the variable is missing.

## Install dependencies

```powershell
cd server
npm install
```

## Start the backend

For development mode:

```powershell
cd server
npm run dev
```

For production mode:

```powershell
cd server
npm start
```

## Health check

With the server running, request:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

The endpoint returns HTTP 200 with JSON similar to:

```json
{
  "status": "ok",
  "message": "Backend is running",
  "database": {
    "status": "connected"
  }
}
```

## Database checks

Run the MongoDB connectivity and schema validation check:

```powershell
cd server
npm run db:check
```

This script performs:
- a MongoDB ping test
- schema validation smoke tests for Institution, User, FDR, and AuditLog
- no database writes or seeded records

## Phase 3: Authentication and authorization

Authentication endpoints:

- `POST /api/auth/register-institution` — accepts an `institution` object (`name`, `institutionCode`, `contactEmail`, `contactPhone`, `address`) and a `user` object (`fullName`, `email`, `password`). Registration always creates an `institution_user` and sets the institution status to `pending`; client-supplied roles or statuses are rejected.
- `POST /api/auth/login` — accepts `email` and `password`, and returns a short-lived JWT as a Bearer access token.
- `GET /api/auth/me` — requires `Authorization: Bearer <token>` and returns safe current-user and institution details.

Passwords must be at least 12 characters. Login and registration requests are rate limited. Access tokens are not persistent login credentials: the future frontend must not store them in `localStorage`. Refresh-token rotation and persistent login are outside this phase.

Create the initial AICTE administrator by setting `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in the local environment, then run:

```powershell
cd server
npm run bootstrap:admin
```

The script validates the environment, hashes the password, and does not change an existing administrator's password when rerun. Administrator provisioning is not available through public registration. Remove the bootstrap credentials from the environment after provisioning.

Run the auth tests with:

```powershell
cd server
npm test
```

## Phase 4: Institution profile and access control

Institution profile endpoints require a valid Bearer access token and an `institution_admin` or `institution_user` role:

- `GET /api/institutions/me` — returns the institution linked to the authenticated user. It does not accept an institution ID.
- `PATCH /api/institutions/me` — updates only `name`, `contactEmail`, `contactPhone`, and `address`. Fields are validated; contact email is trimmed and lowercased. Unknown and protected fields (including `institutionCode`, `status`, and IDs) are rejected.

Example profile update:

```http
PATCH /api/institutions/me
Authorization: Bearer <access-token>
Content-Type: application/json
```

```json
{
  "name": "Updated Institution Name",
  "contactEmail": "office@example.edu",
  "contactPhone": "+91-1234567890",
  "address": "123 Example Road, Pune"
}
```

```json
{
  "institution": {
    "id": "507f1f77bcf86cd799439011",
    "name": "Updated Institution Name",
    "institutionCode": "ABC123",
    "contactEmail": "office@example.edu",
    "contactPhone": "+91-1234567890",
    "address": "123 Example Road, Pune",
    "status": "pending",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-02T00:00:00.000Z"
  }
}
```

Official institution management endpoints require `aicte_admin` or `reviewer`:

- `GET /api/admin/institutions?page=1&limit=20&search=ABC&status=pending` — paginated listing, searching institution name/code and optionally filtering by the model status enum. Page size is capped at 100; results sort by newest first with a stable ID tie-breaker.
- `GET /api/admin/institutions/:institutionId` — safe profile and the latest 20 persisted status-review events.
- `PATCH /api/admin/institutions/:institutionId/status` — status change with a required review reason.

Example status review:

```http
PATCH /api/admin/institutions/507f1f77bcf86cd799439011/status
Authorization: Bearer <access-token>
Content-Type: application/json
```

```json
{
  "status": "active",
  "reason": "Synthetic example: registration documents reviewed"
}
```

Status transitions follow the existing model enum (`pending`, `active`, `inactive`, `suspended`) and these Phase 4 rules:

| Current status | Reviewer may set | AICTE admin may set |
|---|---|---|
| `pending` | `active` or `inactive` | `active` or `inactive` |
| `active` | No transition | `suspended` |
| `suspended` | No transition | `active` |
| `inactive` | No transition (terminal) | No transition (terminal) |

`active` is assigned only by an authorized status-review operation; a profile edit never changes approval status. Every changed profile and status review is saved with its audit event in the same MongoDB transaction. If audit persistence fails, the transaction fails rather than reporting an unaudited successful mutation. Audit events include the authenticated actor; status events retain the previous/new status and reason. User-provided IDs and roles are never used for authorization or ownership.

Run all authentication and institution tests, including role restrictions, ownership, validation, status transitions, pagination/search/filtering, and audit-event checks, with `npm test` from `server`. Run `npm run db:check` there to verify model validation and MongoDB connectivity.

## Phase 5: FDR management and private documents

FDRs are served under `/api/fdrs`. Every endpoint requires a Bearer access token. Institution ownership is derived from the authenticated user record; clients cannot choose an institution.

| Endpoint | Allowed roles | Behavior |
|---|---|---|
| `POST /api/fdrs` | `institution_admin`, `institution_user` | Create an FDR and upload its required supporting document as multipart field `document`. |
| `GET /api/fdrs` | Institution roles, `aicte_admin`, `reviewer` | List FDRs. Institution roles see only their institution; officials can view all. |
| `GET /api/fdrs/:id` | Institution roles, `aicte_admin`, `reviewer` | Read one authorized FDR. Institution roles are restricted to their own institution. |
| `PATCH /api/fdrs/:id` | `institution_admin`, `institution_user` | Edit submitted FDR details only while the record is `draft` or `rejected`; may resubmit by setting `workflowStatus` to `submitted`. |
| `GET /api/fdrs/:id/document` | Institution roles, `aicte_admin`, `reviewer` | Download after record authorization. Each permitted download is audited. |

FDR creation accepts `fdrNumber`, `bankName`, `branch`, positive `amount`, optional three-letter `currency`, `issueDate`, and `maturityDate`. Dates must be valid and maturity must be later than issue. The institution and initial `submitted` status are set by the server; request fields for institution, workflow status, financial status, OCR data, and reviewer decisions are rejected. Institution users may edit the submitted business details while an FDR is `draft` or `rejected`; other workflow states are locked. Financial status and OCR/review fields are not editable through these endpoints.

Example create request (multipart form; do not supply `institution` or a role):

```http
POST /api/fdrs
Authorization: Bearer <access-token>
Content-Type: multipart/form-data
```

Form fields: `fdrNumber=FDR-1001`, `bankName=Example Bank`, `branch=Central Branch`, `amount=250000`, `currency=INR`, `issueDate=2026-01-01`, `maturityDate=2027-01-01`, and a PDF/JPEG/PNG file in `document`.

The JSON response includes safe FDR values and document metadata (filename, MIME type, size, SHA-256 checksum, upload time); it does not include document bytes, storage keys, or filesystem paths. List filters are `page`, `limit` (maximum 100), `search` (FDR number or bank name), `workflowStatus`, `fromDate`, and `toDate` (maturity-date bounds).

Documents are signature-checked and restricted to PDF, JPEG, or PNG, with a default 10 MiB maximum. Storage uses random server-generated keys in a private local directory; only metadata and the SHA-256 checksum are stored in MongoDB. Configure a separate non-public directory with `FDR_STORAGE_DIR` if needed. The default private uploads directory is ignored by Git. Failed database persistence triggers best-effort cleanup of the staged file; audit writes for creation, upload, update, and download must succeed before the relevant operation reports success.

Test the backend with:

```powershell
cd server
npm test
npm run db:check
```

The FDR test file exercises the actual Express routes over HTTP with synthetic users and temporary private storage. The same requests can be run in Postman using the routes above and a synthetic Bearer token; do not use production credentials or real institutional documents in tests.

## Phase 6: Sarvam Vision structured FDR extraction

The backend sends stored private FDR documents to Sarvam Document AI Extract with a schema-defined request, `language=en-IN`, and `output_format=json`. The installed official `sarvamai` SDK (v1.1.12) exposes `docAi.extract`, `docAi.getStatus(jobId)`, and `docAi.getResults(jobId, { format: "json" })`, but its Extract request type does not expose or serialize `language`. To preserve `en-IN`, the implementation uses Sarvam's documented multipart REST Extract endpoint for job submission and the official SDK for status and results. The same `SARVAM_API_KEY` subscription-key authentication is used; credentials and provider payloads are not logged.

OCR endpoints require a Bearer access token and an existing authorized FDR:

| Endpoint | Allowed roles | Behavior |
|---|---|---|
| `POST /api/fdrs/:id/extract` | `institution_admin`, `institution_user`, `aicte_admin`, `reviewer` | Submit the FDR's stored document and return HTTP 202 with `{ "fdrId", "status", "jobReference" }`. |
| `GET /api/fdrs/:id/extraction` | `institution_admin`, `institution_user`, `aicte_admin`, `reviewer` | Poll the saved job and return its safe status, extracted fields, comparison statuses, timestamps, and safe error code when relevant. |

Institution roles can request/poll OCR only for records belonging to their own institution. AICTE administrators and reviewers can access records allowed by their existing official access rules. The record ID is validated; the stored provider job ID is used for polling and cannot be supplied or replaced by the client. `POST` returns `409` for duplicate in-progress or already-successful requests. Failed or rejected jobs may be retried through the same POST route. OCR submissions are limited to 10 requests per authenticated user per 15 minutes; polling is limited to 30 requests per minute.

The internal lifecycle is `not_started`, `submitting`, `queued`, `processing`, `completed`, `partially_completed`, `failed`, or `rejected`. The POST route is asynchronous and never waits for extraction to finish. A future frontend should poll the GET route about every 5 seconds (within the 30/minute limit) and stop polling once a terminal state is returned. Results become available only for `completed` or `partially_completed`; provider job IDs are not included in the GET response.

Stored institution-entered FDR values are kept unchanged. Extracted values are stored separately under `ocrResult.extractedData`, with per-field comparison status in `ocrResult.comparisonResults`. Comparisons return `match`, `mismatch`, `missing_or_unreadable`, or `not_comparable`. FDR number comparison trims/case-normalizes; bank, branch, and institution-name comparisons use conservative Unicode/case/whitespace normalization; amounts are compared numerically; currency is reported separately; dates are normalized to ISO dates. Missing extraction values are not treated as mismatches. OCR discrepancies are data-review signals only: they do not prove tampering, establish authenticity, or automatically approve, reject, or release an FDR.

Sarvam Extract supports PDF, JPEG, and PNG inputs. PDFs are locally checked and limited to 20 pages; the existing configured upload size limit also applies. Unreadable/password-protected PDFs, unsupported media, excessive page counts, and invalid stored document signatures are rejected before submission. Provider errors map to safe codes such as `invalid_api_key`, `rate_limited`, `provider_timeout`, `document_rejected`, and `provider_unavailable`; raw provider messages, API keys, extracted annotations, document bytes, and absolute paths are not returned or logged. Request, completion, and failure audit records are persisted with minimal metadata; successful responses are not returned when their required audit write fails.

Mocked tests do not require a Sarvam account or live API availability:

```powershell
cd server
npm test
npm run db:check
```

An optional live smoke test uses a generated one-page synthetic PDF (not an institutional document), requires a valid key in `SARVAM_API_KEY`, and prints only the terminal job status:

```powershell
cd server
$env:SARVAM_OCR_LIVE_SMOKE = "true"
npm run ocr:smoke
Remove-Item Env:SARVAM_OCR_LIVE_SMOKE
```

The smoke test is opt-in and was not part of the regular test suite. Common errors include a missing or invalid key (`not_configured` / `invalid_api_key`), provider throttling (`rate_limited`), timeout (`provider_timeout`), provider outage (`provider_unavailable`), and unsupported or over-limit documents (`unsupported_document`, `too_many_pages`, or `document_too_large`).

## Phase 7: Document integrity and preliminary forensic analysis

The local forensic analyzer reads only a document retrieved by its validated private storage key. It never accepts a path from the request and does not send documents to an external service. Access requires a Bearer token and an existing FDR:

| Endpoint | Allowed roles | Behavior |
|---|---|---|
| `POST /api/fdrs/:id/forensics` | `institution_admin`, `institution_user`, `aicte_admin`, `reviewer` | Analyze the authorized FDR's stored document and return a sanitized report. |
| `GET /api/fdrs/:id/forensics` | `institution_admin`, `institution_user`, `aicte_admin`, `reviewer` | Return the latest report; returns `404` with `analysis_not_found` before the first analysis. |

Institution roles are limited to FDRs belonging to their authenticated institution. Officials retain the access rules already used by FDR endpoints. Each run is stored as a separate `ForensicAnalysis` history record, and the FDR keeps a pointer to the latest report. Requested, completed, and failed runs are audited; a report is not treated as successfully persisted unless its report and audit entry are saved together.

Supported formats are PDF, JPEG, and PNG, using the existing configured upload cap (`FDR_MAX_UPLOAD_BYTES`, default 10 MiB). PDFs are parsed locally and limited to 20 pages. Images are inspected from bounded headers/structure without full image decoding and limited to 40 million pixels. Image EXIF presence and PDF metadata are weak indicators only. Missing metadata is common and does not establish manipulation. Malformed files and files beyond resource limits are reported as failed or inconclusive rather than being classified as genuine or fraudulent.

The SHA-256 comparison checks whether current stored bytes match the upload-time checksum. A mismatch conclusively indicates a byte change relative to that recorded checksum, but says nothing about whether the document was authentic when issued. If no valid upload-time checksum is available, integrity is inconclusive. The analyzer does not rewrite files.

The configured PDF parser does not reliably enumerate digital-signature fields. Signature-field detection and cryptographic signature validation are unsupported. The system does not validate signer identity, certificate chains, or trust. Image inspection is structural/metadata-only: it does not implement error-level analysis, detect all edits or recompression artifacts, or detect AI-generated imagery. No forensic outcome automatically approves, rejects, or releases an FDR.

For interpretation:

- **Integrity checking** compares stored bytes to the upload-time checksum.
- **Preliminary forensic findings** report bounded parser, metadata, or structural signals, with heuristic/conclusive labels and limitations.
- **OCR discrepancy results** compare Sarvam-extracted fields with institution-submitted FDR values; they are not image-forensics findings or proof of tampering.
- **Bank-side authenticity verification** is not implemented.

Reports identify the local analysis engine and version, and use statuses `no_signals_detected`, `review_recommended`, `analysis_inconclusive`, `integrity_check_failed`, or `analysis_failed`. In particular, `no_signals_detected` means only that these limited checks did not report a signal; it is not an authenticity determination. Findings use `info`, `low`, `medium`, `high`, or `inconclusive` severities and identify whether each is heuristic or conclusive.

Run the automated backend suite and database/schema smoke check with:

```powershell
cd server
npm test
npm run db:check
```

Tests use generated PDF/image fixtures, synthetic accounts, and temporary private storage. No genuine institutional documents or live third-party analysis service are used.

## Phase 8: Administrative review, replacement, and release requests

Administrative review routes require a Bearer token and the current database role `aicte_admin` or `reviewer`:

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/fdrs/review-queue?page=1&limit=20&workflowStatus=submitted&search=...` | Paginated queue, optionally filtered by an existing FDR workflow status and searched by FDR number, institution name, or institution code. Maximum page size is 100; results sort newest-first with a stable ID tie-breaker. |
| `GET /api/admin/fdrs/:id/review` | Consolidated safe institution/FDR summary, document-access endpoint, OCR and forensic summaries, review history, replacements, and release-request summaries. |
| `POST /api/admin/fdrs/:id/review` | Add a traceable administrative decision. |
| `GET /api/admin/release-requests?page=1&limit=20&status=submitted` | Paginated release/refund request queue, maximum page size 100. |
| `GET /api/admin/release-requests/:requestId` | Read a release/refund request and its decision history. |
| `POST /api/admin/release-requests/:requestId/decision` | Record an official request-information, approve, or reject decision. |

Review decision requests contain a required reason:

```json
{
  "decision": "request_correction",
  "reason": "Please correct the synthetic branch details before resubmitting."
}
```

Decisions are `request_correction`, `reject_submission`, and `complete_review`. They are allowed only while an FDR is `submitted` or `under_review`. The transitions are respectively `correction_requested`, `rejected`, and `review_completed`. `review_completed` means administrative scrutiny is complete; it does not mean bank verification, authenticity confirmation, or automatic approval. Correction-requested FDRs can be edited only by their associated institution and must be resubmitted with `workflowStatus: "submitted"`; each decision and resubmission remains in FDR review history. Reviewer-confirmed data is separate from institution-entered and OCR-extracted fields.

Institution roles may submit a new replacement instrument for their own eligible, unreleased FDR:

| Endpoint | Request |
|---|---|
| `POST /api/fdrs/:id/renewal` | Multipart form with the new `fdrNumber`, `bankName`, `branch`, positive `amount`, optional three-letter `currency`, `issueDate`, `maturityDate`, and a PDF/JPEG/PNG `document`. |

Replacement creates a separate FDR in `submitted` status, links it with `replacesFdr`, stores the uploaded document using the existing private storage and checksum flow, and audits the actor and submission. It never overwrites the original instrument or makes the replacement approved. One replacement record is allowed per instrument; continue a replacement chain from its latest record.

Institution roles may submit a release/refund request for their own FDR:

```http
POST /api/fdrs/:id/release-requests
Content-Type: application/json
```

```json
{ "reason": "The deposit has reached its eligible end date; please review release eligibility." }
```

Only one active request per FDR is allowed. A reviewer/admin can `request_information`, `approve_request`, or `reject_request`, each with a required reason. An information-requested submission may be resubmitted and retains its prior history. Approval is permitted only after administrative review completion (`review_completed` or existing `approved`) or when the FDR is marked `matured`. These routes only record administrative requests and decisions: they do not transfer funds, release a bank instrument, change financial status, or claim that a bank has discharged the deposit. Applicable regulation and competent-authority approval remain outside this prototype.

Review decisions, replacements, release-request submissions, resubmissions, and release decisions are persisted with audit entries in transactions. Institution ownership is checked against the authenticated user’s current database record. Review-queue and release-request responses omit document storage keys and contents; document access continues through the separately authorized document endpoint.

Run `npm test` and `npm run db:check` from `server` to run the synthetic workflow/integration tests and validate MongoDB connectivity and model schemas. On the Phase 8 implementation run, `npm test` passed all 64 tests and `npm run db:check` passed against `aicte_fdr_portal` without the prior duplicate `User.email` index warning.

## Troubleshooting connection failures

- Confirm `MONGODB_URI` is set correctly in `server/.env`.
- Verify the Atlas database user has permission to the target database.
- Ensure the current IP is allowed in Atlas Network Access.
- Check that the cluster is running and reachable.
- If the connection fails, review the terminal error and try again after confirming the URL and credentials.

## Current phase scope

Phases 1–10 include the backend foundation, MongoDB models and connectivity, authentication and authorization, institution profile/review access, FDR/document APIs, Sarvam OCR, preliminary local forensic checks, administrative FDR review, linked replacement submissions, administrative release/refund request tracking, in-app maturity reminders, dashboards, reports, and the React frontend integration. Email/SMS delivery, bank-side authenticity verification, actual fund transfers, and automated authenticity decisions remain out of scope.

## Phase 10: Frontend and integration

This repository contains an Express/Mongoose backend in `server/` and a React/Vite JavaScript frontend in `client/`. The frontend uses an olive, warm-neutral, amber, and clay palette and intentionally avoids blue and purple accents. Its centralized API client reads only the public backend API base URL from `client/.env`; it never reads or builds in server credentials.

### Local development

Prerequisites: Node.js 18+, npm, and a reachable MongoDB Atlas cluster. Set backend secrets locally in `server/.env` (see [server/.env.example](./server/.env.example)); do not copy credentials into client configuration.

```powershell
# Backend
cd server
npm install
npm run db:check
npm run dev

# In a second terminal, frontend
cd client
npm install
Copy-Item .env.example .env
npm run dev
```

By default the API listens on port 3000 and the frontend on port 5173. For local development, `FRONTEND_ORIGIN=http://localhost:5173` must match the browser origin. Set `VITE_API_BASE_URL` to the public API origin plus `/api`, for example `https://api.example.gov/api`; this value is public configuration, never a secret.

The login token is held only in JavaScript memory and sent as a Bearer token through one centralized API client. It is not stored in `localStorage` or `sessionStorage`; refreshing the page requires signing in again. The backend remains authoritative for role and institution ownership checks. Authenticated document downloads are fetched through the private API and are not converted into permanent public URLs.

### Frontend pages

- Login and institution registration (no public admin registration)
- Role-scoped institution and AICTE dashboards
- Paginated FDR register, FDR creation/upload, detail/edit, document download, OCR results, forensic findings, linked replacement, and release/refund request
- Official review queue and review detail with supporting document, OCR/forensic summaries, review history, institution status review/history, and release request decisions
- In-app notifications, management reports, and safe CSV export

### Build and production start

```powershell
cd client
npm run build
npm run preview

# Separately, on the backend host:
cd server
npm start
```

`npm run build` writes the static frontend bundle to `client/dist/`. Serve it from the deployment's static frontend host; set `VITE_API_BASE_URL` at build time to the public backend URL. Configure backend `FRONTEND_ORIGIN` to the exact deployed frontend origin, not `*`. Provide `MONGODB_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `SARVAM_API_KEY` (only when OCR is enabled), and other backend configuration through the deployment platform's secret/environment manager. Do not deploy `.env` files.

For Atlas, allow only the backend's required outbound network access in Atlas Network Access and use a least-privilege database user for `aicte_fdr_portal`. Do not use broad public IP allowlists unless the hosting platform provides no stable egress option and the risk has been explicitly accepted.

The prototype stores uploaded documents under the backend's private local `server/private/uploads/fdr` directory by default. This is outside the static frontend and must never be exposed with static-file middleware. Before production, mount a persistent, non-public, access-controlled volume at the configured `FDR_STORAGE_DIR`, preserve it through deployments, and restrict filesystem permissions. If the target platform has an ephemeral filesystem, production deployment is blocked until a supported persistent private volume or private storage adapter is configured and tested. No object-storage credentials are available or configured by this implementation.

The reminder scheduler is opt-in and in-process. Do not run independent production schedulers on multiple instances without coordinating them; the unique notification index prevents duplicate creation but does not prevent duplicate scanning. Use a single scheduler-enabled backend instance or add distributed scheduling coordination before scaling it.

### Verification

```powershell
cd server
npm test
npm run db:check

cd ..\client
npm test
npm run build
```

The frontend suite has three React integration tests for memory-only login/role navigation, synthetic FDR upload, and an official review decision. These tests use synthetic users and mocked API responses; they do not call the live backend. Backend route tests use synthetic data and do not require live Sarvam. A live OCR check is optional and was not run as part of this phase unless explicitly stated in the implementation report. No production deployment is claimed. See [docs/DEMO_GUIDE.md](./docs/DEMO_GUIDE.md) for a synthetic 5–7 minute demonstration flow.

### Known limitations

Browser authentication is intentionally memory-only and does not survive refresh. A secure HttpOnly cookie/session migration is outside this prototype. OCR and local forensics are review aids and do not determine authenticity; bank-side verification and fund transfers remain unsupported. Production file persistence, TLS/domain configuration, and deployment-specific secret provisioning must be verified for the chosen host before launch. Rotate credentials previously shared in conversation before any production use.

## Phase 9: In-app maturity reminders, dashboards, and reports

The backend persists in-app notifications and starts an in-process daily reminder scheduler only after MongoDB connects successfully. The scheduler is disabled by default (including ordinary tests); enable it explicitly with `MATURITY_REMINDERS_ENABLED=true`. No email/SMS credentials or external notification provider are used.

| Environment variable | Default | Description |
|---|---|---|
| `MATURITY_REMINDERS_ENABLED` | `false` | Starts the daily scheduler only when exactly `true`. |
| `MATURITY_REMINDER_TIME` | `09:00` | Daily local schedule time in 24-hour `HH:mm` format. |
| `MATURITY_REMINDER_TIMEZONE` | `Asia/Kolkata` | IANA timezone used for the scheduled time and date-only maturity calculations. |
| `MATURITY_REMINDER_DAYS` | `30,15,7` | Comma-separated days before maturity that create reminders. Valid values are 1–365. |
| `MATURITY_OVERDUE_REMINDER_ENABLED` | `true` | Creates one overdue follow-up, at most once per instrument/maturity date. |
| `MATURITY_REMINDER_OFFICIAL_USER_IDS` | empty | Optional comma-separated user IDs for active AICTE officials who are explicitly configured to receive reminders. Assigned FDR reviewers may also receive the reminder. |

Only records in `review_completed` or `approved` workflow status and `active` or `matured` financial status are eligible. Released, expired, renewed, and cancelled instruments are excluded; an instrument with a current linked replacement is also excluded so a prior instrument does not keep generating reminders. The job does not change any financial or workflow status. Institution `institution_admin` and `institution_user` recipients are selected only from the FDR's institution. Official recipients are limited to the assigned reviewer and explicitly configured active officials.

The overdue policy creates a single `overdue` event if the daily run first sees an instrument within 90 days after its maturity date. It does not emit daily overdue messages, and it does not backfill every missed reminder stage. On startup, after a successful database connection, catch-up evaluates only the date's due stages; older missed stages are not sent. MongoDB's unique `deduplicationKey` index prevents repeated scheduled runs (and concurrent instances) from duplicating the same recipient/FDR/maturity/stage notification. The scan pages by stable maturity-date and ID order and processes at most 5,000 candidate records per run. Errors are logged as sanitized record/query error names and do not stop processing the rest of the batch.

Stored timestamps use UTC. Maturity values are treated as date-only values; the reminder job compares those dates with the current calendar date in `MATURITY_REMINDER_TIMEZONE` to avoid UTC/local midnight off-by-one errors.

### Notification endpoints

All endpoints require a Bearer access token and use the authenticated user's ID as recipient scope; callers cannot select another recipient.

| Endpoint | Behavior |
|---|---|
| `GET /api/notifications?page=1&limit=20&unreadOnly=true` | Paginated notifications; maximum page size is 100; stable newest-first ordering. |
| `GET /api/notifications/unread-count` | Current user's unread count. |
| `PATCH /api/notifications/:id/read` | Mark one owned notification as read; another user's or missing notification returns 404. |
| `PATCH /api/notifications/read-all` | Mark only the current user's unread notifications as read. |

Notification content contains only a short reminder and safe FDR number/date/stage metadata. It does not include credentials, full OCR/forensic payloads, private document bytes, or storage paths.

### Dashboard endpoints

| Endpoint | Required roles | Behavior |
|---|---|---|
| `GET /api/dashboard/summary` | `institution_admin`, `institution_user` | Summary restricted to the authenticated user's institution, including current FDRs, status counts, 30-day upcoming maturities, matured instruments awaiting action, review/correction workload, linked replacement workload, active release requests, and unread notifications. |
| `GET /api/admin/dashboard/summary` | `aicte_admin`, `reviewer` | Cross-institution counts and the last 30 days of official FDR audit workload. |

Both summaries exclude financial records marked renewed/released/cancelled, released/expired workflow records, and superseded originals with a current linked replacement. A maturity date passing does not update a financial status, approve a record, release funds, or establish bank authenticity. Upcoming/matured counts use the UTC date-only value; the summary's upcoming window is today through 30 days ahead.

### Management report and CSV

Both endpoints require `aicte_admin` or `reviewer`; institution users cannot query report data. The optional `institutionId` filter is available only to these authorized officials.

| Endpoint | Behavior |
|---|---|
| `GET /api/admin/reports/fdrs?page=1&limit=20&search=...&workflowStatus=submitted&maturityFrom=2026-01-01&maturityTo=2026-12-31&institutionId=...` | Paginated safe FDR summary, maximum page size 100. Search matches FDR number, institution name, or institution code; maturity filters are inclusive date-only ranges; results sort by maturity date then ID. |
| `GET /api/admin/reports/fdrs/export?...` | CSV using the same filters, capped at 5,000 records. Larger results return HTTP 413 and require narrower filters. |

CSV fields include institution name/code and submitted FDR summary values only. Cell values are quoted and escaped; values beginning with spreadsheet formula characters (`=`, `+`, `-`, or `@`, including after leading whitespace) are prefixed with an apostrophe. Exports omit document paths/content, OCR/forensic payloads, credentials, and unnecessary personal data. Each successful export writes a safe audit event before returning the CSV. Responses use `text/csv`, attachment disposition, and `Cache-Control: no-store`.

Run the automated tests and model/database smoke check from `server`:

```powershell
npm test
npm run db:check
```

Reminder service tests use synthetic dates and records; ordinary test runs do not start the scheduler or require external services. The in-process scheduler is not a durable distributed scheduler: multiple application instances may each run it, with MongoDB uniqueness preventing duplicate notifications. A stopped service catches up only the current day's due stages on restart, not historical stages. Monitor application logs for sanitized run totals and failed record/query counts.

Phase 9 verification in this workspace: `npm test` passed all 74 tests, including 10 Phase 9 tests; `npm run db:check` passed schema validation and MongoDB connectivity to `aicte_fdr_portal`; `git diff --check` passed.

## Phase 11: isolated end-to-end stabilization

The normal backend suite remains self-contained and does not connect to MongoDB. The Phase 11 HTTP integration suite uses a dedicated database named exactly `aicte_fdr_portal_test`, synthetic users and records, and temporary private document storage. It never drops a database or collection; cleanup removes only records created by the current run. Never point `MONGODB_TEST_URI` at `aicte_fdr_portal` or any database containing real data.

Create a separate local test configuration from the placeholder file:

```powershell
cd server
Copy-Item .env.test.example .env.test
```

Set `MONGODB_TEST_URI` to test credentials whose URI targets `aicte_fdr_portal_test`, and set a random test-only `JWT_TEST_SECRET`. Do not copy production credentials or Sarvam API keys into `.env.test`. The HTTP suite forcibly disables reminders and enables a deterministic local OCR provider only when `NODE_ENV=test`; no document is sent to Sarvam. It writes uploads to an automatically created temporary directory and removes that directory after the run.

Run the dedicated checks from `server`:

```powershell
npm run db:check:test
npm run test:e2e
```

`db:check:test` refuses a URI for any database other than `aicte_fdr_portal_test`. The HTTP suite exercises registration and login, authorization and cross-institution access, FDR creation/list/update/download, invalid and oversized uploads, OCR extraction/comparison, forensic analysis, reviewer correction/resubmission/completion, renewal linkage, release request decisions, notifications, dashboards, reports and CSV. The three rendered-frontend Vitest tests use mocked API responses; browser-to-backend coverage is provided separately by the Phase 12 Playwright suite below.

For a manual frontend-to-backend smoke test, create the isolated test configuration as above, then run `npm run start:test` from `server` and `npm run dev` from `client` in separate terminals. The test server pins MongoDB to `aicte_fdr_portal_test`, disables reminders and external OCR credentials, and uses temporary private storage that is removed when the server exits. Use the registration page for a synthetic institution account, then test FDR upload, record detail, OCR/forensic panels, and access-denied states. Stop the test server before running another test suite against the same database.

See [docs/E2E_TEST_REPORT.md](./docs/E2E_TEST_REPORT.md) for the Phase 11 results and [docs/PHASE12_READINESS_REPORT.md](./docs/PHASE12_READINESS_REPORT.md) for actual browser results, test-data isolation details, deployment blockers and manual verification steps.

## Phase 12: browser E2E and deployment readiness

The Playwright browser suite starts both the guarded test backend and Vite frontend, and exercises the rendered React application against Express using synthetic test data. It requires `server/.env.test` configured with a least-privilege test account whose URI targets only `aicte_fdr_portal_test`; create it from `server/.env.test.example` and set a random test-only JWT secret. The test runner refuses other database names, configures the client API URL as `http://localhost:3011/api`, and cleans only its uniquely tagged fixtures and private temporary files. It seeds synthetic administrative/reviewer accounts and performs institution registration through the UI.

```powershell
cd server
Copy-Item .env.test.example .env.test
# Edit .env.test with a dedicated test database account and random test-only JWT secret.
npm run db:check:test
npm test
npm run test:e2e

cd ..\client
npm test
npm run test:e2e
npm run build
```

Install the matching Chromium browser once with `npx playwright install chromium` from `client`. The browser flow covers institution registration/login and role navigation, official institution approval, FDR form submission/document upload/list/detail, deterministic test OCR and local forensics, reviewer queue/decision, unread notifications, and Institution B denial for Institution A's record and document. The test OCR provider is enabled only by the guarded `NODE_ENV=test` startup and is never a live Sarvam result. Do not run `npm run db:check` against the production database for E2E verification.

Current Phase 12 results and known limitations are in [docs/PHASE12_READINESS_REPORT.md](./docs/PHASE12_READINESS_REPORT.md). Browser E2E, test DB connectivity and a production frontend build passed; live Sarvam OCR and production deployment were not verified. Production readiness remains blocked on a configured frontend API URL, confirmed rotated/least-privilege credentials, and persistent private document storage on the selected host.
