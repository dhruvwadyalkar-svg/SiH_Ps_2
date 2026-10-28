import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculateFdrTrustScore,
  TRUST_SCORE_CONFIG,
} from '../services/fdr-trust-score.service.js';
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

