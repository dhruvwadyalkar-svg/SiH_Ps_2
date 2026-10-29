import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculateFdrTrustScore,
  TRUST_SCORE_CONFIG,
} from '../services/fdr-trust-score.service.js';
import {
  calculateFdrRiskScore,
  DEFAULT_RISK_SCORING_RULES,
  mapRiskScoreToLevel,
} from '../services/fdr-risk-score.service.js';
import {
  STANDARD_VERIFICATION_CHECKLIST,
  generateBankVerificationEmailDraft,
  isUntrustedNetworkDestination,
} from '../services/bank-verification.service.js';
import {
  normalizeBankName,
  normalizeFdrNumber,
} from '../services/duplicate-detection.service.js';
import {
  SUPPORTED_OCR_LANGUAGES,
} from '../services/sarvam-ocr.service.js';

describe('USP Feature 1 — Explainable FDR Trust Score', () => {
  it('weights and thresholds conform to specification', () => {
    const weights = TRUST_SCORE_CONFIG.weights;
    const totalWeight = Object.values(weights).reduce((sum, w) => sum + w, 0);
    assert.equal(totalWeight, 100, 'Sum of signal weights must equal 100');
    assert.equal(TRUST_SCORE_CONFIG.thresholds.insufficientEvidenceCoverage, 40);
    assert.equal(TRUST_SCORE_CONFIG.thresholds.highRiskScore, 50);
    assert.equal(TRUST_SCORE_CONFIG.thresholds.mediumRiskScore, 80);
  });

  it('marks unassessed when OCR, forensics, duplicate checks have not run', () => {
    const fdr = {
      fdrNumber: 'FDR-2026-001',
      bankName: 'State Bank of India',
      amount: 1000000,
      issueDate: new Date('2026-01-01'),
      maturityDate: new Date('2031-01-01'),
      ocrResult: { status: 'not_started' },
    };

    const result = calculateFdrTrustScore({ fdr });
    assert.equal(result.category, 'insufficient_evidence');
    assert.equal(result.version, '1.0.0');
    assert(result.evidenceCoverage < 40);
    assert(result.unavailableChecks.some((c) => c.toLowerCase().includes('interest')));
  });

  it('computes positive trust score with completed consistent signals', () => {
    const fdr = {
      fdrNumber: 'FDR-2026-001',
      bankName: 'State Bank of India',
      branch: 'Main Branch New Delhi',
      amount: 1500000,
      currency: 'INR',
      issueDate: new Date('2026-01-01'),
      maturityDate: new Date('2034-01-01'),
      institution: { name: 'Apex Engineering Institute' },
      ocrResult: {
        status: 'completed',
        comparisonResults: {
          fdr_number: { status: 'match' },
          bank_name: { status: 'match' },
          deposit_amount: { status: 'match' },
          issue_date: { status: 'match' },
          maturity_date: { status: 'match' },
          institution_name: { status: 'match' },
        },
      },
    };

    const forensicAnalysis = {
      overallStatus: 'no_signals_detected',
      fileChecksumStatus: 'match',
      findings: [],
    };

    const duplicateResult = {
      status: 'no_candidate_found',
      matches: [],
    };

    const bankVerification = {
      status: 'verified',
      verificationMethod: 'written_bank_confirmation',
      completedItems: [
        'branch_contact_verified',
        'instrument_issuance_confirmed',
        'depositor_name_matched',
        'amount_currency_confirmed',
        'dates_matched',
        'written_confirmation_received',
      ],
    };

    const result = calculateFdrTrustScore({
      fdr,
      forensicAnalysis,
      duplicateResult,
      bankVerification,
    });

    assert(result.score >= 80, `Expected high trust score, got ${result.score}`);
    assert.equal(result.category, 'low_observed_risk');
    assert(result.evidenceCoverage >= 80, `Expected high evidence coverage, got ${result.evidenceCoverage}`);
    assert(result.positiveFindings.length > 0);
    assert.equal(result.riskFindings.length, 0);
  });

  it('flags high risk and reports priority category when critical mismatches occur', () => {
    const fdr = {
      fdrNumber: 'FDR-BAD-999',
      bankName: 'Dummy Bank',
      amount: 500000,
      currency: 'INR',
      issueDate: new Date('2026-06-01'),
      maturityDate: new Date('2025-01-01'), // Impossible date: maturity earlier than issue
      ocrResult: {
        status: 'completed',
        comparisonResults: {
          fdr_number: { status: 'mismatch' },
          deposit_amount: { status: 'mismatch' },
        },
      },
    };

    const forensicAnalysis = {
      overallStatus: 'signals_detected',
      fileChecksumStatus: 'mismatch',
      findings: [{ level: 'critical', description: 'Byte mismatch detected' }],
    };

    const duplicateResult = {
      status: 'duplicate_found',
      matches: [{ matchLevel: 'critical', reason: 'Exact SHA-256 match found in another institution' }],
    };

    const result = calculateFdrTrustScore({
      fdr,
      forensicAnalysis,
      duplicateResult,
    });

    assert(result.score < 50, `Expected low score, got ${result.score}`);
    assert.equal(result.category, 'high_review_priority');
    assert(result.riskFindings.length >= 3);
  });
});

describe('USP Feature 2 — Bank Verification and QR / Reference Workflow', () => {
  it('enforces SSRF protection against private, loopback, and untrusted URLs', () => {
    assert.equal(isUntrustedNetworkDestination('http://localhost:3000'), true);
    assert.equal(isUntrustedNetworkDestination('http://127.0.0.1:8080/verify'), true);
    assert.equal(isUntrustedNetworkDestination('http://10.0.0.5/api/bank'), true);
    assert.equal(isUntrustedNetworkDestination('http://172.16.1.1/test'), true);
    assert.equal(isUntrustedNetworkDestination('http://192.168.1.100/verify'), true);
    assert.equal(isUntrustedNetworkDestination('http://169.254.169.254/latest/meta-data'), true);
    assert.equal(isUntrustedNetworkDestination('http://internal.bank.corp'), true);
    assert.equal(isUntrustedNetworkDestination('ftp://bank.example.com'), true);

    // Legitimate public domain URLs are permitted
    assert.equal(isUntrustedNetworkDestination('https://sbi.co.in/verify?ref=123'), false);
    assert.equal(isUntrustedNetworkDestination('https://pnbindia.in/deposit-verification'), false);
  });

  it('standard checklist contains 6 required verification items', () => {
    assert.equal(STANDARD_VERIFICATION_CHECKLIST.length, 6);
    const itemIds = STANDARD_VERIFICATION_CHECKLIST.map((i) => i.id);
    assert(itemIds.includes('branch_contact_verified'));
    assert(itemIds.includes('instrument_issuance_confirmed'));
    assert(itemIds.includes('depositor_name_matched'));
    assert(itemIds.includes('amount_currency_confirmed'));
    assert(itemIds.includes('dates_matched'));
    assert(itemIds.includes('written_confirmation_received'));
  });

  it('generates an official copyable bank inquiry draft', () => {
    const fdr = {
      fdrNumber: 'FDR-SBI-7721',
      bankName: 'State Bank of India',
      branch: 'Connaught Place Branch, New Delhi',
      amount: 2500000,
      currency: 'INR',
      issueDate: new Date('2026-03-01'),
      maturityDate: new Date('2036-03-01'),
    };
    const institution = {
      name: 'Delhi Institute of Engineering',
      institutionCode: 'DEL-ENG-001',
    };

    const draft = generateBankVerificationEmailDraft({ fdr, institution });
    assert(draft.subject.includes('FDR-SBI-7721'));
    assert(draft.body.includes('Delhi Institute of Engineering'));
    assert(draft.body.includes('DEL-ENG-001'));
    assert(draft.body.includes('25,00,000') || draft.body.includes('2500000'));
    assert(draft.body.includes('AICTE'));
  });
});

describe('USP Feature 3 — Normalized Duplicate & Fraud Collateral Detector', () => {
  it('normalizes FDR numbers properly', () => {
    assert.equal(normalizeFdrNumber('fdr-123-456'), 'FDR123456');
    assert.equal(normalizeFdrNumber(' SBI / 9988 / 2026 '), 'SBI99882026');
    assert.equal(normalizeFdrNumber(''), '');
    assert.equal(normalizeFdrNumber(null), '');
  });

  it('normalizes bank names properly', () => {
    assert.equal(normalizeBankName('State Bank of India (SBI)'), 'statebankofindiasbi');
    assert.equal(normalizeBankName('Punjab National Bank - PNB'), 'punjabnationalbankpnb');
    assert.equal(normalizeBankName(''), '');
    assert.equal(normalizeBankName(null), '');
  });
});

describe('USP Feature 5 — Multilingual Indic OCR (23 Languages)', () => {
  it('supports all 23 official Indic and English languages according to 8th Schedule', () => {
    const langCodes = Object.keys(SUPPORTED_OCR_LANGUAGES);
    assert.equal(langCodes.length, 23, 'Must support exactly 23 languages');

    const expectedLangs = [
      'en-IN', 'hi-IN', 'bn-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'or-IN',
      'pa-IN', 'ta-IN', 'te-IN', 'ur-IN', 'as-IN', 'bodo-IN', 'doi-IN', 'ks-IN',
      'kok-IN', 'mai-IN', 'mni-IN', 'ne-IN', 'sa-IN', 'sat-IN', 'sd-IN',
    ];

    expectedLangs.forEach((code) => {
      assert(SUPPORTED_OCR_LANGUAGES[code], `Language code ${code} should be supported`);
    });
  });
});

describe('USP Feature 6 — Explainable FDR Risk Scoring Engine', () => {
  it('weights and risk level thresholds conform to specification', () => {
    const { weights, thresholds } = DEFAULT_RISK_SCORING_RULES;
    assert.equal(weights.exactIdentifierCollision, 40);
    assert.equal(weights.amountMismatch, 25);
    assert.equal(weights.maturityDateMismatch, 20);
    assert.equal(weights.unexplainedVersionChange, 20);
    assert.equal(weights.missingRequiredInfo, 10);
    assert.equal(weights.lowOcrConfidenceCritical, 10);
    assert.equal(weights.impossibleDateSequence, 25);
    assert.equal(weights.ifscFormatInvalid, 10);

    assert.equal(mapRiskScoreToLevel(0), 'low');
    assert.equal(mapRiskScoreToLevel(24), 'low');
    assert.equal(mapRiskScoreToLevel(25), 'medium');
    assert.equal(mapRiskScoreToLevel(49), 'medium');
    assert.equal(mapRiskScoreToLevel(50), 'high');
    assert.equal(mapRiskScoreToLevel(74), 'high');
    assert.equal(mapRiskScoreToLevel(75), 'critical');
    assert.equal(mapRiskScoreToLevel(100), 'critical');
  });

  it('computes low risk for clean conforming FDR submission', () => {
    const fdr = {
      fdrNumber: 'FDR-2026-CLEAN',
      bankName: 'State Bank of India',
      branch: 'Parliament Street, New Delhi',
      amount: 1500000,
      currency: 'INR',
      issueDate: new Date('2026-01-01'),
      maturityDate: new Date('2036-01-01'),
      ifscCode: 'SBIN0000691',
      documentMetadata: { fileName: 'fdr_scan.pdf', storageRef: 'some_ref' },
      ocrResult: { status: 'completed', extractedData: {}, comparisonResults: {} },
    };

    const risk = calculateFdrRiskScore({ fdr });
    assert.equal(risk.score, 0);
    assert.equal(risk.level, 'low');
    assert.equal(risk.findings.length, 0);
    assert(risk.summary.includes('LOW'));
  });

  it('flags exact duplicate collision (+40 pts) and assigns Medium risk', () => {
    const fdr = {
      fdrNumber: 'FDR-2026-DUP',
      bankName: 'Canara Bank',
      branch: 'MG Road, Bangalore',
      amount: 2500000,
      currency: 'INR',
      issueDate: new Date('2026-01-01'),
      maturityDate: new Date('2036-01-01'),
      ifscCode: 'CNRB0000123',
      documentMetadata: { fileName: 'fdr.pdf', storageRef: 'some_ref' },
    };
    const duplicateResult = {
      status: 'exact_document_match',
      matches: [{ fdrNumber: 'FDR-2026-DUP', isAuthorizedReplacement: false }],
    };

    const risk = calculateFdrRiskScore({ fdr, duplicateResult });
    assert.equal(risk.score, 40);
    assert.equal(risk.level, 'medium');
    assert.equal(risk.findings.length, 1);
    assert.equal(risk.findings[0].id, 'exact_identifier_collision');
    assert.equal(risk.findings[0].points, 40);
  });

  it('flags cumulative discrepancies: amount mismatch (+25) and impossible chronology (+25) as High risk (50)', () => {
    const fdr = {
      fdrNumber: 'FDR-2026-ERR',
      bankName: 'Bank of Baroda',
      branch: 'Alkapuri, Vadodara',
      amount: 5000000,
      currency: 'INR',
      issueDate: new Date('2026-05-01'),
      maturityDate: new Date('2026-01-01'), // Impossible: maturity before issue
      ifscCode: 'BARB0ALKAPU',
      documentMetadata: { fileName: 'fdr.pdf', storageRef: 'ref' },
      ocrResult: {
        status: 'completed',
        extractedData: { deposit_amount: 3500000 },
        comparisonResults: {
          deposit_amount: { status: 'mismatch' },
        },
      },
    };

    const risk = calculateFdrRiskScore({ fdr });
    assert.equal(risk.score, 50);
    assert.equal(risk.level, 'high');
    assert(risk.findings.some((f) => f.id === 'deposit_amount_mismatch'));
    assert(risk.findings.some((f) => f.id === 'impossible_date_sequence'));
  });

  it('detects unexplained modification from previously stored version (+20 pts)', () => {
    const original = {
      fdrNumber: 'FDR-ORIG-001',
      bankName: 'State Bank of India',
      amount: 1000000,
    };
    const renewed = {
      fdrNumber: 'FDR-RENEW-002', // changed
      bankName: 'State Bank of India',
      branch: 'Main Branch',
      amount: 800000, // changed
      currency: 'INR',
      issueDate: new Date('2026-01-01'),
      maturityDate: new Date('2031-01-01'),
      ifscCode: 'SBIN0000691',
      documentMetadata: { fileName: 'renewed.pdf', storageRef: 'ref' },
      ocrResult: { status: 'not_started' },
    };

    const risk = calculateFdrRiskScore({ fdr: renewed, previousFdr: original });
    assert(risk.score >= 20);
    assert(risk.findings.some((f) => f.id === 'unexplained_version_change'));
    const finding = risk.findings.find((f) => f.id === 'unexplained_version_change');
    assert(finding.evidence.includes('Principal'));
    assert(finding.evidence.includes('FDR Number'));
  });

  it('detects invalid IFSC code structure (+10 pts)', () => {
    const fdr = {
      fdrNumber: 'FDR-2026-IFSC',
      bankName: 'Punjab National Bank',
      branch: 'Connaught Place',
      amount: 1000000,
      currency: 'INR',
      issueDate: new Date('2026-01-01'),
      maturityDate: new Date('2036-01-01'),
      ifscCode: 'INVALID_IFSC_123', // Malformed IFSC
      documentMetadata: { fileName: 'fdr.pdf', storageRef: 'ref' },
      ocrResult: { status: 'not_started' },
    };

    const risk = calculateFdrRiskScore({ fdr });
    assert(risk.findings.some((f) => f.id === 'ifsc_format_invalid'));
  });
});

