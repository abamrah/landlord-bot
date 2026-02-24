/**
 * noticeService.ts — Generate Ontario LTB notice PDFs (N1–N13)
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

// ═══════════════════════════════════════════════════════════
//  N1 — Notice to Increase Rent
// ═══════════════════════════════════════════════════════════

export interface N1Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    currentRent: number;
    newRent: number;
    effectiveDate: string;
    dateGiven: string;
    signedBy: string;
}

export function generateN1Notice(data: N1Data): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "LETTER", margin: 50 });
            const chunks: Buffer[] = [];
            doc.on("data", (chunk: Buffer) => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            addHeader(doc, "N1", "Notice to Increase the Rent");

            addSection(doc, "Part 1: Rental Unit Address");
            addField(doc, "Address of the Rental Unit:", data.rentalUnitAddress);

            addSection(doc, "Part 2: Tenant Information");
            addField(doc, "Tenant Name(s):", data.tenantName);

            addSection(doc, "Part 3: Landlord Information");
            addField(doc, "Landlord Name:", data.landlordName);
            if (data.landlordAddress) addField(doc, "Landlord Address:", data.landlordAddress);
            if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone);

            addSection(doc, "Part 4: Rent Increase Details");
            addField(doc, "Current Rent:", `$${data.currentRent.toFixed(2)}`);
            addField(doc, "New Rent:", `$${data.newRent.toFixed(2)}`);
            addField(doc, "Increase Amount:", `$${(data.newRent - data.currentRent).toFixed(2)}`);
            addField(doc, "Effective Date:", data.effectiveDate);

            addSection(doc, "Important Information");
            addParagraph(doc, "• The landlord must give at least 90 days notice before a rent increase takes effect.");
            addParagraph(doc, "• The rent increase can only take effect at least 12 months after the last rent increase or the start of tenancy, whichever is later.");
            addParagraph(doc, "• For most units, the increase cannot exceed the Ontario rent increase guideline for the year, unless the landlord has obtained an order from the LTB permitting a larger increase.");
            addParagraph(doc, "• If you believe the increase is above the guideline or is otherwise improper, you may file an application with the Landlord and Tenant Board (LTB).");

            addSignatureBlock(doc, data.signedBy, data.dateGiven);

            doc.moveDown(1);
            doc.fontSize(7).font("Helvetica").fillColor("#666666")
                .text("Generated by AI Landlord Assistant — This form follows the structure of the Ontario LTB Form N1. Verify all details before serving.", 50, doc.y, { width: 495, align: "center" });
            doc.end();
        } catch (err) { reject(err); }
    });
}

// ═══════════════════════════════════════════════════════════
//  N2 — Notice to End Tenancy (Agreement to Terminate)
// ═══════════════════════════════════════════════════════════

export interface N2Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
}

export function generateN2Notice(data: N2Data): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "LETTER", margin: 50 });
            const chunks: Buffer[] = [];
            doc.on("data", (chunk: Buffer) => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            addHeader(doc, "N2", "Notice to End your Tenancy Because the Landlord, a Purchaser or a Family Member Requires the Rental Unit — Condominium Conversion");

            addSection(doc, "Part 1: Rental Unit Address");
            addField(doc, "Address of the Rental Unit:", data.rentalUnitAddress);

            addSection(doc, "Part 2: Tenant Information");
            addField(doc, "Tenant Name(s):", data.tenantName);

            addSection(doc, "Part 3: Landlord Information");
            addField(doc, "Landlord Name:", data.landlordName);
            if (data.landlordAddress) addField(doc, "Landlord Address:", data.landlordAddress);
            if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone);

            addSection(doc, "Part 4: Reason for This Notice");
            addParagraph(doc, "The residential complex in which your rental unit is located is being converted to condominium. A purchaser has entered into an agreement of purchase and sale for the unit you occupy.");

            addSection(doc, "Part 5: Termination Date");
            addField(doc, "Termination Date:", data.terminationDate);
            addParagraph(doc, "The termination date must be at least 60 days after this notice is given and must be the last day of a rental period.");

            addSection(doc, "Important Information for the Tenant");
            addParagraph(doc, "• This notice can only be given if the residential complex containing your rental unit has been registered as a condominium and a purchaser has signed an agreement of purchase and sale for the unit you occupy.");
            addParagraph(doc, "• You are entitled to compensation equal to one month's rent or an offer of another acceptable rental unit.");
            addParagraph(doc, "• This notice does NOT mean you have to move. The landlord must apply to the LTB for an eviction order.");
            addParagraph(doc, "• You have the right to attend the hearing and present your case.");

            addSignatureBlock(doc, data.signedBy, data.dateGiven);

            doc.moveDown(1);
            doc.fontSize(7).font("Helvetica").fillColor("#666666")
                .text("Generated by AI Landlord Assistant — This form follows the structure of the Ontario LTB Form N2. Verify all details before serving.", 50, doc.y, { width: 495, align: "center" });
            doc.end();
        } catch (err) { reject(err); }
    });
}

// ═══════════════════════════════════════════════════════════
//  N5 — Notice to End Tenancy for Interfering with Others, Damage, or Overcrowding
// ═══════════════════════════════════════════════════════════

export interface N5Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    /** "interference" | "damage" | "overcrowding" | "act_impairs_safety" */
    reason: string;
    /** Description of the behaviour or damage */
    details: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
}

export function generateN5Notice(data: N5Data): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "LETTER", margin: 50 });
            const chunks: Buffer[] = [];
            doc.on("data", (chunk: Buffer) => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            addHeader(doc, "N5", "Notice to End your Tenancy for Interfering with Others, Damage, or Overcrowding");

            addSection(doc, "Part 1: Rental Unit Address");
            addField(doc, "Address of the Rental Unit:", data.rentalUnitAddress);

            addSection(doc, "Part 2: Tenant Information");
            addField(doc, "Tenant Name(s):", data.tenantName);

            addSection(doc, "Part 3: Landlord Information");
            addField(doc, "Landlord Name:", data.landlordName);
            if (data.landlordAddress) addField(doc, "Landlord Address:", data.landlordAddress);
            if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone);

            addSection(doc, "Part 4: Reason(s) for This Notice");
            const reasonTexts: Record<string, string> = {
                interference: "The tenant, an occupant, or a guest has substantially interfered with another tenant's or the landlord's reasonable enjoyment of the residential complex.",
                damage: "The tenant, an occupant, or a guest has wilfully or negligently caused undue damage to the rental unit or residential complex.",
                overcrowding: "The number of persons occupying the rental unit results in a contravention of health, safety, or housing standards.",
                act_impairs_safety: "The tenant, an occupant, or a guest has committed an act or carried on an activity that has impaired the safety of any person.",
            };
            addParagraph(doc, reasonTexts[data.reason] || reasonTexts.interference);
            addSection(doc, "Details of the Behaviour / Damage");
            addParagraph(doc, data.details);

            addSection(doc, "Part 5: Termination Date");
            addField(doc, "Termination Date:", data.terminationDate);
            addParagraph(doc, "For a first N5 notice, the termination date must be at least 20 days after the notice is given. The tenant has 7 days to correct the behaviour or repair the damage to void the notice.");

            addSection(doc, "Important Information for the Tenant");
            addParagraph(doc, "• This is a FIRST notice (non-voidable on second notice within 6 months). You have 7 days to stop the behaviour or repair the damage to void this notice.");
            addParagraph(doc, "• If you void this notice by correcting the issue, the notice is cancelled.");
            addParagraph(doc, "• If you do NOT correct it within 7 days, the landlord can apply to the LTB for an eviction order.");
            addParagraph(doc, "• If a second N5 notice is served within 6 months, the tenant cannot void it.");

            addSignatureBlock(doc, data.signedBy, data.dateGiven);

            doc.moveDown(1);
            doc.fontSize(7).font("Helvetica").fillColor("#666666")
                .text("Generated by AI Landlord Assistant — This form follows the structure of the Ontario LTB Form N5. Verify all details before serving.", 50, doc.y, { width: 495, align: "center" });
            doc.end();
        } catch (err) { reject(err); }
    });
}

// ═══════════════════════════════════════════════════════════
//  N6 — Notice to End Tenancy for Illegal Acts or Misrepresentation of Income
// ═══════════════════════════════════════════════════════════

export interface N6Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    /** "illegal_act" | "misrepresentation" */
    reason: string;
    details: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
}

export function generateN6Notice(data: N6Data): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "LETTER", margin: 50 });
            const chunks: Buffer[] = [];
            doc.on("data", (chunk: Buffer) => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            addHeader(doc, "N6", "Notice to End your Tenancy for Illegal Acts or Misrepresentation of Income");

            addSection(doc, "Part 1: Rental Unit Address");
            addField(doc, "Address of the Rental Unit:", data.rentalUnitAddress);

            addSection(doc, "Part 2: Tenant Information");
            addField(doc, "Tenant Name(s):", data.tenantName);

            addSection(doc, "Part 3: Landlord Information");
            addField(doc, "Landlord Name:", data.landlordName);
            if (data.landlordAddress) addField(doc, "Landlord Address:", data.landlordAddress);
            if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone);

            addSection(doc, "Part 4: Reason for This Notice");
            const reasonText = data.reason === "misrepresentation"
                ? "The tenant has knowingly and materially misrepresented their income or the income of other household members in an application for a unit in a rent-geared-to-income housing project."
                : "The tenant, an occupant, or a guest has committed an illegal act or is carrying on an illegal business at the residential complex.";
            addParagraph(doc, reasonText);
            addSection(doc, "Details");
            addParagraph(doc, data.details);

            addSection(doc, "Part 5: Termination Date");
            addField(doc, "Termination Date:", data.terminationDate);
            addParagraph(doc, "For illegal acts, the termination date must be at least 10 days after the notice is given (20 days if the notice is for an illegal act involving production/trafficking of drugs or a related health or safety concern). This notice cannot be voided.");

            addSection(doc, "Important Information for the Tenant");
            addParagraph(doc, "• This notice CANNOT be voided. The landlord can immediately apply to the LTB for an eviction order after serving this notice.");
            addParagraph(doc, "• You have the right to attend the hearing and present your case to the Board.");
            addParagraph(doc, "• The Board will decide if the illegal act occurred and whether eviction is appropriate.");

            addSignatureBlock(doc, data.signedBy, data.dateGiven);

            doc.moveDown(1);
            doc.fontSize(7).font("Helvetica").fillColor("#666666")
                .text("Generated by AI Landlord Assistant — This form follows the structure of the Ontario LTB Form N6. Verify all details before serving.", 50, doc.y, { width: 495, align: "center" });
            doc.end();
        } catch (err) { reject(err); }
    });
}

// ═══════════════════════════════════════════════════════════
//  N7 — Notice to End Tenancy for Impaired Safety
// ═══════════════════════════════════════════════════════════

export interface N7Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    details: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
}

export function generateN7Notice(data: N7Data): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "LETTER", margin: 50 });
            const chunks: Buffer[] = [];
            doc.on("data", (chunk: Buffer) => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            addHeader(doc, "N7", "Notice to End your Tenancy for Causing Serious Problems in the Rental Unit or Residential Complex");

            addSection(doc, "Part 1: Rental Unit Address");
            addField(doc, "Address of the Rental Unit:", data.rentalUnitAddress);

            addSection(doc, "Part 2: Tenant Information");
            addField(doc, "Tenant Name(s):", data.tenantName);

            addSection(doc, "Part 3: Landlord Information");
            addField(doc, "Landlord Name:", data.landlordName);
            if (data.landlordAddress) addField(doc, "Landlord Address:", data.landlordAddress);
            if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone);

            addSection(doc, "Part 4: Reason for This Notice");
            addParagraph(doc, "The tenant, an occupant, or a guest has committed an act that seriously impairs or has seriously impaired the safety of another person, and this act occurred in the residential complex.");
            addSection(doc, "Details of the Act");
            addParagraph(doc, data.details);

            addSection(doc, "Part 5: Termination Date");
            addField(doc, "Termination Date:", data.terminationDate);
            addParagraph(doc, "The termination date must be at least 10 days after this notice is given. This notice cannot be voided by the tenant.");

            addSection(doc, "Important Information for the Tenant");
            addParagraph(doc, "• This is a serious notice. The landlord can apply to the LTB immediately after serving this notice.");
            addParagraph(doc, "• This notice CANNOT be voided. The Board may issue an eviction order that takes effect immediately.");
            addParagraph(doc, "• The Board can expedite the hearing if the situation is urgent.");
            addParagraph(doc, "• You have the right to attend the hearing and present evidence.");

            addSignatureBlock(doc, data.signedBy, data.dateGiven);

            doc.moveDown(1);
            doc.fontSize(7).font("Helvetica").fillColor("#666666")
                .text("Generated by AI Landlord Assistant — This form follows the structure of the Ontario LTB Form N7. Verify all details before serving.", 50, doc.y, { width: 495, align: "center" });
            doc.end();
        } catch (err) { reject(err); }
    });
}

// ═══════════════════════════════════════════════════════════
//  N8 — Notice to End Tenancy at End of Term for Persistent Late Payment
// ═══════════════════════════════════════════════════════════

export interface N8Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    /** Array of late payment instances: { period, dueDate, datePaid } */
    latePayments: Array<{
        period: string;
        dueDate: string;
        datePaid: string;
    }>;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
}

export function generateN8Notice(data: N8Data): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "LETTER", margin: 50 });
            const chunks: Buffer[] = [];
            doc.on("data", (chunk: Buffer) => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            addHeader(doc, "N8", "Notice to End your Tenancy at the End of the Term for Persistent Late Payment of Rent");

            addSection(doc, "Part 1: Rental Unit Address");
            addField(doc, "Address of the Rental Unit:", data.rentalUnitAddress);

            addSection(doc, "Part 2: Tenant Information");
            addField(doc, "Tenant Name(s):", data.tenantName);

            addSection(doc, "Part 3: Landlord Information");
            addField(doc, "Landlord Name:", data.landlordName);
            if (data.landlordAddress) addField(doc, "Landlord Address:", data.landlordAddress);
            if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone);

            addSection(doc, "Part 4: History of Late Rent Payments");
            addParagraph(doc, "The tenant has persistently failed to pay rent on the date it becomes due and payable:");

            // Table
            const tableTop = doc.y;
            doc.fontSize(8).font("Helvetica-Bold");
            doc.text("Period", 55, tableTop, { width: 160 });
            doc.text("Due Date", 220, tableTop, { width: 130, align: "center" });
            doc.text("Date Actually Paid", 360, tableTop, { width: 170, align: "center" });
            doc.moveDown(0.5);
            doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
            doc.moveDown(0.3);

            doc.font("Helvetica").fontSize(8);
            for (const row of data.latePayments) {
                const rowY = doc.y;
                doc.text(row.period, 55, rowY, { width: 160 });
                doc.text(row.dueDate, 220, rowY, { width: 130, align: "center" });
                doc.text(row.datePaid, 360, rowY, { width: 170, align: "center" });
                doc.moveDown(0.5);
            }
            doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
            doc.moveDown(0.5);

            addSection(doc, "Part 5: Termination Date");
            addField(doc, "Termination Date:", data.terminationDate);
            addParagraph(doc, "The termination date must be at the end of a rental period and at least 60 days after this notice is given.");

            addSection(doc, "Important Information for the Tenant");
            addParagraph(doc, "• This notice CANNOT be voided by paying the arrears. The landlord is seeking eviction due to a pattern of persistently late payments.");
            addParagraph(doc, "• The landlord must apply to the LTB for an eviction order. You will receive a Notice of Hearing.");
            addParagraph(doc, "• At the hearing, you can explain the reasons for late payments and present your case.");
            addParagraph(doc, "• The Board may refuse the eviction if the circumstances do not support it.");

            addSignatureBlock(doc, data.signedBy, data.dateGiven);

            doc.moveDown(1);
            doc.fontSize(7).font("Helvetica").fillColor("#666666")
                .text("Generated by AI Landlord Assistant — This form follows the structure of the Ontario LTB Form N8. Verify all details before serving.", 50, doc.y, { width: 495, align: "center" });
            doc.end();
        } catch (err) { reject(err); }
    });
}

// ═══════════════════════════════════════════════════════════
//  N9 — Tenant's Notice to End the Tenancy
// ═══════════════════════════════════════════════════════════

export interface N9Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
}

export function generateN9Notice(data: N9Data): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "LETTER", margin: 50 });
            const chunks: Buffer[] = [];
            doc.on("data", (chunk: Buffer) => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            addHeader(doc, "N9", "Tenant's Notice to End the Tenancy");

            addSection(doc, "Part 1: Rental Unit Address");
            addField(doc, "Address of the Rental Unit:", data.rentalUnitAddress);

            addSection(doc, "Part 2: Tenant Information");
            addField(doc, "Tenant Name(s):", data.tenantName);

            addSection(doc, "Part 3: Landlord Information");
            addField(doc, "Landlord Name:", data.landlordName);
            if (data.landlordAddress) addField(doc, "Landlord Address:", data.landlordAddress);
            if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone);

            addSection(doc, "Part 4: Termination Date");
            addField(doc, "Termination Date:", data.terminationDate);
            addParagraph(doc, "For a monthly or yearly tenancy, the termination date must be at least 60 days after the notice is given and must be the last day of a rental period. For a daily or weekly tenancy, the termination date must be at least 28 days after the notice is given.");

            addSection(doc, "Important Information");
            addParagraph(doc, "• This notice is given by the tenant to the landlord to end the tenancy.");
            addParagraph(doc, "• Once this notice is given, the tenant must vacate the unit by the termination date.");
            addParagraph(doc, "• If the tenant does not vacate, the landlord can apply to the Board for an eviction order without notice.");
            addParagraph(doc, "• The tenant and landlord can agree in writing to an earlier termination date.");

            addSignatureBlock(doc, data.signedBy, data.dateGiven);

            doc.moveDown(1);
            doc.fontSize(7).font("Helvetica").fillColor("#666666")
                .text("Generated by AI Landlord Assistant — This form follows the structure of the Ontario LTB Form N9. Verify all details before serving.", 50, doc.y, { width: 495, align: "center" });
            doc.end();
        } catch (err) { reject(err); }
    });
}

// ═══════════════════════════════════════════════════════════
//  N10 — Notice to End Tenancy for Demolition, Conversion, or Repairs
// ═══════════════════════════════════════════════════════════

export interface N10Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    /** "demolition" | "conversion" | "repairs" */
    reason: string;
    details: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
}

export function generateN10Notice(data: N10Data): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "LETTER", margin: 50 });
            const chunks: Buffer[] = [];
            doc.on("data", (chunk: Buffer) => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            addHeader(doc, "N10", "Notice to End your Tenancy at the End of the Term for Demolition, Conversion, or Repairs");

            addSection(doc, "Part 1: Rental Unit Address");
            addField(doc, "Address of the Rental Unit:", data.rentalUnitAddress);

            addSection(doc, "Part 2: Tenant Information");
            addField(doc, "Tenant Name(s):", data.tenantName);

            addSection(doc, "Part 3: Landlord Information");
            addField(doc, "Landlord Name:", data.landlordName);
            if (data.landlordAddress) addField(doc, "Landlord Address:", data.landlordAddress);
            if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone);

            addSection(doc, "Part 4: Reason for This Notice");
            const reasonTexts: Record<string, string> = {
                demolition: "The landlord intends to demolish the residential complex or the rental unit.",
                conversion: "The landlord intends to convert the residential complex or rental unit to a non-residential use.",
                repairs: "The landlord requires the rental unit to be vacated in order to do extensive repairs or renovations that require a building permit and vacant possession.",
            };
            addParagraph(doc, reasonTexts[data.reason] || reasonTexts.repairs);
            addSection(doc, "Details");
            addParagraph(doc, data.details);

            addSection(doc, "Part 5: Termination Date");
            addField(doc, "Termination Date:", data.terminationDate);
            addParagraph(doc, "The termination date must be at least 120 days after this notice is given and must be the last day of a rental period.");

            addSection(doc, "Part 6: Compensation and Right of First Refusal");
            addParagraph(doc, "The landlord must:");
            addParagraph(doc, "• Pay compensation equal to one month's rent, or offer another acceptable rental unit.");
            addParagraph(doc, "• If the work is repairs/renovations, offer the tenant the right of first refusal to return to the unit at the same rent after the work is completed.");

            addSection(doc, "Important Information for the Tenant");
            addParagraph(doc, "• The landlord must obtain the necessary permits before the LTB will consider the application.");
            addParagraph(doc, "• You have the right to attend the hearing and challenge the application.");
            addParagraph(doc, "• The Board will assess whether the landlord genuinely intends to carry out the stated purpose.");

            addSignatureBlock(doc, data.signedBy, data.dateGiven);

            doc.moveDown(1);
            doc.fontSize(7).font("Helvetica").fillColor("#666666")
                .text("Generated by AI Landlord Assistant — This form follows the structure of the Ontario LTB Form N10. Verify all details before serving.", 50, doc.y, { width: 495, align: "center" });
            doc.end();
        } catch (err) { reject(err); }
    });
}

// ═══════════════════════════════════════════════════════════
//  N11 — Agreement to Terminate a Tenancy
// ═══════════════════════════════════════════════════════════

export interface N11Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
    /** The tenant's signature name (both parties must sign) */
    tenantSignedBy: string;
}

export function generateN11Notice(data: N11Data): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "LETTER", margin: 50 });
            const chunks: Buffer[] = [];
            doc.on("data", (chunk: Buffer) => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            addHeader(doc, "N11", "Agreement to End the Tenancy");

            addSection(doc, "Part 1: Rental Unit Address");
            addField(doc, "Address of the Rental Unit:", data.rentalUnitAddress);

            addSection(doc, "Part 2: Tenant Information");
            addField(doc, "Tenant Name(s):", data.tenantName);

            addSection(doc, "Part 3: Landlord Information");
            addField(doc, "Landlord Name:", data.landlordName);
            if (data.landlordAddress) addField(doc, "Landlord Address:", data.landlordAddress);
            if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone);

            addSection(doc, "Part 4: Agreement");
            addParagraph(doc, `The landlord and tenant agree that the tenancy for the rental unit at the above address will end on ${data.terminationDate}.`);
            addField(doc, "Termination Date:", data.terminationDate);

            addSection(doc, "Important Information");
            addParagraph(doc, "• Both the landlord and tenant must sign this agreement for it to be valid.");
            addParagraph(doc, "• If the tenant does not move out by the termination date, the landlord can apply to the Board for an eviction order without further notice.");
            addParagraph(doc, "• The tenant can change their mind and stay if they give written notice to the landlord before the termination date. However, this may not apply if the agreement was made because the landlord gave a notice under sections 48, 49, or 50 of the RTA.");
            addParagraph(doc, "• Neither party should feel pressured into signing. If coercion occurred, contact the LTB.");

            // Dual signature block
            doc.moveDown(1);
            doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
            doc.moveDown(0.5);
            addSection(doc, "Signatures");
            addParagraph(doc, `Date of agreement: ${data.dateGiven}`);
            doc.moveDown(1);

            // Landlord signature
            doc.moveTo(50, doc.y + 20).lineTo(280, doc.y + 20).stroke();
            doc.fontSize(9).font("Helvetica").text("Landlord Signature", 50, doc.y + 25);
            doc.moveDown(2);
            addField(doc, "Print Name:", data.signedBy);
            doc.moveDown(0.5);

            // Tenant signature
            doc.moveTo(50, doc.y + 20).lineTo(280, doc.y + 20).stroke();
            doc.fontSize(9).font("Helvetica").text("Tenant Signature", 50, doc.y + 25);
            doc.moveDown(2);
            addField(doc, "Print Name:", data.tenantSignedBy);
            addField(doc, "Date:", data.dateGiven);

            doc.moveDown(1);
            doc.fontSize(7).font("Helvetica").fillColor("#666666")
                .text("Generated by AI Landlord Assistant — This form follows the structure of the Ontario LTB Form N11. Verify all details before serving.", 50, doc.y, { width: 495, align: "center" });
            doc.end();
        } catch (err) { reject(err); }
    });
}

// ═══════════════════════════════════════════════════════════
//  N13 — Notice to Increase Rent Above the Guideline
// ═══════════════════════════════════════════════════════════

export interface N13Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    currentRent: number;
    newRent: number;
    /** "capital_expenditures" | "operating_costs" | "both" */
    reason: string;
    details: string;
    effectiveDate: string;
    dateGiven: string;
    signedBy: string;
}

export function generateN13Notice(data: N13Data): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "LETTER", margin: 50 });
            const chunks: Buffer[] = [];
            doc.on("data", (chunk: Buffer) => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            addHeader(doc, "N13", "Notice to Increase the Rent Above the Guideline and/or to Increase a Charge for Care Services and Meals");

            addSection(doc, "Part 1: Rental Unit Address");
            addField(doc, "Address of the Rental Unit:", data.rentalUnitAddress);

            addSection(doc, "Part 2: Tenant Information");
            addField(doc, "Tenant Name(s):", data.tenantName);

            addSection(doc, "Part 3: Landlord Information");
            addField(doc, "Landlord Name:", data.landlordName);
            if (data.landlordAddress) addField(doc, "Landlord Address:", data.landlordAddress);
            if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone);

            addSection(doc, "Part 4: Rent Increase Details");
            addField(doc, "Current Rent:", `$${data.currentRent.toFixed(2)}`);
            addField(doc, "Proposed New Rent:", `$${data.newRent.toFixed(2)}`);
            addField(doc, "Proposed Increase:", `$${(data.newRent - data.currentRent).toFixed(2)}`);
            addField(doc, "Effective Date:", data.effectiveDate);

            addSection(doc, "Part 5: Reason for Above-Guideline Increase");
            const reasonTexts: Record<string, string> = {
                capital_expenditures: "The landlord has incurred or will incur eligible capital expenditures for the residential complex.",
                operating_costs: "The landlord's operating costs for the residential complex have increased significantly above the guideline.",
                both: "The landlord is requesting an above-guideline increase due to both capital expenditures and increased operating costs.",
            };
            addParagraph(doc, reasonTexts[data.reason] || reasonTexts.capital_expenditures);
            addSection(doc, "Details");
            addParagraph(doc, data.details);

            addSection(doc, "Important Information for the Tenant");
            addParagraph(doc, "• The landlord must file an application with the LTB for an above-guideline increase BEFORE the increase can take effect.");
            addParagraph(doc, "• You have the right to attend the hearing and challenge the increase.");
            addParagraph(doc, "• The Board will review the landlord's financial evidence and determine if the increase is justified.");
            addParagraph(doc, "• You do not have to pay the above-guideline portion until the Board issues an order.");
            addParagraph(doc, "• The landlord must give at least 90 days notice.");

            addSignatureBlock(doc, data.signedBy, data.dateGiven);

            doc.moveDown(1);
            doc.fontSize(7).font("Helvetica").fillColor("#666666")
                .text("Generated by AI Landlord Assistant — This form follows the structure of the Ontario LTB Form N13. Verify all details before serving.", 50, doc.y, { width: 495, align: "center" });
            doc.end();
        } catch (err) { reject(err); }
    });
}

// ═══════════════════════════════════════════════════════════
//  VALID NOTICE TYPES (for validation)
// ═══════════════════════════════════════════════════════════

export const VALID_NOTICE_TYPES = ["N1", "N2", "N4", "N5", "N6", "N7", "N8", "N9", "N10", "N11", "N12", "N13"] as const;
export type NoticeType = typeof VALID_NOTICE_TYPES[number];

export default {
    generateN1Notice,
    generateN2Notice,
    generateN4Notice,
    generateN5Notice,
    generateN6Notice,
    generateN7Notice,
    generateN8Notice,
    generateN9Notice,
    generateN10Notice,
    generateN11Notice,
    generateN12Notice,
    generateN13Notice,
    VALID_NOTICE_TYPES,
};
