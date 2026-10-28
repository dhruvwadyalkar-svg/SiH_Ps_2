export const TRUST_SCORE_CONFIG = {
  version: '1.0.0',
  thresholds: {
    insufficientEvidenceCoverage: 40,
    highRiskScore: 50,
    mediumRiskScore: 80,
  },
  weights: {
    ocrConsistency: 25,
    bankInstrumentData: 15,
    dateTenureValidation: 15,
    duplicateAndReuse: 20,
    forensicSignals: 15,
    bankVerification: 10,
  },
};

export const calculateFdrTrustScore = ({
  fdr,
  forensicAnalysis = null,
  duplicateResult = null,
  bankVerification = null,
  trigger = 'assessment_update',
}) => {
  const signals = [];
  const positiveFindings = [];
  const riskFindings = [];
  const missingData = [];
  const unavailableChecks = [];

  const ocr = fdr.ocrResult || {};
  const ocrCompleted = ['completed', 'partially_completed'].includes(ocr.status);
  const comparisons = ocr.comparisonResults || {};
  const extracted = ocr.extractedData || {};

  // 1. OCR Consistency (max 25 pts)
  const ocrFields = [
    { key: 'fdr_number', label: 'FDR number consistency', weight: 5 },
    { key: 'bank_name', label: 'Bank name consistency', weight: 5 },
    { key: 'deposit_amount', label: 'Deposit amount consistency', weight: 5 },
    { key: 'issue_date', label: 'Issue date consistency', weight: 4 },
    { key: 'maturity_date', label: 'Maturity date consistency', weight: 4 },
    { key: 'institution_name', label: 'Institution/depositor name consistency', weight: 2 },
  ];

  if (!ocrCompleted) {
    ocrFields.forEach(({ key, label, weight }) => {
      signals.push({
        category: 'ocr_consistency',
        label,
        status: ocr.status === 'not_started' ? 'not_assessed' : 'missing_data',
        score: 0,
        maxScore: weight,
        impact: 'neutral',
        details: ocr.status === 'not_started'
          ? 'OCR extraction has not yet been executed.'
          : `OCR extraction is in state: ${ocr.status}.`,
        sourceReference: 'ocrResult.status',
      });
    });
    if (ocr.status === 'not_started') {
      unavailableChecks.push('OCR extraction not requested or completed.');
    } else {
      missingData.push(`OCR extraction in progress or failed (${ocr.status}).`);
    }
  } else {
    ocrFields.forEach(({ key, label, weight }) => {
      const comp = comparisons[key] || {};
      const status = comp.status;
      if (status === 'match') {
        signals.push({
          category: 'ocr_consistency',
          label,
          status: 'passed',
          score: weight,
          maxScore: weight,
          impact: 'positive',
          details: `OCR extracted value matches institution-submitted value for ${key}.`,
          sourceReference: `ocrResult.comparisonResults.${key}`,
        });
        positiveFindings.push(`${label}: match verified.`);
      } else if (status === 'mismatch') {
        signals.push({
          category: 'ocr_consistency',
          label,
          status: 'failed',
          score: 0,
          maxScore: weight,
          impact: 'negative',
          details: `Mismatch observed between submitted and OCR extracted value for ${key}.`,
          sourceReference: `ocrResult.comparisonResults.${key}`,
        });
        riskFindings.push(`${label}: value mismatch detected.`);
      } else if (status === 'missing_or_unreadable') {
        signals.push({
          category: 'ocr_consistency',
          label,
          status: 'missing_data',
          score: 0,
          maxScore: weight,
          impact: 'neutral',
          details: `Field ${key} was unreadable or absent from the uploaded document.`,
          sourceReference: `ocrResult.comparisonResults.${key}`,
        });
        missingData.push(`${label}: missing or unreadable in document.`);
      } else {
        signals.push({
          category: 'ocr_consistency',
          label,
          status: 'not_assessed',
          score: 0,
          maxScore: weight,
          impact: 'neutral',
          details: `Field ${key} was not comparable.`,
          sourceReference: `ocrResult.comparisonResults.${key}`,
        });
      }
    });
  }

  // 2. Bank and Instrument Data (max 15 pts)
  // Bank name and branch validity (10 pts)
  const bankName = (fdr.bankName || '').trim();
  const branch = (fdr.branch || '').trim();
  if (bankName.length >= 3 && branch.length >= 2) {
    signals.push({
      category: 'bank_instrument_data',
      label: 'Bank and branch name structure',
      status: 'passed',
      score: 10,
      maxScore: 10,
      impact: 'positive',
      details: `Bank (${bankName}) and branch (${branch}) provide complete identifier structure.`,
      sourceReference: 'fdr.bankName',
    });
    positiveFindings.push('Bank and branch identifier structure is complete.');
  } else {
    signals.push({
      category: 'bank_instrument_data',
      label: 'Bank and branch name structure',
      status: 'warning',
      score: 0,
      maxScore: 10,
      impact: 'negative',
      details: 'Bank name or branch is unusually short or incomplete.',
      sourceReference: 'fdr.bankName',
    });
    riskFindings.push('Bank or branch information appears incomplete.');
  }

  // IFSC format and consistency (5 pts) - check if provided in extracted or details
  const ifscCandidate = extracted.ifsc_code || extracted.branch_ifsc || fdr.branchIfsc || null;
  if (ifscCandidate) {
    const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
    if (ifscRegex.test(ifscCandidate.trim().toUpperCase())) {
      signals.push({
        category: 'bank_instrument_data',
        label: 'IFSC format validation',
        status: 'passed',
        score: 5,
        maxScore: 5,
        impact: 'positive',
        details: `Instrument IFSC (${ifscCandidate.toUpperCase()}) conforms to standard RBI format.`,
        sourceReference: 'extracted.ifsc_code',
      });
      positiveFindings.push(`Valid RBI IFSC format: ${ifscCandidate.toUpperCase()}.`);
    } else {
      signals.push({
        category: 'bank_instrument_data',
        label: 'IFSC format validation',
        status: 'failed',
        score: 0,
        maxScore: 5,
        impact: 'negative',
        details: `IFSC "${ifscCandidate}" does not match standard 11-character RBI format.`,
        sourceReference: 'extracted.ifsc_code',
      });
      riskFindings.push(`Invalid IFSC format: ${ifscCandidate}.`);
    }
  } else {
    signals.push({
      category: 'bank_instrument_data',
      label: 'IFSC format validation',
      status: 'not_assessed',
      score: 0,
      maxScore: 5,
      impact: 'neutral',
      details: 'No IFSC provided on the instrument or record to evaluate.',
      sourceReference: 'fdr.branchIfsc',
    });
    unavailableChecks.push('IFSC code not provided on instrument.');
  }

  // External reference directory check (strictly unassessed)
  signals.push({
    category: 'bank_instrument_data',
    label: 'Authorized bank/IFSC directory check',
    status: 'not_assessed',
    score: 0,
    maxScore: 0,
    impact: 'neutral',
    details: 'External bank and IFSC reference directory integration is not configured.',
    sourceReference: 'config.bankDirectory',
  });
  unavailableChecks.push('Authorized bank/IFSC directory not configured.');

  // 3. Date and Tenure Validation (max 15 pts)
  const issueDate = fdr.issueDate ? new Date(fdr.issueDate) : null;
  const maturityDate = fdr.maturityDate ? new Date(fdr.maturityDate) : null;
  const now = new Date();

  let hasImpossibleDate = false;
  if (!issueDate || !maturityDate || Number.isNaN(issueDate.getTime()) || Number.isNaN(maturityDate.getTime())) {
    signals.push({
      category: 'date_tenure',
      label: 'Instrument date consistency',
      status: 'missing_data',
      score: 0,
      maxScore: 10,
      impact: 'neutral',
      details: 'Issue date or maturity date is missing or invalid.',
      sourceReference: 'fdr.issueDate',
    });
    missingData.push('Issue date or maturity date is missing.');
  } else if (maturityDate <= issueDate) {
    hasImpossibleDate = true;
    signals.push({
      category: 'date_tenure',
      label: 'Instrument date consistency',
      status: 'failed',
      score: 0,
      maxScore: 10,
      impact: 'negative',
      details: 'Impossible date: maturity date is on or before the issue date.',
      sourceReference: 'fdr.maturityDate',
    });
    riskFindings.push('Impossible dates: maturity date does not succeed issue date.');
  } else {
    // Check if issue date is in the far future (> 1 day ahead)
    const futureToleranceMs = 24 * 60 * 60 * 1000;
    if (issueDate.getTime() > now.getTime() + futureToleranceMs) {
      hasImpossibleDate = true;
      signals.push({
        category: 'date_tenure',
        label: 'Instrument date consistency',
        status: 'failed',
        score: 0,
        maxScore: 10,
        impact: 'negative',
        details: 'Issue date is recorded in the future.',
        sourceReference: 'fdr.issueDate',
      });
      riskFindings.push('Issue date recorded in the future.');
    } else {
      signals.push({
        category: 'date_tenure',
        label: 'Instrument date consistency',
        status: 'passed',
        score: 10,
        maxScore: 10,
        impact: 'positive',
        details: 'Issue date precedes maturity date and dates are chronologically plausible.',
        sourceReference: 'fdr.issueDate',
      });
      positiveFindings.push('Date chronology is consistent.');
    }
  }

  // Tenure reasonableness check (5 pts)
  if (issueDate && maturityDate && maturityDate > issueDate) {
    const tenureDays = Math.round((maturityDate - issueDate) / (24 * 60 * 60 * 1000));
    // Standard AICTE security deposit tenure: typically between 30 days and 12 years (4380 days)
    if (tenureDays >= 30 && tenureDays <= 4380) {
      signals.push({
        category: 'date_tenure',
        label: 'Deposit tenure reasonableness',
        status: 'passed',
        score: 5,
        maxScore: 5,
        impact: 'positive',
        details: `Calculated deposit tenure of ${tenureDays} days (~${Math.round(tenureDays / 365 * 10) / 10} years) is within standard regulatory tenure range.`,
        sourceReference: 'fdr.maturityDate',
      });
      positiveFindings.push(`Tenure of ${tenureDays} days is consistent with typical security deposit terms.`);
    } else {
      signals.push({
        category: 'date_tenure',
        label: 'Deposit tenure reasonableness',
        status: 'warning',
        score: 2,
        maxScore: 5,
        impact: 'negative',
        details: `Calculated tenure of ${tenureDays} days is unusually short (<30 days) or long (>12 years).`,
        sourceReference: 'fdr.maturityDate',
      });
      riskFindings.push(`Unusual deposit tenure observed (${tenureDays} days).`);
    }
  } else {
    signals.push({
      category: 'date_tenure',
      label: 'Deposit tenure reasonableness',
      status: 'not_assessed',
      score: 0,
      maxScore: 5,
      impact: 'neutral',
      details: 'Tenure could not be calculated due to missing or invalid dates.',
      sourceReference: 'fdr.maturityDate',
    });
  }

  // Interest rate reasonableness (strictly not assessed as required)
  signals.push({
    category: 'date_tenure',
    label: 'Interest rate reasonableness',
    status: 'not_assessed',
    score: 0,
    maxScore: 0,
    impact: 'neutral',
    details: 'Interest-rate reasonableness check not assessed: reliable, dated, bank/product-specific reference rate data is not configured.',
    sourceReference: 'config.referenceRates',
  });
  unavailableChecks.push('Interest-rate reasonableness check not assessed (reference rate data unavailable).');

  // 4. Duplicate and Reuse Signals (max 20 pts)
  const dup = duplicateResult || fdr.duplicateCheck || {};
  const duplicateStatus = dup.status || 'no_candidate_found';
  const hasConfirmedDuplicate = dup.resolution?.status === 'confirmed_duplicate';
  const isLegitReplacement = dup.resolution?.status === 'legitimate_renewal_replacement';

  // Checksum matching (10 pts)
  if (duplicateStatus === 'exact_document_match' && !isLegitReplacement) {
    signals.push({
      category: 'duplicate_reuse',
      label: 'Document checksum uniqueness',
      status: 'failed',
      score: 0,
      maxScore: 10,
      impact: 'negative',
      details: 'Identical SHA-256 document checksum matched another existing instrument in the repository.',
      sourceReference: 'duplicateCheck.matches',
    });
    riskFindings.push('Exact document checksum match with another instrument.');
  } else {
    signals.push({
      category: 'duplicate_reuse',
      label: 'Document checksum uniqueness',
      status: 'passed',
      score: 10,
      maxScore: 10,
      impact: 'positive',
      details: isLegitReplacement
        ? 'Document match verified as legitimate authorized replacement.'
        : 'Document checksum is unique across the register.',
      sourceReference: 'documentMetadata.checksum',
    });
    positiveFindings.push('Document checksum uniqueness verified.');
  }

  // Instrument reference matching (5 pts)
  if (duplicateStatus === 'same_instrument_reference' && !isLegitReplacement) {
    signals.push({
      category: 'duplicate_reuse',
      label: 'Instrument reference uniqueness',
      status: 'failed',
      score: 0,
      maxScore: 5,
      impact: 'negative',
      details: 'Same normalized FDR number and bank detected in multiple submissions.',
      sourceReference: 'duplicateCheck.matches',
    });
    riskFindings.push('Matching normalized FDR number and bank found in another submission.');
  } else {
    signals.push({
      category: 'duplicate_reuse',
      label: 'Instrument reference uniqueness',
      status: 'passed',
      score: 5,
      maxScore: 5,
      impact: 'positive',
      details: 'Normalized FDR number and issuing bank are distinct in the register.',
      sourceReference: 'fdr.fdrNumber',
    });
    positiveFindings.push('Instrument reference uniqueness confirmed.');
  }

  // Metadata similarity (5 pts)
  if (duplicateStatus === 'probable_metadata_duplicate' && !isLegitReplacement) {
    signals.push({
      category: 'duplicate_reuse',
      label: 'Deposit metadata pattern uniqueness',
      status: 'warning',
      score: 2,
      maxScore: 5,
      impact: 'negative',
      details: 'High similarity in amount, bank, and date parameters with another instrument.',
      sourceReference: 'duplicateCheck.matches',
    });
    riskFindings.push('Probable metadata duplicate flagged for administrative review.');
  } else {
    signals.push({
      category: 'duplicate_reuse',
      label: 'Deposit metadata pattern uniqueness',
      status: 'passed',
      score: 5,
      maxScore: 5,
      impact: 'positive',
      details: 'No suspicious duplicate metadata patterns detected.',
      sourceReference: 'duplicateCheck.status',
    });
  }

  // 5. Preliminary Forensic Signals (max 15 pts)
  const forensics = forensicAnalysis || null;
  const hasStorageDoc = Boolean(fdr.documentMetadata?.storageRef);
  const uploadChecksum = fdr.documentMetadata?.checksum;

  // Stored file byte integrity (7 pts)
  if (!hasStorageDoc) {
    signals.push({
      category: 'forensic_signals',
      label: 'Stored document integrity check',
      status: 'missing_data',
      score: 0,
      maxScore: 7,
      impact: 'neutral',
      details: 'No supporting document file is attached to this instrument.',
      sourceReference: 'fdr.documentMetadata',
    });
    missingData.push('Supporting document file is missing.');
  } else if (!uploadChecksum) {
    signals.push({
      category: 'forensic_signals',
      label: 'Stored document integrity check',
      status: 'warning',
      score: 2,
      maxScore: 7,
      impact: 'neutral',
      details: 'Document upload checksum was not recorded at upload time.',
      sourceReference: 'fdr.documentMetadata.checksum',
    });
    unavailableChecks.push('Upload checksum not recorded.');
  } else if (forensics?.status === 'integrity_check_failed') {
    signals.push({
      category: 'forensic_signals',
      label: 'Stored document integrity check',
      status: 'failed',
      score: 0,
      maxScore: 7,
      impact: 'negative',
      details: 'Stored document bytes do not match the SHA-256 checksum recorded at upload time.',
      sourceReference: 'ForensicAnalysis.checksum',
    });
    riskFindings.push('Critical: Stored document byte integrity check failed (checksum mismatch).');
  } else {
    signals.push({
      category: 'forensic_signals',
      label: 'Stored document integrity check',
      status: 'passed',
      score: 7,
      maxScore: 7,
      impact: 'positive',
      details: 'Stored file byte integrity verified against upload checksum.',
      sourceReference: 'fdr.documentMetadata.checksum',
    });
    positiveFindings.push('File byte integrity verified since upload.');
  }

  // Forensic findings (8 pts)
  if (!forensics) {
    signals.push({
      category: 'forensic_signals',
      label: 'Preliminary document structure analysis',
      status: 'not_assessed',
      score: 0,
      maxScore: 8,
      impact: 'neutral',
      details: 'Document forensic analysis has not yet been executed.',
      sourceReference: 'latestForensicAnalysis',
    });
    unavailableChecks.push('Document forensic analysis not yet executed.');
  } else if (forensics.status === 'analysis_failed') {
    signals.push({
      category: 'forensic_signals',
      label: 'Preliminary document structure analysis',
      status: 'failed',
      score: 0,
      maxScore: 8,
      impact: 'negative',
      details: 'Forensic inspection failed to safely parse the document structure.',
      sourceReference: 'ForensicAnalysis.status',
    });
    riskFindings.push('Forensic document structure parser failed.');
  } else {
    const highFindings = (forensics.findings || []).filter((f) => f.severity === 'high');
    const mediumFindings = (forensics.findings || []).filter((f) => f.severity === 'medium');

    if (highFindings.length > 0) {
      signals.push({
        category: 'forensic_signals',
        label: 'Preliminary document structure analysis',
        status: 'failed',
        score: 0,
        maxScore: 8,
        impact: 'negative',
        details: `High-severity structural finding detected: ${highFindings[0].explanation}`,
        sourceReference: `ForensicAnalysis.findings.${highFindings[0].code}`,
      });
      riskFindings.push(`Forensic high-severity finding: ${highFindings[0].explanation}`);
    } else if (mediumFindings.length > 0) {
      signals.push({
        category: 'forensic_signals',
        label: 'Preliminary document structure analysis',
        status: 'warning',
        score: 4,
        maxScore: 8,
        impact: 'negative',
        details: `Medium-severity finding: ${mediumFindings[0].explanation}`,
        sourceReference: `ForensicAnalysis.findings.${mediumFindings[0].code}`,
      });
      riskFindings.push(`Forensic finding: ${mediumFindings[0].explanation}`);
    } else {
      signals.push({
        category: 'forensic_signals',
        label: 'Preliminary document structure analysis',
        status: 'passed',
        score: 8,
        maxScore: 8,
        impact: 'positive',
        details: 'No anomalous structural or metadata markers detected in preliminary analysis.',
        sourceReference: 'ForensicAnalysis.status',
      });
      positiveFindings.push('Preliminary document structure analysis completed without anomalies.');
    }
  }

  // 6. Bank Verification (max 10 pts)
  const bv = bankVerification || fdr.bankVerification || {};
  const bvStatus = bv.status || 'pending';

  if (bvStatus === 'verified_with_bank') {
    signals.push({
      category: 'bank_verification',
      label: 'Direct bank confirmation',
      status: 'passed',
      score: 10,
      maxScore: 10,
      impact: 'positive',
      details: `Instrument verified directly with bank. Source: ${bv.manualVerification?.evidenceSource || 'Authorized bank response'}.`,
      sourceReference: 'bankVerification.status',
    });
    positiveFindings.push('Instrument confirmed directly with the issuing bank branch.');
  } else if (bvStatus === 'verification_failed') {
    signals.push({
      category: 'bank_verification',
      label: 'Direct bank confirmation',
      status: 'failed',
      score: 0,
      maxScore: 10,
      impact: 'negative',
      details: 'Bank verification attempt failed or issuing bank reported instrument unknown/invalid.',
      sourceReference: 'bankVerification.status',
    });
    riskFindings.push('Critical: Bank verification attempt failed.');
  } else if (bvStatus === 'unverifiable') {
    signals.push({
      category: 'bank_verification',
      label: 'Direct bank confirmation',
      status: 'warning',
      score: 0,
      maxScore: 10,
      impact: 'negative',
      details: 'Bank branch could not be reached or instrument could not be confirmed after attempts.',
      sourceReference: 'bankVerification.status',
    });
    riskFindings.push('Bank verification inconclusive / unverifiable.');
  } else {
    // pending
    signals.push({
      category: 'bank_verification',
      label: 'Direct bank confirmation',
      status: 'not_assessed',
      score: 0,
      maxScore: 10,
      impact: 'neutral',
      details: 'Bank confirmation has not yet been obtained. Verification is pending.',
      sourceReference: 'bankVerification.status',
    });
    unavailableChecks.push('Bank verification is pending.');
  }

  // Calculate score and evidence coverage
  // Total possible across all assessed signals
  const totalPossible = 100;
  let assessedMaxScore = 0;
  let earnedScore = 0;

  signals.forEach((sig) => {
    if (sig.status !== 'not_assessed') {
      assessedMaxScore += sig.maxScore;
      earnedScore += sig.score;
    }
  });

  const evidenceCoverage = Math.min(
    100,
    Math.max(0, Math.round((assessedMaxScore / totalPossible) * 100)),
  );

  let score = 0;
  if (assessedMaxScore > 0) {
    score = Math.min(100, Math.max(0, Math.round((earnedScore / assessedMaxScore) * 100)));
  }

  // Result category evaluation
  let category;
  const criticalFindings = [
    hasImpossibleDate,
    hasConfirmedDuplicate,
    bvStatus === 'verification_failed',
    forensics?.status === 'integrity_check_failed',
  ];

  if (evidenceCoverage < TRUST_SCORE_CONFIG.thresholds.insufficientEvidenceCoverage) {
    category = 'insufficient_evidence';
  } else if (criticalFindings.some(Boolean) || score < TRUST_SCORE_CONFIG.thresholds.highRiskScore) {
    category = 'high_review_priority';
  } else if (
    riskFindings.length > 0 ||
    score < TRUST_SCORE_CONFIG.thresholds.mediumRiskScore ||
    bvStatus === 'unverifiable'
  ) {
    category = 'review_recommended';
  } else {
    category = 'low_observed_risk';
  }

  const summary = `Score: ${score}/100 (${category.replace(/_/g, ' ')}), evidence coverage: ${evidenceCoverage}%.`;

  return {
    score,
    category,
    evidenceCoverage,
    version: TRUST_SCORE_CONFIG.version,
    calculatedAt: new Date(),
    signals,
    positiveFindings,
    riskFindings,
    missingData,
    unavailableChecks,
    summary,
    trigger,
  };
};

export const fdrTrustScoreService = {
  calculateFdrTrustScore,
  TRUST_SCORE_CONFIG,
};

export default fdrTrustScoreService;

