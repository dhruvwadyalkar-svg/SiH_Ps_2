import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import AuditLog from '../models/AuditLog.js';
import FDR from '../models/FDR.js';
import Institution from '../models/Institution.js';
import { readStoredDocument } from './document-storage.service.js';

export const STANDARD_VERIFICATION_CHECKLIST = [
  { id: 'branch_contact_verified', label: 'Branch contact details verified via official bank directory or domain' },
  { id: 'instrument_issuance_confirmed', label: 'Bank confirmed genuine issuance of instrument with recorded FDR number' },
  { id: 'depositor_name_matched', label: 'Depositor / institution name confirmed on bank records' },
  { id: 'amount_currency_confirmed', label: 'Principal deposit amount and currency confirmed' },
  { id: 'dates_matched', label: 'Issue date and maturity date match core banking system' },
  { id: 'written_confirmation_received', label: 'Official bank written response or confirmation letter received' },
];

export class BankVerificationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// SSRF and private destination check
export const isUntrustedNetworkDestination = (urlString) => {
  try {
    const url = new URL(urlString);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return true;
    }
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.corp') ||
      hostname.endsWith('.lan')
    ) {
      return true;
    }

    // Check for IPv4 loopback, private, link-local
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const ipMatch = hostname.match(ipv4Regex);
    if (ipMatch) {
      const [, o1, o2] = ipMatch.map(Number);
      if (o1 === 127) return true; // Loopback
      if (o1 === 10) return true; // 10.0.0.0/8
      if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16.0.0/12
      if (o1 === 192 && o2 === 168) return true; // 192.168.0.0/16
      if (o1 === 169 && o2 === 254) return true; // Link-local 169.254.0.0/16
      if (o1 === 0) return true;
    }

    // IPv6 loopback
    if (hostname === '::1' || hostname === '[::1]') return true;

    return false;
  } catch {
    return true;
  }
};

export const extractVerificationReference = (text) => {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim();

  // Pattern matches common reference queries: ref=..., fdr=..., receipt=..., id=...
  const queryMatch = clean.match(/(?:ref|fdr|receipt|id|cert|txn|no)=([A-Za-z0-9\-_/]+)/i);
  if (queryMatch) return queryMatch[1];

  // Try finding an alphanumeric reference code (e.g., FDR/2024/..., or 10-20 alphanumeric characters)
  const codeMatch = clean.match(/\b([A-Z0-9\-_/]{8,32})\b/);
  if (codeMatch && !clean.startsWith('http')) return codeMatch[1];

  return null;
};

export const scanQrCodeFromRgba = (rgbaBuffer, width, height) => {
  try {
    const clamped = new Uint8ClampedArray(rgbaBuffer);
    const code = jsQR(clamped, width, height);
    if (code && code.data) {
      const decodedText = code.data.trim();
      let candidateUrl = null;
      let isUntrusted = false;

      if (/^https?:\/\//i.test(decodedText)) {
        candidateUrl = decodedText;
        isUntrusted = isUntrustedNetworkDestination(candidateUrl);
      }

      return {
        detected: true,
        decodedText,
        extractedReference: extractVerificationReference(decodedText),
        candidateUrl,
        isUntrustedDestination: isUntrusted,
        location: code.location
          ? `topLeft: (${Math.round(code.location.topLeftCorner.x)}, ${Math.round(code.location.topLeftCorner.y)})`
          : null,
      };
    }
  } catch {
    // Ignore decode errors
  }
  return null;
};

export const scanDocumentForQrCode = async (buffer, mimeType) => {
  if (!buffer || buffer.length === 0) {
    return { detected: false };
  }

  // 1. PNG Image
  if (mimeType === 'image/png') {
    try {
      const png = PNG.sync.read(buffer);
      const result = scanQrCodeFromRgba(png.data, png.width, png.height);
      if (result) return { ...result, pageNumber: 1 };
    } catch {
      // Fall through
    }
  }

  // 2. JPEG Image
  if (mimeType === 'image/jpeg') {
    try {
      const rawImage = jpeg.decode(buffer, { useTArray: true });
      const result = scanQrCodeFromRgba(rawImage.data, rawImage.width, rawImage.height);
      if (result) return { ...result, pageNumber: 1 };
    } catch {
      // Fall through
    }
  }

  // 3. PDF Document
  if (mimeType === 'application/pdf') {
    try {
      const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
      const context = pdfDoc.context;
      const indirectObjects = context.enumerateIndirectObjects();

      let pageIndex = 1;
      for (const [ref, obj] of indirectObjects) {
        if (obj instanceof PDFRawStream) {
          const dict = obj.dict;
          const subtype = dict.get(PDFName.of('Subtype'));
          if (subtype === PDFName.of('Image')) {
            const filter = dict.get(PDFName.of('Filter'));
            const imageBytes = obj.contents;

            // Check if JPEG stream
            if (filter === PDFName.of('DCTDecode')) {
              try {
                const rawImage = jpeg.decode(imageBytes, { useTArray: true });
                const result = scanQrCodeFromRgba(rawImage.data, rawImage.width, rawImage.height);
                if (result) return { ...result, pageNumber: pageIndex };
              } catch {
                // Continue scanning next image
              }
            }
          }
        }
      }
    } catch {
      // PDF processing error
    }
  }

  return { detected: false };
};

export const generateBankVerificationEmailDraft = ({ fdr, institution, reviewer }) => {
  const fdrNumber = fdr.fdrNumber || 'UNKNOWN';
  const bankName = fdr.bankName || 'Issuing Bank';
  const branch = fdr.branch || 'Branch';
  const amount = fdr.amount
    ? `${fdr.currency || 'INR'} ${Number(fdr.amount).toLocaleString('en-IN')}`
    : 'As stated in receipt';
  const issueDateStr = fdr.issueDate
    ? new Date(fdr.issueDate).toISOString().slice(0, 10)
    : 'Not specified';
  const maturityDateStr = fdr.maturityDate
    ? new Date(fdr.maturityDate).toISOString().slice(0, 10)
    : 'Not specified';
  const instName = institution?.name || 'Institution';
  const instCode = institution?.institutionCode || 'N/A';
  const reviewerName = reviewer?.fullName || 'Authorized Verification Officer';

  const subject = `AICTE Security Deposit Verification: FDR Ref ${fdrNumber} · ${instName}`;
  const body = `To: The Branch Manager / Authorized Verification Officer
${bankName}, ${branch} Branch

Subject: Official Verification Request for Fixed Deposit Receipt (FDR No: ${fdrNumber})

Dear Sir / Madam,

This is an administrative inquiry regarding Fixed Deposit Receipt (FDR) details submitted to the AICTE Security Deposit Portal by ${instName}.

Instrument Details for Verification:
- Fixed Deposit Receipt No.: ${fdrNumber}
- Depositor / Institution Name: ${instName} (Institution Code: ${instCode})
- Issuing Bank: ${bankName}
- Branch: ${branch}
- Principal Deposit Amount: ${amount}
- Date of Issue: ${issueDateStr}
- Date of Maturity: ${maturityDateStr}

We request your branch to confirm:
1. Whether the referenced Fixed Deposit Receipt was genuinely issued by your branch.
2. Whether the deposit is currently active, unencumbered, and held in favor of or lien-marked for AICTE security deposit obligations as applicable.
3. Whether the principal amount and maturity date recorded above match the core banking record.

Kindly reply to this inquiry from an official bank domain email address confirming the validity of the instrument.

Sincerely,
${reviewerName}
Administrative Review & Verification Team
AICTE Security Deposit Management Portal`;

  return {
    subject,
    recipientSuggested: `branch.manager@${bankName.toLowerCase().replace(/[^a-z0-9]/g, '')}.co.in`,
    body,
    notice: 'Pre-drafted email template. Review before sending externally through authorized institutional or official mail channels.',
  };
};

export const inspectFdrDocumentForQr = async ({ fdr }) => {
  const storageRef = fdr.documentMetadata?.storageRef;
  const mimeType = fdr.documentMetadata?.mimeType;
  if (!storageRef || !mimeType) {
    return { detected: false };
  }

  let buffer;
  try {
    buffer = await readStoredDocument(storageRef);
  } catch {
    return { detected: false };
  }

  const qrResult = await scanDocumentForQrCode(buffer, mimeType);
  return {
    ...qrResult,
    inspectedAt: new Date(),
  };
};

export const bankVerificationService = {
  STANDARD_VERIFICATION_CHECKLIST,
  isUntrustedNetworkDestination,
  extractVerificationReference,
  scanQrCodeFromRgba,
  scanDocumentForQrCode,
  generateBankVerificationEmailDraft,
  inspectFdrDocumentForQr,
};

export default bankVerificationService;

