/**
 * Stripe billing integration.
 * All Stripe calls are gated behind STRIPE_SECRET_KEY existing.
 * When the key is absent, the endpoints still work but return helpful placeholders.
 *
 * Required environment variables:
 *   STRIPE_SECRET_KEY          — Stripe secret key (sk_live_... or sk_test_...)
 *   STRIPE_PRO_PRICE_ID        — Price ID for the PRO plan (price_...)
 *   STRIPE_ENTERPRISE_PRICE_ID — Price ID for the ENTERPRISE plan (price_...)
 *   STRIPE_WEBHOOK_SECRET      — Webhook signing secret (whsec_...)
 *   APP_URL                    — Public URL for success/cancel redirects
 */
import { db } from "../config/database";

const isStripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY);

let stripeInstance: any = null;
function getStripe() {
    if (!isStripeConfigured()) return null;
    if (!stripeInstance) {
        try {
            const Stripe = require("stripe");
            stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY!, {
                apiVersion: "2024-12-18.acacia",
            });
        } catch {
            console.warn("Stripe package not installed. Run: npm install stripe");
            return null;
        }
    }
    return stripeInstance;
}

const PRICE_IDS: Record<string, string> = {
    PRO: process.env.STRIPE_PRO_PRICE_ID || "",
    ENTERPRISE: process.env.STRIPE_ENTERPRISE_PRICE_ID || "",
};

// ── Helpers ─────────────────────────────────────────────

/** Find or create a Stripe customer for a landlord */
async function findOrCreateCustomer(landlord: { id: string; email: string; name: string; stripeCustomerId?: string | null }) {
    const stripe = getStripe();
    if (!stripe) return null;

    // Already have a customer ID — verify it exists
    if (landlord.stripeCustomerId) {
        try {
            const existing = await stripe.customers.retrieve(landlord.stripeCustomerId);
            if (!existing.deleted) return existing.id;
        } catch { /* deleted or invalid — create new */ }
    }

    // Search by email first so we don't create duplicates
    const search = await stripe.customers.list({ email: landlord.email, limit: 1 });
    if (search.data.length > 0) {
        const customerId = search.data[0].id;
        await db.landlord.update({ where: { id: landlord.id }, data: { stripeCustomerId: customerId } });
        return customerId;
    }

    // Create new customer
    const customer = await stripe.customers.create({
        email: landlord.email,
        name: landlord.name,
        metadata: { landlordId: landlord.id },
    });
    await db.landlord.update({ where: { id: landlord.id }, data: { stripeCustomerId: customer.id } });
    return customer.id;
}

// ── Checkout ────────────────────────────────────────────

export async function createCheckoutSession(landlordId: string, targetPlan: "PRO" | "ENTERPRISE") {
    const stripe = getStripe();
    if (!stripe) {
        return { url: null, error: "stripe_not_configured", message: "Set STRIPE_SECRET_KEY to enable billing" };
    }

    const landlord = await db.landlord.findUnique({ where: { id: landlordId } });
    if (!landlord) return { url: null, error: "landlord_not_found" };

    const priceId = PRICE_IDS[targetPlan];
    if (!priceId) return { url: null, error: "price_not_configured", message: `Set STRIPE_${targetPlan}_PRICE_ID env var` };

    try {
        const customerId = await findOrCreateCustomer(landlord as any);
        const appUrl = process.env.APP_URL || "http://localhost:3000";

        const sessionParams: any = {
            mode: "subscription",
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${appUrl}/dashboard?upgraded=true`,
            cancel_url: `${appUrl}/dashboard?cancelled=true`,
            metadata: { landlordId, plan: targetPlan },
            subscription_data: {
                metadata: { landlordId, plan: targetPlan },
            },
            allow_promotion_codes: true,
        };

        // Attach customer if found, otherwise use email
        if (customerId) {
            sessionParams.customer = customerId;
        } else {
            sessionParams.customer_email = landlord.email;
        }

        const session = await stripe.checkout.sessions.create(sessionParams);
        return { url: session.url, error: null };
    } catch (err: any) {
        console.error("Stripe checkout failed", err);
        return { url: null, error: "checkout_failed", message: err.message };
    }
}

// ── Customer Portal ──────────────────────────────────────

export async function createPortalSession(landlordId: string) {
    const stripe = getStripe();
    if (!stripe) return { url: null, error: "stripe_not_configured" };

    const landlord = await db.landlord.findUnique({ where: { id: landlordId } });
    if (!landlord?.stripeCustomerId) {
        return { url: null, error: "no_subscription", message: "No active subscription found." };
    }

    try {
        const appUrl = process.env.APP_URL || "http://localhost:3000";
        const session = await stripe.billingPortal.sessions.create({
            customer: landlord.stripeCustomerId,
            return_url: `${appUrl}/dashboard`,
        });
        return { url: session.url, error: null };
    } catch (err: any) {
        console.error("Stripe portal session failed", err);
        return { url: null, error: "portal_failed", message: err.message };
    }
}

// ── Webhook Handler ──────────────────────────────────────

export async function handleWebhook(payload: Buffer, signature: string) {
    const stripe = getStripe();
    if (!stripe) return { handled: false, error: "stripe_not_configured" };

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
    if (!webhookSecret) return { handled: false, error: "webhook_secret_not_configured" };

    try {
        const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);

        switch (event.type) {
            case "checkout.session.completed": {
                const session = event.data.object;
                const landlordId = session.metadata?.landlordId;
                const plan = session.metadata?.plan || "PRO";

                if (landlordId) {
                    await db.landlord.update({
                        where: { id: landlordId },
                        data: {
                            plan: plan as any,
                            stripeCustomerId: session.customer as string,
                        },
                    });
                    console.log(`[Stripe] ✓ Landlord ${landlordId} upgraded to ${plan}`);
                }
                return { handled: true, event: event.type };
            }

            case "customer.subscription.updated": {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                const status = subscription.status;
                const plan = subscription.metadata?.plan;

                if (status === "active" && plan && customerId) {
                    await db.landlord.updateMany({
                        where: { stripeCustomerId: customerId as string },
                        data: { plan: plan as any },
                    });
                    console.log(`[Stripe] ✓ Subscription updated to ${plan} for customer ${customerId}`);
                }
                // Handle past_due / unpaid → downgrade
                if (status === "past_due" || status === "unpaid") {
                    console.warn(`[Stripe] ⚠ Subscription ${subscription.id} is ${status}`);
                }
                return { handled: true, event: event.type };
            }

            case "customer.subscription.deleted": {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                if (customerId) {
                    await db.landlord.updateMany({
                        where: { stripeCustomerId: customerId as string },
                        data: { plan: "FREE" },
                    });
                    console.log(`[Stripe] ✓ Subscription cancelled — customer ${customerId} downgraded to FREE`);
                }
                return { handled: true, event: event.type };
            }

            case "invoice.payment_failed": {
                const invoice = event.data.object;
                const customerId = invoice.customer;
                console.warn(`[Stripe] ⚠ Payment failed for customer ${customerId}, invoice ${invoice.id}`);
                // Could send an email/notification here in the future
                return { handled: true, event: event.type };
            }

            default:
                return { handled: false, event: event.type, note: "unhandled_event_type" };
        }
    } catch (err: any) {
        console.error("Stripe webhook failed", err);
        return { handled: false, error: err.message };
    }
}

// ── Status Check ─────────────────────────────────────────

export function getStripeStatus() {
    return {
        configured: isStripeConfigured(),
        proPriceConfigured: Boolean(PRICE_IDS.PRO),
        enterprisePriceConfigured: Boolean(PRICE_IDS.ENTERPRISE),
        webhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    };
}

export default { createCheckoutSession, createPortalSession, handleWebhook, getStripeStatus };
