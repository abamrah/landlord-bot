/**
 * noticeService.ts — Generate Ontario LTB notice PDFs (N1–N13)
 *
 * All forms match the official Tribunals Ontario / Landlord and Tenant Board
 * format and structure, with correct RTA section references, bilingual
 * identifiers, and proper legal language.
 *
 * Official form registry (tribunalsontario.ca/ltb/forms/):
 *   N1  – Notice of Rent Increase (s. 116 RTA)
 *   N2  – Notice of Rent Increase – Unit Partially Exempt (s. 6(2), 120 RTA)
 *   N4  – Notice to End Tenancy Early for Non-payment of Rent (s. 59 RTA)
 *   N5  – Notice to End Tenancy for Interfering, Damage or Overcrowding (ss. 62,64,67 RTA)
 *   N6  – Notice to End Tenancy for Illegal Acts or Misrepresenting Income (ss. 60,61 RTA)
 *   N7  – Notice to End Tenancy for Causing Serious Problems (s. 66 RTA)
 *   N8  – Notice to End Tenancy at the End of the Term (ss. 58,144 RTA)
 *   N9  – Tenant's Notice to End the Tenancy (s. 47 RTA)
 *   N10 – Agreement to Increase the Rent Above the Guideline (s. 121 RTA)
 *   N11 – Agreement to End the Tenancy (s. 77 RTA)
 *   N12 – Notice to End Tenancy – Landlord/Purchaser/Family Own Use (ss. 48,49 RTA)
 *   N13 – Notice to End Tenancy for Demolition, Repair or Conversion (s. 50 RTA)
 */

import PDFDocument from "pdfkit";

// ═══════════════════════════════════════════════════════════
//  DATA INTERFACES
// ═══════════════════════════════════════════════════════════

export interface N1Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    currentRent: number;
    newRent: number;
    /** Date the increase takes effect (must be ≥90 days from dateGiven, ≥12 months from last increase) */
    effectiveDate: string;
    dateGiven: string;
    signedBy: string;
}

export interface N2Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    currentRent: number;
    newRent: number;
    /** Date the increase takes effect */
    effectiveDate: string;
    /** Reason for partial exemption: "post_nov_2018" | "other" */
    exemptionReason?: string;
    dateGiven: string;
    signedBy: string;
}

export interface N4Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    rentOwing: Array<{
        period: string;
        rentCharged: number;
        rentPaid: number;
        rentOwing: number;
    }>;
    totalOwing: number;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
}

export interface N5Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    /** "interference" | "damage" | "overcrowding" | "act_impairs_safety" */
    reason: string;
    details: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
}

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

export interface N8Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    latePayments: Array<{
        period: string;
        dueDate: string;
        datePaid: string;
    }>;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
}

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

export interface N10Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    currentRent: number;
    newRent: number;
    /** "capital_expenditure" | "new_or_additional_services" | "both" */
    reason: string;
    details: string;
    effectiveDate: string;
    dateGiven: string;
    signedBy: string;
    tenantSignedBy: string;
}

export interface N11Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
    tenantSignedBy: string;
}

export interface N12Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
    reason: "personal_use" | "family_use" | "purchaser_use";
    occupantName: string;
    relationship?: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
}

export interface N13Data {
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

// ═══════════════════════════════════════════════════════════
//  PDF HELPERS — Official LTB format
// ═══════════════════════════════════════════════════════════

/**
 * Official Tribunals Ontario / LTB header matching the real form design.
 */
function addLtbHeader(doc: PDFKit.PDFDocument, formNumber: string, titleEn: string, rtaSections: string) {
    // Tribunals Ontario bilingual identifier
    doc.fontSize(8).font("Helvetica")
        .text("Tribunals Ontario", 50, 40)
        .text("Tribunaux Ontario", 50, 50);

    doc.fontSize(8).font("Helvetica")
        .text("Landlord and Tenant Board", 350, 40, { width: 200, align: "right" })
        .text("Commission de la location immobilière", 350, 50, { width: 200, align: "right" });

    doc.moveDown(1.5);

    // Horizontal rule
    doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(1.5).stroke();
    doc.moveDown(0.4);

    // Form number
    doc.fontSize(14).font("Helvetica-Bold")
        .text(`Form ${formNumber}`, 50, doc.y, { align: "center" });
    doc.moveDown(0.3);

    // Title
    doc.fontSize(11).font("Helvetica-Bold")
        .text(titleEn, 50, doc.y, { align: "center", width: 495 });
    doc.moveDown(0.3);

    // RTA reference
    doc.fontSize(8).font("Helvetica")
        .text(`Residential Tenancies Act, 2006`, 50, doc.y, { align: "center" })
        .text(rtaSections, 50, doc.y, { align: "center" });
    doc.moveDown(0.3);

    // Horizontal rule
    doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(0.5).stroke();
    doc.moveDown(0.3);

    // Instructions line
    doc.fontSize(7).font("Helvetica-Oblique").fillColor("#333333")
        .text("Read the instructions carefully before completing this form.", 50, doc.y, { align: "center" });
    doc.fillColor("#000000");
    doc.moveDown(0.5);
}

function addPart(doc: PDFKit.PDFDocument, partNumber: number, title: string) {
    doc.moveDown(0.4);
    doc.fontSize(10).font("Helvetica-Bold")
        .text(`Part ${partNumber}: ${title}`, 50);
    doc.moveDown(0.3);
}

function addField(doc: PDFKit.PDFDocument, label: string, value: string, indent = 50) {
    doc.fontSize(9).font("Helvetica-Bold").text(label, indent, doc.y, { continued: true });
    doc.font("Helvetica").text(`  ${value}`);
    doc.moveDown(0.2);
}

function addCheckbox(doc: PDFKit.PDFDocument, checked: boolean, label: string, indent = 55) {
    const marker = checked ? "☑" : "☐";
    doc.fontSize(9).font("Helvetica").text(`${marker}  ${label}`, indent, doc.y, { width: 490 });
    doc.moveDown(0.2);
}

function addParagraph(doc: PDFKit.PDFDocument, text: string, indent = 55) {
    doc.fontSize(8.5).font("Helvetica").text(text, indent, doc.y, { width: 485 });
    doc.moveDown(0.2);
}

function addBullet(doc: PDFKit.PDFDocument, text: string, indent = 65) {
    doc.fontSize(8.5).font("Helvetica").text(`•  ${text}`, indent, doc.y, { width: 475 });
    doc.moveDown(0.15);
}

function addSignatureBlock(doc: PDFKit.PDFDocument, signedBy: string, dateGiven: string, label = "Signature of Landlord or Landlord's Agent") {
    doc.moveDown(0.8);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(0.5).stroke();
    doc.moveDown(0.5);

    doc.fontSize(10).font("Helvetica-Bold").text("Signature", 50);
    doc.moveDown(0.4);

    doc.fontSize(8.5).font("Helvetica").text(`Date this notice/agreement is given: ${dateGiven}`, 55);
    doc.moveDown(0.5);

    // Signature line
    doc.moveTo(55, doc.y + 15).lineTo(300, doc.y + 15).lineWidth(0.5).stroke();
    doc.fontSize(8).font("Helvetica").text(label, 55, doc.y + 20);
    doc.moveDown(2.5);

    addField(doc, "Print Name:", signedBy, 55);
    addField(doc, "Date:", dateGiven, 55);
    addField(doc, "Phone Number:", "", 55);
}

function addDualSignatureBlock(doc: PDFKit.PDFDocument, landlordName: string, tenantName: string, dateGiven: string) {
    doc.moveDown(0.8);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(0.5).stroke();
    doc.moveDown(0.5);

    doc.fontSize(10).font("Helvetica-Bold").text("Signatures", 50);
    doc.moveDown(0.2);
    doc.fontSize(8.5).font("Helvetica").text("Both the landlord (or agent) and the tenant must sign this form for it to be valid.", 55);
    doc.moveDown(0.4);

    doc.fontSize(8.5).font("Helvetica").text(`Date: ${dateGiven}`, 55);
    doc.moveDown(0.5);

    // Landlord signature
    doc.moveTo(55, doc.y + 15).lineTo(280, doc.y + 15).lineWidth(0.5).stroke();
    doc.fontSize(8).font("Helvetica").text("Signature of Landlord or Agent", 55, doc.y + 20);
    doc.moveDown(2.5);
    addField(doc, "Print Name:", landlordName, 55);
    doc.moveDown(0.4);

    // Tenant signature
    doc.moveTo(55, doc.y + 15).lineTo(280, doc.y + 15).lineWidth(0.5).stroke();
    doc.fontSize(8).font("Helvetica").text("Signature of Tenant", 55, doc.y + 20);
    doc.moveDown(2.5);
    addField(doc, "Print Name:", tenantName, 55);
}

function addLtbFooter(doc: PDFKit.PDFDocument, formNumber: string) {
    doc.moveDown(0.8);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(0.3).stroke();
    doc.moveDown(0.3);

    doc.fontSize(6.5).font("Helvetica").fillColor("#666666")
        .text(
            `This information is collected under the authority of the Residential Tenancies Act, 2006, ` +
            `S.O. 2006, c. 17 and will be used to process applications filed with the Landlord and Tenant Board. ` +
            `Questions about this collection should be directed to the Landlord and Tenant Board, ` +
            `15 Grosvenor Street, Ground Floor, Toronto, Ontario M7A 2G6 or call 1-888-332-3234.`,
            50, doc.y, { width: 495, align: "left" }
        );
    doc.moveDown(0.3);
    doc.fontSize(6.5).font("Helvetica")
        .text(`Form ${formNumber} — Generated by NestMind AI Landlord Assistant — Verify all details before serving.`, 50, doc.y, { width: 495, align: "center" });
    doc.fillColor("#000000");
}

function addLandlordTenantInfo(doc: PDFKit.PDFDocument, data: {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordAddress?: string;
    landlordPhone?: string;
}, addressPartNum = 1, tenantPartNum = 2, landlordPartNum = 3) {
    addPart(doc, addressPartNum, "Address of the Rental Unit");
    addField(doc, "Address:", data.rentalUnitAddress, 55);

    addPart(doc, tenantPartNum, "Tenant Information");
    addField(doc, "Tenant Name(s):", data.tenantName, 55);

    addPart(doc, landlordPartNum, "Landlord Information");
    addField(doc, "Landlord Name:", data.landlordName, 55);
    if (data.landlordAddress) addField(doc, "Address:", data.landlordAddress, 55);
    if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone, 55);
}

function createDoc(): PDFKit.PDFDocument {
    return new PDFDocument({ size: "LETTER", margin: 50, bufferPages: true });
}

function promiseFromDoc(doc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        doc.on("data", (chunk: Buffer) => chunks.push(chunk));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
    });
}

// ═══════════════════════════════════════════════════════════
//  N1 — Notice of Rent Increase
//  Residential Tenancies Act, 2006, Section 116
// ═══════════════════════════════════════════════════════════

export function generateN1Notice(data: N1Data): Promise<Buffer> {
    const doc = createDoc();
    const result = promiseFromDoc(doc);

    addLtbHeader(doc, "N1",
        "Notice of Rent Increase",
        "Section 116");

    addLandlordTenantInfo(doc, data);

    addPart(doc, 4, "Rent Increase");
    addParagraph(doc, "The landlord is increasing the rent for the rental unit described above.");
    addField(doc, "Current lawful rent (per month):", `$${data.currentRent.toFixed(2)}`, 55);
    addField(doc, "New rent (per month):", `$${data.newRent.toFixed(2)}`, 55);
    addField(doc, "Amount of increase:", `$${(data.newRent - data.currentRent).toFixed(2)}`, 55);
    addField(doc, "Date the increase takes effect:", data.effectiveDate, 55);

    const pctIncrease = data.currentRent > 0
        ? (((data.newRent - data.currentRent) / data.currentRent) * 100).toFixed(1)
        : "N/A";
    addField(doc, "Percentage increase:", `${pctIncrease}%`, 55);

    addPart(doc, 5, "Information for the Tenant");
    addParagraph(doc, "The Residential Tenancies Act, 2006 (the Act) requires that a landlord give a tenant at least 90 days written notice before a rent increase can take effect.");
    doc.moveDown(0.2);
    addBullet(doc, "A rent increase can only take effect at least 12 months after the last rent increase or 12 months after the tenancy began, whichever is later.");
    addBullet(doc, "For most rental units, the increase cannot exceed the Ontario rent increase guideline for the year, unless the landlord has obtained an order from the Landlord and Tenant Board (LTB) permitting a larger increase.");
    addBullet(doc, "A tenant who believes their rent increase is improper may apply to the LTB within 12 months.");
    addBullet(doc, "You can contact the LTB at 1-888-332-3234 or visit tribunalsontario.ca/ltb.");

    addSignatureBlock(doc, data.signedBy, data.dateGiven);
    addLtbFooter(doc, "N1");

    doc.end();
    return result;
}

// ═══════════════════════════════════════════════════════════
//  N2 — Notice of Rent Increase – Unit Partially Exempt
//  Residential Tenancies Act, 2006, Section 6(2), 120
// ═══════════════════════════════════════════════════════════

export function generateN2Notice(data: N2Data): Promise<Buffer> {
    const doc = createDoc();
    const result = promiseFromDoc(doc);

    addLtbHeader(doc, "N2",
        "Notice of Rent Increase – Unit Partially Exempt from Rent Increase Rules",
        "Sections 6(2), 120");

    addLandlordTenantInfo(doc, data);

    addPart(doc, 4, "Exemption Reason");
    addParagraph(doc, "This rental unit is partially exempt from the rent increase rules under the Residential Tenancies Act, 2006. Check the reason that applies:");
    doc.moveDown(0.1);
    addCheckbox(doc, data.exemptionReason === "post_nov_2018",
        "The rental unit was first occupied for residential purposes on or after November 15, 2018, and is therefore not subject to the rent increase guideline under section 6.1 of the Act.");
    addCheckbox(doc, data.exemptionReason === "other",
        "The rental unit is partially exempt from rent increase rules for another reason under subsection 6(2) of the Act.");

    addPart(doc, 5, "Rent Increase");
    addField(doc, "Current lawful rent (per month):", `$${data.currentRent.toFixed(2)}`, 55);
    addField(doc, "New rent (per month):", `$${data.newRent.toFixed(2)}`, 55);
    addField(doc, "Amount of increase:", `$${(data.newRent - data.currentRent).toFixed(2)}`, 55);
    addField(doc, "Date the increase takes effect:", data.effectiveDate, 55);

    addPart(doc, 6, "Information for the Tenant");
    addParagraph(doc, "Even though this unit may be partially exempt from rent increase rules, the landlord must still give the tenant at least 90 days written notice of a rent increase, and a rent increase can only take effect 12 months after the last increase or 12 months after the tenancy began.");
    doc.moveDown(0.2);
    addBullet(doc, "If the rental unit was first occupied for residential purposes on or after November 15, 2018, the annual rent increase guideline does not apply. However, the landlord must still provide 90 days notice and can only increase rent once every 12 months.");
    addBullet(doc, "If you believe the exemption does not apply to your unit, you can apply to the Landlord and Tenant Board (LTB).");
    addBullet(doc, "Contact the LTB at 1-888-332-3234 or visit tribunalsontario.ca/ltb.");

    addSignatureBlock(doc, data.signedBy, data.dateGiven);
    addLtbFooter(doc, "N2");

    doc.end();
    return result;
}

// ═══════════════════════════════════════════════════════════
//  N4 — Notice to End a Tenancy Early for Non-payment of Rent
//  Residential Tenancies Act, 2006, Section 59
// ═══════════════════════════════════════════════════════════

export function generateN4Notice(data: N4Data): Promise<Buffer> {
    const doc = createDoc();
    const result = promiseFromDoc(doc);

    addLtbHeader(doc, "N4",
        "Notice to End your Tenancy Early for Non-payment of Rent",
        "Section 59");

    addPart(doc, 1, "Address of the Rental Unit");
    addField(doc, "Address:", data.rentalUnitAddress, 55);

    addPart(doc, 2, "Tenant Information");
    addField(doc, "To:", data.tenantName, 55);

    addPart(doc, 3, "Landlord Information");
    addField(doc, "From:", data.landlordName, 55);
    if (data.landlordAddress) addField(doc, "Address:", data.landlordAddress, 55);
    if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone, 55);

    addPart(doc, 4, "This Notice is Given Because You Owe Rent");
    addParagraph(doc, "I am giving you this notice because I believe you owe the following amounts of rent:");
    doc.moveDown(0.3);

    // Rent owing table
    const tableTop = doc.y;
    doc.fontSize(8).font("Helvetica-Bold");
    doc.text("Rental Period", 60, tableTop, { width: 150 });
    doc.text("Rent Charged", 215, tableTop, { width: 100, align: "right" });
    doc.text("Rent Paid", 320, tableTop, { width: 100, align: "right" });
    doc.text("Rent Owing", 425, tableTop, { width: 100, align: "right" });
    doc.moveDown(0.4);
    doc.moveTo(55, doc.y).lineTo(540, doc.y).lineWidth(0.5).stroke();
    doc.moveDown(0.3);

    doc.font("Helvetica").fontSize(8);
    for (const row of data.rentOwing) {
        const rowY = doc.y;
        doc.text(row.period, 60, rowY, { width: 150 });
        doc.text(`$${row.rentCharged.toFixed(2)}`, 215, rowY, { width: 100, align: "right" });
        doc.text(`$${row.rentPaid.toFixed(2)}`, 320, rowY, { width: 100, align: "right" });
        doc.text(`$${row.rentOwing.toFixed(2)}`, 425, rowY, { width: 100, align: "right" });
        doc.moveDown(0.5);
    }
    doc.moveTo(55, doc.y).lineTo(540, doc.y).lineWidth(0.5).stroke();
    doc.moveDown(0.3);
    doc.fontSize(9).font("Helvetica-Bold");
    doc.text(`Total Rent Owing: $${data.totalOwing.toFixed(2)}`, 60, doc.y, { width: 470, align: "right" });

    addPart(doc, 5, "Termination Date");
    addField(doc, "I am asking you to move out by:", data.terminationDate, 55);
    addParagraph(doc, "For a monthly or yearly tenancy, the termination date must be at least 14 days after the date this notice is given to the tenant. For a daily or weekly tenancy, the termination date must be at least 7 days after the date this notice is given.");

    addPart(doc, 6, "What the Tenant Can Do");
    addParagraph(doc, "THE TENANT DOES NOT HAVE TO MOVE OUT.");
    doc.moveDown(0.1);
    addBullet(doc, "You can pay the total rent owing by the termination date. If you do, this notice is void and your tenancy will continue.");
    addBullet(doc, "Even after the termination date, you can void this notice by paying all the rent owing plus any additional rent that has come due, as well as the landlord's filing fee for any application to the Board. This right exists up until the Board issues an eviction order.");
    addBullet(doc, "If you do not pay, the landlord may apply to the Landlord and Tenant Board (LTB) for an order to evict you and collect the rent you owe.");
    addBullet(doc, "At the LTB hearing, you can make arguments about why you should not be evicted.");
    addBullet(doc, "You may contact the LTB at 1-888-332-3234 or visit tribunalsontario.ca/ltb.");

    addSignatureBlock(doc, data.signedBy, data.dateGiven);
    addLtbFooter(doc, "N4");

    doc.end();
    return result;
}

// ═══════════════════════════════════════════════════════════
//  N5 — Notice to End Tenancy for Interfering with Others,
//       Damage or Overcrowding
//  Residential Tenancies Act, 2006, Sections 62, 64, 67
// ═══════════════════════════════════════════════════════════

export function generateN5Notice(data: N5Data): Promise<Buffer> {
    const doc = createDoc();
    const result = promiseFromDoc(doc);

    addLtbHeader(doc, "N5",
        "Notice to End your Tenancy for Interfering with Others, Damage or Overcrowding",
        "Sections 62, 64, 67");

    addLandlordTenantInfo(doc, data);

    addPart(doc, 4, "Reason(s) for This Notice");
    addParagraph(doc, "I am giving you this notice because of the reason(s) checked below:");
    doc.moveDown(0.1);
    addCheckbox(doc, data.reason === "interference",
        "Reason 1 (section 64): You, another occupant of the rental unit, or a person you permitted in the residential complex have substantially interfered with another tenant's or my reasonable enjoyment of the residential complex and/or lawful rights, privileges, or interests.");
    addCheckbox(doc, data.reason === "damage",
        "Reason 2 (section 62): You, another occupant, or a person you permitted in the complex have wilfully or negligently caused undue damage to the rental unit or the residential complex.");
    addCheckbox(doc, data.reason === "overcrowding",
        "Reason 3 (section 67): The number of persons occupying the rental unit on a continuing basis results in a contravention of health, safety, or housing standards required by law.");
    addCheckbox(doc, data.reason === "act_impairs_safety",
        "Reason 4 (section 66): You, another occupant, or a person you permitted in the complex have committed an act or carried on an activity or permitted an act or activity in the residential complex that has seriously impaired the safety of another person.");

    addPart(doc, 5, "Details of the Problem");
    addParagraph(doc, "Provide details about each reason checked above, including dates, times, and descriptions:");
    doc.moveDown(0.1);
    addParagraph(doc, data.details);

    addPart(doc, 6, "Termination Date");
    addField(doc, "Termination Date:", data.terminationDate, 55);
    addParagraph(doc, "The termination date must be at least 20 days after the date this notice is given to the tenant.");

    addPart(doc, 7, "What the Tenant Can Do");
    addParagraph(doc, "THE TENANT DOES NOT HAVE TO MOVE OUT.");
    doc.moveDown(0.1);
    addBullet(doc, "This is a notice that can be voided. If you stop the activity or correct the problem within 7 days of receiving this notice, this notice is void and your tenancy will continue.");
    addBullet(doc, "If the problem is damage to the unit or complex, you can void this notice by repairing the damage or paying the landlord the reasonable cost of repair within 7 days.");
    addBullet(doc, "If you do NOT correct the problem within 7 days, the landlord can apply to the LTB for an order to evict you.");
    addBullet(doc, "If a second N5 notice is served on you within 6 months of this notice, that notice cannot be voided.");
    addBullet(doc, "You may contact the LTB at 1-888-332-3234 or visit tribunalsontario.ca/ltb.");

    addSignatureBlock(doc, data.signedBy, data.dateGiven);
    addLtbFooter(doc, "N5");

    doc.end();
    return result;
}

// ═══════════════════════════════════════════════════════════
//  N6 — Notice to End Tenancy for Illegal Acts or
//       Misrepresenting Income in a Rent-Geared-to-Income Unit
//  Residential Tenancies Act, 2006, Sections 60, 61
// ═══════════════════════════════════════════════════════════

export function generateN6Notice(data: N6Data): Promise<Buffer> {
    const doc = createDoc();
    const result = promiseFromDoc(doc);

    addLtbHeader(doc, "N6",
        "Notice to End your Tenancy for Illegal Acts or Misrepresenting Income in a Rent-Geared-to-Income Rental Unit",
        "Sections 60, 61");

    addLandlordTenantInfo(doc, data);

    addPart(doc, 4, "Reason for This Notice");
    addParagraph(doc, "I am giving you this notice because of the reason checked below:");
    doc.moveDown(0.1);
    addCheckbox(doc, data.reason === "illegal_act",
        "Reason 1 (section 61): You, another occupant of the rental unit, or a person permitted in the residential complex has committed an illegal act or is carrying on an illegal business at the residential complex.");
    addCheckbox(doc, data.reason === "misrepresentation",
        "Reason 2 (section 60): You have knowingly and materially misrepresented your income or the income of other members of your household in your application for a rent-geared-to-income unit in a social housing project.");

    addPart(doc, 5, "Details");
    addParagraph(doc, "Describe the illegal act, illegal business, or misrepresentation:");
    doc.moveDown(0.1);
    addParagraph(doc, data.details);

    addPart(doc, 6, "Termination Date");
    addField(doc, "Termination Date:", data.terminationDate, 55);
    addParagraph(doc, "For an illegal act, the termination date must be at least 10 days after the notice is given. For production, trafficking, or possession for the purpose of trafficking an illegal drug, the termination date must be at least 10 days. For misrepresentation of income, the termination date must be at least 20 days.");

    addPart(doc, 7, "What the Tenant Can Do");
    addParagraph(doc, "THIS NOTICE CANNOT BE VOIDED.");
    doc.moveDown(0.1);
    addBullet(doc, "Unlike the N5 notice, this notice cannot be voided by correcting the problem. The landlord can apply to the LTB immediately after serving this notice.");
    addBullet(doc, "You still have the right to attend the hearing and present your case to the Board.");
    addBullet(doc, "The Board will decide whether the illegal act occurred and whether eviction is appropriate in the circumstances.");
    addBullet(doc, "You may contact the LTB at 1-888-332-3234 or visit tribunalsontario.ca/ltb.");

    addSignatureBlock(doc, data.signedBy, data.dateGiven);
    addLtbFooter(doc, "N6");

    doc.end();
    return result;
}

// ═══════════════════════════════════════════════════════════
//  N7 — Notice to End Tenancy for Causing Serious Problems
//       in the Rental Unit or Residential Complex
//  Residential Tenancies Act, 2006, Section 66
// ═══════════════════════════════════════════════════════════

export function generateN7Notice(data: N7Data): Promise<Buffer> {
    const doc = createDoc();
    const result = promiseFromDoc(doc);

    addLtbHeader(doc, "N7",
        "Notice to End your Tenancy for Causing Serious Problems in the Rental Unit or Residential Complex",
        "Section 66");

    addLandlordTenantInfo(doc, data);

    addPart(doc, 4, "Reason for This Notice");
    addParagraph(doc, "I am giving you this notice because you, another occupant of the rental unit, or a person you permitted in the residential complex have:");
    doc.moveDown(0.1);
    addCheckbox(doc, true, "Committed an act that has seriously impaired or has seriously impaired the safety of any person, and this act or activity occurred in the residential complex. (Section 66 of the Act)");

    addPart(doc, 5, "Details of the Act");
    addParagraph(doc, "Describe the act and explain how it has seriously impaired safety:");
    doc.moveDown(0.1);
    addParagraph(doc, data.details);

    addPart(doc, 6, "Termination Date");
    addField(doc, "Termination Date:", data.terminationDate, 55);
    addParagraph(doc, "The termination date must be at least 10 days after this notice is given.");

    addPart(doc, 7, "What the Tenant Can Do");
    addParagraph(doc, "THIS NOTICE CANNOT BE VOIDED.");
    doc.moveDown(0.1);
    addBullet(doc, "This notice cannot be voided. The landlord can apply to the LTB for an eviction order immediately after serving this notice.");
    addBullet(doc, "If the situation is serious and urgent, the Board may schedule an expedited hearing.");
    addBullet(doc, "The Board may issue an eviction order that is effective immediately, without a standard notice period.");
    addBullet(doc, "You still have the right to attend the hearing and present evidence.");
    addBullet(doc, "You may contact the LTB at 1-888-332-3234 or visit tribunalsontario.ca/ltb.");

    addSignatureBlock(doc, data.signedBy, data.dateGiven);
    addLtbFooter(doc, "N7");

    doc.end();
    return result;
}

// ═══════════════════════════════════════════════════════════
//  N8 — Notice to End your Tenancy at the End of the Term
//  Residential Tenancies Act, 2006, Sections 58, 144
// ═══════════════════════════════════════════════════════════

export function generateN8Notice(data: N8Data): Promise<Buffer> {
    const doc = createDoc();
    const result = promiseFromDoc(doc);

    addLtbHeader(doc, "N8",
        "Notice to End your Tenancy at the End of the Term",
        "Sections 58, 144");

    addLandlordTenantInfo(doc, data);

    addPart(doc, 4, "Reason for This Notice");
    addParagraph(doc, "I am giving you this notice because of the reason checked below:");
    doc.moveDown(0.1);
    addCheckbox(doc, true, "Reason 1 (subsection 58(1)1): You have persistently failed to pay rent on the date it becomes due and payable.");

    addPart(doc, 5, "History of Late Rent Payments");
    addParagraph(doc, "The following is a record of late rent payments:");
    doc.moveDown(0.3);

    // Table header
    const tableTop = doc.y;
    doc.fontSize(8).font("Helvetica-Bold");
    doc.text("Rental Period", 60, tableTop, { width: 150 });
    doc.text("Date Rent Due", 215, tableTop, { width: 140, align: "center" });
    doc.text("Date Actually Paid", 365, tableTop, { width: 160, align: "center" });
    doc.moveDown(0.4);
    doc.moveTo(55, doc.y).lineTo(540, doc.y).lineWidth(0.5).stroke();
    doc.moveDown(0.3);

    doc.font("Helvetica").fontSize(8);
    for (const row of data.latePayments) {
        const rowY = doc.y;
        doc.text(row.period, 60, rowY, { width: 150 });
        doc.text(row.dueDate, 215, rowY, { width: 140, align: "center" });
        doc.text(row.datePaid, 365, rowY, { width: 160, align: "center" });
        doc.moveDown(0.5);
    }
    doc.moveTo(55, doc.y).lineTo(540, doc.y).lineWidth(0.5).stroke();

    addPart(doc, 6, "Termination Date");
    addField(doc, "Termination Date:", data.terminationDate, 55);
    addParagraph(doc, "The termination date must be at the end of a rental period (e.g. the last day of the month) and at least 60 days after this notice is given.");

    addPart(doc, 7, "What the Tenant Can Do");
    addParagraph(doc, "THIS NOTICE CANNOT BE VOIDED BY PAYING ARREARS.");
    doc.moveDown(0.1);
    addBullet(doc, "Unlike an N4 notice, this notice cannot be voided by paying the rent arrears. The landlord is seeking to end the tenancy because of a persistent pattern of late payments.");
    addBullet(doc, "The landlord must apply to the LTB for an eviction order. You will receive a Notice of Hearing.");
    addBullet(doc, "At the hearing, you can explain the reasons for the late payments and present any evidence.");
    addBullet(doc, "The Board will consider all the circumstances, including whether the pattern is likely to continue, and may grant or refuse the eviction.");
    addBullet(doc, "You may contact the LTB at 1-888-332-3234 or visit tribunalsontario.ca/ltb.");

    addSignatureBlock(doc, data.signedBy, data.dateGiven);
    addLtbFooter(doc, "N8");

    doc.end();
    return result;
}

// ═══════════════════════════════════════════════════════════
//  N9 — Tenant's Notice to End the Tenancy
//  Residential Tenancies Act, 2006, Section 47
// ═══════════════════════════════════════════════════════════

export function generateN9Notice(data: N9Data): Promise<Buffer> {
    const doc = createDoc();
    const result = promiseFromDoc(doc);

    addLtbHeader(doc, "N9",
        "Tenant's Notice to End the Tenancy",
        "Section 47");

    addPart(doc, 1, "Address of the Rental Unit");
    addField(doc, "Address:", data.rentalUnitAddress, 55);

    addPart(doc, 2, "Tenant Information");
    addField(doc, "Tenant Name(s):", data.tenantName, 55);

    addPart(doc, 3, "Landlord Information");
    addField(doc, "Landlord Name:", data.landlordName, 55);
    if (data.landlordAddress) addField(doc, "Address:", data.landlordAddress, 55);
    if (data.landlordPhone) addField(doc, "Phone:", data.landlordPhone, 55);

    addPart(doc, 4, "Termination Date");
    addParagraph(doc, "I am giving this notice to end my tenancy. My termination date is:");
    addField(doc, "Termination Date:", data.terminationDate, 55);
    doc.moveDown(0.2);
    addParagraph(doc, "The termination date must meet the following requirements:");
    addBullet(doc, "For a monthly or yearly tenancy: at least 60 days after this notice is given, and must be the last day of a rental period.");
    addBullet(doc, "For a daily or weekly tenancy: at least 28 days after this notice is given, and must be the last day of a rental period.");
    addBullet(doc, "For a fixed-term tenancy: the termination date is the last day of the fixed term.");

    addPart(doc, 5, "Important Information");
    addBullet(doc, "Once this notice is given, the tenant must vacate the unit by the termination date.");
    addBullet(doc, "If the tenant does not vacate, the landlord can apply to the LTB for an eviction order without giving the tenant any further notice.");
    addBullet(doc, "The tenant and landlord may agree in writing to an earlier termination date.");
    addBullet(doc, "All tenants listed on the lease should sign this notice. If one tenant in a joint tenancy gives this notice, the tenancy ends for all tenants.");
    addBullet(doc, "Contact the LTB at 1-888-332-3234 or visit tribunalsontario.ca/ltb.");

    addSignatureBlock(doc, data.signedBy, data.dateGiven, "Signature of Tenant");
    addLtbFooter(doc, "N9");

    doc.end();
    return result;
}

// ═══════════════════════════════════════════════════════════
//  N10 — Agreement to Increase the Rent Above the Guideline
//  Residential Tenancies Act, 2006, Section 121
// ═══════════════════════════════════════════════════════════

export function generateN10Notice(data: N10Data): Promise<Buffer> {
    const doc = createDoc();
    const result = promiseFromDoc(doc);

    addLtbHeader(doc, "N10",
        "Agreement to Increase the Rent Above the Guideline",
        "Section 121");

    addLandlordTenantInfo(doc, data);

    addPart(doc, 4, "Reason for the Above-Guideline Increase");
    addParagraph(doc, "The landlord and tenant agree to an above-guideline rent increase for the following reason(s):");
    doc.moveDown(0.1);
    addCheckbox(doc, data.reason === "capital_expenditure" || data.reason === "both",
        "Capital expenditure: The landlord has incurred or will incur an eligible capital expenditure for work done or to be done in the rental unit or residential complex.");
    addCheckbox(doc, data.reason === "new_or_additional_services" || data.reason === "both",
        "New or additional services: The landlord is providing or will provide a new or additional service in exchange for the rent increase.");

    addPart(doc, 5, "Details of the Work or Service");
    addParagraph(doc, data.details);

    addPart(doc, 6, "Rent Increase");
    addField(doc, "Current lawful rent (per month):", `$${data.currentRent.toFixed(2)}`, 55);
    addField(doc, "New rent (per month):", `$${data.newRent.toFixed(2)}`, 55);
    addField(doc, "Amount of increase:", `$${(data.newRent - data.currentRent).toFixed(2)}`, 55);
    addField(doc, "Date the increase takes effect:", data.effectiveDate, 55);

    addPart(doc, 7, "Information for the Tenant");
    addBullet(doc, "This is a voluntary agreement. A landlord cannot force a tenant to sign this form.");
    addBullet(doc, "You are not required to agree to an above-guideline rent increase. If you do not agree, the landlord may apply to the LTB for an above-guideline increase order under section 126.");
    addBullet(doc, "If you sign this agreement, you can still apply to the LTB for a rent reduction if the work is not completed or the service is not provided as agreed.");
    addBullet(doc, "You may contact the LTB at 1-888-332-3234 or visit tribunalsontario.ca/ltb.");

    addDualSignatureBlock(doc, data.signedBy, data.tenantSignedBy, data.dateGiven);
    addLtbFooter(doc, "N10");

    doc.end();
    return result;
}

// ═══════════════════════════════════════════════════════════
//  N11 — Agreement to End the Tenancy
//  Residential Tenancies Act, 2006, Section 77
// ═══════════════════════════════════════════════════════════

export function generateN11Notice(data: N11Data): Promise<Buffer> {
    const doc = createDoc();
    const result = promiseFromDoc(doc);

    addLtbHeader(doc, "N11",
        "Agreement to End the Tenancy",
        "Section 77");

    addLandlordTenantInfo(doc, data);

    addPart(doc, 4, "Agreement");
    addParagraph(doc, `The landlord and tenant agree that the tenancy for the rental unit described above will terminate on the date set out below.`);
    doc.moveDown(0.2);
    addField(doc, "Termination Date:", data.terminationDate, 55);

    addPart(doc, 5, "Important Information");
    addBullet(doc, "Both the landlord and tenant must sign this agreement for it to be valid.");
    addBullet(doc, "If the tenant does not move out by the termination date, the landlord can apply to the Landlord and Tenant Board (LTB) for an eviction order without giving the tenant any further notice of termination.");
    addBullet(doc, "The tenant may be able to set aside this agreement if they can show they were coerced or misled into signing it.");
    addBullet(doc, "If this agreement was entered into because the landlord gave the tenant an N12 or N13 notice, the tenant can change their mind and stay if they give the landlord written notice before the termination date.");
    addBullet(doc, "Neither party should feel pressured into signing. If coercion occurred, advise the LTB.");
    addBullet(doc, "Contact the LTB at 1-888-332-3234 or visit tribunalsontario.ca/ltb.");

    addDualSignatureBlock(doc, data.signedBy, data.tenantSignedBy, data.dateGiven);
    addLtbFooter(doc, "N11");

    doc.end();
    return result;
}

// ═══════════════════════════════════════════════════════════
//  N12 — Notice to End Tenancy Because the Landlord, a Purchaser
//        or a Family Member Requires the Rental Unit
//  Residential Tenancies Act, 2006, Sections 48, 49
// ═══════════════════════════════════════════════════════════

export function generateN12Notice(data: N12Data): Promise<Buffer> {
    const doc = createDoc();
    const result = promiseFromDoc(doc);

    addLtbHeader(doc, "N12",
        "Notice to End your Tenancy Because the Landlord, a Purchaser or a Family Member Requires the Rental Unit",
        "Sections 48, 49");

    addLandlordTenantInfo(doc, data);

    addPart(doc, 4, "Reason for This Notice");
    addParagraph(doc, "I am giving you this notice because of the reason checked below:");
    doc.moveDown(0.1);
    addCheckbox(doc, data.reason === "personal_use",
        "Reason 1 (section 48): I, the landlord, in good faith require possession of the rental unit for residential occupation by myself.");
    addCheckbox(doc, data.reason === "family_use",
        `Reason 2 (section 48): I, the landlord, in good faith require possession of the rental unit for residential occupation by a member of my immediate family: ${data.occupantName}${data.relationship ? ` (${data.relationship})` : ""}.`);
    addCheckbox(doc, data.reason === "purchaser_use",
        `Reason 3 (section 49): A purchaser of the residential complex or unit, in good faith, requires possession of the rental unit for the purchaser's own residential occupation: ${data.occupantName}.`);

    addPart(doc, 5, "Person Who Will Occupy the Unit");
    addField(doc, "Name:", data.occupantName, 55);
    if (data.relationship) addField(doc, "Relationship to Landlord:", data.relationship, 55);

    addPart(doc, 6, "Termination Date");
    addField(doc, "Termination Date:", data.terminationDate, 55);
    addParagraph(doc, "The termination date must be at least 60 days after the date this notice is given to the tenant. The termination date must also be the last day of a rental period (e.g. the last day of the month if rent is paid monthly).");

    addPart(doc, 7, "Compensation");
    addParagraph(doc, "Under the Residential Tenancies Act, 2006, the landlord must compensate the tenant in an amount equal to one month's rent, or offer the tenant another rental unit that is acceptable to the tenant. The compensation must be paid no later than the termination date in this notice. If the landlord does not pay the compensation, the notice is void.");

    addPart(doc, 8, "What the Tenant Can Do");
    addParagraph(doc, "THE TENANT DOES NOT HAVE TO MOVE OUT.");
    doc.moveDown(0.1);
    addBullet(doc, "The landlord must apply to the LTB for an eviction order. You will receive a copy of the application and a Notice of Hearing.");
    addBullet(doc, "You can attend the hearing and present evidence. The Board will decide if the landlord's application should be granted.");
    addBullet(doc, "If you believe the landlord is acting in bad faith (not genuinely intending to occupy the unit), raise this at the hearing.");
    addBullet(doc, "Under Ontario law (Protecting Tenants and Strengthening Community Housing Act), bad-faith N12 evictions carry administrative penalties of up to $50,000 for individuals and $250,000 for corporations.");
    addBullet(doc, "You are entitled to one month's rent compensation. Ensure it is paid by the termination date.");
    addBullet(doc, "Contact the LTB at 1-888-332-3234 or visit tribunalsontario.ca/ltb.");

    addPart(doc, 9, "Declaration");
    addParagraph(doc, "I declare that I have given this notice in good faith and that the person named above genuinely intends to occupy the rental unit for residential purposes for a period of at least one year.");

    addSignatureBlock(doc, data.signedBy, data.dateGiven);
    addLtbFooter(doc, "N12");

    doc.end();
    return result;
}

// ═══════════════════════════════════════════════════════════
//  N13 — Notice to End Tenancy Because the Landlord Wants to
//        Demolish, Repair or Convert the Rental Unit
//  Residential Tenancies Act, 2006, Section 50
// ═══════════════════════════════════════════════════════════

export function generateN13Notice(data: N13Data): Promise<Buffer> {
    const doc = createDoc();
    const result = promiseFromDoc(doc);

    addLtbHeader(doc, "N13",
        "Notice to End your Tenancy Because the Landlord Wants to Demolish the Rental Unit, Repair it or Convert it to Another Use",
        "Section 50");

    addLandlordTenantInfo(doc, data);

    addPart(doc, 4, "Reason for This Notice");
    addParagraph(doc, "I am giving you this notice because of the reason checked below:");
    doc.moveDown(0.1);
    addCheckbox(doc, data.reason === "demolition",
        "Reason 1 (subsection 50(1)(a)): I intend to demolish the residential complex or the rental unit.");
    addCheckbox(doc, data.reason === "repairs",
        "Reason 2 (subsection 50(1)(b)): I require the rental unit to be vacated in order to do repairs or renovations so extensive that they require a building permit AND vacant possession of the rental unit.");
    addCheckbox(doc, data.reason === "conversion",
        "Reason 3 (subsection 50(1)(c)): I intend to convert the rental unit or the residential complex to a use other than residential premises.");

    addPart(doc, 5, "Details");
    addParagraph(doc, "Describe the planned demolition, repairs, or conversion:");
    doc.moveDown(0.1);
    addParagraph(doc, data.details);

    addPart(doc, 6, "Termination Date");
    addField(doc, "Termination Date:", data.terminationDate, 55);
    addParagraph(doc, "The termination date must be at least 120 days after this notice is given and must be the last day of a rental period.");

    addPart(doc, 7, "Compensation and Right of First Refusal");
    addParagraph(doc, "The landlord must:");
    doc.moveDown(0.1);
    addBullet(doc, "Pay the tenant compensation equal to one month's rent, or offer the tenant another acceptable rental unit. The compensation must be paid no later than the termination date.");
    addBullet(doc, "For repairs/renovations (Reason 2): Also offer the tenant the right of first refusal to return to the rental unit at the same rent when the repairs are completed. The tenant must notify the landlord in writing before vacating that they wish to exercise this right.");

    addPart(doc, 8, "What the Tenant Can Do");
    addParagraph(doc, "THE TENANT DOES NOT HAVE TO MOVE OUT.");
    doc.moveDown(0.1);
    addBullet(doc, "The landlord must apply to the LTB for an eviction order. The Board will hold a hearing.");
    addBullet(doc, "The landlord must obtain the necessary permits before the Board will consider the application.");
    addBullet(doc, "You have the right to attend the hearing and challenge the application.");
    addBullet(doc, "The Board will assess whether the landlord genuinely intends to carry out the stated purpose.");
    addBullet(doc, "Bad-faith N13 evictions carry administrative penalties of up to $50,000 for individuals and $250,000 for corporations.");
    addBullet(doc, "Contact the LTB at 1-888-332-3234 or visit tribunalsontario.ca/ltb.");

    addSignatureBlock(doc, data.signedBy, data.dateGiven);
    addLtbFooter(doc, "N13");

    doc.end();
    return result;
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
