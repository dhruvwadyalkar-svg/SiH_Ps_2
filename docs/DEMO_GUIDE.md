# AICTE FDR Portal Demo Guide

This 5–7 minute walkthrough uses synthetic records only. Use separate synthetic institution and reviewer accounts provisioned in a non-production environment. Do not use actual bank statements or institution financial data.

## Preparation

- Start MongoDB-backed API and the React client using the root README commands.
- Configure a synthetic institution account and an authorized reviewer through the supported registration/bootstrap process.
- For the OCR step, use a synthetic sample document and configure a test Sarvam key only in the backend environment. If OCR is not configured, explain the safe provider-not-configured outcome; do not imply a live result.
- To demonstrate reminders, use a non-production database and a maturity date at a supported threshold. Reminders are disabled unless explicitly enabled in backend environment configuration.

## Walkthrough

1. **Institution sign-in (30 seconds):** Log in as the sample institution user. Show the role-scoped dashboard, maturity and pending-work counts, and unread notification count.
2. **Create an FDR (60 seconds):** Open FDR register → Add FDR. Enter synthetic institution, bank, FDR number, dates, currency, and amount. Upload a generated synthetic PDF, JPEG, or PNG and submit. Show that the server records the submitted values and provides a private document download action.
3. **OCR (60 seconds):** Request OCR from the FDR detail page. Show the queued/processing state, then the extracted fields beside the submitted values with per-field comparison results. Explain that OCR extracts text, it does not confirm instrument authenticity.
4. **Forensics (45 seconds):** Run local document analysis and show the report status, findings, confidence category, and limitations. Emphasize that a missing finding is not proof of authenticity and that checksum verification only checks whether stored bytes changed since upload.
5. **Reviewer sign-in (45 seconds):** Sign in using the separate authorized reviewer account. Open the FDR review queue, filter for the synthetic record, inspect its submitted details, private supporting document, OCR, forensic report, and review history.
6. **Decision (30 seconds):** Record a correction request or complete the administrative review with a reason. Show the resulting workflow status and audit history. Administrative completion is not bank confirmation or automatic approval.
7. **Notifications and maturity dashboard (30 seconds):** Show the notification inbox and mark-one/read-all actions. If the test data is within a configured threshold, show the maturity reminder. Otherwise explain that the daily job is opt-in and deduplicated.
8. **Replacement and release request (60 seconds):** Return to the institution account. Submit a synthetic linked replacement (the original remains in history), or submit a release/refund request. As the reviewer, inspect the request and record an allowed decision with a reason. Explain that the decision records workflow only and does not move funds.

## Limitations to call out

- OCR field matches are not authenticity verification.
- Local document-forensics findings are preliminary; the system does not validate signer certificates or detect every manipulation or AI-generated image.
- Bank-side verification and actual fund transfers are not integrated.
- The reminder scheduler creates in-app notifications only; it sends no email or SMS.
- Demo users, documents, access tokens, and database records must be synthetic and confined to a non-production environment.
