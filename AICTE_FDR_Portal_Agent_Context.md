# AICTE Security Deposit / FDR Management Portal — Agent Context

> **Purpose of this file:** Give a coding agent enough context to understand the project, current decisions, MVP scope, architecture, security requirements, and implementation order. Read this file before making code changes.

## 1. Project Summary

Build a secure, centralized **Security Deposit / Fixed Deposit Receipt (FDR) Management Portal** prototype for AICTE-style approval and compliance workflows.

The portal should help authorized institutions submit FDR records and supporting documents, and help authorized reviewers manage verification, discrepancies, maturity dates, renewals/replacements, release/refund requests, alerts, and audit history.

This is a **prototype/MVP**, not an official AICTE production system. Do not imply that it is connected to AICTE or banks unless a genuine, authorized integration is later supplied and verified.

## 2. Problem Being Solved

Institutions may need to maintain security deposits or FDRs as part of applicable approval/compliance processes. Fragmented spreadsheets, documents, and correspondence make it harder to:

- Keep institution-wise and instrument-wise records up to date.
- Locate submitted FDRs and supporting documents.
- Extract and check important fields consistently.
- Identify missing details, inconsistencies, or documents that need scrutiny.
- Monitor validity, maturity, renewal, and replacement dates.
- Track release/refund requests and their administrative status.
- Understand pending work through a centralized dashboard.
- Keep an auditable history of submissions, reviews, and changes.

## 3. Product Goal and MVP Success Criteria

The MVP should demonstrate this end-to-end flow:

1. An institution user signs in.
2. The institution creates an FDR record and uploads a sample PDF/image.
3. The backend stores the document privately and saves submitted metadata.
4. The user or authorized reviewer triggers OCR/document extraction through **Sarvam Vision / Sarvam Document AI**, using the configured API key on the server only.
5. The system extracts fields and compares them with the institution-submitted fields.
6. The system flags missing fields, mismatches, invalid/inconsistent dates, and other review concerns.
7. An authorized reviewer can inspect the original document, extracted results, warnings, add notes, and record a review outcome.
8. The dashboard shows records by workflow status and upcoming maturity dates.
9. The system tracks renewals/replacements and release/refund requests at a basic administrative-workflow level.
10. Important actions are added to an audit log.

### MVP does NOT have to include

- A live AICTE integration.
- Live bank verification unless an authorized and technically available service is provided.
- DigiLocker integration.
- Automatic legal/compliance decisions.
- A custom trained tampering classifier in the first implementation.
- Complex microservices or Kubernetes.
- Any claim that OCR alone proves a document is genuine.

## 4. Confirmed Technology Direction

Use the following stack unless there is a strong, documented reason to propose a change:

- **Frontend:** React + Vite.
- **Styling:** Tailwind CSS and a consistent component system, if installed and supported by the existing project.
- **Main backend:** Node.js + Express, using ES modules.
- **Database:** MongoDB + Mongoose.
- **Authentication:** bcrypt/bcryptjs for password hashing; JWT or a secure session/cookie approach. Use `HttpOnly`, `Secure` (in production), and appropriate `SameSite` cookie settings if JWTs are stored in cookies. Avoid storing sensitive tokens in `localStorage` by default.
- **Validation:** Zod or equivalent server-side input validation.
- **Uploads:** Multer can handle multipart uploads, but uploaded files must be validated and stored in a private location. Do not expose files from a public static directory.
- **OCR/document extraction:** Sarvam Vision / Sarvam Document AI using the user's API key. Prefer an official, current SDK/API documented by Sarvam. Verify the current package name, endpoint, authentication header, request schema, supported file formats, file-size/page limits, response schema, rate limits, and pricing using official documentation before implementing. Do not guess SDK methods.
- **API testing:** Postman or equivalent.
- **Version control:** Git + GitHub.
- **Optional later:** Python + FastAPI + OpenCV for dedicated image-forensics processing, only once the base workflow is working and an evaluated method is chosen.

### Important architecture choice

For the MVP, call Sarvam from the **Express backend**. A separate Python OCR service is not required just to call Sarvam. If later adding Python/OpenCV for forensic analysis, keep that optional service separate from the core FDR workflow.

## 5. Suggested Repository Layout

```text
aicte-fdr-portal/
├── client/                         # React + Vite
│   └── src/
│       ├── components/
│       ├── layouts/
│       ├── pages/
│       ├── routes/
│       ├── services/                # Frontend API client
│       ├── hooks/
│       └── utils/
├── server/                         # Node.js + Express
│   └── src/
│       ├── config/                  # Database and configuration
│       ├── controllers/
│       ├── middleware/              # Auth, RBAC, error handling, upload checks
│       ├── models/                  # Mongoose models
│       ├── routes/
│       ├── services/                # Sarvam client, FDR workflow
│       ├── jobs/                    # Maturity reminders
│       ├── validators/
│       ├── utils/
│       └── server.js
├── docs/
│   ├── architecture.md
│   └── api-contracts.md
├── .gitignore
└── README.md
```

Do not create every directory upfront if it is not yet used. Build incrementally and keep modules focused.

## 6. User Roles and Permissions

Minimum roles:

- **Institution user:** Manage only their institution's records; submit FDRs; view extraction results and review status; submit corrections/renewals/release requests.
- **Admin/reviewer:** Search and review allowed records; see documents and extracted fields; add scrutiny notes; request correction; record review decisions; view dashboards and audit history.

Security rules:

- Enforce role and institution ownership on the **server for every endpoint**. Hiding a UI control is not access control.
- Do not let an institution user approve their own instrument as independently verified.
- Use least privilege and deny access by default.
- Do not expose secrets or document URLs publicly.
- Do not hardcode real credentials or commit `.env` files.
- Add `.env`, uploaded test files containing sensitive information, build outputs, and `node_modules` to `.gitignore`.

## 7. Core Data Model (Initial Proposal)

Use Mongoose schemas. Adjust details after defining the endpoint contracts.

### `User`

- `name`
- `email` (normalized and unique)
- `passwordHash`
- `role`: `INSTITUTION_USER` or `ADMIN_REVIEWER`
- `institutionId` for institution users
- `isActive`
- timestamps

### `Institution`

- `name`
- `institutionCode` / applicable identifier, if available
- `address` (only necessary fields)
- `contacts` (minimal required information)
- timestamps

### `FDR`

Suggested fields:

- `institutionId`
- `fdrNumber` (as submitted; consider normalized search value separately)
- `bankName`
- `branchName` (optional)
- `depositAmount` (numeric; validate currency and non-negative value)
- `currency` (default INR only if suitable for the prototype)
- `issueDate`
- `maturityDate`
- `validityStatus`
- `workflowStatus`
- `document`: private storage key, original filename, MIME type, byte size, checksum/hash, upload timestamp, uploadedBy
- `submittedFields`: values entered by the institution
- `extraction`: provider, model/version if available, extracted fields, raw/structured result as appropriate, extraction timestamp, processing status, errors
- `validationFindings`: structured list of check code, severity, expected/observed details, message, source, timestamp
- `review`: reviewer, decision, notes, timestamp
- `renewalHistory`: references to replacement/renewal records or a history list
- `releaseRequests`: request status/history or separate collection later
- timestamps

Do not store a sensitive full OCR payload when only normalized fields are needed. Avoid logging document content, secrets, tokens, or unnecessary personal/financial data.

### `AuditLog`

- `actorUserId`
- `actorRole`
- `action`
- `entityType`
- `entityId`
- `timestamp`
- limited structured metadata (no secrets or full document content)

### Optional later `Notification`

- `recipientUserId`
- `fdrId`
- `type`
- `message`
- `dueAt`
- `sentAt` / `readAt`
- status

## 8. Suggested Workflow Statuses

Keep **document authenticity** separate from **administrative workflow** and **validity/maturity**. Do not try to represent all of them with one status field.

### Administrative workflow status

- `SUBMITTED`
- `PROCESSING`
- `PENDING_REVIEW`
- `CORRECTION_REQUIRED`
- `REVIEWED`
- `RENEWAL_DUE`
- `RELEASE_REQUESTED`
- `RELEASE_APPROVED`
- `CLOSED`

Choose and document exact transitions. Only authorized reviewer actions should move review/approval states.

### Extraction status

- `NOT_STARTED`
- `PROCESSING`
- `COMPLETED`
- `FAILED`

### Verification outcome

- `NOT_ASSESSED`
- `NO_ISSUES_DETECTED` (does **not** mean genuine)
- `FLAGGED_FOR_REVIEW`
- `INCONSISTENT_FIELDS`
- `BANK_CONFIRMED` (only if a trusted authorized bank verification mechanism confirms it)
- `MANUAL_REVIEW_REQUIRED`

### Maturity/validity status

Derive from `maturityDate` and current date where possible; do not rely solely on an old saved status. Example UI labels: `ACTIVE`, `EXPIRING_SOON`, `MATURED`, `UNKNOWN`.

## 9. API Plan

Implement only the endpoints needed by the currently active milestone. Proposed endpoints:

### Authentication

- `POST /api/auth/register` — only if institution registration is included; consider admin-controlled onboarding for prototype security.
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### Institutions

- `GET /api/institutions/:id` — authorized access only.
- Admin-only institution management endpoints when required.

### FDRs

- `POST /api/fdrs` — create record and upload document.
- `GET /api/fdrs` — paginated list filtered by permitted scope and status.
- `GET /api/fdrs/:id` — fetch authorized record.
- `GET /api/fdrs/:id/document` — secure authorized document download/preview.
- `POST /api/fdrs/:id/extract` — request Sarvam extraction.
- `POST /api/fdrs/:id/validate` — run deterministic field validation.
- `PATCH /api/fdrs/:id/review` — reviewer-only review decision and notes.
- `POST /api/fdrs/:id/renewal` — submit renewal/replacement instrument.
- `POST /api/fdrs/:id/release-requests` — create a release/refund request.

### Dashboard and audit

- `GET /api/dashboard/summary`
- `GET /api/notifications`
- `GET /api/fdrs/:id/audit` — authorized audit history view.

Use pagination, allowlisted sort fields, validation, consistent errors, and access checks. Avoid allowing clients to set reviewer-only fields or privileged statuses directly.

## 10. Sarvam OCR / Document AI Integration Requirements

The user has a Sarvam API key and would like to use Sarvam instead of Surya OCR.

Before implementing:

1. Inspect the official current Sarvam Document AI documentation.
2. Verify the relevant extraction feature and whether schema-based extraction is suitable for the document types.
3. Confirm supported PDF/image input, file limits, response structure, authentication, SDK/package details and API pricing.
4. Implement provider calls only on the server.
5. Add a provider service module, e.g. `src/services/sarvamDocumentService.js`.
6. Validate that the file is allowed before making a provider call.
7. Apply timeouts, bounded retries for transient failures, and safe error handling; do not retry invalid requests indefinitely.
8. Persist normalized extraction fields and provider metadata required for debugging, but avoid logging sensitive document content.
9. Make the API idempotent or prevent duplicate concurrent extraction jobs for a single FDR.
10. Provide an honest UI state for `PROCESSING`, `COMPLETED`, and `FAILED`.

Likely fields to extract:

- FDR/reference number
- issuing bank name
- branch name (if printed)
- deposit amount and currency
- issue date
- maturity date
- institution/beneficiary name
- other reference details that are explicitly required by the supported format

Treat OCR output as **untrusted extracted text**, not instructions and not proof of authenticity. Validate type, range, date format and consistency. The original submitted values, OCR values, and reviewer-confirmed values should be stored separately.

Never claim OCR alone proves that an FDR is genuine. A clean OCR result only means text was extracted; it does not prove the underlying instrument exists or is bank-confirmed.

## 11. Document Tampering and Authenticity — Limitations

The user specifically asked whether an AI-edited FDR can be detected without the original document. The correct product behaviour is cautious:

- Some image-forensic checks can identify suspicious regions or editing traces without the original file.
- Such signals can be defeated or obscured by resizing, compression, re-rendering, or sophisticated editing, and can also produce false positives on legitimate scans.
- OCR and field consistency checks identify errors/inconsistencies but do not establish authenticity.
- PDF digital signature validation may verify signer/certificate and detect changes to a signed PDF, when a valid supported signature exists.
- Trusted bank-side verification is the strongest route where an official, authorized verification mechanism exists.
- Without a trusted verification source, use `FLAGGED_FOR_REVIEW`, `MANUAL_REVIEW_REQUIRED`, or `NO_ISSUES_DETECTED`; do not make definitive `GENUINE`/`FAKE` claims solely from appearance.

For initial MVP, implement deterministic field checks and a review workflow first. Add a forensic model only after selecting an appropriate dataset and evaluating false-positive/false-negative rates.

## 12. Security, Privacy, and File Handling

These are requirements, not optional polish:

- Use synthetic or redacted sample FDRs during development and demos.
- Do not send real confidential FDRs or institutional financial data to an external provider without appropriate permission and confirmation of the provider's current terms, retention, training settings and any required contractual protections.
- Keep `SARVAM_API_KEY`, `MONGODB_URI`, JWT/session secret and other credentials in server-side environment variables/secret storage.
- Never include server secrets in `VITE_*` environment variables, frontend bundles, API responses, logs, or source control.
- Restrict file size and file extensions; verify MIME type and file signature where possible. Do not trust client-supplied MIME type alone.
- Generate server-side storage names; preserve the submitted filename only as metadata after sanitization.
- Store documents privately, outside static/public folders. Require authorization for every file download/preview.
- Consider malware scanning, PDF parsing limits, and resource/time limits before production use.
- Prevent path traversal and arbitrary file paths.
- Use `helmet`, request rate limiting, request-body validation, and safe error responses.
- Configure CORS to known origins, not `*` with credentials.
- Add server-side ownership/role checks to all reads, writes, extraction and review endpoints.
- Use least-privilege database credentials and TLS where available.
- Add audit records for uploads, extraction requests, reviews, renewals and release actions.
- Never log passwords, tokens, API keys, document contents, or unnecessary personal/financial details.
- Add `.env` to `.gitignore` before the first commit.

## 13. Maturity Alerts

For MVP, build a scheduled backend job that checks records daily and creates in-app notifications for configurable thresholds, such as 30, 15, and 7 days before maturity. These thresholds are prototype defaults, not an AICTE rule; make them configurable and do not present them as official policy.

Also flag already matured instruments and overdue actions. Ensure a job does not create duplicate alerts for the same FDR, recipient, threshold and maturity date. Email/SMS can be added later.

## 14. UI Pages (MVP)

### Institution user

- Login
- Institution dashboard
- Submit FDR / add instrument
- FDR list and search
- FDR detail page with upload/extraction/review status
- Renewal/replacement submission
- Release/refund request form
- Notifications

### Admin/reviewer

- Admin dashboard with counts
- Institution/FDR search and filters
- Review queue
- FDR detail: private document preview, submitted fields vs OCR fields, warnings, reviewer notes and decision controls
- Expiring/matured list
- Release/refund request queue
- Audit history

Dashboard values shown in demos must be clearly sample/demo data, not real AICTE statistics.

## 15. Development Order — Follow This Sequence

Do not implement all features in one giant change. Finish and test each milestone before moving on.

### Milestone 1 — Project foundation

- Inspect current directory and installed versions first.
- Create `client/` (React + Vite) and `server/` (Express ES modules).
- Create `/api/health` endpoint.
- Configure environment files and `.gitignore`.
- Confirm frontend and backend start.
- Initialize Git repository and add a README.

**Acceptance:** React app opens and `GET /api/health` returns an `ok` response.

### Milestone 2 — Database and authentication

- Connect MongoDB Atlas or local MongoDB.
- Define `User` and `Institution` models.
- Implement login, logout/current-user endpoint and password hashing.
- Add role/ownership middleware and protect routes.

**Acceptance:** Institution user and admin can authenticate; institution user cannot access admin routes or another institution's records.

### Milestone 3 — FDR CRUD and private uploads

- Define FDR model and validation.
- Implement upload and private storage.
- Add record list/detail/create/update flows.
- Add secure document preview/download authorization.

**Acceptance:** Create an FDR, store its metadata, view it in the correct dashboard, and reject unauthorized document access.

### Milestone 4 — Sarvam extraction

- Read current official API docs and test a synthetic document using a minimal server-side script first.
- Create extraction service and route.
- Map the provider response to normalized fields.
- Save extraction status, results, and safe error details.
- Compare submitted vs extracted data.

**Acceptance:** On supported test files, extraction output is shown and saved; failures are visible and safely handled; the API key never reaches the browser.

### Milestone 5 — Review workflow and audit logs

- Create structured validation findings.
- Build reviewer queue and decision UI.
- Restrict decisions to reviewer role.
- Record audit events.

**Acceptance:** Reviewer can see warnings, add notes, request correction, and save a review outcome; all actions are traceable.

### Milestone 6 — Maturity and renewal tracking

- Add dashboard counts and filters.
- Add configurable maturity thresholds and non-duplicating scheduled notifications.
- Record renewal/replacement history and basic release/refund requests.

**Acceptance:** Sample dates produce the expected alert and dashboard status, with no duplicate notifications.

### Milestone 7 — Test and deploy

- Test valid, missing-field, inconsistent-date, mismatched-amount, corrupted-file and unsupported-file scenarios.
- Test authorization boundaries and upload security.
- Deploy using private storage and server-side secrets.
- Document setup, environment variables, routes and limitations.

**Acceptance:** A judge can follow the demo from upload through extraction, review and maturity monitoring without manual database edits.

## 16. Test Scenarios

Use synthetic documents/fixtures with no real customer data:

1. A clean, readable sample FDR.
2. A scan with a low-resolution or rotated page.
3. A document with a missing maturity date.
4. An entered amount that differs from the OCR-extracted amount.
5. A maturity date that is earlier than the issue date.
6. An unsupported file extension or invalid MIME/content signature.
7. A corrupted PDF/image.
8. An OCR provider timeout or rate-limit response.
9. An institution user attempting to access another institution's FDR.
10. An institution user attempting to approve an FDR.
11. A reviewer attempting an invalid state transition.
12. An FDR with a maturity date within a reminder threshold.
13. A PDF with a digital signature, if test fixtures and a suitable validation library are available.
14. A suspicious image test case, ensuring a suspicious signal is described as a flag and not conclusive proof of fraud.

## 17. Coding Agent Rules of Engagement

- Read this file and inspect the existing repository before modifying anything.
- Work milestone by milestone; avoid implementing the entire system in one pass.
- Before adding a dependency or using an SDK, verify current official documentation and package names.
- Do not invent Sarvam API endpoints, SDK methods, pricing, formats, or request/response fields.
- Keep provider-specific logic inside a service module; the rest of the app should use normalized internal data structures.
- Use clear naming, small modules, input validation, consistent error handling and meaningful HTTP status codes.
- Do not silently change the chosen stack.
- Do not claim a feature works until it has been run/tested. Report commands executed and remaining blockers honestly.
- Add or update tests for every meaningful backend workflow and security boundary.
- Do not use real FDRs or sensitive data for test fixtures.
- Explain any destructive commands before running them; never delete user data without explicit approval.
- Do not commit secrets.
- Keep README instructions current so another developer can run the project from scratch.

## 18. Current Starting Point

The project is being started from scratch. The user has a Sarvam API key, but it must not be copied into chat, GitHub, frontend code or this context file. The key should be added privately to `server/.env` when needed.

Immediate next task: **complete Milestone 1 only**—inspect/create the project folders, initialize React + Vite and Express, configure `.gitignore` and `.env.example`, add `GET /api/health`, run both servers, and verify them. After the foundation is confirmed, proceed to MongoDB schemas and authentication.

## 19. Useful Official Documentation Starting Points

Verify these are current before using them:

- Sarvam API documentation: https://docs.sarvam.ai/
- React: https://react.dev/
- Vite: https://vite.dev/guide/
- Express: https://expressjs.com/
- MongoDB Node.js driver: https://www.mongodb.com/docs/drivers/node/current/
- Mongoose: https://mongoosejs.com/docs/
- OWASP File Upload Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html

---

**North-star principle:** Build a reliable record-management and review workflow first. OCR is an extraction aid, forensic checks are risk signals, and authenticity must not be claimed without appropriate trusted verification.
