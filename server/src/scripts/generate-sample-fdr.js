import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

async function generateSampleFdr() {
  const pdfDoc = await PDFDocument.create();
  
  // A4 Landscape / Portrait: 595.28 x 841.89 (A4 Portrait)
  const width = 595.28;
  const height = 841.89;
  const page = pdfDoc.addPage([width, height]);

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontTimes = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontTimesBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

  // Palette
  const sbiBlue = rgb(0.07, 0.28, 0.55); // #12478c
  const sbiDarkBlue = rgb(0.04, 0.16, 0.35);
  const goldAccent = rgb(0.79, 0.58, 0.16); // #c99429
  const darkGray = rgb(0.18, 0.2, 0.22);
  const lightGray = rgb(0.95, 0.96, 0.97);
  const borderGray = rgb(0.8, 0.83, 0.86);
  const bannerBg = rgb(0.93, 0.96, 1.0);
  const redStamp = rgb(0.75, 0.1, 0.1);

  // Outer Decorative Double Border
  page.drawRectangle({
    x: 20,
    y: 20,
    width: width - 40,
    height: height - 40,
    borderColor: sbiBlue,
    borderWidth: 2.5,
    color: rgb(1, 1, 1),
  });

  page.drawRectangle({
    x: 25,
    y: 25,
    width: width - 50,
    height: height - 50,
    borderColor: goldAccent,
    borderWidth: 0.8,
  });

  // Top Security Header Strip
  page.drawRectangle({
    x: 26,
    y: height - 60,
    width: width - 52,
    height: 34,
    color: sbiBlue,
  });

  page.drawText('STATE BANK OF INDIA - STATUTORY TERM DEPOSIT RECEIPT', {
    x: 105,
    y: height - 44,
    size: 13,
    font: fontBold,
    color: rgb(1, 1, 1),
  });

  page.drawText('GOVERNMENT REGULATORY SECURITY DEPOSIT CERTIFICATE', {
    x: 155,
    y: height - 55,
    size: 8,
    font: fontRegular,
    color: rgb(0.9, 0.95, 1),
  });

  // Bank Info Sub-Header
  page.drawText('STATE BANK OF INDIA', {
    x: 45,
    y: height - 85,
    size: 18,
    font: fontTimesBold,
    color: sbiDarkBlue,
  });

  page.drawText('PARLIAMENT STREET MAIN BRANCH (CODE: 00691)', {
    x: 45,
    y: height - 100,
    size: 9.5,
    font: fontBold,
    color: darkGray,
  });

  page.drawText('11, Sansad Marg, New Delhi - 110001 | Tel: 011-23374100 | Email: sbi.00691@sbi.co.in', {
    x: 45,
    y: height - 112,
    size: 8,
    font: fontRegular,
    color: darkGray,
  });

  page.drawText('IFSC CODE: SBIN0000691', {
    x: 430,
    y: height - 85,
    size: 10.5,
    font: fontBold,
    color: sbiBlue,
  });

  page.drawText('MICR: 110002087', {
    x: 430,
    y: height - 98,
    size: 9,
    font: fontRegular,
    color: darkGray,
  });

  page.drawText('GSTIN: 07AAACS8577K1ZQ', {
    x: 430,
    y: height - 110,
    size: 8,
    font: fontRegular,
    color: darkGray,
  });

  // Horizontal divider
  page.drawLine({
    start: { x: 45, y: height - 122 },
    end: { x: width - 45, y: height - 122 },
    thickness: 1.5,
    color: goldAccent,
  });

  // Certificate Title Banner
  page.drawRectangle({
    x: 45,
    y: height - 160,
    width: width - 90,
    height: 30,
    color: bannerBg,
    borderColor: sbiBlue,
    borderWidth: 1,
  });

  page.drawText('FIXED DEPOSIT RECEIPT / SPECIAL TERM DEPOSIT ADVICE', {
    x: 100,
    y: height - 147,
    size: 13,
    font: fontBold,
    color: sbiDarkBlue,
  });

  page.drawText('(LIEN MARKED IN FAVOUR OF AICTE, NEW DELHI)', {
    x: 185,
    y: height - 157,
    size: 8.5,
    font: fontBold,
    color: redStamp,
  });

  // Key Identifiers Box
  page.drawRectangle({
    x: 45,
    y: height - 215,
    width: width - 90,
    height: 45,
    color: lightGray,
    borderColor: borderGray,
    borderWidth: 0.8,
  });

  // Column 1
  page.drawText('FDR / RECEIPT NUMBER', { x: 55, y: height - 180, size: 8, font: fontRegular, color: darkGray });
  page.drawText('SBIN-2026-FDR-98124', { x: 55, y: height - 195, size: 12, font: fontBold, color: sbiBlue });

  // Column 2
  page.drawText('DEPOSIT ACCOUNT NO.', { x: 220, y: height - 180, size: 8, font: fontRegular, color: darkGray });
  page.drawText('39201948201', { x: 220, y: height - 195, size: 12, font: fontBold, color: darkGray });

  // Column 3
  page.drawText('CUSTOMER ID (CIF)', { x: 350, y: height - 180, size: 8, font: fontRegular, color: darkGray });
  page.drawText('889201920', { x: 350, y: height - 195, size: 11, font: fontRegular, color: darkGray });

  // Column 4
  page.drawText('SCHEME TYPE', { x: 460, y: height - 180, size: 8, font: fontRegular, color: darkGray });
  page.drawText('TDR-INST-REG', { x: 460, y: height - 195, size: 10, font: fontBold, color: darkGray });

  // Pledging / Beneficiary Details Section
  let yPos = height - 235;

  page.drawText('DEPOSITOR & LIEN HOLDER PARTICULARS', {
    x: 45,
    y: yPos,
    size: 10,
    font: fontBold,
    color: sbiBlue,
  });

  yPos -= 8;
  page.drawLine({
    start: { x: 45, y: yPos },
    end: { x: width - 45, y: yPos },
    thickness: 0.8,
    color: borderGray,
  });

  yPos -= 18;
  page.drawText('Depositor / Institution Name:', { x: 45, y: yPos, size: 9, font: fontBold, color: darkGray });
  page.drawText('DELHI INSTITUTE OF ENGINEERING & TECHNOLOGY', { x: 195, y: yPos, size: 9.5, font: fontBold, color: sbiDarkBlue });

  yPos -= 16;
  page.drawText('AICTE Permanent Institute ID:', { x: 45, y: yPos, size: 9, font: fontRegular, color: darkGray });
  page.drawText('1-3329184711 (Application Ref: AICTE-ET-2026-N091)', { x: 195, y: yPos, size: 9, font: fontRegular, color: darkGray });

  yPos -= 16;
  page.drawText('Registered Trust / Society:', { x: 45, y: yPos, size: 9, font: fontRegular, color: darkGray });
  page.drawText('Shri Balaji Educational and Welfare Charitable Trust (Regd.)', { x: 195, y: yPos, size: 9, font: fontRegular, color: darkGray });

  yPos -= 16;
  page.drawText('Statutory Joint Holder / Lien:', { x: 45, y: yPos, size: 9, font: fontBold, color: darkGray });
  page.drawText('MEMBER SECRETARY, AICTE, NEW DELHI (EXCLUSIVE LIEN)', { x: 195, y: yPos, size: 9.5, font: fontBold, color: redStamp });

  // Financial Deposit Terms Table
  yPos -= 28;
  page.drawText('FINANCIAL TERMS & MATURITY SCHEDULE', {
    x: 45,
    y: yPos,
    size: 10,
    font: fontBold,
    color: sbiBlue,
  });

  yPos -= 8;
  page.drawLine({
    start: { x: 45, y: yPos },
    end: { x: width - 45, y: yPos },
    thickness: 0.8,
    color: borderGray,
  });

  // Table Box
  yPos -= 8;
  const tableHeight = 125;
  page.drawRectangle({
    x: 45,
    y: yPos - tableHeight,
    width: width - 90,
    height: tableHeight,
    color: lightGray,
    borderColor: borderGray,
    borderWidth: 1,
  });

  // Table rows
  const rowH = 25;
  let currY = yPos - 18;

  // Row 1: Principal Amount
  page.drawText('Principal Deposit Amount:', { x: 60, y: currY, size: 9.5, font: fontRegular, color: darkGray });
  page.drawText('INR 25,00,000.00', { x: 210, y: currY, size: 11, font: fontBold, color: sbiDarkBlue });
  page.drawText('(Twenty-Five Lakh Indian Rupees Only)', { x: 330, y: currY, size: 8.5, font: fontRegular, color: darkGray });

  currY -= rowH;
  page.drawLine({ start: { x: 45, y: currY + 6 }, end: { x: width - 45, y: currY + 6 }, thickness: 0.5, color: borderGray });

  // Row 2: Dates
  page.drawText('Date of Deposit (Issue):', { x: 60, y: currY, size: 9.5, font: fontRegular, color: darkGray });
  page.drawText('01-04-2026', { x: 210, y: currY, size: 10.5, font: fontBold, color: darkGray });
  page.drawText('Date of Maturity:', { x: 330, y: currY, size: 9.5, font: fontRegular, color: darkGray });
  page.drawText('01-04-2029', { x: 430, y: currY, size: 10.5, font: fontBold, color: redStamp });

  currY -= rowH;
  page.drawLine({ start: { x: 45, y: currY + 6 }, end: { x: width - 45, y: currY + 6 }, thickness: 0.5, color: borderGray });

  // Row 3: Interest & Tenure
  page.drawText('Interest Rate (p.a.):', { x: 60, y: currY, size: 9.5, font: fontRegular, color: darkGray });
  page.drawText('7.10% (Fixed Quarterly Compound)', { x: 210, y: currY, size: 9.5, font: fontBold, color: darkGray });
  page.drawText('Deposit Tenure:', { x: 330, y: currY, size: 9.5, font: fontRegular, color: darkGray });
  page.drawText('36 Months (3 Years)', { x: 430, y: currY, size: 9.5, font: fontBold, color: darkGray });

  currY -= rowH;
  page.drawLine({ start: { x: 45, y: currY + 6 }, end: { x: width - 45, y: currY + 6 }, thickness: 0.5, color: borderGray });

  // Row 4: Maturity Value
  page.drawText('Estimated Maturity Value:', { x: 60, y: currY, size: 9.5, font: fontRegular, color: darkGray });
  page.drawText('INR 30,86,412.00', { x: 210, y: currY, size: 11, font: fontBold, color: sbiBlue });
  page.drawText('Auto-Renewal Clause: Pledged / Retain on Maturity', { x: 330, y: currY, size: 8, font: fontRegular, color: darkGray });

  // Mandatory Regulatory Lien Condition Box
  yPos -= (tableHeight + 20);
  page.drawRectangle({
    x: 45,
    y: yPos - 60,
    width: width - 90,
    height: 60,
    color: rgb(1, 0.96, 0.96),
    borderColor: rgb(0.85, 0.4, 0.4),
    borderWidth: 1,
  });

  page.drawText('STATUTORY ENCUMBRANCE & LIEN UNDERTAKING', {
    x: 55,
    y: yPos - 14,
    size: 8.5,
    font: fontBold,
    color: redStamp,
  });

  page.drawText(
    '1. This Term Deposit Receipt is issued in joint name with AICTE and marked under irrevocable statutory lien.',
    { x: 55, y: yPos - 26, size: 7.5, font: fontRegular, color: darkGray }
  );
  page.drawText(
    '2. No loan, overdraft, advance, or premature encashment shall be granted against this deposit without prior written NOC.',
    { x: 55, y: yPos - 37, size: 7.5, font: fontRegular, color: darkGray }
  );
  page.drawText(
    '3. In the event of default or AICTE revocation, proceeds shall be payable exclusively to the Member Secretary, AICTE.',
    { x: 55, y: yPos - 48, size: 7.5, font: fontRegular, color: darkGray }
  );

  // Security Watermark / Stamp simulation
  yPos -= 80;

  // Verification Box with QR simulation
  page.drawRectangle({
    x: 45,
    y: yPos - 80,
    width: 140,
    height: 80,
    color: rgb(0.98, 0.98, 0.98),
    borderColor: borderGray,
    borderWidth: 0.8,
  });

  // Simulated QR Code grid
  const qrX = 55;
  const qrY = yPos - 70;
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      if ((r + c) % 2 === 0 || (r === 0 || r === 6 || c === 0 || c === 6)) {
        page.drawRectangle({
          x: qrX + c * 7,
          y: qrY + r * 7,
          width: 5.5,
          height: 5.5,
          color: sbiDarkBlue,
        });
      }
    }
  }

  page.drawText('SCAN FOR PORTAL VERIFICATION', { x: 50, y: yPos - 77, size: 6, font: fontBold, color: sbiBlue });
  page.drawText('Ref: SBIN/2026/FDR/98124', { x: 108, y: yPos - 30, size: 6.5, font: fontRegular, color: darkGray });
  page.drawText('Cert SHA-256 Validated', { x: 108, y: yPos - 42, size: 6.5, font: fontBold, color: rgb(0.1, 0.55, 0.2) });
  page.drawText('Issuing Branch: 00691', { x: 108, y: yPos - 54, size: 6.5, font: fontRegular, color: darkGray });

  // Bank Official Signatures
  page.drawText('For STATE BANK OF INDIA', { x: 380, y: yPos - 20, size: 8.5, font: fontBold, color: sbiDarkBlue });

  // Signature line 1
  page.drawLine({ start: { x: 260, y: yPos - 60 }, end: { x: 370, y: yPos - 60 }, thickness: 0.8, color: darkGray });
  page.drawText('Prepared By (Officer)', { x: 275, y: yPos - 72, size: 7.5, font: fontRegular, color: darkGray });
  page.drawText('Emp. No: 649201', { x: 285, y: yPos - 82, size: 7, font: fontRegular, color: darkGray });

  // Signature line 2 (Manager)
  page.drawLine({ start: { x: 400, y: yPos - 60 }, end: { x: 530, y: yPos - 60 }, thickness: 0.8, color: darkGray });
  page.drawText('Chief Manager & Branch Head', { x: 405, y: yPos - 72, size: 7.5, font: fontBold, color: darkGray });
  page.drawText('SS No. 49201 | Branch Seal Affixed', { x: 405, y: yPos - 82, size: 7, font: fontRegular, color: darkGray });

  // Official Bank Round Seal Stamp simulation
  page.drawCircle({
    x: 465,
    y: yPos - 40,
    size: 26,
    borderColor: rgb(0.2, 0.4, 0.8),
    borderWidth: 1.2,
    color: rgb(0.9, 0.94, 1),
    opacity: 0.5,
  });
  page.drawText('SBI NEW DELHI', { x: 442, y: yPos - 38, size: 6, font: fontBold, color: sbiBlue });
  page.drawText('PARLIAMENT ST', { x: 441, y: yPos - 46, size: 5.5, font: fontRegular, color: sbiBlue });

  // Footer security line
  page.drawText(
    'THIS IS A SECURE STATUTORY COMPUTER-GENERATED RECEIPT PRINTED UNDER SPECIAL SECURITY PROTOCOL. SUBJECT TO TERMS AND CONDITIONS OF SBI.',
    { x: 38, y: 32, size: 5.8, font: fontRegular, color: darkGray }
  );

  const pdfBytes = await pdfDoc.save();
  const outputPath = path.resolve(process.cwd(), '..', 'Sample_AICTE_FDR_Receipt.pdf');
  await writeFile(outputPath, pdfBytes);
  console.log(`Sample FDR successfully generated at: ${outputPath}`);
}

generateSampleFdr().catch(console.error);

