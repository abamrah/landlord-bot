/**
 * Tenant screening service — provider-agnostic.
 *
 * Supports:
 *   - Certn (Canadian background checks — credit, criminal, identity)
 *   - SingleKey (Canadian tenant screening — OREA/FRPO trusted)
 *   - Manual (landlord uploads / enters results manually)
 *
 * Flow:
 *   1. Landlord requests a screening → applicant receives consent link
 *   2. Applicant consents → provider starts the check
 *   3. Webhook or polling retrieves results
 *   4. AI generates a summary recommendation
 *
 * Required env vars (optional — falls back to manual mode):
 *   CERTN_API_KEY     — Certn API key
 *   SINGLEKEY_API_KEY — SingleKey API key
 *   SCREENING_PROVIDER — "certn" | "singlekey" | "manual" (default: "manual")
 */
import { db } from "../config/database";

const getProvider = () => process.env.SCREENING_PROVIDER || "manual";

// ═══════════════════════════════════════════════════════════
// 1. REQUEST SCREENING
// ═══════════════════════════════════════════════════════════

interface ScreeningRequest {
    landlordId: string;
    applicantName: string;
    applicantEmail?: string;
    applicantPhone?: string;
    unitId?: string;
}

/**
 * Initiate a new tenant screening request.
 */
export async function requestScreening(params: ScreeningRequest) {
    const { landlordId, applicantName, applicantEmail, applicantPhone, unitId } = params;
    const provider = getProvider();

    // Create the screening record
    const screening = await db.tenantScreening.create({
        data: {
            landlordId,
            applicantName,
            applicantEmail: applicantEmail || null,
            applicantPhone: applicantPhone || null,
            unitId: unitId || null,
            provider,
            status: "REQUESTED",
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        },
    });

    // Attempt to initiate with the provider
    let consentUrl: string | null = null;
    let externalId: string | null = null;

    if (provider === "certn" && process.env.CERTN_API_KEY) {
        const result = await initiateCertnScreening(screening.id, params);
        consentUrl = result.consentUrl;
        externalId = result.externalId;
    } else if (provider === "singlekey" && process.env.SINGLEKEY_API_KEY) {
        const result = await initiateSingleKeyScreening(screening.id, params);
        consentUrl = result.consentUrl;
        externalId = result.externalId;
    } else {
        // Manual mode — generate a self-serve consent link
        const appUrl = process.env.APP_URL || "http://localhost:3000";
        consentUrl = `${appUrl}/screening/consent/${screening.id}`;
    }

    // Update with provider details
    await db.tenantScreening.update({
        where: { id: screening.id },
        data: {
            consentUrl,
            externalId,
            status: consentUrl ? "PENDING_CONSENT" : "REQUESTED",
        },
    });

    return {
        id: screening.id,
        consentUrl,
        provider,
        status: "PENDING_CONSENT",
    };
}

// ═══════════════════════════════════════════════════════════
// 2. CERTN INTEGRATION
// ═══════════════════════════════════════════════════════════

async function initiateCertnScreening(screeningId: string, params: ScreeningRequest) {
    const apiKey = process.env.CERTN_API_KEY;
    if (!apiKey) return { consentUrl: null, externalId: null };

    try {
        // Certn API v1 — POST /api/v1/screenings/invite/
        const response = await fetch("https://api.certn.co/api/v1/screenings/invite/", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                email: params.applicantEmail,
                phone_number: params.applicantPhone,
                position_name: "Tenant Screening",
                request_softcheck: true,
                request_equifax: true,
                request_criminal_record_check: true,
                request_identity_verification: true,
                tag: screeningId,
                information: {
                    first_name: params.applicantName.split(" ")[0],
                    last_name: params.applicantName.split(" ").slice(1).join(" ") || params.applicantName,
                },
            }),
        });

        if (!response.ok) {
            console.error(`[Screening] Certn API error: ${response.status} ${await response.text()}`);
            return { consentUrl: null, externalId: null };
        }

        const data = await response.json();
        return {
            consentUrl: data.applicant_url || data.url || null,
            externalId: data.id || data.applicant_id || null,
        };
    } catch (err: any) {
        console.error("[Screening] Certn initiation failed:", err.message);
        return { consentUrl: null, externalId: null };
    }
}

// ═══════════════════════════════════════════════════════════
// 3. SINGLEKEY INTEGRATION
// ═══════════════════════════════════════════════════════════

async function initiateSingleKeyScreening(screeningId: string, params: ScreeningRequest) {
    const apiKey = process.env.SINGLEKEY_API_KEY;
    if (!apiKey) return { consentUrl: null, externalId: null };

    try {
        // SingleKey API — POST /api/v1/screening-requests
        const response = await fetch("https://api.singlekey.com/api/v1/screening-requests", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                applicant: {
                    name: params.applicantName,
                    email: params.applicantEmail,
                    phone: params.applicantPhone,
                },
                property_address: params.unitId || undefined,
                reference: screeningId,
                products: ["credit_check", "criminal_check", "identity_verification"],
            }),
        });

        if (!response.ok) {
            console.error(`[Screening] SingleKey API error: ${response.status} ${await response.text()}`);
            return { consentUrl: null, externalId: null };
        }

        const data = await response.json();
        return {
            consentUrl: data.consent_url || data.applicant_link || null,
            externalId: data.id || data.request_id || null,
        };
    } catch (err: any) {
        console.error("[Screening] SingleKey initiation failed:", err.message);
        return { consentUrl: null, externalId: null };
    }
}

// ═══════════════════════════════════════════════════════════
// 4. CHECK / POLL RESULTS
// ═══════════════════════════════════════════════════════════

/**
 * Poll the screening provider for updated results.
 */
export async function checkScreeningResult(screeningId: string) {
    const screening = await db.tenantScreening.findUnique({ where: { id: screeningId } });
    if (!screening) return { error: "not_found" };
    if (screening.status === "COMPLETED") return { screening, alreadyComplete: true };

    if (screening.provider === "certn" && screening.externalId) {
        return await pollCertnResult(screening);
    } else if (screening.provider === "singlekey" && screening.externalId) {
        return await pollSingleKeyResult(screening);
    }

    return { screening, message: "Manual screening — update results via dashboard" };
}

async function pollCertnResult(screening: any) {
    const apiKey = process.env.CERTN_API_KEY;
    if (!apiKey) return { screening, error: "certn_not_configured" };

    try {
        const response = await fetch(`https://api.certn.co/api/v1/applicants/${screening.externalId}/`, {
            headers: { "Authorization": `Bearer ${apiKey}` },
        });

        if (!response.ok) return { screening, error: `certn_api_${response.status}` };
        const data = await response.json();

        if (data.status === "COMPLETE" || data.status === "Returned") {
            const results = mapCertnResults(data);
            await db.tenantScreening.update({
                where: { id: screening.id },
                data: {
                    status: "COMPLETED",
                    completedAt: new Date(),
                    ...results,
                    rawReport: data,
                },
            });
            return { screening: { ...screening, ...results, status: "COMPLETED" } };
        }

        if (data.status === "IN_PROGRESS" || data.status === "Analyzing") {
            await db.tenantScreening.update({
                where: { id: screening.id },
                data: { status: "IN_PROGRESS" },
            });
        }

        return { screening, providerStatus: data.status };
    } catch (err: any) {
        return { screening, error: err.message };
    }
}

function mapCertnResults(data: any) {
    const creditReport = data.report_summary?.equifax || data.equifax_result || {};
    const criminalCheck = data.report_summary?.criminal_record_check || data.criminal_record_check_result || {};

    const creditScore = creditReport.score || creditReport.credit_score || null;
    let creditRating = null;
    if (creditScore) {
        if (creditScore >= 750) creditRating = "excellent";
        else if (creditScore >= 660) creditRating = "good";
        else if (creditScore >= 560) creditRating = "fair";
        else creditRating = "poor";
    }

    const criminalClearRaw = criminalCheck.result === "CLEAR" || criminalCheck.status === "CLEAR";
    const criminalClear: boolean | null = criminalClearRaw || null;
    const identityVerified = data.identity_verification?.verified ?? data.report_summary?.identity_verified ?? null;

    let riskScore = "medium";
    if (creditScore && creditScore >= 700 && criminalClear) riskScore = "low";
    else if ((creditScore && creditScore < 560) || !criminalClear) riskScore = "high";

    let recommendation = "conditional";
    if (riskScore === "low") recommendation = "approve";
    else if (riskScore === "high") recommendation = "decline";

    return {
        creditScore,
        creditRating,
        identityVerified,
        criminalClear,
        riskScore,
        recommendation,
        reportSummary: `Credit score: ${creditScore || "N/A"} (${creditRating || "N/A"}). Criminal: ${criminalClear === true ? "Clear" : criminalClear === false ? "Record found" : "N/A"}. ID verified: ${identityVerified === true ? "Yes" : identityVerified === false ? "No" : "N/A"}. Risk: ${riskScore}. Recommendation: ${recommendation}.`,
    };
}

async function pollSingleKeyResult(screening: any) {
    const apiKey = process.env.SINGLEKEY_API_KEY;
    if (!apiKey) return { screening, error: "singlekey_not_configured" };

    try {
        const response = await fetch(`https://api.singlekey.com/api/v1/screening-requests/${screening.externalId}`, {
            headers: { "Authorization": `Bearer ${apiKey}` },
        });

        if (!response.ok) return { screening, error: `singlekey_api_${response.status}` };
        const data = await response.json();

        if (data.status === "completed" || data.status === "ready") {
            const results = mapSingleKeyResults(data);
            await db.tenantScreening.update({
                where: { id: screening.id },
                data: {
                    status: "COMPLETED",
                    completedAt: new Date(),
                    ...results,
                    rawReport: data,
                },
            });
            return { screening: { ...screening, ...results, status: "COMPLETED" } };
        }

        return { screening, providerStatus: data.status };
    } catch (err: any) {
        return { screening, error: err.message };
    }
}

function mapSingleKeyResults(data: any) {
    const report = data.report || data.results || {};
    const creditScore = report.credit_score || null;
    let creditRating = null;
    if (creditScore) {
        if (creditScore >= 750) creditRating = "excellent";
        else if (creditScore >= 660) creditRating = "good";
        else if (creditScore >= 560) creditRating = "fair";
        else creditRating = "poor";
    }

    const recommendation = report.recommendation || report.decision || null;
    const riskScore = report.risk_level || report.risk_score || null;

    return {
        creditScore,
        creditRating,
        identityVerified: report.identity_verified ?? null,
        criminalClear: report.criminal_clear ?? null,
        evictionHistory: report.eviction_history ?? null,
        incomeVerified: report.income_verified ?? null,
        monthlyIncome: report.monthly_income ? Math.round(report.monthly_income * 100) : null,
        riskScore: riskScore || (creditScore && creditScore >= 700 ? "low" : "medium"),
        recommendation: recommendation || "conditional",
        reportSummary: `Credit: ${creditScore || "N/A"} (${creditRating || "N/A"}). Risk: ${riskScore || "N/A"}. Recommendation: ${recommendation || "Pending review"}.`,
    };
}

// ═══════════════════════════════════════════════════════════
// 5. MANUAL SCREENING RESULTS ENTRY
// ═══════════════════════════════════════════════════════════

interface ManualScreeningResult {
    creditScore?: number;
    creditRating?: string;
    identityVerified?: boolean;
    criminalClear?: boolean;
    evictionHistory?: boolean;
    incomeVerified?: boolean;
    monthlyIncome?: number;
    recommendation?: string;
    notes?: string;
}

/**
 * Landlord manually enters screening results (for manual mode or to supplement provider results).
 */
export async function updateScreeningManually(screeningId: string, landlordId: string, results: ManualScreeningResult) {
    const screening = await db.tenantScreening.findFirst({
        where: { id: screeningId, landlordId },
    });
    if (!screening) return { error: "not_found" };

    let riskScore = "medium";
    if (results.creditScore) {
        if (results.creditScore >= 700 && results.criminalClear !== false) riskScore = "low";
        else if (results.creditScore < 560 || results.criminalClear === false) riskScore = "high";
    }

    const updated = await db.tenantScreening.update({
        where: { id: screeningId },
        data: {
            status: "COMPLETED",
            completedAt: new Date(),
            creditScore: results.creditScore ?? screening.creditScore,
            creditRating: results.creditRating ?? screening.creditRating,
            identityVerified: results.identityVerified ?? screening.identityVerified,
            criminalClear: results.criminalClear ?? screening.criminalClear,
            evictionHistory: results.evictionHistory ?? screening.evictionHistory,
            incomeVerified: results.incomeVerified ?? screening.incomeVerified,
            monthlyIncome: results.monthlyIncome ? Math.round(results.monthlyIncome * 100) : screening.monthlyIncome,
            riskScore: riskScore,
            recommendation: results.recommendation ?? screening.recommendation,
            reportSummary: results.notes || screening.reportSummary,
        },
    });

    return { screening: updated };
}

// ═══════════════════════════════════════════════════════════
// 6. SCREENING LIST & DETAILS
// ═══════════════════════════════════════════════════════════

/**
 * Get all screenings for a landlord.
 */
export async function getScreenings(landlordId: string, filters?: {
    status?: string;
    limit?: number;
    offset?: number;
}) {
    const where: any = { landlordId };
    if (filters?.status) where.status = filters.status;

    const [screenings, total] = await Promise.all([
        db.tenantScreening.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: filters?.limit || 50,
            skip: filters?.offset || 0,
        }),
        db.tenantScreening.count({ where }),
    ]);

    return { screenings, total };
}

/**
 * Get a single screening by ID (landlord-scoped).
 */
export async function getScreeningById(screeningId: string, landlordId: string) {
    return db.tenantScreening.findFirst({
        where: { id: screeningId, landlordId },
    });
}

// ═══════════════════════════════════════════════════════════
// 7. WEBHOOK HANDLERS
// ═══════════════════════════════════════════════════════════

/**
 * Handle Certn webhook (POST /webhooks/certn)
 */
export async function handleCertnWebhook(body: any) {
    const screeningId = body.tag || body.reference;
    if (!screeningId) return { handled: false };

    const screening = await db.tenantScreening.findUnique({ where: { id: screeningId } });
    if (!screening) return { handled: false, error: "screening_not_found" };

    if (body.status === "COMPLETE" || body.status === "Returned") {
        const results = mapCertnResults(body);
        await db.tenantScreening.update({
            where: { id: screeningId },
            data: {
                status: "COMPLETED",
                completedAt: new Date(),
                ...results,
                rawReport: body,
            },
        });
        console.log(`[Screening] ✓ Certn screening ${screeningId} completed`);
        return { handled: true };
    }

    if (body.status === "IN_PROGRESS") {
        await db.tenantScreening.update({
            where: { id: screeningId },
            data: { status: "IN_PROGRESS" },
        });
    }

    return { handled: true };
}

/**
 * Handle SingleKey webhook (POST /webhooks/singlekey)
 */
export async function handleSingleKeyWebhook(body: any) {
    const screeningId = body.reference || body.external_id;
    if (!screeningId) return { handled: false };

    const screening = await db.tenantScreening.findUnique({ where: { id: screeningId } });
    if (!screening) return { handled: false, error: "screening_not_found" };

    if (body.status === "completed" || body.status === "ready") {
        const results = mapSingleKeyResults(body);
        await db.tenantScreening.update({
            where: { id: screeningId },
            data: {
                status: "COMPLETED",
                completedAt: new Date(),
                ...results,
                rawReport: body,
            },
        });
        console.log(`[Screening] ✓ SingleKey screening ${screeningId} completed`);
        return { handled: true };
    }

    return { handled: true };
}

export default {
    requestScreening,
    checkScreeningResult,
    updateScreeningManually,
    getScreenings,
    getScreeningById,
    handleCertnWebhook,
    handleSingleKeyWebhook,
};
