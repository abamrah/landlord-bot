/**
 * noticeService.ts — Fill Ontario LTB N-form PDF templates (N1–N14)
 *
 * Instead of generating our own PDFs, we autofill the official government
 * XFA-based PDF templates using pikepdf (Python) via child_process.
 * An LLM call is used for complex forms to intelligently map reason codes,
 * event details, and checkbox selections to the correct XFA field names.
 *
 * Official form registry (tribunalsontario.ca/ltb/forms/):
 *   N1  – Notice of Rent Increase (s. 116 RTA)
 *   N2  – Notice of Rent Increase – Unit Partially Exempt (s. 6(2), 120 RTA)
 *   N3  – Notice of Rent Increase – Care Home (s. 116 RTA)
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
 *   N14 – Notice to Spouse of Tenant who Vacated (s. 50 RTA)
 */

import { execFile } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { vertexAI, defaultModel } from "../config/gemini";

// ═══════════════════════════════════════════════════════════
//  SHARED SUB-INTERFACES
// ═══════════════════════════════════════════════════════════

/** Agent/representative information (shared across most forms) */
export interface AgentInfo {
    agentName?: string;
    agentLSUC?: string;
    agentCompany?: string;
    agentAddress?: string;
    agentPhone?: string;
    agentMunicipality?: string;
    agentProvince?: string;
    agentPostCode?: string;
    agentFax?: string;
}

/** Filing information (N5-N8, N10-N13) */
export interface FilingInfo {
    fileNumber?: string;
    /** "in_person" | "mail" | "courier" | "email" | "efile" | "fax" */
    deliveryMethod?: string;
    filingLocation?: string;
}

/** An incident event row (N5/N6/N7) */
export interface EventRow {
    dateTime: string;
    description: string;
}

// ═══════════════════════════════════════════════════════════
//  DATA INTERFACES
// ═══════════════════════════════════════════════════════════

export interface N1Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordPhone?: string;
    currentRent: number;
    newRent: number;
    /** Date the increase takes effect (must be ≥90 days from dateGiven) */
    effectiveDate: string;
    /** "at_or_below_guideline" | "above_guideline" */
    increaseType?: string;
    /** If above_guideline: "applied_to_ltb" | "intends_to_apply" */
    aboveGuidelineReason?: string;
    /** Above-guideline increase amount (if applicable) */
    aboveGuidelineAmount?: number;
    /** "monthly" | "weekly" | "other" */
    paymentPeriod?: string;
    otherPaymentPeriod?: string;
    dateGiven: string;
    signedBy: string;
    /** "landlord" | "representative" */
    signerType?: string;
    agent?: AgentInfo;
}

export interface N2Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordPhone?: string;
    currentRent: number;
    newRent: number;
    effectiveDate: string;
    /** "monthly" | "weekly" | "other" */
    paymentPeriod?: string;
    otherPaymentPeriod?: string;
    exemptionReason?: string;
    dateGiven: string;
    signedBy: string;
    signerType?: string;
    agent?: AgentInfo;
}

export interface N3Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordPhone?: string;
    currentRent: number;
    newRent: number;
    effectiveDate: string;
    /** Will rent increase? */
    rentWillIncrease?: boolean;
    /** "no_approval_needed" | "needs_ltb_approval" */
    rentIncreaseApproval?: string;
    /** Will care/meals charges increase? */
    careChargesIncrease?: boolean;
    /** New care/meals charge amount */
    newCareCharge?: number;
    /** Total new rent + care/meals */
    totalNewAmount?: number;
    /** "monthly" | "weekly" | "other" */
    paymentPeriod?: string;
    otherPaymentPeriod?: string;
    dateGiven: string;
    signedBy: string;
    signerType?: string;
    agent?: AgentInfo;
}

export interface N4Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordPhone?: string;
    rentOwing: Array<{
        periodFrom: string;
        periodTo: string;
        rentCharged: number;
        rentPaid: number;
        rentOwing: number;
    }>;
    totalOwing: number;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
    signerType?: string;
    agent?: AgentInfo;
}

export interface N5Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordPhone?: string;
    /** "interference" | "damage" | "overcrowding" */
    reason: string;
    /** Sub-reason details for the selected reason */
    subReason?: string;
    details: string;
    /** Amount owed for damage */
    damageAmount?: number;
    /** Other amount owed */
    otherAmount?: number;
    /** Overcrowding explanation */
    overcrowdingExplanation?: string;
    /** Incident events (up to 3) */
    events?: EventRow[];
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
    signerType?: string;
    agent?: AgentInfo;
    filing?: FilingInfo;
}

export interface N6Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordPhone?: string;
    /** "illegal_act_unit" | "illegal_act_complex" | "misrepresentation" */
    reason: string;
    details: string;
    /** Incident events (up to 3) */
    events?: EventRow[];
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
    signerType?: string;
    agent?: AgentInfo;
    filing?: FilingInfo;
}

export interface N7Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordPhone?: string;
    /** "impaired_safety" | "illegal_drugs_unit" | "illegal_drugs_complex" | "serious_impairment_complex" */
    reason?: string;
    details: string;
    /** Incident events (up to 3) */
    events?: EventRow[];
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
    signerType?: string;
    agent?: AgentInfo;
    filing?: FilingInfo;
}

export interface N8Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordPhone?: string;
    /** "persistent_late_payment" | "no_longer_qualifies_subsidized" | "employment_ended" | "no_longer_needs_rehab" | "gave_notice_didnt_move" */
    reason?: string;
    latePayments: Array<{
        period: string;
        dueDate: string;
        datePaid: string;
    }>;
    /** Free-text notice detail area */
    noticeDetail?: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
    signerType?: string;
    agent?: AgentInfo;
    filing?: FilingInfo;
}

export interface N9Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordPhone?: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
}

export interface N10Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
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
    filing?: FilingInfo;
}

export interface N11Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordPhone?: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
    tenantSignedBy: string;
    filing?: FilingInfo;
}

export interface N12Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordPhone?: string;
    /** "personal_use" | "family_use" | "purchaser_use" | "care_provider" */
    reason: "personal_use" | "family_use" | "purchaser_use" | "care_provider";
    /** Who will occupy — "me" | "spouse" | "child" | "parent" | "spouses_child" | "spouses_parent" */
    whoWillOccupy?: string;
    /** Is it a care provider scenario? */
    isCareProvider?: boolean;
    /** Who care is being provided for */
    careRecipient?: string;
    occupantName: string;
    relationship?: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
    signerType?: string;
    agent?: AgentInfo;
    filing?: FilingInfo;
}

export interface N13Data {
    tenantName: string;
    rentalUnitAddress: string;
    landlordName: string;
    landlordPhone?: string;
    /** "demolition" | "conversion" | "repairs" */
    reason: string;
    details: string;
    /** Separate work plan description */
    workPlan?: string;
    /** "obtained" | "will_obtain" | "not_needed" */
    permitsStatus?: string;
    terminationDate: string;
    dateGiven: string;
    signedBy: string;
    signerType?: string;
    agent?: AgentInfo;
    filing?: FilingInfo;
}

export interface N14Data {
    /** Spouse's name (to) */
    spouseName: string;
    /** Landlord name (from) */
    landlordName: string;
    landlordPhone?: string;
    rentalUnitAddress: string;
    /** Original tenant who vacated */
    originalTenantName: string;
    /** Date the rental period ends */
    periodEndDate: string;
    /** Date tenant moved out */
    moveOutDate: string;
    /** Date payment is due from spouse */
    paymentDueDate: string;
    /** Amount the tenant owes */
    amountOwed?: number;
    /** Current rent for the unit */
    currentRent?: number;
    /** Pay period: "daily" | "weekly" | "monthly" */
    payPeriod?: string;
    dateGiven: string;
    signedBy: string;
    signerType?: string;
    agent?: AgentInfo;
}

// ═══════════════════════════════════════════════════════════
//  TEMPLATE PATHS & PYTHON EXECUTABLE
// ═══════════════════════════════════════════════════════════

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const FORMS_DIR = path.join(PROJECT_ROOT, "N-forms");
const FILL_SCRIPT = path.join(PROJECT_ROOT, "scripts", "fill_xfa.py");

/** Resolve the Python executable — prefers the project venv, falls back to system */
function getPythonPath(): string {
    // Windows venv
    const venvWin = path.join(PROJECT_ROOT, ".venv", "Scripts", "python.exe");
    if (fs.existsSync(venvWin)) return venvWin;
    // Unix venv
    const venvUnix = path.join(PROJECT_ROOT, ".venv", "bin", "python");
    if (fs.existsSync(venvUnix)) return venvUnix;
    // System fallback
    return process.platform === "win32" ? "python" : "python3";
}

function getTemplatePath(formNumber: string): string {
    // Handle special case for N14 (long filename)
    if (formNumber === "N14") {
        const n14 = fs.readdirSync(FORMS_DIR).find(f => f.startsWith("N14") && f.endsWith(".pdf"));
        if (n14) return path.join(FORMS_DIR, n14);
    }
    return path.join(FORMS_DIR, `${formNumber}.pdf`);
}

// ═══════════════════════════════════════════════════════════
//  CORE: Fill XFA template via Python pikepdf
// ═══════════════════════════════════════════════════════════

/**
 * Fill an XFA PDF template by calling the Python fill_xfa.py script.
 * Returns the filled PDF as a Buffer.
 */
async function fillTemplate(formNumber: string, fields: Record<string, string>): Promise<Buffer> {
    const templatePath = getTemplatePath(formNumber);
    if (!fs.existsSync(templatePath)) {
        throw new Error(`Template not found: ${templatePath}`);
    }

    // Create a temp file for the output
    const tmpDir = os.tmpdir();
    const outputPath = path.join(tmpDir, `${formNumber}_${Date.now()}.pdf`);

    const input = JSON.stringify({
        template: templatePath,
        output: outputPath,
        fields,
    });

    return new Promise<Buffer>((resolve, reject) => {
        const pythonPath = getPythonPath();
        const proc = execFile(
            pythonPath,
            [FILL_SCRIPT],
            { maxBuffer: 10 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(`fill_xfa.py failed: ${stderr || err.message}`));
                    return;
                }
                try {
                    const result = JSON.parse(stdout.trim());
                    if (result.error) {
                        reject(new Error(`fill_xfa.py error: ${result.error}`));
                        return;
                    }
                    const pdfBuffer = fs.readFileSync(outputPath);
                    // Clean up temp file
                    try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
                    resolve(pdfBuffer);
                } catch (parseErr) {
                    reject(new Error(`Failed to parse fill_xfa.py output: ${stdout}`));
                }
            }
        );

        proc.stdin?.write(input);
        proc.stdin?.end();
    });
}

// ═══════════════════════════════════════════════════════════
//  LLM-ASSISTED FIELD MAPPING
// ═══════════════════════════════════════════════════════════

/**
 * Use Gemini LLM to intelligently map complex form data to XFA fields.
 * Used for forms with radio buttons, checkboxes, and complex reason
 * selections where simple deterministic mapping may be insufficient.
 */
async function llmMapFields(
    formNumber: string,
    availableFields: string[],
    inputData: Record<string, any>,
    context: string
): Promise<Record<string, string>> {
    if (!vertexAI) {
        console.warn("[noticeService] LLM not available, falling back to deterministic mapping");
        return {};
    }

    const gemini = vertexAI.getGenerativeModel({ model: defaultModel });

    const prompt = `You are an expert at filling Ontario Landlord and Tenant Board (LTB) forms.

Given the following XFA form fields for Form ${formNumber} and the input data, determine the correct value for each field.

AVAILABLE XFA FIELDS:
${availableFields.map(f => `- ${f}`).join("\n")}

INPUT DATA:
${JSON.stringify(inputData, null, 2)}

CONTEXT ABOUT THIS FORM:
${context}

RULES:
- For text fields, provide the exact value to fill in
- For checkbox fields (values are "0" for unchecked, "1" for checked), determine which should be "1"
- For radio button groups (exclusion groups), provide the value that selects the correct option
- For date fields, use the format provided in the input data
- For money amounts, format as plain numbers (e.g. "1500.00")
- Only include fields that should have a non-empty value
- Field names must EXACTLY match the available fields listed above

Respond ONLY with a valid JSON object mapping field names to their values. No explanation, no markdown, just the JSON object.`;

    try {
        const result = await gemini.generateContent(prompt);
        const text = result.response.text().trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    } catch (err) {
        console.error(`[noticeService] LLM field mapping failed for ${formNumber}:`, err);
    }

    return {};
}

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════

function splitName(fullName: string): { first: string; last: string } {
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 1) return { first: parts[0], last: "" };
    return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** Add agent/representative fields to the field map */
function addAgentFields(fields: Record<string, string>, agent?: AgentInfo): void {
    if (!agent) return;
    if (agent.agentName) fields.AgentName = agent.agentName;
    if (agent.agentLSUC) fields.AgentLSUC = agent.agentLSUC;
    if (agent.agentCompany) fields.AgentCompany = agent.agentCompany;
    if (agent.agentAddress) fields.AgentAddress = agent.agentAddress;
    if (agent.agentPhone) fields.AgentPhoneNum = agent.agentPhone;
    if (agent.agentMunicipality) fields.AgentMunicipality = agent.agentMunicipality;
    if (agent.agentProvince) fields.AgentProvince = agent.agentProvince;
    if (agent.agentPostCode) fields.AgentPostCode = agent.agentPostCode;
    if (agent.agentFax) fields.AgentFaxNum = agent.agentFax;
}

/** Add filing info fields to the field map */
function addFilingFields(fields: Record<string, string>, filing?: FilingInfo): void {
    if (!filing) return;
    if (filing.fileNumber) fields.FileNumber = filing.fileNumber;
    if (filing.deliveryMethod) fields.DeliveryMethod = filing.deliveryMethod;
    if (filing.filingLocation) fields.FilingLocation = filing.filingLocation;
}

/** Map signer type to SelectSign radio value */
function signerTypeValue(signerType?: string): string {
    // "1" = landlord, "2" = representative
    return signerType === "representative" ? "2" : "1";
}

/** Add event rows to Table2 fields */
function addEventRows(fields: Record<string, string>, events?: EventRow[]): void {
    if (!events) return;
    events.forEach((ev, i) => {
        const rowNum = i + 1;
        if (rowNum > 3) return;
        fields[`Table2.Row${rowNum}.EventDateTime${rowNum}`] = ev.dateTime;
        fields[`Table2.Row${rowNum}.Event${rowNum}`] = ev.description;
    });
}

// ═══════════════════════════════════════════════════════════
//  FORM-SPECIFIC GENERATORS
// ═══════════════════════════════════════════════════════════

/**
 * N1 — Notice of Rent Increase
 * XFA fields: To_TenantName, From_LandlordName, RentUnitAddress, StartDate,
 *   RentIncAmount1, RentIncAmount2, RentIncPercent, PaymentPeriodM, OtherSpecify,
 *   Check1, Check2, Check_2_1, Check_2_2, SelectSign, SignName, SignPhoneNum,
 *   Signature, SignDate, Agent block (9 fields)
 */
export async function generateN1Notice(data: N1Data): Promise<Buffer> {
    const increase = data.newRent - data.currentRent;
    const pct = ((increase / data.currentRent) * 100).toFixed(2);

    const fields: Record<string, string> = {
        To_TenantName: data.tenantName,
        From_LandlordName: data.landlordName,
        RentUnitAddress: data.rentalUnitAddress,
        StartDate: data.effectiveDate,
        RentIncAmount1: data.newRent.toFixed(2),
        RentIncPercent: pct,
        SelectSign: signerTypeValue(data.signerType),
        SignName: data.signedBy,
        SignPhoneNum: data.landlordPhone || "",
        SignDate: data.dateGiven,
    };

    // Increase type checkboxes
    if (data.increaseType === "above_guideline") {
        fields.Check2 = "1";
        if (data.aboveGuidelineAmount != null) {
            fields.RentIncAmount2 = data.aboveGuidelineAmount.toFixed(2);
        }
        if (data.aboveGuidelineReason === "applied_to_ltb") fields.Check_2_1 = "1";
        else if (data.aboveGuidelineReason === "intends_to_apply") fields.Check_2_2 = "1";
    } else {
        fields.Check1 = "1"; // at or below guideline
    }

    // Payment period
    if (data.paymentPeriod === "weekly") {
        fields.PaymentPeriodM = "2";
    } else if (data.paymentPeriod === "other") {
        fields.PaymentPeriodM = "3";
        if (data.otherPaymentPeriod) fields.OtherSpecify = data.otherPaymentPeriod;
    } else {
        fields.PaymentPeriodM = "1"; // monthly default
    }

    addAgentFields(fields, data.agent);
    return fillTemplate("N1", fields);
}

/**
 * N2 — Notice of Rent Increase – Unit Partially Exempt
 * XFA fields: To_TenantName, From_LandlordName, RentUnitAddress, StratDate (official typo),
 *   RentIncAmount1, PaymentPeriodM, OtherSpecify, SelectSign, SignName, SignPhoneNum,
 *   Signature, SignDate, Agent block
 */
export async function generateN2Notice(data: N2Data): Promise<Buffer> {
    const fields: Record<string, string> = {
        To_TenantName: data.tenantName,
        From_LandlordName: data.landlordName,
        RentUnitAddress: data.rentalUnitAddress,
        StratDate: data.effectiveDate,  // Note: official form has typo "Strat"
        RentIncAmount1: data.newRent.toFixed(2),
        SelectSign: signerTypeValue(data.signerType),
        SignName: data.signedBy,
        SignPhoneNum: data.landlordPhone || "",
        SignDate: data.dateGiven,
    };

    // Payment period
    if (data.paymentPeriod === "weekly") {
        fields.PaymentPeriodM = "2";
    } else if (data.paymentPeriod === "other") {
        fields.PaymentPeriodM = "3";
        if (data.otherPaymentPeriod) fields.OtherSpecify = data.otherPaymentPeriod;
    } else {
        fields.PaymentPeriodM = "1";
    }

    addAgentFields(fields, data.agent);
    return fillTemplate("N2", fields);
}

/**
 * N3 — Notice of Rent Increase (Care Home)
 * XFA fields: To_TenantName, From_LandlordName, RentUnitAddress, StartDate,
 *   Check_1, Check_1_1, Check_1_2, Check_2, RentIncAmount1, RentIncAmount2,
 *   RentIncAmount3, PaymentPeriodM (x3), OtherSpecify (x3),
 *   SelectSign, SignName, SignPhoneNum, Signature, SignDate, Agent block
 */
export async function generateN3Notice(data: N3Data): Promise<Buffer> {
    const fields: Record<string, string> = {
        To_TenantName: data.tenantName,
        From_LandlordName: data.landlordName,
        RentUnitAddress: data.rentalUnitAddress,
        StartDate: data.effectiveDate,
        RentIncAmount1: data.newRent.toFixed(2),
        SelectSign: signerTypeValue(data.signerType),
        SignName: data.signedBy,
        SignPhoneNum: data.landlordPhone || "",
        SignDate: data.dateGiven,
    };

    // Rent increase checkboxes
    if (data.rentWillIncrease !== false) {
        fields.Check_1 = "1";
        if (data.rentIncreaseApproval === "needs_ltb_approval") {
            fields.Check_1_2 = "1";
        } else {
            fields.Check_1_1 = "1"; // no approval needed
        }
    }

    // Care/meals charge increase
    if (data.careChargesIncrease) {
        fields.Check_2 = "1";
        if (data.newCareCharge != null) fields.RentIncAmount2 = data.newCareCharge.toFixed(2);
    }

    // Total
    if (data.totalNewAmount != null) {
        fields.RentIncAmount3 = data.totalNewAmount.toFixed(2);
    }

    // Payment period
    if (data.paymentPeriod === "weekly") {
        fields.PaymentPeriodM = "2";
    } else if (data.paymentPeriod === "other") {
        fields.PaymentPeriodM = "3";
        if (data.otherPaymentPeriod) fields.OtherSpecify = data.otherPaymentPeriod;
    } else {
        fields.PaymentPeriodM = "1";
    }

    addAgentFields(fields, data.agent);
    return fillTemplate("N3", fields);
}

/**
 * N4 — Notice to End Tenancy Early for Non-payment of Rent
 * XFA fields: CheckList1-7, TO_TenameName, From_LandlordName, RentalUnitAddress,
 *   OweMeAmount, PayDate, Table1.Row1-3 (ArrearFrom/To, RentCharge/Paid/Owe),
 *   TotalRentOwe, SelectSign, RFirstName, RLastName, RDayPhone, Signature, SignDate,
 *   Agent block
 */
export async function generateN4Notice(data: N4Data): Promise<Buffer> {
    const { first, last } = splitName(data.signedBy);

    const fields: Record<string, string> = {
        // Checklist items — landlord confirms compliance
        CheckList1: "1",
        CheckList2: "1",
        CheckList3: "1",
        CheckList4: "1",
        CheckList5: "1",
        CheckList6: "1",
        CheckList7: "1",
        TO_TenameName: data.tenantName,
        From_LandlordName: data.landlordName,
        RentalUnitAddress: data.rentalUnitAddress,
        OweMeAmount: data.totalOwing.toFixed(2),
        PayDate: data.terminationDate,
        TotalRentOwe: data.totalOwing.toFixed(2),
        SelectSign: signerTypeValue(data.signerType),
        RFirstName: first,
        RLastName: last,
        RDayPhone: data.landlordPhone || "",
        SignDate: data.dateGiven,
    };

    // Fill rent arrears table rows (up to 3)
    data.rentOwing.forEach((row, i) => {
        const rowNum = i + 1;
        if (rowNum > 3) return;
        const prefix = `Table1.Row${rowNum}`;
        fields[`${prefix}.ArrearFrom${rowNum}`] = row.periodFrom || "";
        fields[`${prefix}.ArrearTo${rowNum}`] = row.periodTo || "";
        fields[`${prefix}.RentCharge${rowNum}`] = row.rentCharged.toFixed(2);
        fields[`${prefix}.RentPaid${rowNum}`] = row.rentPaid.toFixed(2);
        fields[`${prefix}.RentOwe${rowNum}`] = row.rentOwing.toFixed(2);
    });

    addAgentFields(fields, data.agent);
    return fillTemplate("N4", fields);
}

/**
 * N5 — Notice to End Tenancy for Interfering, Damage or Overcrowding
 * XFA fields: TO_TenameName, From_LandlordName, RentalUnitAddress,
 *   TerminationDate, Reason1, Reason1_1, Reason2, Reason2_1, Reason2_2,
 *   Reason3, Reason3_1, Reason3_2, Reason3Explain,
 *   PayMe1, PayMe2, Table2.Row1-3 (EventDateTime/Event),
 *   SelectSign, RFirstName, RLastName, RDayPhone, Signature, SignDate,
 *   Agent block, Filing block
 */
export async function generateN5Notice(data: N5Data): Promise<Buffer> {
    const { first, last } = splitName(data.signedBy);

    const fields: Record<string, string> = {
        TO_TenameName: data.tenantName,
        From_LandlordName: data.landlordName,
        RentalUnitAddress: data.rentalUnitAddress,
        TerminationDate: data.terminationDate,
        SelectSign: signerTypeValue(data.signerType),
        RFirstName: first,
        RLastName: last,
        RDayPhone: data.landlordPhone || "",
        SignDate: data.dateGiven,
    };

    // Use LLM to map reason + details → checkboxes & event rows
    const availableFields = [
        "Reason1", "Reason1_1", "Reason2", "Reason2_1", "Reason2_2",
        "PayMe1", "PayMe2", "Reason3", "Reason3_1", "Reason3_2", "Reason3Explain",
        "Table2.Row1.EventDateTime1", "Table2.Row1.Event1",
        "Table2.Row2.EventDateTime2", "Table2.Row2.Event2",
        "Table2.Row3.EventDateTime3", "Table2.Row3.Event3",
    ];

    const llmContext = `Form N5 – Notice to End Tenancy for Interfering with Others, Damage, or Overcrowding.
Reason1 = "1": Tenant/guest has substantially interfered with reasonable enjoyment or lawful rights.
  Reason1_1 = "1": Tenant has 7 days to stop activities.
Reason2 = "1": Tenant/guest has wilfully or negligently caused undue damage.
  Reason2_1 = "1": Tenant has 7 days to correct problem.
  Reason2_2 = "1": Can apply to Board immediately (2nd notice).
Reason3 = "1": Number of persons in the unit exceeds health/safety/housing standards.
  Reason3_1 = "1": Tenant has 7 days to reduce occupants.
  Reason3_2 = "1": Other sub-reason.
  Reason3Explain = overcrowding explanation text.
PayMe1 = amount owed for damage ($).
PayMe2 = other amount owed ($).
EventDateTime1-3 and Event1-3: dates and descriptions of incidents.
User reason code "${data.reason}" → interference→Reason1, damage→Reason2, overcrowding→Reason3.
User sub-reason: "${data.subReason || ""}"
User details: "${data.details}"
User events: ${JSON.stringify(data.events || [])}`;

    const llmFields = await llmMapFields("N5", availableFields, {
        reason: data.reason, details: data.details, events: data.events || [],
        damageAmount: data.damageAmount, otherAmount: data.otherAmount,
        overcrowdingExplanation: data.overcrowdingExplanation,
        subReason: data.subReason,
    }, llmContext);

    Object.assign(fields, llmFields);

    // Deterministic fallback for reasons
    if (!fields.Reason1 && !fields.Reason2 && !fields.Reason3) {
        if (data.reason === "interference") {
            fields.Reason1 = "1";
            fields.Reason1_1 = "1";
        } else if (data.reason === "damage") {
            fields.Reason2 = "1";
            fields.Reason2_1 = "1";
        } else if (data.reason === "overcrowding") {
            fields.Reason3 = "1";
            fields.Reason3_1 = "1";
        }
    }

    // Deterministic fallback for amounts
    if (data.damageAmount != null && !fields.PayMe1) {
        fields.PayMe1 = data.damageAmount.toFixed(2);
    }
    if (data.otherAmount != null && !fields.PayMe2) {
        fields.PayMe2 = data.otherAmount.toFixed(2);
    }
    if (data.overcrowdingExplanation && !fields.Reason3Explain) {
        fields.Reason3Explain = data.overcrowdingExplanation;
    }

    // Deterministic fallback for events
    if (!fields["Table2.Row1.Event1"]) {
        if (data.events && data.events.length > 0) {
            addEventRows(fields, data.events);
        } else if (data.details) {
            fields["Table2.Row1.EventDateTime1"] = data.dateGiven;
            fields["Table2.Row1.Event1"] = data.details;
        }
    }

    addAgentFields(fields, data.agent);
    addFilingFields(fields, data.filing);
    return fillTemplate("N5", fields);
}

/**
 * N6 — Notice to End Tenancy for Illegal Acts or Misrepresenting Income
 * XFA fields: TO_TenameName, From_LandlordName, RentalUnitAddress,
 *   TerminationDate, Reason1, Reason2, Reason3, Table2.Row1-3 (EventDateTime/Event),
 *   SelectSign, RFirstName, RLastName, RDayPhone, Signature, SignDate,
 *   Agent block, Filing block
 */
export async function generateN6Notice(data: N6Data): Promise<Buffer> {
    const { first, last } = splitName(data.signedBy);

    const fields: Record<string, string> = {
        TO_TenameName: data.tenantName,
        From_LandlordName: data.landlordName,
        RentalUnitAddress: data.rentalUnitAddress,
        TerminationDate: data.terminationDate,
        SelectSign: signerTypeValue(data.signerType),
        RFirstName: first,
        RLastName: last,
        RDayPhone: data.landlordPhone || "",
        SignDate: data.dateGiven,
    };

    // LLM for reason mapping
    const availableFields = [
        "Reason1", "Reason2", "Reason3",
        "Table2.Row1.EventDateTime1", "Table2.Row1.Event1",
        "Table2.Row2.EventDateTime2", "Table2.Row2.Event2",
        "Table2.Row3.EventDateTime3", "Table2.Row3.Event3",
    ];

    const llmContext = `Form N6 – Illegal Acts or Misrepresenting Income.
Reason1 = "1": Illegal act or business at the rental unit.
Reason2 = "1": Illegal act or business at the residential complex.
Reason3 = "1": Misrepresented income in rent-geared-to-income unit.
User reason "${data.reason}" → illegal_act_unit→Reason1, illegal_act_complex→Reason2, illegal_act→Reason1, misrepresentation→Reason3.
User details: "${data.details}"
User events: ${JSON.stringify(data.events || [])}`;

    const llmFields = await llmMapFields("N6", availableFields, {
        reason: data.reason, details: data.details, events: data.events || [],
    }, llmContext);

    Object.assign(fields, llmFields);

    // Deterministic fallback
    if (!fields.Reason1 && !fields.Reason2 && !fields.Reason3) {
        if (data.reason === "illegal_act_unit" || data.reason === "illegal_act") fields.Reason1 = "1";
        else if (data.reason === "illegal_act_complex") fields.Reason2 = "1";
        else if (data.reason === "misrepresentation") fields.Reason3 = "1";
    }

    // Deterministic fallback for events
    if (!fields["Table2.Row1.Event1"]) {
        if (data.events && data.events.length > 0) {
            addEventRows(fields, data.events);
        } else if (data.details) {
            fields["Table2.Row1.EventDateTime1"] = data.dateGiven;
            fields["Table2.Row1.Event1"] = data.details;
        }
    }

    addAgentFields(fields, data.agent);
    addFilingFields(fields, data.filing);
    return fillTemplate("N6", fields);
}

/**
 * N7 — Notice to End Tenancy for Causing Serious Problems
 * XFA fields: TO_TenameName, From_LandlordName, RentalUnitAddress,
 *   TerminationDate, Reason1-4, Table2.Row1-3 (EventDateTime/Event),
 *   SelectSign, RFirstName, RLastName, RDayPhone, Signature, SignDate,
 *   Agent block, Filing block
 */
export async function generateN7Notice(data: N7Data): Promise<Buffer> {
    const { first, last } = splitName(data.signedBy);

    const availableFields = [
        "Reason1", "Reason2", "Reason3", "Reason4",
        "Table2.Row1.EventDateTime1", "Table2.Row1.Event1",
        "Table2.Row2.EventDateTime2", "Table2.Row2.Event2",
        "Table2.Row3.EventDateTime3", "Table2.Row3.Event3",
    ];

    const llmContext = `Form N7 – Causing Serious Problems in the Rental Unit or Complex.
Reason1 = "1": Act/omission has seriously impaired the safety of another person.
Reason2 = "1": Illegal act involving production/trafficking/possession of illegal drugs.
Reason3 = "1": Illegal act involving use of rental unit for production/trafficking.
Reason4 = "1": Serious impairment of safety — act occurred in the residential complex.
User reason: "${data.reason || ""}"
impaired_safety→Reason1, illegal_drugs_unit→Reason2, illegal_drugs_complex→Reason3, serious_impairment_complex→Reason4.
User details: "${data.details}"
User events: ${JSON.stringify(data.events || [])}`;

    const llmFields = await llmMapFields("N7", availableFields, {
        reason: data.reason, details: data.details, events: data.events || [],
    }, llmContext);

    const fields: Record<string, string> = {
        TO_TenameName: data.tenantName,
        From_LandlordName: data.landlordName,
        RentalUnitAddress: data.rentalUnitAddress,
        TerminationDate: data.terminationDate,
        SelectSign: signerTypeValue(data.signerType),
        RFirstName: first,
        RLastName: last,
        RDayPhone: data.landlordPhone || "",
        SignDate: data.dateGiven,
        ...llmFields,
    };

    // Deterministic fallback
    if (!fields.Reason1 && !fields.Reason2 && !fields.Reason3 && !fields.Reason4) {
        if (data.reason === "impaired_safety") fields.Reason1 = "1";
        else if (data.reason === "illegal_drugs_unit") fields.Reason2 = "1";
        else if (data.reason === "illegal_drugs_complex") fields.Reason3 = "1";
        else if (data.reason === "serious_impairment_complex") fields.Reason4 = "1";
        else fields.Reason1 = "1"; // default
    }

    // Deterministic fallback for events
    if (!fields["Table2.Row1.Event1"]) {
        if (data.events && data.events.length > 0) {
            addEventRows(fields, data.events);
        } else if (data.details) {
            fields["Table2.Row1.EventDateTime1"] = data.dateGiven;
            fields["Table2.Row1.Event1"] = data.details;
        }
    }

    addAgentFields(fields, data.agent);
    addFilingFields(fields, data.filing);
    return fillTemplate("N7", fields);
}

/**
 * N8 — Notice to End Tenancy at the End of the Term
 * XFA fields: TO_TenameName, From_LandlordName, RentalUnitAddress,
 *   TerminationDate, Reason1-5, NoticeDetail, SelectSign, RFirstName,
 *   RLastName, RDayPhone, Signature, SignDate, Agent block, Filing block
 */
export async function generateN8Notice(data: N8Data): Promise<Buffer> {
    const { first, last } = splitName(data.signedBy);

    const availableFields = [
        "Reason1", "Reason2", "Reason3", "Reason4", "Reason5", "NoticeDetail",
    ];

    const llmContext = `Form N8 – End Tenancy at End of Term.
Reason1 = "1": Persistent late payment of rent.
Reason2 = "1": Tenant no longer qualifies for subsidized housing.
Reason3 = "1": Employment-based tenancy; employment has ended.
Reason4 = "1": Tenant no longer needs rehabilitation/therapy services.
Reason5 = "1": Tenant gave 30-day notice but didn't move out.
User reason: "${data.reason || ""}"
persistent_late_payment→Reason1, no_longer_qualifies_subsidized→Reason2, employment_ended→Reason3,
no_longer_needs_rehab→Reason4, gave_notice_didnt_move→Reason5.
Late payments: ${JSON.stringify(data.latePayments)}
Notice detail: "${data.noticeDetail || ""}"`;

    const llmFields = await llmMapFields("N8", availableFields, {
        reason: data.reason, latePayments: data.latePayments, noticeDetail: data.noticeDetail,
    }, llmContext);

    const fields: Record<string, string> = {
        TO_TenameName: data.tenantName,
        From_LandlordName: data.landlordName,
        RentalUnitAddress: data.rentalUnitAddress,
        TerminationDate: data.terminationDate,
        SelectSign: signerTypeValue(data.signerType),
        RFirstName: first,
        RLastName: last,
        RDayPhone: data.landlordPhone || "",
        SignDate: data.dateGiven,
        ...llmFields,
    };

    // Deterministic fallback: reason
    if (!fields.Reason1 && !fields.Reason2 && !fields.Reason3 && !fields.Reason4 && !fields.Reason5) {
        if (data.reason === "no_longer_qualifies_subsidized") fields.Reason2 = "1";
        else if (data.reason === "employment_ended") fields.Reason3 = "1";
        else if (data.reason === "no_longer_needs_rehab") fields.Reason4 = "1";
        else if (data.reason === "gave_notice_didnt_move") fields.Reason5 = "1";
        else fields.Reason1 = "1"; // persistent late payment default
    }

    // Deterministic fallback: notice detail
    if (!fields.NoticeDetail) {
        if (data.noticeDetail) {
            fields.NoticeDetail = data.noticeDetail;
        } else if (data.latePayments.length > 0) {
            fields.NoticeDetail = data.latePayments
                .map(lp => `Period: ${lp.period}, Due: ${lp.dueDate}, Paid: ${lp.datePaid}`)
                .join("; ");
        }
    }

    addAgentFields(fields, data.agent);
    addFilingFields(fields, data.filing);
    return fillTemplate("N8", fields);
}

/**
 * N9 — Tenant's Notice to End the Tenancy
 * Note: N9 template not in standard LTB bundle; re-uses N11 template
 * Fields: TO_TenameName, RentalUnitAddress, EndDate, RFirstName, RLastName, RDayPhone, SignDate
 */
export async function generateN9Notice(data: N9Data): Promise<Buffer> {
    const { first, last } = splitName(data.tenantName);

    const fields: Record<string, string> = {
        // N9 is FROM tenant TO landlord (reversed)
        TO_TenameName: data.landlordName,
        From_LandlordName: data.tenantName,
        RentalUnitAddress: data.rentalUnitAddress,
        EndDate: data.terminationDate,
        TerminationDate: data.terminationDate,
        RFirstName: first,
        RLastName: last,
        RDayPhone: data.landlordPhone || "",
        SignDate: data.dateGiven,
    };

    // Use N11 template since N9 isn't in the government bundle
    return fillTemplate("N11", fields);
}

/**
 * N10 — Agreement to Increase the Rent Above the Guideline
 * XFA fields: To_TenantName, From_LandlordName, RentUnitAddress,
 *   TerminationDate, RentIncAmount1, RentIncPeriod1, WorkDetail,
 *   RFirstName (x2), RLastName (x2), RDayPhone (x2), Signature (x2),
 *   SignDate (x2), Filing block
 */
export async function generateN10Notice(data: N10Data): Promise<Buffer> {
    const tenantParts = splitName(data.tenantSignedBy);
    const increase = data.newRent - data.currentRent;

    const fields: Record<string, string> = {
        To_TenantName: data.tenantName,
        From_LandlordName: data.landlordName,
        RentUnitAddress: data.rentalUnitAddress,
        TerminationDate: data.effectiveDate,
        RentIncAmount1: increase.toFixed(2),
        RentIncPeriod1: "Monthly",
        WorkDetail: data.details,
        // First signature block (tenant)
        RFirstName: tenantParts.first,
        RLastName: tenantParts.last,
        RDayPhone: "",
        SignDate: data.dateGiven,
    };

    addFilingFields(fields, data.filing);
    return fillTemplate("N10", fields);
}

/**
 * N11 — Agreement to End the Tenancy
 * XFA fields: TO_TenameName, From_LandlordName, RentalUnitAddress,
 *   EndDate, RFirstName (x2), RLastName (x2), RDayPhone (x2), Signature (x2),
 *   SignDate (x2), Filing block
 */
export async function generateN11Notice(data: N11Data): Promise<Buffer> {
    const landlordParts = splitName(data.signedBy);

    const fields: Record<string, string> = {
        TO_TenameName: data.tenantName,
        From_LandlordName: data.landlordName,
        RentalUnitAddress: data.rentalUnitAddress,
        EndDate: data.terminationDate,
        RFirstName: landlordParts.first,
        RLastName: landlordParts.last,
        RDayPhone: data.landlordPhone || "",
        SignDate: data.dateGiven,
    };

    addFilingFields(fields, data.filing);
    return fillTemplate("N11", fields);
}

/**
 * N12 — Notice to End Tenancy – Landlord/Purchaser/Family Own Use
 * XFA fields: TO_TenameName, From_LandlordName, RentalUnitAddress,
 *   TerminationDate, Reason1 (radio), Reason1_A1-A6, Reason1_B, Reason1_B1-B6,
 *   Reason2 (radio), Reason2_A1-A6, Reason2_B, Reason2_B1-B6,
 *   SelectSign, RFirstName, RLastName, RDayPhone, Signature, SignDate,
 *   Agent block, Filing block
 */
export async function generateN12Notice(data: N12Data): Promise<Buffer> {
    const { first, last } = splitName(data.signedBy);

    // LLM for the complex reason/checkbox mapping
    const availableFields = [
        "Reason1", "Reason1_A1", "Reason1_A2", "Reason1_A3", "Reason1_A4", "Reason1_A5", "Reason1_A6",
        "Reason1_B", "Reason1_B1", "Reason1_B2", "Reason1_B3", "Reason1_B4", "Reason1_B5", "Reason1_B6",
        "Reason2", "Reason2_A1", "Reason2_A2", "Reason2_A3", "Reason2_A4", "Reason2_A5", "Reason2_A6",
        "Reason2_B", "Reason2_B1", "Reason2_B2", "Reason2_B3", "Reason2_B4", "Reason2_B5", "Reason2_B6",
    ];

    const llmContext = `Form N12 – Landlord/Purchaser/Family Own Use.
Reason1 (radio) = Section 48(1): Landlord requires unit for own/family use.
  A1="1": Landlord themselves | A2="1": Spouse | A3="1": Child | A4="1": Parent
  A5="1": Spouse's child | A6="1": Spouse's parent
  B="1": Person providing care services to one of the above
  B1-B6: same as A1-A6 for care provider scenario
Reason2 (radio) = Section 49: Purchaser requires unit.
  A1-A6: Who will move in for purchaser
  B, B1-B6: care provider variant for purchaser

User: reason="${data.reason}", occupant="${data.occupantName}", relationship="${data.relationship || "N/A"}"
whoWillOccupy="${data.whoWillOccupy || "N/A"}", isCareProvider=${data.isCareProvider || false},
careRecipient="${data.careRecipient || "N/A"}"
personal_use → Reason1 + A1; family_use → Reason1 + appropriate A checkbox;
purchaser_use → Reason2 + appropriate A checkbox; care_provider → Reason1 or Reason2 + B + appropriate B checkbox.`;

    const llmFields = await llmMapFields("N12", availableFields, {
        reason: data.reason, occupantName: data.occupantName, relationship: data.relationship,
        whoWillOccupy: data.whoWillOccupy, isCareProvider: data.isCareProvider, careRecipient: data.careRecipient,
    }, llmContext);

    const fields: Record<string, string> = {
        TO_TenameName: data.tenantName,
        From_LandlordName: data.landlordName,
        RentalUnitAddress: data.rentalUnitAddress,
        TerminationDate: data.terminationDate,
        SelectSign: signerTypeValue(data.signerType),
        RFirstName: first,
        RLastName: last,
        RDayPhone: data.landlordPhone || "",
        SignDate: data.dateGiven,
        ...llmFields,
    };

    // Deterministic fallback
    if (!fields.Reason1 && !fields.Reason2) {
        if (data.reason === "personal_use") {
            fields.Reason1 = "1";
            fields.Reason1_A1 = "1";
        } else if (data.reason === "family_use") {
            fields.Reason1 = "1";
            const w = data.whoWillOccupy || data.relationship;
            if (w === "spouse") fields.Reason1_A2 = "1";
            else if (w === "child") fields.Reason1_A3 = "1";
            else if (w === "parent") fields.Reason1_A4 = "1";
            else if (w === "spouses_child") fields.Reason1_A5 = "1";
            else if (w === "spouses_parent") fields.Reason1_A6 = "1";
            else fields.Reason1_A3 = "1"; // default to child
        } else if (data.reason === "purchaser_use") {
            fields.Reason2 = "1";
            fields.Reason2_A1 = "1";
        } else if (data.reason === "care_provider") {
            fields.Reason1 = "1";
            fields.Reason1_B = "1";
            fields.Reason1_B1 = "1";
        }
    }

    addAgentFields(fields, data.agent);
    addFilingFields(fields, data.filing);
    return fillTemplate("N12", fields);
}

/**
 * N13 — Notice to End Tenancy for Demolition, Repair or Conversion
 * XFA fields: TO_TenameName, From_LandlordName, RentalUnitAddress,
 *   TerminationDate, Reason1-3, R3Table.Row1.WorkPlan, R3Table.Row1.WorkDetail,
 *   NecessaryPermits, SelectSign, RFirstName, RLastName, RDayPhone, Signature,
 *   SignDate, Agent block, Filing block
 */
export async function generateN13Notice(data: N13Data): Promise<Buffer> {
    const { first, last } = splitName(data.signedBy);

    const fields: Record<string, string> = {
        TO_TenameName: data.tenantName,
        From_LandlordName: data.landlordName,
        RentalUnitAddress: data.rentalUnitAddress,
        TerminationDate: data.terminationDate,
        SelectSign: signerTypeValue(data.signerType),
        RFirstName: first,
        RLastName: last,
        RDayPhone: data.landlordPhone || "",
        SignDate: data.dateGiven,
    };

    // Map reason to checkbox
    if (data.reason === "demolition") fields.Reason1 = "1";
    else if (data.reason === "conversion") fields.Reason2 = "1";
    else if (data.reason === "repairs") fields.Reason3 = "1";

    // Fill work details
    if (data.workPlan || data.details) {
        fields["R3Table.Row1.WorkPlan"] = data.workPlan || data.details;
        fields["R3Table.Row1.WorkDetail"] = data.details;
    }

    // Permits status
    if (data.permitsStatus) {
        // NecessaryPermits radio: "1" = obtained, "2" = will obtain, "3" = not needed
        if (data.permitsStatus === "obtained") fields.NecessaryPermits = "1";
        else if (data.permitsStatus === "will_obtain") fields.NecessaryPermits = "2";
        else if (data.permitsStatus === "not_needed") fields.NecessaryPermits = "3";
    }

    addAgentFields(fields, data.agent);
    addFilingFields(fields, data.filing);
    return fillTemplate("N13", fields);
}

/**
 * N14 — Notice to Spouse of Tenant who Vacated the Rental Unit
 * XFA fields: To_TenantName, From_LandlordName, RentUnitAddress, TenantName,
 *   PeriodEndDate, MoveOutDate, PaymentDueDate, OewMeAmount (official typo),
 *   CurrentRentAmount, PayPeriod, SignSelect (not SelectSign), SignName,
 *   SignPhoneNum, Signature, SignDate, Agent block,
 *   Spouse response: ToLandlordName, OtherForm.Row1.UnitNum/StreetAddress,
 *   OtherForm.Row3.City/PostCode, SpouseName
 */
export async function generateN14Notice(data: N14Data): Promise<Buffer> {
    const fields: Record<string, string> = {
        To_TenantName: data.spouseName,
        From_LandlordName: data.landlordName,
        RentUnitAddress: data.rentalUnitAddress,
        TenantName: data.originalTenantName,
        PeriodEndDate: data.periodEndDate,
        MoveOutDate: data.moveOutDate,
        PaymentDueDate: data.paymentDueDate,
        // Note: N14 uses "SignSelect" instead of "SelectSign"
        SignSelect: data.signerType === "representative" ? "2" : "1",
        SignName: data.signedBy,
        SignPhoneNum: data.landlordPhone || "",
        SignDate: data.dateGiven,
    };

    if (data.amountOwed != null) {
        fields.OewMeAmount = data.amountOwed.toFixed(2);
    }
    if (data.currentRent != null) {
        fields.CurrentRentAmount = data.currentRent.toFixed(2);
    }
    if (data.payPeriod) {
        fields.PayPeriod = data.payPeriod;
    }

    // Pre-fill the landlord name in the spouse response section
    fields.ToLandlordName = data.landlordName;

    addAgentFields(fields, data.agent);
    return fillTemplate("N14", fields);
}

// ═══════════════════════════════════════════════════════════
//  VALID NOTICE TYPES
// ═══════════════════════════════════════════════════════════

export const VALID_NOTICE_TYPES = ["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "N10", "N11", "N12", "N13", "N14"] as const;
export type NoticeType = typeof VALID_NOTICE_TYPES[number];

export default {
    generateN1Notice,
    generateN2Notice,
    generateN3Notice,
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
    generateN14Notice,
    VALID_NOTICE_TYPES,
};
