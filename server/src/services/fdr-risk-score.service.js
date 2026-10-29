/**
 * Explainable FDR Risk Scoring Engine
 *
 * Rule-based, transparent risk scoring engine that assesses FDR verification
 * findings, cross-record discrepancies, duplicate collisions, and version changes.
 *
 * Score Range: 0–100
 * Risk Levels:
 *   - Low: 0–24
 *   - Medium: 25–49
 *   - High: 50–74
 *   - Critical: 75–100
 */

export const DEFAULT_RISK_SCORING_RULES = {
  version: '1.0.0',
  thresholds: {
    low: { min: 0, max: 24, label: 'Low', level: 'low', tone: 'success' },
    medium: { min: 25, max: 49, label: 'Medium', level: 'medium', tone: 'warning' },
    high: { min: 50, max: 74, label: 'High', level: 'high', tone: 'danger' },
    critical: { min: 75, max: 100, label: 'Critical', level: 'critical', tone: 'danger' },
  },
  weights: {
    exactIdentifierCollision: 40,
    amountMismatch: 25,
    maturityDateMismatch: 20,
    unexplainedVersionChange: 20,
    missingRequiredInfo: 10,
    lowOcrConfidenceCritical: 10,
    impossibleDateSequence: 25,
    ifscFormatInvalid: 10,
  },
};

export const mapRiskScoreToLevel = (score) => {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
};

const formatMoneyText = (amount, currency = 'INR') => {
  if (amount === null || amount === undefined) return '—';
  return `${currency} ${Number(amount).toLocaleString('en-IN')}`;
};

const formatDateText = (date) => {
  if (!date) return '—';
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
};

export const calculateFdrRiskScore = ({
  fdr,
  previousFdr = null,
  duplicateResult = null,
  customRules = null,
}) => {
  const rules = customRules || DEFAULT_RISK_SCORING_RULES;
  const weights = rules.weights;
  const findings = [];

  const ocr = fdr.ocrResult || {};
  const comparisons = ocr.comparisonResults || {};
  const extracted = ocr.extractedData || {};
  const dup = duplicateResult || fdr.duplicateCheck || null;

  // 1. Exact FDR Identifier Collision (+40 pts)
  const isAuthorizedReplacement = Boolean(fdr.replacesFdr || dup?.matches?.some((m) => m.isAuthorizedReplacement));
  if (
    dup &&
    (dup.status === 'exact_document_match' || dup.status === 'same_instrument_reference') &&
    !isAuthorizedReplacement
  ) {
    findings.push({
      id: 'exact_identifier_collision',
      label: 'Exact FDR identifier or document collision',
      points: weights.exactIdentifierCollision,
      category: 'duplicate',
      evidence: `Collision detected: ${dup.matches?.length || 1} existing instrument(s) in the register share identical FDR reference or SHA-256 document checksum.`,
      explanation: 'The same FDR receipt or document has been uploaded across multiple institution submissions, indicating potential duplicate collateral.',
      status: 'active',
    });
  }

  // 2. Deposit Amount Mismatch (+25 pts)
  if (comparisons.deposit_amount?.status === 'mismatch') {
    const declaredAmt = formatMoneyText(fdr.amount, fdr.currency);
    const ocrAmt = formatMoneyText(extracted.deposit_amount, extracted.currency || fdr.currency);
    findings.push({
      id: 'deposit_amount_mismatch',
      label: 'Deposit principal mismatch between OCR and declaration',
      points: weights.amountMismatch,
      category: 'discrepancy',
      evidence: `Declared amount: ${declaredAmt} vs. Optical receipt extraction: ${ocrAmt}.`,
      explanation: 'The deposit amount submitted by the institution does not match the principal printed on the receipt document.',
      status: 'active',
    });
  }

  // 3. Maturity Date Mismatch (+20 pts)
  if (comparisons.maturity_date?.status === 'mismatch') {
    const declaredMat = formatDateText(fdr.maturityDate);
    const ocrMat = formatDateText(extracted.maturity_date);
    findings.push({
      id: 'maturity_date_mismatch',
      label: 'Maturity date mismatch between OCR and declaration',
      points: weights.maturityDateMismatch,
      category: 'discrepancy',
      evidence: `Declared maturity: ${declaredMat} vs. Optical receipt extraction: ${ocrMat}.`,
      explanation: 'The date on which the security deposit matures differs between the institution record and the bank instrument.',
      status: 'active',
    });
  }

  // 4. Impossible Date Sequence (+25 pts)
  if (fdr.issueDate && fdr.maturityDate && new Date(fdr.maturityDate) <= new Date(fdr.issueDate)) {
    findings.push({
      id: 'impossible_date_sequence',
      label: 'Impossible date chronology (maturity on or before issue date)',
      points: weights.impossibleDateSequence,
      category: 'discrepancy',
      evidence: `Issue date: ${formatDateText(fdr.issueDate)} · Maturity date: ${formatDateText(fdr.maturityDate)}.`,
      explanation: 'Statutory compliance requires deposit maturity to be chronologically later than the issue date.',
      status: 'active',
    });
  }

  // 5. Unexplained Version Change from Previous Stored Version (+20 pts)
  if (previousFdr) {
    const amountChanged = previousFdr.amount !== undefined && Number(previousFdr.amount) !== Number(fdr.amount);
    const bankChanged = previousFdr.bankName && fdr.bankName && previousFdr.bankName.trim().toLowerCase() !== fdr.bankName.trim().toLowerCase();
    const fdrNumberChanged = previousFdr.fdrNumber && fdr.fdrNumber && previousFdr.fdrNumber.trim().toUpperCase() !== fdr.fdrNumber.trim().toUpperCase();

    if (amountChanged || bankChanged || fdrNumberChanged) {
      const changes = [];
      if (amountChanged) changes.push(`Principal: ${formatMoneyText(previousFdr.amount)} -> ${formatMoneyText(fdr.amount)}`);
      if (bankChanged) changes.push(`Bank: ${previousFdr.bankName} -> ${fdr.bankName}`);
      if (fdrNumberChanged) changes.push(`FDR Number: ${previousFdr.fdrNumber} -> ${fdr.fdrNumber}`);

      findings.push({
        id: 'unexplained_version_change',
        label: 'Unexplained modification from previously stored instrument version',
        points: weights.unexplainedVersionChange,
        category: 'version_change',
        evidence: `Modified fields: ${changes.join('; ')}.`,
        explanation: 'Core deposit parameters differ from the previously registered and approved instrument version without prior council waiver.',
        status: 'active',
      });
    }
  }

  // 6. Missing Required Information (+10 pts)
  const missingRequired = [];
  if (!fdr.fdrNumber || fdr.fdrNumber.trim() === '') missingRequired.push('FDR number');
  if (!fdr.bankName || fdr.bankName.trim() === '') missingRequired.push('Bank name');
  if (!fdr.branch || fdr.branch.trim() === '') missingRequired.push('Branch name');
  if (!fdr.amount || Number(fdr.amount) <= 0) missingRequired.push('Valid deposit amount');
  if (!fdr.issueDate) missingRequired.push('Issue date');
  if (!fdr.maturityDate) missingRequired.push('Maturity date');
  if (!fdr.documentMetadata?.storageRef && !fdr.documentMetadata?.fileName) missingRequired.push('Supporting document file');

  if (missingRequired.length > 0) {
    findings.push({
      id: 'missing_required_info',
      label: 'Missing required deposit parameters or unreadable document',
      points: weights.missingRequiredInfo,
      category: 'missing_data',
      evidence: `Missing or incomplete parameters: ${missingRequired.join(', ')}.`,
      explanation: 'Statutory compliance requires all primary deposit and banking parameters to be fully recorded.',
      status: 'active',
    });
  }

  // 7. Low OCR Confidence on Critical Field (+10 pts)
  const lowConfFields = ocr.lowConfidenceFields || [];
  const missingOcrFields = ocr.missingFields || [];
  if (['completed', 'partially_completed'].includes(ocr.status)) {
    const criticalOcrMissing = missingOcrFields.filter((f) =>
      ['fdr_number', 'deposit_amount', 'maturity_date'].includes(f),
    );
    if (criticalOcrMissing.length > 0 || lowConfFields.length > 0) {
      findings.push({
        id: 'low_ocr_confidence_critical',
        label: 'Low optical confidence or missing critical values in OCR scan',
        points: weights.lowOcrConfidenceCritical,
        category: 'confidence',
        evidence: `Uncertain or missing OCR fields: ${[...criticalOcrMissing, ...lowConfFields].join(', ')}.`,
        explanation: 'The optical clarity of the uploaded receipt is insufficient to extract critical fields with high confidence.',
        status: 'active',
      });
    }
  }

  // 8. Invalid IFSC Format (+10 pts)
  if (fdr.ifscCode && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(fdr.ifscCode.trim().toUpperCase())) {
    findings.push({
      id: 'ifsc_format_invalid',
      label: 'Invalid IFSC code structure',
      points: weights.ifscFormatInvalid,
      category: 'discrepancy',
      evidence: `Submitted IFSC: "${fdr.ifscCode}" does not match standard 11-character RBI format.`,
      explanation: 'Branch IFSC codes must adhere to RBI formatting rules (4 letters, digit 0, 6 alphanumeric).',
      status: 'active',
    });
  }

  // Calculate score from active (non-dismissed) findings
  const rawScore = findings
    .filter((f) => f.status === 'active')
    .reduce((sum, f) => sum + f.points, 0);

  const score = Math.min(100, Math.max(0, rawScore));
  const level = mapRiskScoreToLevel(score);

  // Recommended next actions based on risk level
  let recommendedAction;
  if (level === 'critical') {
    recommendedAction = 'Immediate administrative hold. Cross-verify instrument directly with bank branch manager and request formal explanation from institution head.';
  } else if (level === 'high') {
    recommendedAction = 'Detailed reviewer scrutiny recommended. Inspect original document scan against flagged discrepancy evidence before proceeding.';
  } else if (level === 'medium') {
    recommendedAction = 'Standard verification review. Verify highlighted fields or missing data points with institution admin.';
  } else {
    recommendedAction = 'Routine administrative processing. Automated checks conform to statutory criteria.';
  }

  const activeCount = findings.filter((f) => f.status === 'active').length;
  const summary = `Risk Score: ${score}/100 (${level.toUpperCase()}). ${activeCount} active risk finding(s) evaluated. ${recommendedAction}`;

  return {
    score,
    level,
    version: rules.version,
    calculatedAt: new Date(),
    findings,
    summary,
    recommendedAction,
  };
};

export const fdrRiskScoreService = {
  calculateFdrRiskScore,
  DEFAULT_RISK_SCORING_RULES,
  mapRiskScoreToLevel,
};

export default fdrRiskScoreService;
