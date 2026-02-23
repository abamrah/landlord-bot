/**
 * noticeService.ts — Generate Ontario LTB eviction notice PDFs (N4, N12)
 * Uses pdfkit to create properly formatted notices.
 */

import PDFDocument from "pdfkit";

// ── N4 Notice Data ──────────────────────────────────────

export interface N4Data {
  /** Tenant full name(s) */
  tenantName: string;
  /** Rental unit address */
  rentalUnitAddress: string;
  /** Landlord full name */
  landlordName: string;
  /** Landlord address (for service) */
  landlordAddress?: string;
  /** Landlord phone */
  landlordPhone?: string;
  /** Rent owing periods — array of { period, rentCharged, rentPaid, rentOwing } */
  rentOwing: Array<{
    period: string;
    rentCharged: number;
    rentPaid: number;
    rentOwing: number;
  }>;
  /** Total amount owing */
  totalOwing: number;
  /** Termination date (must be at least 14 days from date of notice for monthly tenancy) */
  terminationDate: string;
  /** Date notice is given */
  dateGiven: string;
  /** Landlord signature name */
  signedBy: string;
}

// ── N12 Notice Data ─────────────────────────────────────

export interface N12Data {
  /** Tenant full name(s) */
  tenantName: string;
  /** Rental unit address */
  rentalUnitAddress: string;
  /** Landlord full name */
  landlordName: string;
  /** Landlord address */
  landlordAddress?: string;
  /** Landlord phone */
  landlordPhone?: string;
  /** Reason: "personal_use" | "family_use" | "purchaser_use" */
  reason: "personal_use" | "family_use" | "purchaser_use";
  /** Name of person who will occupy the unit */
  occupantName: string;
  /** Relationship to landlord (if family) */
  relationship?: string;
  /** Termination date (must be at least 60 days, at end of rental period) */
  terminationDate: string;
  /** Date notice is given */
  dateGiven: string;
  /** Landlord signature name */
  signedBy: string;
}

// ── Helpers ─────────────────────────────────────────────

function addHeader(doc: PDFKit.PDFDocument, formNumber: string, title: string) {
  doc.fontSize(10).font("Helvetica")
    .text("Landlord and Tenant Board", { align: "center" })
    .text("Ontario", { align: "center" })
    .moveDown(0.3);

  doc.fontSize(16).font("Helvetica-Bold")
    .text(`Form ${formNumber}`, { align: "center" })
    .moveDown(0.2);

  doc.fontSize(12).font("Helvetica-Bold")
    .text(title, { align: "center" })
    .moveDown(0.5);

  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.5);
}

function addField(doc: PDFKit.PDFDocument, label: string, value: string, indent = 50) {
  doc.fontSize(9).font("Helvetica-Bold").text(label, indent, doc.y, { continued: true });
  doc.font("Helvetica").text(`  ${value}`);
  doc.moveDown(0.3);
}

function addSection(doc: PDFKit.PDFDocument, title: string) {
  doc.moveDown(0.5);
  doc.fontSize(10).font("Helvetica-Bold").text(title, 50);
  doc.moveDown(0.3);
}

function addParagraph(doc: PDFKit.PDFDocument, text: string, indent = 50) {
  doc.fontSize(9).font("Helvetica").text(text, indent, doc.y, { width: 495 });
  doc.moveDown(0.3);
}

function addSignatureBlock(doc: PDFKit.PDFDocument, signedBy: string, dateGiven: string) {
  doc.moveDown(1);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.5);

  addSection(doc, "Signature");
  addParagraph(doc, `This notice is given on: ${dateGiven}`);
  doc.moveDown(0.5);

  // Signature line
  doc.moveTo(50, doc.y + 20).lineTo(300, doc.y + 20).stroke();
  doc.fontSize(9).font("Helvetica").text("Signature of Landlord / Agent", 50, doc.y + 25);
  doc.moveDown(2);

  addField(doc, "Print Name:", signedBy);
  addField(doc, "Date:", dateGiven);
}

// ── Generate N4 PDF ─────────────────────────────────────

export function generateN4Notice(data: N4Data): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "LETTER", margin: 50 });
      const chunks: Buffer[] = [];

      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Header
      addHeader(doc, "N4", "Notice to End a Tenancy Early for Non-payment of Rent");

      // Part 1: Address
      addSection(doc, "Part 1: Rental Unit Address");
      addField(doc, "Address of the Rental Unit:", data.rentalUnitAddress);

      // Part 2: Tenant Info
      addSection(doc, "Part 2: Tenant Information");
      addField(doc, "Tenant Name(s):", data.tenantName);

      // Part 3: Landlord Info
      addSection(doc, "Part 3: Landlord Information");
      addField(doc, "Landlord Name:", data.landlordName);
      if (data.landlordAddress) addField(doc, "Landlord Address:", data.landlordAddress);
      if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone);

      // Part 4: Rent Owing
      addSection(doc, "Part 4: Rent Owing");
      addParagraph(doc, "The following rent is owing:");
      doc.moveDown(0.3);

      // Table header
      const tableTop = doc.y;
      doc.fontSize(8).font("Helvetica-Bold");
      doc.text("Period", 55, tableTop, { width: 160 });
      doc.text("Rent Charged", 220, tableTop, { width: 100, align: "right" });
      doc.text("Rent Paid", 325, tableTop, { width: 100, align: "right" });
      doc.text("Rent Owing", 430, tableTop, { width: 100, align: "right" });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.3);

      // Table rows
      doc.font("Helvetica").fontSize(8);
      for (const row of data.rentOwing) {
        const rowY = doc.y;
        doc.text(row.period, 55, rowY, { width: 160 });
        doc.text(`$${row.rentCharged.toFixed(2)}`, 220, rowY, { width: 100, align: "right" });
        doc.text(`$${row.rentPaid.toFixed(2)}`, 325, rowY, { width: 100, align: "right" });
        doc.text(`$${row.rentOwing.toFixed(2)}`, 430, rowY, { width: 100, align: "right" });
        doc.moveDown(0.5);
      }

      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.3);
      doc.fontSize(9).font("Helvetica-Bold");
      doc.text(`Total Rent Owing: $${data.totalOwing.toFixed(2)}`, 55, doc.y, { width: 480, align: "right" });

      // Part 5: Termination Date
      addSection(doc, "Part 5: Termination Date");
      addField(doc, "Termination Date:", data.terminationDate);
      addParagraph(doc, "The termination date must be at least 14 days after the landlord gives this notice to the tenant (for a daily or weekly tenancy, the termination date must be at least 7 days after the notice is given).");

      // Part 6: Important Information
      addSection(doc, "Important Information for the Tenant");
      addParagraph(doc, "• This notice does NOT mean you have to move out. You can pay the rent owing by the termination date to void this notice.");
      addParagraph(doc, "• If you do not pay by the termination date, the landlord can apply to the Landlord and Tenant Board (LTB) for an order to evict you and collect the rent you owe.");
      addParagraph(doc, "• You can pay any time before the Board issues an eviction order, even after the termination date. This will void the notice and any application to the Board.");
      addParagraph(doc, "• You may be eligible for fee waiver at the LTB. Contact the Board for more information.");

      // Signature
      addSignatureBlock(doc, data.signedBy, data.dateGiven);

      // Footer
      doc.moveDown(1);
      doc.fontSize(7).font("Helvetica").fillColor("#666666")
        .text("Generated by AI Landlord Assistant — This form follows the structure of the Ontario LTB Form N4. Verify all details before serving.", 50, doc.y, { width: 495, align: "center" });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ── Generate N12 PDF ────────────────────────────────────

export function generateN12Notice(data: N12Data): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "LETTER", margin: 50 });
      const chunks: Buffer[] = [];

      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Header
      addHeader(doc, "N12", "Notice to End your Tenancy Because the Landlord, a Purchaser or a Family Member Requires the Rental Unit");

      // Part 1: Address
      addSection(doc, "Part 1: Rental Unit Address");
      addField(doc, "Address of the Rental Unit:", data.rentalUnitAddress);

      // Part 2: Tenant Info
      addSection(doc, "Part 2: Tenant Information");
      addField(doc, "Tenant Name(s):", data.tenantName);

      // Part 3: Landlord Info
      addSection(doc, "Part 3: Landlord Information");
      addField(doc, "Landlord Name:", data.landlordName);
      if (data.landlordAddress) addField(doc, "Landlord Address:", data.landlordAddress);
      if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone);

      // Part 4: Reason
      addSection(doc, "Part 4: Reason for This Notice");

      const reasonText = data.reason === "personal_use"
        ? "I, the landlord, in good faith require possession of the rental unit for my own personal residential use."
        : data.reason === "family_use"
          ? `I, the landlord, in good faith require possession of the rental unit for the use of a family member: ${data.occupantName}${data.relationship ? ` (${data.relationship})` : ""}.`
          : `A purchaser of the residential complex, in good faith, requires possession of the rental unit for the purchaser's own personal use: ${data.occupantName}.`;

      addParagraph(doc, reasonText);
      addField(doc, "Person who will occupy the unit:", data.occupantName);
      if (data.relationship) addField(doc, "Relationship to Landlord:", data.relationship);

      // Part 5: Termination Date
      addSection(doc, "Part 5: Termination Date");
      addField(doc, "Termination Date:", data.terminationDate);
      addParagraph(doc, "The termination date must be at least 60 days after the landlord gives the tenant this notice. The termination date must also be the last day of a rental period (e.g., the last day of the month if rent is paid monthly).");

      // Part 6: Compensation
      addSection(doc, "Part 6: Compensation");
      addParagraph(doc, "Under the Residential Tenancies Act, 2006, the landlord must compensate the tenant an amount equal to one month's rent or offer another rental unit acceptable to the tenant.");
      addParagraph(doc, "The compensation must be paid no later than the termination date in this notice. If the landlord does not pay the compensation or offer another unit, this notice is void.");

      // Part 7: Important Information
      addSection(doc, "Important Information for the Tenant");
      addParagraph(doc, "• This notice does NOT mean you have to move out. You do not have to move out by the termination date.");
      addParagraph(doc, "• The landlord must apply to the Landlord and Tenant Board (LTB) for an order evicting you. You will receive a copy of the application and a Notice of Hearing.");
      addParagraph(doc, "• You can attend the hearing and present evidence to the Board. The Board will decide if the landlord's application should be granted.");
      addParagraph(doc, "• If you believe the landlord is acting in bad faith (not genuinely intending to occupy the unit), raise this at the hearing.");
      addParagraph(doc, "• Under Ontario's Bill 60 (Homeowner Protection Act), bad-faith N12 evictions carry penalties up to $100,000 for individuals and $500,000 for corporations.");
      addParagraph(doc, "• You have the right to one month's rent compensation. Ensure it is paid by the termination date.");

      // Declaration
      addSection(doc, "Declaration");
      addParagraph(doc, "I declare that I have provided this notice in good faith and that the person named above genuinely intends to occupy the rental unit for at least one year.");

      // Signature
      addSignatureBlock(doc, data.signedBy, data.dateGiven);

      // Footer
      doc.moveDown(1);
      doc.fontSize(7).font("Helvetica").fillColor("#666666")
        .text("Generated by AI Landlord Assistant — This form follows the structure of the Ontario LTB Form N12. Verify all details before serving.", 50, doc.y, { width: 495, align: "center" });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

export default {
  generateN4Notice,
  generateN12Notice,
};
