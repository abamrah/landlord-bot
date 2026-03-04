/**
 * conversationMemory.ts — Persistent conversation history backed by DB.
 *
 * Stores every message exchanged with a phone number so the AI agent
 * has full context across sessions and server restarts.
 */

import { db } from "../config/database";

const isDbEnabled = Boolean(process.env.DATABASE_URL);

export type ConversationRole = "tenant" | "ai" | "landlord" | "system";

export interface ConversationEntry {
    role: ConversationRole;
    content: string;
    createdAt: string;
    meta?: Record<string, unknown>;
}

/**
 * Save a single message to conversation history.
 */
export async function saveMessage(params: {
    phone: string;
    landlordId?: string;
    role: ConversationRole;
    content: string;
    meta?: Record<string, unknown>;
}): Promise<void> {
    if (!isDbEnabled || !params.phone || !params.content) return;
    try {
        await db.conversationMessage.create({
            data: {
                phone: params.phone,
                landlordId: params.landlordId || null,
                role: params.role,
                content: params.content,
                meta: params.meta as any || undefined,
            },
        });
    } catch (err) {
        console.warn("saveMessage failed", err);
    }
}

/**
 * Retrieve recent conversation history for a phone number.
 * Returns the most recent `limit` messages in chronological order.
 */
export async function getHistory(params: {
    phone: string;
    landlordId?: string;
    limit?: number;
}): Promise<ConversationEntry[]> {
    if (!isDbEnabled || !params.phone) return [];
    const limit = params.limit || 20;
    try {
        const messages = await db.conversationMessage.findMany({
            where: {
                phone: params.phone,
                ...(params.landlordId ? { landlordId: params.landlordId } : {}),
            },
            orderBy: { createdAt: "desc" },
            take: limit,
        });
        // Reverse to chronological order
        return messages.reverse().map((m: any) => ({
            role: m.role as ConversationRole,
            content: m.content,
            createdAt: m.createdAt.toISOString(),
            meta: m.meta as Record<string, unknown> | undefined,
        }));
    } catch (err) {
        console.warn("getHistory failed", err);
        return [];
    }
}

/**
 * Format conversation history as a string for injection into prompts.
 */
export function formatHistory(entries: ConversationEntry[], maxEntries = 10): string {
    if (!entries.length) return "";
    const recent = entries.slice(-maxEntries);
    const lines = recent.map((e) => {
        const role = e.role.toUpperCase();
        const time = new Date(e.createdAt).toLocaleString("en-CA", {
            timeZone: "America/Toronto",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
        return `[${time}] ${role}: ${e.content}`;
    });
    return lines.join("\n");
}

/**
 * Get message count for a phone number (for analytics).
 */
export async function getMessageCount(params: {
    phone: string;
    landlordId?: string;
    since?: Date;
}): Promise<number> {
    if (!isDbEnabled || !params.phone) return 0;
    try {
        return await db.conversationMessage.count({
            where: {
                phone: params.phone,
                ...(params.landlordId ? { landlordId: params.landlordId } : {}),
                ...(params.since ? { createdAt: { gte: params.since } } : {}),
            },
        });
    } catch {
        return 0;
    }
}

/**
 * Check if the landlord has sent a message to this phone number recently.
 * Used to suppress AI auto-replies when the landlord is actively chatting.
 */
export async function hasRecentLandlordReply(params: {
    phone: string;
    landlordId?: string;
    windowMinutes?: number;
}): Promise<boolean> {
    if (!isDbEnabled || !params.phone) return false;
    const windowMs = (params.windowMinutes || 30) * 60 * 1000;
    const cutoff = new Date(Date.now() - windowMs);
    try {
        const recent = await db.conversationMessage.findFirst({
            where: {
                phone: params.phone,
                role: "landlord",
                createdAt: { gte: cutoff },
                ...(params.landlordId ? { landlordId: params.landlordId } : {}),
            },
            orderBy: { createdAt: "desc" },
        });
        return Boolean(recent);
    } catch (err) {
        console.warn("hasRecentLandlordReply failed", err);
        return false;
    }
}

export default {
    saveMessage,
    getHistory,
    formatHistory,
    getMessageCount,
    hasRecentLandlordReply,
};
