import 'dotenv/config';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { parseExtractedFdrFields } from '../utils/fdr-extraction.schema.js';
import { sarvamOcrService } from '../services/sarvam-ocr.service.js';

const pollIntervalMs = 3000;
const maxPolls = 40;
const terminalStatuses = new Set(['completed', 'partially_completed', 'failed', 'rejected']);

const makeSyntheticDocument = async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(
    [
      'SYNTHETIC TEST DOCUMENT - NOT A VALID FINANCIAL INSTRUMENT',
      'FDR Number: SYNTHETIC-FDR-001',
      'Bank: Example Test Bank',
      'Branch: Test Branch',
      'Deposit Amount: INR 12345.00',
      'Issue Date: 2026-01-01',
      'Maturity Date: 2027-01-01',
      'Institution: Synthetic Example Institute',
    ].join('\n'),
    { x: 48, y: 720, size: 12, font, lineHeight: 24 },
  );
  return Buffer.from(await pdf.save());
};

const runSmokeTest = async () => {
  if (process.env.SARVAM_OCR_LIVE_SMOKE !== 'true') {
    throw new Error('Set SARVAM_OCR_LIVE_SMOKE=true to enable the optional live smoke test.');
  }
  if (!process.env.SARVAM_API_KEY?.trim()) {
    throw new Error('SARVAM_API_KEY is required for the optional live smoke test.');
  }

  const document = await makeSyntheticDocument();
  const job = await sarvamOcrService.submitExtraction({
    document,
    fileName: 'synthetic-fdr-smoke-test.pdf',
    mimeType: 'application/pdf',
  });
  let status = 'queued';

  for (let poll = 0; poll < maxPolls; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const response = await sarvamOcrService.getJobStatus(job.jobId);
    status = response.status;
    if (terminalStatuses.has(status)) break;
  }

  if (!terminalStatuses.has(status)) {
    throw new Error('The live OCR smoke test reached its polling timeout.');
  }
  if (status === 'failed' || status === 'rejected') {
    throw new Error('Sarvam did not complete the synthetic OCR smoke test.');
  }

  const result = await sarvamOcrService.getJobResults(job.jobId);
  if (!parseExtractedFdrFields(result).success) {
    throw new Error('Sarvam returned an invalid response for the synthetic OCR smoke test.');
  }

  console.log(`Sarvam OCR live smoke test passed with terminal status "${status}".`);
};

try {
  await runSmokeTest();
} catch (error) {
  console.error(error.message || 'Sarvam OCR live smoke test failed.');
  process.exitCode = 1;
}
