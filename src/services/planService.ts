import { db } from "../config/database";

export type PlanLimits = {
    maxUnits: number;
    maxMessagesPerMonth: number;
    autopilot: boolean;
    utilityTracking: boolean;
    contractorDispatch: boolean;
    maxWhatsAppNumbers: number;
    analytics: boolean;
    priceLabel: string;
};

export const PLANS: Record<string, PlanLimits> = {
    FREE: {
        maxUnits: 3,
        maxMessagesPerMonth: 30,
        autopilot: false,
        utilityTracking: false,
        contractorDispatch: false,
        maxWhatsAppNumbers: 1,
        analytics: false,
        priceLabel: "Free",
    },
    PRO: {
        maxUnits: 25,
        maxMessagesPerMonth: 1000,
        autopilot: true,
        utilityTracking: true,
        contractorDispatch: true,
        maxWhatsAppNumbers: 3,
        analytics: true,
        priceLabel: "$29/mo",
    },
    ENTERPRISE: {
        maxUnits: 999999,
        maxMessagesPerMonth: 999999,
        autopilot: true,
        utilityTracking: true,
        contractorDispatch: true,
        maxWhatsAppNumbers: 10,
        analytics: true,
        priceLabel: "$79/mo",
    },
};

export async function checkPlanLimit(landlordId: string, resource: "units" | "messages"): Promise<{ allowed: boolean; current: number; max: number; plan: string }> {
    const landlord = await db.landlord.findUnique({ where: { id: landlordId } });
    if (!landlord) return { allowed: false, current: 0, max: 0, plan: "UNKNOWN" };

    const plan = PLANS[landlord.plan] || PLANS.FREE;

    if (resource === "units") {
        const count = await db.unit.count({ where: { landlordId } });
        return { allowed: count < plan.maxUnits, current: count, max: plan.maxUnits, plan: landlord.plan };
    }

    if (resource === "messages") {
        // Reset monthly counter if we've rolled into a new month
        const now = new Date();
        const resetAt = new Date(landlord.messageCountResetAt);
        if (now.getUTCMonth() !== resetAt.getUTCMonth() || now.getUTCFullYear() !== resetAt.getUTCFullYear()) {
            await db.landlord.update({
                where: { id: landlordId },
                data: { messageCountThisMonth: 0, messageCountResetAt: now },
            });
            return { allowed: true, current: 0, max: plan.maxMessagesPerMonth, plan: landlord.plan };
        }
        return {
            allowed: landlord.messageCountThisMonth < plan.maxMessagesPerMonth,
            current: landlord.messageCountThisMonth,
            max: plan.maxMessagesPerMonth,
            plan: landlord.plan,
        };
    }

    return { allowed: true, current: 0, max: 0, plan: landlord.plan };
}

export async function incrementMessageCount(landlordId: string) {
    try {
        await db.landlord.update({
            where: { id: landlordId },
            data: { messageCountThisMonth: { increment: 1 } },
        });
    } catch {
        // Non-critical
    }
}

export function getPlanFeatures(plan: string): PlanLimits {
    return PLANS[plan] || PLANS.FREE;
}
