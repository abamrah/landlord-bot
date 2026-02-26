/**
 * Stripe Connect rent collection service.
 *
 * Uses the "Collect then transfer" (destination charges) model:
 *   1. Landlord onboards via Stripe Connect Express
 *   2. Platform creates PaymentIntents on behalf of landlord
 *   3. Funds land in platform account → auto-transferred to landlord's connected account
 *   4. Platform optionally takes an application fee
 *
 * Ontario RTA compliance notes:
 *   - s.108(1): Cannot force tenants to pay via platform — must offer alternatives
 *   - s.109: Must provide receipts for rent payments (auto-generated)
 *   - s.134(1): No late fees allowed in Ontario — platform_fee is service fee, not penalty
 *   - Consent: Tenants must voluntarily opt in
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY   — Platform's Stripe secret key
 *   APP_URL             — Public URL for redirects
 */
import { db } from "../config/database";

const PLATFORM_FEE_PERCENT = 2.5; // 2.5% platform fee on rent payments

let stripeInstance: any = null;
function getStripe() {
    if (!process.env.STRIPE_SECRET_KEY) return null;
    if (!stripeInstance) {
        try {
            const Stripe = require("stripe");
            stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY!, {
                apiVersion: "2024-12-18.acacia",
            });
        } catch {
            console.warn("[RentCollection] Stripe package not installed");
            return null;
        }
    }
    return stripeInstance;
}

// ═══════════════════════════════════════════════════════════
// 1. LANDLORD ONBOARDING (Stripe Connect Express)
// ═══════════════════════════════════════════════════════════

/**
 * Create a Stripe Connect Express account for the landlord and return an onboarding link.
 */
export async function createConnectAccount(landlordId: string) {
    const stripe = getStripe();
    if (!stripe) return { url: null, error: "stripe_not_configured" };

    const landlord = await db.landlord.findUnique({ where: { id: landlordId } });
    if (!landlord) return { url: null, error: "landlord_not_found" };

    try {
        let accountId = landlord.stripeConnectAccountId;

        // Create account if not exists
        if (!accountId) {
            const account = await stripe.accounts.create({
                type: "express",
                country: "CA",
                email: landlord.email,
                capabilities: {
                    card_payments: { requested: true },
                    transfers: { requested: true },
                },
                business_type: "individual",
                metadata: {
                    landlordId: landlord.id,
                    platform: "nestmind",
                },
            });
            accountId = account.id;
            await db.landlord.update({
                where: { id: landlordId },
                data: { stripeConnectAccountId: accountId },
            });
        }

        // Create onboarding link
        const appUrl = process.env.APP_URL || "http://localhost:3000";
        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: `${appUrl}/dashboard?connect=refresh`,
            return_url: `${appUrl}/dashboard?connect=success`,
            type: "account_onboarding",
        });

        return { url: accountLink.url, accountId, error: null };
    } catch (err: any) {
        console.error("[RentCollection] Connect account creation failed", err);
        return { url: null, error: err.message };
    }
}

/**
 * Get the landlord's Connect account status (onboarding complete, payouts enabled, etc.)
 */
export async function getConnectAccountStatus(landlordId: string) {
    const stripe = getStripe();
    if (!stripe) return { status: "not_configured" };

    const landlord = await db.landlord.findUnique({ where: { id: landlordId } });
    if (!landlord?.stripeConnectAccountId) {
        return { status: "not_connected", onboarded: false };
    }

    try {
        const account = await stripe.accounts.retrieve(landlord.stripeConnectAccountId);
        const isOnboarded = account.details_submitted && account.charges_enabled && account.payouts_enabled;

        // Update local flag
        if (isOnboarded && !landlord.stripeConnectOnboarded) {
            await db.landlord.update({
                where: { id: landlordId },
                data: { stripeConnectOnboarded: true },
            });
        }

        return {
            status: isOnboarded ? "active" : "pending",
            onboarded: isOnboarded,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
            detailsSubmitted: account.details_submitted,
            accountId: landlord.stripeConnectAccountId,
        };
    } catch (err: any) {
        console.error("[RentCollection] Failed to retrieve Connect account", err);
        return { status: "error", error: err.message };
    }
}

/**
 * Create a Stripe Connect login link for landlords to access their Express Dashboard.
 */
export async function createConnectLoginLink(landlordId: string) {
    const stripe = getStripe();
    if (!stripe) return { url: null, error: "stripe_not_configured" };

    const landlord = await db.landlord.findUnique({ where: { id: landlordId } });
    if (!landlord?.stripeConnectAccountId) {
        return { url: null, error: "not_connected" };
    }

    try {
        const loginLink = await stripe.accounts.createLoginLink(landlord.stripeConnectAccountId);
        return { url: loginLink.url, error: null };
    } catch (err: any) {
        return { url: null, error: err.message };
    }
}

// ═══════════════════════════════════════════════════════════
// 2. RENT PAYMENT CREATION
// ═══════════════════════════════════════════════════════════

interface CreateRentPaymentParams {
    landlordId: string;
    tenantId: string;
    unitTenantId: string;
    amountCents: number;
    dueDate: Date;
    periodStart: Date;
    periodEnd: Date;
}

/**
 * Create a Stripe Checkout session for a single rent payment (destination charge).
 * Returns a payment URL that can be sent to the tenant via WhatsApp or displayed in the portal.
 */
export async function createRentPaymentSession(params: CreateRentPaymentParams) {
    const stripe = getStripe();
    if (!stripe) return { url: null, error: "stripe_not_configured" };

    const { landlordId, tenantId, unitTenantId, amountCents, dueDate, periodStart, periodEnd } = params;

    // Validate landlord has Connect account
    const landlord = await db.landlord.findUnique({ where: { id: landlordId } });
    if (!landlord?.stripeConnectAccountId || !landlord.stripeConnectOnboarded) {
        return { url: null, error: "landlord_not_onboarded", message: "Landlord must complete Stripe Connect onboarding first." };
    }

    // Get tenant
    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return { url: null, error: "tenant_not_found" };

    // Get unit tenant + unit info
    const unitTenant = await db.unitTenant.findUnique({
        where: { id: unitTenantId },
        include: { unit: true },
    });
    if (!unitTenant) return { url: null, error: "unit_tenant_not_found" };

    try {
        // Find or create Stripe customer for tenant
        let customerIdForTenant = tenant.stripeCustomerId;
        if (!customerIdForTenant) {
            const searchEmail = tenant.email ? await stripe.customers.list({ email: tenant.email, limit: 1 }) : { data: [] };
            if (searchEmail.data.length > 0) {
                customerIdForTenant = searchEmail.data[0].id;
            } else {
                const customer = await stripe.customers.create({
                    email: tenant.email || undefined,
                    name: tenant.name,
                    phone: tenant.phone || undefined,
                    metadata: { tenantId, landlordId, platform: "nestmind" },
                });
                customerIdForTenant = customer.id;
            }
            await db.tenant.update({
                where: { id: tenantId },
                data: { stripeCustomerId: customerIdForTenant },
            });
        }

        // Calculate platform fee
        const platformFeeCents = Math.round(amountCents * PLATFORM_FEE_PERCENT / 100);

        // Create rent payment record
        const rentPayment = await db.rentPayment.create({
            data: {
                landlordId,
                tenantId,
                unitTenantId,
                amountCents,
                currency: "CAD",
                status: "PENDING",
                platformFeeCents,
                dueDate,
                periodStart,
                periodEnd,
            },
        });

        const appUrl = process.env.APP_URL || "http://localhost:3000";
        const monthLabel = periodStart.toLocaleString("en-CA", { month: "long", year: "numeric" });

        // Create Checkout Session with destination charge
        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            customer: customerIdForTenant,
            line_items: [{
                price_data: {
                    currency: "cad",
                    product_data: {
                        name: `Rent — ${unitTenant.unit.label}`,
                        description: `Rent payment for ${monthLabel}`,
                    },
                    unit_amount: amountCents,
                },
                quantity: 1,
            }],
            payment_intent_data: {
                application_fee_amount: platformFeeCents,
                transfer_data: {
                    destination: landlord.stripeConnectAccountId,
                },
                metadata: {
                    rentPaymentId: rentPayment.id,
                    landlordId,
                    tenantId,
                    unitTenantId,
                    type: "rent_payment",
                },
            },
            success_url: `${appUrl}/pay/success?payment=${rentPayment.id}`,
            cancel_url: `${appUrl}/pay/cancelled?payment=${rentPayment.id}`,
            metadata: {
                rentPaymentId: rentPayment.id,
                type: "rent_payment",
            },
        });

        // Update payment with session ID
        await db.rentPayment.update({
            where: { id: rentPayment.id },
            data: { stripePaymentIntentId: session.payment_intent },
        });

        return {
            url: session.url,
            paymentId: rentPayment.id,
            amountCents,
            platformFeeCents,
            error: null,
        };
    } catch (err: any) {
        console.error("[RentCollection] Payment session creation failed", err);
        return { url: null, error: err.message };
    }
}

// ═══════════════════════════════════════════════════════════
// 3. BULK RENT INVOICING
// ═══════════════════════════════════════════════════════════

/**
 * Generate rent payment links for all active tenants of a landlord.
 * Returns an array of results with tenant name + payment URL.
 */
export async function generateMonthlyRentLinks(landlordId: string, month: Date) {
    const landlord = await db.landlord.findUnique({ where: { id: landlordId } });
    if (!landlord?.stripeConnectAccountId || !landlord.stripeConnectOnboarded) {
        return { results: [], error: "landlord_not_onboarded" };
    }

    // Get all active unit-tenants with rent configured
    const unitTenants = await db.unitTenant.findMany({
        where: {
            unit: { landlordId },
            rentAmountCents: { not: null },
            OR: [
                { endDate: null },
                { endDate: { gte: new Date() } },
            ],
        },
        include: { tenant: true, unit: true },
    });

    const periodStart = new Date(month.getFullYear(), month.getMonth(), 1);
    const periodEnd = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const dueDate = periodStart; // Due on the 1st

    const results: Array<{ tenantName: string; unitLabel: string; url: string | null; error?: string }> = [];

    for (const ut of unitTenants) {
        // Check if payment already exists for this period
        const existing = await db.rentPayment.findFirst({
            where: {
                unitTenantId: ut.id,
                periodStart,
                status: { in: ["PENDING", "PROCESSING", "SUCCEEDED"] },
            },
        });

        if (existing) {
            results.push({ tenantName: ut.tenant.name, unitLabel: ut.unit.label, url: null, error: "already_created" });
            continue;
        }

        const result = await createRentPaymentSession({
            landlordId,
            tenantId: ut.tenantId,
            unitTenantId: ut.id,
            amountCents: ut.rentAmountCents!,
            dueDate,
            periodStart,
            periodEnd,
        });

        results.push({
            tenantName: ut.tenant.name,
            unitLabel: ut.unit.label,
            url: result.url,
            error: result.error || undefined,
        });
    }

    return { results, error: null };
}

// ═══════════════════════════════════════════════════════════
// 4. PAYMENT TRACKING & HISTORY
// ═══════════════════════════════════════════════════════════

/**
 * Get rent payment history for a landlord, optionally filtered by tenant or status.
 */
export async function getRentPayments(landlordId: string, filters?: {
    tenantId?: string;
    status?: string;
    limit?: number;
    offset?: number;
}) {
    const where: any = { landlordId };
    if (filters?.tenantId) where.tenantId = filters.tenantId;
    if (filters?.status) where.status = filters.status;

    const [payments, total] = await Promise.all([
        db.rentPayment.findMany({
            where,
            include: {
                tenant: { select: { id: true, name: true, phone: true, email: true } },
                unitTenant: { include: { unit: { select: { id: true, label: true, address: true } } } },
            },
            orderBy: { dueDate: "desc" },
            take: filters?.limit || 50,
            skip: filters?.offset || 0,
        }),
        db.rentPayment.count({ where }),
    ]);

    return { payments, total };
}

/**
 * Get rent payment summary stats for the landlord dashboard.
 */
export async function getRentPaymentStats(landlordId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const [collected, pending, overdue, totalEver] = await Promise.all([
        db.rentPayment.aggregate({
            where: { landlordId, status: "SUCCEEDED", paidAt: { gte: monthStart, lte: monthEnd } },
            _sum: { amountCents: true },
            _count: true,
        }),
        db.rentPayment.aggregate({
            where: { landlordId, status: "PENDING" },
            _sum: { amountCents: true },
            _count: true,
        }),
        db.rentPayment.aggregate({
            where: { landlordId, status: "PENDING", dueDate: { lt: now } },
            _sum: { amountCents: true },
            _count: true,
        }),
        db.rentPayment.aggregate({
            where: { landlordId, status: "SUCCEEDED" },
            _sum: { amountCents: true },
            _count: true,
        }),
    ]);

    return {
        thisMonth: {
            collectedCents: collected._sum.amountCents || 0,
            collectedCount: collected._count,
        },
        pending: {
            amountCents: pending._sum.amountCents || 0,
            count: pending._count,
        },
        overdue: {
            amountCents: overdue._sum.amountCents || 0,
            count: overdue._count,
        },
        allTime: {
            collectedCents: totalEver._sum.amountCents || 0,
            collectedCount: totalEver._count,
        },
    };
}

// ═══════════════════════════════════════════════════════════
// 5. CONNECT WEBHOOK HANDLING
// ═══════════════════════════════════════════════════════════

/**
 * Handle Stripe Connect webhook events (payment_intent.succeeded, etc.)
 * This should be called from the main webhook route.
 */
export async function handleRentWebhookEvent(event: any) {
    switch (event.type) {
        case "payment_intent.succeeded": {
            const pi = event.data.object;
            if (pi.metadata?.type !== "rent_payment") return { handled: false };

            const rentPaymentId = pi.metadata.rentPaymentId;
            if (!rentPaymentId) return { handled: false };

            await db.rentPayment.update({
                where: { id: rentPaymentId },
                data: {
                    status: "SUCCEEDED",
                    stripePaymentIntentId: pi.id,
                    stripeChargeId: pi.latest_charge,
                    paidAt: new Date(),
                    receiptUrl: pi.charges?.data?.[0]?.receipt_url || null,
                },
            });

            // Also record in FinancialRecord for the landlord ledger
            const payment = await db.rentPayment.findUnique({
                where: { id: rentPaymentId },
                include: { tenant: true, unitTenant: { include: { unit: true } } },
            });

            if (payment) {
                await db.financialRecord.create({
                    data: {
                        landlordId: payment.landlordId,
                        tenantName: payment.tenant.name,
                        tenantPhone: payment.tenant.phone,
                        unitLabel: payment.unitTenant.unit.label,
                        type: "RENT_PAYMENT",
                        amount: payment.amountCents / 100,
                        currency: payment.currency,
                        description: `Rent payment — ${payment.unitTenant.unit.label} — ${payment.periodStart.toLocaleDateString("en-CA")} to ${payment.periodEnd.toLocaleDateString("en-CA")}`,
                        date: new Date(),
                    },
                });
            }

            console.log(`[RentCollection] ✓ Payment ${rentPaymentId} succeeded`);
            return { handled: true, event: event.type, rentPaymentId };
        }

        case "payment_intent.payment_failed": {
            const pi = event.data.object;
            if (pi.metadata?.type !== "rent_payment") return { handled: false };

            const rentPaymentId = pi.metadata.rentPaymentId;
            if (!rentPaymentId) return { handled: false };

            await db.rentPayment.update({
                where: { id: rentPaymentId },
                data: {
                    status: "FAILED",
                    failureReason: pi.last_payment_error?.message || "Payment failed",
                },
            });

            console.warn(`[RentCollection] ✗ Payment ${rentPaymentId} failed: ${pi.last_payment_error?.message}`);
            return { handled: true, event: event.type, rentPaymentId };
        }

        case "charge.refunded": {
            const charge = event.data.object;
            if (charge.metadata?.type !== "rent_payment") return { handled: false };

            const rentPaymentId = charge.metadata.rentPaymentId;
            if (!rentPaymentId) return { handled: false };

            await db.rentPayment.update({
                where: { id: rentPaymentId },
                data: { status: "REFUNDED" },
            });

            console.log(`[RentCollection] ↩ Payment ${rentPaymentId} refunded`);
            return { handled: true, event: event.type, rentPaymentId };
        }

        case "account.updated": {
            // Landlord Connect account status changed
            const account = event.data.object;
            const landlordId = account.metadata?.landlordId;
            if (!landlordId) return { handled: false };

            const isOnboarded = account.details_submitted && account.charges_enabled && account.payouts_enabled;
            await db.landlord.update({
                where: { id: landlordId },
                data: { stripeConnectOnboarded: isOnboarded },
            });

            console.log(`[RentCollection] Account ${account.id} updated — onboarded: ${isOnboarded}`);
            return { handled: true, event: event.type };
        }

        default:
            return { handled: false };
    }
}

export default {
    createConnectAccount,
    getConnectAccountStatus,
    createConnectLoginLink,
    createRentPaymentSession,
    generateMonthlyRentLinks,
    getRentPayments,
    getRentPaymentStats,
    handleRentWebhookEvent,
};
