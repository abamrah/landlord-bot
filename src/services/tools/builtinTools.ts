/**
 * tools/ — Concrete tool implementations for the agent framework.
 *
 * Each file exports functions that create ToolDefinition objects.
 * Tools are grouped by category: data, communication, web, ai, utility.
 */

import https from "https";
import http from "http";
import { ToolDefinition } from "../toolRegistry";
import repo from "../repository";
import whatsappService from "../whatsappService";
import conversationMemory from "../conversationMemory";
import { getProfile, listProvinces } from "../../config/rtaProfiles";
import { db } from "../../config/database";
import greenButton from "../greenButtonService";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ═══════════════════════════════════════════════════════════
//  DATA TOOLS — Read/write to the database
// ═══════════════════════════════════════════════════════════

export function lookupTenantTool(): ToolDefinition {
    return {
        name: "lookup_tenant",
        description: "Look up a tenant by phone number or ID. Returns tenant info including unit, name, and lease details.",
        parameters: {
            phone: { type: "string", description: "Tenant phone number" },
            tenantId: { type: "string", description: "Tenant ID" },
        },
        category: "data",
        enabled: true,
        async execute(args) {
            if (args.phone) {
                const tenant = await repo.findTenantByPhone(String(args.phone), args.landlordId ? String(args.landlordId) : undefined);
                return tenant || { error: "Tenant not found" };
            }
            if (args.tenantId) {
                const tenant = await db.tenant.findUnique({
                    where: { id: String(args.tenantId) },
                    include: { units: true },
                });
                return tenant || { error: "Tenant not found" };
            }
            return { error: "Provide phone or tenantId" };
        },
    };
}

export function lookupUnitTool(): ToolDefinition {
    return {
        name: "lookup_unit",
        description: "Look up a rental unit by ID. Returns unit details, address, and associated tenants.",
        parameters: {
            unitId: { type: "string", description: "Unit ID" },
        },
        required: ["unitId"],
        category: "data",
        enabled: true,
        async execute(args) {
            const unit = await db.unit.findUnique({
                where: { id: String(args.unitId) },
                include: { tenants: true },
            });
            return unit || { error: "Unit not found" };
        },
    };
}

export function listMaintenanceTool(): ToolDefinition {
    return {
        name: "list_maintenance",
        description: "List maintenance requests. Can filter by status, unit, or tenant. Returns recent issues with triage info.",
        parameters: {
            status: { type: "string", description: "Filter by status: OPEN, PENDING, IN_TRIAGE, SCHEDULED, IN_PROGRESS, RESOLVED, CANCELLED" },
            unitId: { type: "string", description: "Filter by unit ID" },
            tenantId: { type: "string", description: "Filter by tenant ID" },
            limit: { type: "number", description: "Max results to return (default 20)" },
        },
        category: "data",
        enabled: true,
        async execute(args) {
            const result = await repo.listMaintenance({
                status: args.status ? String(args.status) : undefined,
                landlordId: args.landlordId ? String(args.landlordId) : undefined,
            });
            let items = result.items || [];
            if (args.unitId) items = items.filter((i: any) => i.unitId === args.unitId);
            if (args.tenantId) items = items.filter((i: any) => i.tenantId === args.tenantId);
            const limit = Number(args.limit) || 20;
            return { items: items.slice(0, limit), total: items.length };
        },
    };
}

export function createMaintenanceRequestTool(): ToolDefinition {
    return {
        name: "create_maintenance_request",
        description: "Create a new maintenance request in the database. Used when a tenant reports an issue.",
        parameters: {
            message: { type: "string", description: "The tenant's maintenance message" },
            tenantId: { type: "string", description: "Tenant ID" },
            unitId: { type: "string", description: "Unit ID" },
            triageJson: { type: "object", description: "Triage result JSON from triage_message tool", properties: { classification: { type: "object", properties: { severity: { type: "string" }, category: { type: "string" } } }, summary: { type: "string" } } },
        },
        required: ["message"],
        category: "data",
        enabled: true,
        async execute(args) {
            const request = await repo.createMaintenanceRequest({
                message: String(args.message),
                tenantId: args.tenantId ? String(args.tenantId) : undefined,
                unitId: args.unitId ? String(args.unitId) : undefined,
                landlordId: args.landlordId ? String(args.landlordId) : undefined,
                triage: (args.triageJson || undefined) as Record<string, unknown> | undefined,
            });
            return request;
        },
    };
}

export function updateMaintenanceStatusTool(): ToolDefinition {
    return {
        name: "update_maintenance_status",
        description: "Update the status of a maintenance request. Valid statuses: OPEN, PENDING, IN_TRIAGE, SCHEDULED, IN_PROGRESS, RESOLVED, CANCELLED.",
        parameters: {
            requestId: { type: "string", description: "Maintenance request ID" },
            status: { type: "string", description: "New status" },
        },
        required: ["requestId", "status"],
        category: "data",
        enabled: true,
        async execute(args) {
            const updated = await db.maintenanceRequest.update({
                where: { id: String(args.requestId) },
                data: {
                    status: String(args.status) as any,
                    statusChangedAt: new Date(),
                },
            });
            return { id: updated.id, status: updated.status };
        },
    };
}

export function listContractorsTool(): ToolDefinition {
    return {
        name: "list_contractors",
        description: "List available contractors. Can filter by specialty/role (plumber, electrician, HVAC, general). Also auto-matches by maintenance category.",
        parameters: {
            role: { type: "string", description: "Filter by role/specialty" },
            category: { type: "string", description: "Maintenance category to auto-match (plumbing, electrical, hvac, roofing, general, appliance, pest, locksmith)" },
        },
        category: "data",
        enabled: true,
        async execute(args) {
            const items = await repo.listContractors(args.landlordId ? String(args.landlordId) : undefined);
            const filterTerm = String(args.role || args.category || "").toLowerCase();
            if (filterTerm) {
                // Category-to-specialty mapping for smart matching
                const categoryMap: Record<string, string[]> = {
                    plumbing: ["plumber", "plumbing", "pipe", "drain", "water"],
                    electrical: ["electrician", "electrical", "wiring", "power"],
                    hvac: ["hvac", "heating", "cooling", "ac", "furnace", "thermostat", "air conditioning"],
                    roofing: ["roofer", "roofing", "roof"],
                    appliance: ["appliance", "washer", "dryer", "fridge", "dishwasher", "oven", "stove"],
                    pest: ["pest", "exterminator", "pest control", "bug", "rodent"],
                    locksmith: ["locksmith", "lock", "key", "door"],
                    general: ["general", "handyman", "maintenance"],
                };
                const expandedTerms = categoryMap[filterTerm] || [filterTerm];
                const filtered = items.filter((c: any) =>
                    expandedTerms.some((term) =>
                        (c.role || "").toLowerCase().includes(term) ||
                        (c.specialties || []).some((s: string) => s.toLowerCase().includes(term)) ||
                        (c.name || "").toLowerCase().includes(term)
                    )
                );
                // If specific match found, return those; otherwise return all with a note
                if (filtered.length > 0) {
                    return { items: filtered, matchedBy: filterTerm };
                }
                return { items, matchedBy: null, note: `No contractors specifically matched "${filterTerm}" — showing all available.` };
            }
            return { items };
        },
    };
}

export function lookupUtilityBillsTool(): ToolDefinition {
    return {
        name: "lookup_utility_bills",
        description: "Look up recent utility bills for a unit. Shows amounts, types, and anomaly flags.",
        parameters: {
            unitId: { type: "string", description: "Unit ID to look up bills for" },
            limit: { type: "number", description: "Max results (default 10)" },
        },
        category: "data",
        enabled: true,
        async execute(args) {
            const where: any = {};
            if (args.unitId) where.unitId = String(args.unitId);
            if (args.landlordId) where.landlordId = String(args.landlordId);
            const bills = await db.utilityBill.findMany({
                where,
                orderBy: { billingPeriodEnd: "desc" },
                take: Number(args.limit) || 10,
                include: { unit: true },
            });
            return { bills };
        },
    };
}

export function getUtilityCredentialsTool(): ToolDefinition {
    return {
        name: "get_utility_credentials",
        description: "Get utility portal login credentials for a unit. Used by web_browse to log into utility websites.",
        parameters: {
            unitId: { type: "string", description: "Unit ID" },
            utilityType: { type: "string", description: "INTERNET, WATER_GAS, or HYDRO" },
        },
        required: ["unitId"],
        category: "data",
        enabled: true,
        async execute(args) {
            const where: any = { unitId: String(args.unitId) };
            if (args.utilityType) where.utilityType = String(args.utilityType);
            if (args.landlordId) where.landlordId = String(args.landlordId);
            const creds = await db.utilityCredential.findMany({ where });
            // Mask passwords in output to LLM — only expose to web_browse tool
            return {
                credentials: creds.map((c: any) => ({
                    id: c.id,
                    unitId: c.unitId,
                    utilityType: c.utilityType,
                    username: c.username,
                    hasPassword: Boolean(c.password || c.passwordEncrypted),
                    portalUrl: c.url || null,
                    notes: c.notes,
                })),
            };
        },
    };
}

// ═══════════════════════════════════════════════════════════
//  COMMUNICATION TOOLS — Send messages via WhatsApp
// ═══════════════════════════════════════════════════════════

export function sendWhatsAppTool(): ToolDefinition {
    return {
        name: "send_whatsapp",
        description: "Send a WhatsApp message to a phone number. Use this to reply to tenants, alert landlords, or contact contractors.",
        parameters: {
            to: { type: "string", description: "Recipient phone number (e.g., +14165551234)" },
            text: { type: "string", description: "Message text to send" },
        },
        required: ["to", "text"],
        category: "communication",
        enabled: true,
        async execute(args) {
            const result = await whatsappService.sendWhatsAppText({
                to: String(args.to),
                text: String(args.text),
                landlordId: args.landlordId ? String(args.landlordId) : undefined,
            });
            return result;
        },
    };
}

export function alertLandlordTool(): ToolDefinition {
    return {
        name: "alert_landlord",
        description: "Send an alert message to the landlord's WhatsApp number(s). Use for urgent issues, status updates, or important notifications.",
        parameters: {
            message: { type: "string", description: "Alert message text" },
        },
        required: ["message"],
        category: "communication",
        enabled: true,
        async execute(args) {
            if (!args.landlordId) return { error: "No landlord context" };
            await whatsappService.alertLandlord(String(args.landlordId), String(args.message));
            return { sent: true };
        },
    };
}

export function dispatchContractorTool(): ToolDefinition {
    return {
        name: "dispatch_contractor",
        description: "Send a maintenance request to a contractor via WhatsApp. Include the issue details and unit address.",
        parameters: {
            contractorId: { type: "string", description: "Contractor ID from list_contractors" },
            message: { type: "string", description: "Message describing the maintenance work needed" },
            requestId: { type: "string", description: "Maintenance request ID for tracking" },
        },
        required: ["contractorId", "message"],
        category: "communication",
        enabled: true,
        async execute(args) {
            const contractor = await db.contractor.findUnique({ where: { id: String(args.contractorId) } });
            if (!contractor || !contractor.phone) return { error: "Contractor not found or has no phone" };
            const result = await whatsappService.sendWhatsAppText({
                to: contractor.phone,
                text: String(args.message),
                landlordId: args.landlordId ? String(args.landlordId) : undefined,
            });
            return { sent: result.ok, contractor: contractor.name, error: result.error };
        },
    };
}

// ═══════════════════════════════════════════════════════════
//  AI TOOLS — LLM sub-tasks (triage, draft, etc.)
// ═══════════════════════════════════════════════════════════

export function triageMessageTool(): ToolDefinition {
    return {
        name: "triage_message",
        description: "Analyze a tenant's maintenance message and classify its severity (critical/high/normal/low), category, and urgency. Returns structured triage data.",
        parameters: {
            tenantMessage: { type: "string", description: "The tenant's message to analyze" },
            tenantId: { type: "string", description: "Tenant ID for context" },
            unitId: { type: "string", description: "Unit ID for context" },
            province: { type: "string", description: "Province/state code for RTA compliance" },
        },
        required: ["tenantMessage"],
        category: "ai",
        enabled: true,
        async execute(args) {
            // Import dynamically to avoid circular dependency
            const agentService = require("../agentService").default;
            return agentService.triageMaintenance({
                tenantMessage: String(args.tenantMessage),
                tenantId: args.tenantId ? String(args.tenantId) : undefined,
                unitId: args.unitId ? String(args.unitId) : undefined,
                province: args.province ? String(args.province) : undefined,
            });
        },
    };
}

export function draftReplyTool(): ToolDefinition {
    return {
        name: "draft_reply",
        description: "Draft a tenant-facing reply based on triage results. The draft is casual, legally aware, and ready for landlord approval.",
        parameters: {
            tenantMessage: { type: "string", description: "Original tenant message" },
            triageJson: { type: "object", description: "Triage result from triage_message", properties: { classification: { type: "object", properties: { severity: { type: "string" }, category: { type: "string" } } }, summary: { type: "string" } } },
            conversationLog: { type: "array", description: "Previous conversation entries", items: { type: "object", properties: { role: { type: "string" }, content: { type: "string" } } } },
            province: { type: "string", description: "Province/state code" },
        },
        required: ["tenantMessage", "triageJson"],
        category: "ai",
        enabled: true,
        async execute(args) {
            const agentService = require("../agentService").default;
            return agentService.draftRtaResponse({
                tenantMessage: String(args.tenantMessage),
                triage: args.triageJson as any,
                utilityCheck: { usedSkill: false, status: "ok" as const, anomalyFound: false, notes: "" },
                conversationLog: args.conversationLog as any,
                province: args.province ? String(args.province) : undefined,
            });
        },
    };
}

// ═══════════════════════════════════════════════════════════
//  UTILITY TOOLS — Province info, date/time, etc.
// ═══════════════════════════════════════════════════════════

export function rtaInfoTool(): ToolDefinition {
    return {
        name: "rta_info",
        description: "Get tenancy law information for a specific province/state/jurisdiction. Returns legislation name, notice periods, emergency procedures, and rent rules.",
        parameters: {
            province: { type: "string", description: "Province/state code (ON, BC, NY, CA_US, etc.)" },
        },
        required: ["province"],
        category: "utility",
        enabled: true,
        async execute(args) {
            const code = String(args.province);
            const profile = getProfile(code);
            return profile;
        },
    };
}

export function currentTimeTool(): ToolDefinition {
    return {
        name: "current_time",
        description: "Get the current date and time. Useful for determining business hours, scheduling, and deadline calculations.",
        parameters: {},
        category: "utility",
        enabled: true,
        async execute() {
            const now = new Date();
            return {
                iso: now.toISOString(),
                date: now.toLocaleDateString("en-CA"),
                time: now.toLocaleTimeString("en-CA", { hour12: false }),
                dayOfWeek: now.toLocaleDateString("en-CA", { weekday: "long" }),
                isWeekend: [0, 6].includes(now.getDay()),
                isBusinessHours: now.getHours() >= 9 && now.getHours() < 17 && ![0, 6].includes(now.getDay()),
            };
        },
    };
}

// ═══════════════════════════════════════════════════════════
//  WEB SEARCH TOOLS — Search the web and fetch pages
// ═══════════════════════════════════════════════════════════

/** Helper: fetch a URL and return body text via https/http */
function httpGet(url: string, maxLen = 15000): Promise<string> {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith("https") ? https : http;
        const req = mod.get(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; NestMindBot/1.0)" }, timeout: 15000 }, (res) => {
            // Follow redirects (up to 3)
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpGet(res.headers.location, maxLen).then(resolve).catch(reject);
            }
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
                body += chunk;
                if (body.length > maxLen * 2) res.destroy(); // stop early for huge pages
            });
            res.on("end", () => resolve(body));
            res.on("error", reject);
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    });
}

/** Strip HTML tags and collapse whitespace */
function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#?\w+;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function webSearchTool(): ToolDefinition {
    return {
        name: "web_search",
        description: "Search the web using Google Search. Use this to find product manuals, troubleshooting guides, repair instructions, warranty information, appliance documentation, and any other reference material. Returns a summary of findings with source URLs.",
        parameters: {
            query: { type: "string", description: "Search query (e.g., 'Honeywell T6 Pro thermostat user manual PDF')" },
        },
        required: ["query"],
        category: "web",
        enabled: true,
        async execute(args) {
            const query = String(args.query).trim();
            if (!query) return { error: "Search query is required" };

            const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
            if (!apiKey) return { error: "Google API key not configured" };

            try {
                const genAI = new GoogleGenerativeAI(apiKey);
                const model = genAI.getGenerativeModel({
                    model: "gemini-2.5-flash",
                    tools: [{ googleSearch: {} } as any],
                });

                const result = await model.generateContent(
                    `Search the web for: ${query}\n\nReturn the most relevant findings including:\n- Direct URLs to manuals, guides, or documentation\n- Key troubleshooting steps or instructions found\n- Relevant product details\nBe specific and include actual links.`
                );

                const response = result.response;
                const text = response.text();

                // Extract grounding sources
                const candidate = (response as any).candidates?.[0];
                const groundingMeta = candidate?.groundingMetadata;
                const sources: Array<{ title: string; url: string }> = [];
                const searchQueries: string[] = groundingMeta?.webSearchQueries || [];

                if (groundingMeta?.groundingChunks) {
                    for (const chunk of groundingMeta.groundingChunks) {
                        if (chunk.web) {
                            sources.push({ title: chunk.web.title || "", url: chunk.web.uri || "" });
                        }
                    }
                }

                return {
                    query,
                    summary: text.slice(0, 3000),
                    sources: sources.slice(0, 10),
                    searchQueries,
                };
            } catch (err) {
                return { error: `Web search failed: ${(err as Error).message}`, query };
            }
        },
    };
}

export function fetchPageContentTool(): ToolDefinition {
    return {
        name: "fetch_page_content",
        description: "Fetch and read the text content of a webpage URL. Use this after web_search to read a manual, guide, or article. Returns the page text content (no JavaScript rendering). Good for documentation pages, PDFs hosted online, support articles, etc.",
        parameters: {
            url: { type: "string", description: "The full URL to fetch (e.g., 'https://example.com/manual.html')" },
            maxLength: { type: "number", description: "Max characters to return (default 12000)" },
        },
        required: ["url"],
        category: "web",
        enabled: true,
        async execute(args) {
            const url = String(args.url).trim();
            if (!url) return { error: "URL is required" };

            try {
                const maxLen = Number(args.maxLength) || 12000;
                const html = await httpGet(url, maxLen);
                const text = htmlToText(html);
                const truncated = text.length > maxLen ? text.slice(0, maxLen) + "\n...[truncated]" : text;

                // Extract title
                const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
                const title = titleMatch ? htmlToText(titleMatch[1]).slice(0, 150) : "";

                return {
                    url,
                    title,
                    content: truncated,
                    contentLength: text.length,
                    truncatedAt: text.length > maxLen ? maxLen : undefined,
                };
            } catch (err) {
                return { error: `Fetch failed: ${(err as Error).message}`, url };
            }
        },
    };
}

// ═══════════════════════════════════════════════════════════
//  NEW PORTFOLIO TOOLS — List tenants, units, reminders, leases
// ═══════════════════════════════════════════════════════════

export function listTenantsTool(): ToolDefinition {
    return {
        name: "list_tenants",
        description: "List all tenants for this landlord. Returns tenant names, phone numbers, emails, unit assignments, and lease dates. Use this when the landlord asks about their tenants, occupancy, or wants to find a tenant by name.",
        parameters: {},
        category: "data",
        enabled: true,
        async execute(args) {
            const landlordId = args.landlordId ? String(args.landlordId) : undefined;
            if (!landlordId) return { error: "No landlord context" };
            const tenants = await db.tenant.findMany({
                where: { landlordId },
                include: {
                    units: {
                        include: { unit: { select: { label: true, address: true } } },
                    },
                },
                orderBy: { name: "asc" },
            });
            return {
                tenants: tenants.map((t: any) => ({
                    id: t.id,
                    name: t.name,
                    phone: t.phone,
                    email: t.email,
                    autoReplyEnabled: t.autoReplyEnabled,
                    units: t.units.map((ut: any) => ({
                        unitLabel: ut.unit?.label,
                        unitAddress: ut.unit?.address,
                        leaseStart: ut.startDate?.toISOString?.().split("T")[0] || null,
                        leaseEnd: ut.endDate?.toISOString?.().split("T")[0] || null,
                    })),
                })),
                total: tenants.length,
            };
        },
    };
}

export function listUnitsTool(): ToolDefinition {
    return {
        name: "list_units",
        description: "List all rental units for this landlord. Returns unit labels, addresses, and how many tenants are in each unit. Use this when the landlord asks about their properties or occupancy.",
        parameters: {},
        category: "data",
        enabled: true,
        async execute(args) {
            const landlordId = args.landlordId ? String(args.landlordId) : undefined;
            if (!landlordId) return { error: "No landlord context" };
            const units = await db.unit.findMany({
                where: { landlordId },
                include: {
                    tenants: {
                        include: { tenant: { select: { id: true, name: true, phone: true } } },
                    },
                },
                orderBy: { label: "asc" },
            });
            return {
                units: units.map((u: any) => ({
                    id: u.id,
                    label: u.label,
                    address: u.address,
                    tenantCount: u.tenants.length,
                    tenants: u.tenants.map((ut: any) => ({
                        name: ut.tenant?.name,
                        phone: ut.tenant?.phone,
                        leaseStart: ut.startDate?.toISOString?.().split("T")[0] || null,
                        leaseEnd: ut.endDate?.toISOString?.().split("T")[0] || null,
                    })),
                })),
                total: units.length,
            };
        },
    };
}

export function listRemindersTool(): ToolDefinition {
    return {
        name: "list_reminders",
        description: "List all active reminders (rent due dates, utility payment schedules) for this landlord. Shows scheduled day of month, time, type, and status.",
        parameters: {},
        category: "data",
        enabled: true,
        async execute(args) {
            const landlordId = args.landlordId ? String(args.landlordId) : undefined;
            if (!landlordId) return { error: "No landlord context" };
            const reminders = await db.reminder.findMany({
                where: { landlordId },
                orderBy: { dayOfMonth: "asc" },
            });
            return {
                reminders: reminders.map((r: any) => ({
                    id: r.id,
                    type: r.type,
                    dayOfMonth: r.dayOfMonth,
                    timeUtc: r.timeUtc,
                    style: r.style,
                    active: r.active,
                    lastSentAt: r.lastSentAt?.toISOString?.() || null,
                })),
                total: reminders.length,
            };
        },
    };
}

export function expiringLeasesTool(): ToolDefinition {
    return {
        name: "expiring_leases",
        description: "Check for leases expiring within a given number of days (default 90). Returns tenant names, units, and days remaining. Use when the landlord asks about lease renewals or upcoming expirations.",
        parameters: {
            daysAhead: { type: "number", description: "Number of days to look ahead (default 90)" },
        },
        category: "data",
        enabled: true,
        async execute(args) {
            const { findExpiringLeases } = await import("../leaseExpiryService");
            const daysAhead = Number(args.daysAhead) || 90;
            const landlordId = args.landlordId ? String(args.landlordId) : undefined;
            const all = await findExpiringLeases(daysAhead);
            const filtered = landlordId ? all.filter((a) => a.landlordId === landlordId) : all;
            return {
                expiringLeases: filtered.map((a) => ({
                    tenantName: a.tenantName,
                    tenantPhone: a.tenantPhone,
                    unitLabel: a.unitLabel,
                    unitAddress: a.unitAddress,
                    endDate: a.endDate.toISOString().split("T")[0],
                    daysRemaining: a.daysRemaining,
                })),
                total: filtered.length,
                lookAheadDays: daysAhead,
            };
        },
    };
}

export function lookupLeaseTool(): ToolDefinition {
    return {
        name: "lookup_lease",
        description: "Look up lease documents and extracted terms for a specific unit or tenant. Returns AI-extracted lease terms (rent, dates, deposit, clauses) from uploaded lease PDFs.",
        parameters: {
            unitId: { type: "string", description: "Unit ID to look up leases for" },
            tenantId: { type: "string", description: "Tenant ID to look up leases for" },
        },
        category: "data",
        enabled: true,
        async execute(args) {
            const where: any = {};
            if (args.unitId) where.unitId = String(args.unitId);
            if (args.tenantId) where.tenantId = String(args.tenantId);
            if (!args.unitId && !args.tenantId) {
                // If landlordId is available, get all leases for this landlord
                if (args.landlordId) {
                    const unitTenants = await db.unitTenant.findMany({
                        where: { unit: { landlordId: String(args.landlordId) } },
                        include: {
                            tenant: { select: { name: true, phone: true } },
                            unit: { select: { label: true, address: true } },
                            leaseDocuments: { select: { id: true, fileName: true, extractedTerms: true, summary: true, uploadedAt: true } },
                        },
                    });
                    return {
                        leases: unitTenants.map((ut: any) => ({
                            tenantName: ut.tenant?.name,
                            unitLabel: ut.unit?.label,
                            startDate: ut.startDate?.toISOString?.().split("T")[0],
                            endDate: ut.endDate?.toISOString?.().split("T")[0],
                            documents: ut.leaseDocuments,
                        })),
                        total: unitTenants.length,
                    };
                }
                return { error: "Provide unitId or tenantId" };
            }
            const unitTenants = await db.unitTenant.findMany({
                where,
                include: {
                    tenant: { select: { name: true, phone: true } },
                    unit: { select: { label: true, address: true } },
                    leaseDocuments: { select: { id: true, fileName: true, extractedTerms: true, summary: true, uploadedAt: true } },
                },
            });
            return {
                leases: unitTenants.map((ut: any) => ({
                    tenantName: ut.tenant?.name,
                    unitLabel: ut.unit?.label,
                    startDate: ut.startDate?.toISOString?.().split("T")[0],
                    endDate: ut.endDate?.toISOString?.().split("T")[0],
                    documents: ut.leaseDocuments,
                })),
                total: unitTenants.length,
            };
        },
    };
}

export function maintenanceGuidanceTool(): ToolDefinition {
    return {
        name: "maintenance_guidance",
        description: "Get property maintenance guidance, seasonal checklists, preventive maintenance schedules, and general landlord help. Searches the web for best practices and provides actionable advice.",
        parameters: {
            topic: { type: "string", description: "The maintenance topic or question (e.g., 'winter preparation checklist', 'HVAC maintenance schedule', 'how often to inspect fire alarms')" },
        },
        required: ["topic"],
        category: "utility",
        enabled: true,
        async execute(args) {
            const topic = String(args.topic);
            // Use web search internally for real-time guidance
            const searchTool = webSearchTool();
            const searchResult = await searchTool.execute({
                ...args,
                query: `property maintenance landlord guide: ${topic}`,
            });
            return {
                topic,
                guidance: searchResult,
                note: "This guidance is based on general best practices. Always check local regulations.",
            };
        },
    };
}

// ═══════════════════════════════════════════════════════════
//  FINANCIAL TOOLS
// ═══════════════════════════════════════════════════════════

export function recordPaymentTool(): ToolDefinition {
    return {
        name: "record_payment",
        description: "Record a financial transaction — rent payment received, expense incurred, security deposit collected, or refund issued. Creates a permanent ledger entry. Use this when the landlord mentions receiving rent, paying for repairs, collecting deposits, etc.",
        parameters: {
            type: { type: "string", description: "Transaction type: RENT_PAYMENT, EXPENSE, DEPOSIT, REFUND, or OTHER" },
            amount: { type: "number", description: "Dollar amount of the transaction" },
            tenantName: { type: "string", description: "Name of the tenant involved (optional)" },
            unitLabel: { type: "string", description: "Unit label/address (optional)" },
            description: { type: "string", description: "Description of the transaction (e.g., 'February 2026 rent', 'Plumber repair for kitchen sink')" },
            date: { type: "string", description: "Date of transaction in ISO format (defaults to today)" },
        },
        required: ["type", "amount"],
        category: "data",
        enabled: true,
        async execute(args) {
            const landlordId = args.landlordId as string;
            if (!landlordId) return { error: "Not authenticated" };
            const validTypes = ["RENT_PAYMENT", "EXPENSE", "DEPOSIT", "REFUND", "OTHER"];
            const type = String(args.type).toUpperCase();
            if (!validTypes.includes(type)) return { error: `Invalid type. Must be one of: ${validTypes.join(", ")}` };
            const amount = Number(args.amount);
            if (isNaN(amount) || amount <= 0) return { error: "Amount must be a positive number" };

            const record = await repo.createFinancialRecord({
                landlordId,
                tenantName: args.tenantName ? String(args.tenantName) : undefined,
                unitLabel: args.unitLabel ? String(args.unitLabel) : undefined,
                type,
                amount,
                description: args.description ? String(args.description) : undefined,
                date: args.date ? new Date(String(args.date)) : undefined,
            });
            return {
                success: true,
                id: record?.id,
                type,
                amount,
                message: `Recorded ${type} of $${amount.toFixed(2)}${args.tenantName ? ` for ${args.tenantName}` : ""}`,
            };
        },
    };
}

export function listFinancialRecordsTool(): ToolDefinition {
    return {
        name: "list_financial_records",
        description: "List financial records / ledger entries for the landlord. Can filter by type (RENT_PAYMENT, EXPENSE, DEPOSIT, REFUND), tenant name, or date range. Shows recent transactions.",
        parameters: {
            type: { type: "string", description: "Filter by type: RENT_PAYMENT, EXPENSE, DEPOSIT, REFUND, OTHER (optional)" },
            tenantName: { type: "string", description: "Filter by tenant name (partial match, optional)" },
            limit: { type: "number", description: "Maximum records to return (default 20)" },
        },
        required: [],
        category: "data",
        enabled: true,
        async execute(args) {
            const landlordId = args.landlordId as string;
            if (!landlordId) return { error: "Not authenticated" };
            const records = await repo.listFinancialRecords(landlordId, {
                type: args.type ? String(args.type).toUpperCase() : undefined,
                tenantName: args.tenantName ? String(args.tenantName) : undefined,
                limit: args.limit ? Number(args.limit) : 20,
            });
            return {
                records: records.map((r: any) => ({
                    id: r.id,
                    type: r.type,
                    amount: r.amount,
                    currency: r.currency,
                    tenantName: r.tenantName,
                    unitLabel: r.unitLabel,
                    description: r.description,
                    date: r.date,
                })),
                total: records.length,
            };
        },
    };
}

export function financialSummaryTool(): ToolDefinition {
    return {
        name: "financial_summary",
        description: "Get a financial summary for the landlord — total income (rent payments + deposits), total expenses, net amount, broken down by transaction type. Useful for quick financial overview or reporting.",
        parameters: {},
        required: [],
        category: "data",
        enabled: true,
        async execute(args) {
            const landlordId = args.landlordId as string;
            if (!landlordId) return { error: "Not authenticated" };
            const summary = await repo.getFinancialSummary(landlordId);
            if (!summary) return { error: "Could not load financial data" };
            return summary;
        },
    };
}

// ═══════════════════════════════════════════════════════════
//  LEGAL NOTICE GENERATION TOOL
// ═══════════════════════════════════════════════════════════

export function generateNoticeTool(): ToolDefinition {
    return {
        name: "generate_notice",
        description:
            "Generate an Ontario LTB notice PDF matching official Tribunals Ontario format. Supported forms: " +
            "N1 (rent increase, s.116), N2 (rent increase – unit partially exempt, s.6(2)), " +
            "N4 (non-payment of rent, s.59), N5 (interference/damage/overcrowding, ss.62,64,67), " +
            "N6 (illegal acts/misrepresentation, ss.60,61), N7 (impaired safety, s.66), " +
            "N8 (end of term – persistent late payment, ss.58,144), N9 (tenant's notice to end, s.47), " +
            "N10 (agreement to increase rent above guideline, s.121), N11 (agreement to end tenancy, s.77), " +
            "N12 (landlord/family/purchaser own use, ss.48,49), N13 (demolition/repair/conversion, s.50). " +
            "Returns the notice as a downloadable PDF.",
        parameters: {
            noticeType: { type: "string", description: "Type of notice: N1, N2, N4, N5, N6, N7, N8, N9, N10, N11, N12, or N13" },
            tenantName: { type: "string", description: "Full name(s) of the tenant(s)" },
            rentalUnitAddress: { type: "string", description: "Full address of the rental unit" },
            landlordName: { type: "string", description: "Full name of the landlord" },
            landlordPhone: { type: "string", description: "Landlord's phone number (optional)" },
            terminationDate: { type: "string", description: "Termination/effective date (required for most forms)" },
            // N1/N13 fields
            currentRent: { type: "number", description: "For N1/N13: current monthly rent amount" },
            newRent: { type: "number", description: "For N1/N13: new monthly rent amount" },
            // N4-specific
            rentOwingPeriod: { type: "string", description: "For N4: rent period (e.g., 'February 2026')" },
            rentCharged: { type: "number", description: "For N4: rent amount charged" },
            rentPaid: { type: "number", description: "For N4: rent amount paid" },
            // N5/N6/N7/N12/N13 fields
            reason: { type: "string", description: "Reason for the notice — N5: interference|damage|overcrowding|act_impairs_safety, N6: illegal_act|misrepresentation, N10: capital_expenditure|new_or_additional_services|both, N12: personal_use|family_use|purchaser_use, N13: demolition|conversion|repairs" },
            details: { type: "string", description: "For N5/N6/N7/N10/N13: detailed description of the issue" },
            // N8-specific
            latePayments: { type: "string", description: "For N8: JSON array of late payments [{period, dueDate, datePaid}]" },
            // N11-specific
            tenantSignedBy: { type: "string", description: "For N11: tenant's printed name for signature" },
            // N12-specific
            occupantName: { type: "string", description: "For N12: name of person who will occupy the unit" },
            relationship: { type: "string", description: "For N12: relationship to landlord (if family_use)" },
        },
        required: ["noticeType", "tenantName", "rentalUnitAddress", "landlordName"],
        category: "utility",
        enabled: true,
        async execute(args) {
            const noticeType = String(args.noticeType).toUpperCase();
            const noticeService = require("../noticeService");
            const validTypes = noticeService.VALID_NOTICE_TYPES as readonly string[];
            if (!validTypes.includes(noticeType)) {
                return { error: `Invalid notice type '${noticeType}'. Valid types: ${validTypes.join(", ")}` };
            }

            const common = {
                tenantName: String(args.tenantName),
                rentalUnitAddress: String(args.rentalUnitAddress),
                landlordName: String(args.landlordName),
                landlordPhone: args.landlordPhone ? String(args.landlordPhone) : undefined,
                dateGiven: new Date().toISOString().split("T")[0],
                signedBy: String(args.landlordName),
            };

            try {
                let pdfBuffer: Buffer;
                let description = "";

                switch (noticeType) {
                    case "N1": {
                        const cur = Number(args.currentRent) || 0;
                        const nw = Number(args.newRent) || 0;
                        pdfBuffer = await noticeService.generateN1Notice({
                            ...common,
                            currentRent: cur,
                            newRent: nw,
                            effectiveDate: String(args.terminationDate || ""),
                        });
                        description = `Rent increase from $${cur.toFixed(2)} to $${nw.toFixed(2)}, effective ${args.terminationDate}`;
                        break;
                    }
                    case "N2": {
                        const cur2 = Number(args.currentRent) || 0;
                        const nw2 = Number(args.newRent) || 0;
                        pdfBuffer = await noticeService.generateN2Notice({
                            ...common,
                            currentRent: cur2,
                            newRent: nw2,
                            effectiveDate: String(args.terminationDate || ""),
                            exemptionReason: String(args.reason || "post_nov_2018"),
                        });
                        description = `Rent increase (unit partially exempt) from $${cur2.toFixed(2)} to $${nw2.toFixed(2)}, effective ${args.terminationDate}`;
                        break;
                    }
                    case "N4": {
                        const rentCharged = Number(args.rentCharged) || 0;
                        const rentPaid = Number(args.rentPaid) || 0;
                        const rentOwing = rentCharged - rentPaid;
                        pdfBuffer = await noticeService.generateN4Notice({
                            ...common,
                            rentOwing: [{
                                period: String(args.rentOwingPeriod || "Current period"),
                                rentCharged,
                                rentPaid,
                                rentOwing,
                            }],
                            totalOwing: rentOwing,
                            terminationDate: String(args.terminationDate || ""),
                        });
                        description = `Non-payment of rent. Owing: $${rentOwing.toFixed(2)}. Termination: ${args.terminationDate}`;
                        break;
                    }
                    case "N5": {
                        pdfBuffer = await noticeService.generateN5Notice({
                            ...common,
                            reason: String(args.reason || "interference"),
                            details: String(args.details || ""),
                            terminationDate: String(args.terminationDate || ""),
                        });
                        description = `Interference/damage/overcrowding (${args.reason || "interference"}). Termination: ${args.terminationDate}`;
                        break;
                    }
                    case "N6": {
                        pdfBuffer = await noticeService.generateN6Notice({
                            ...common,
                            reason: String(args.reason || "illegal_act"),
                            details: String(args.details || ""),
                            terminationDate: String(args.terminationDate || ""),
                        });
                        description = `Illegal act/misrepresentation (${args.reason || "illegal_act"}). Termination: ${args.terminationDate}`;
                        break;
                    }
                    case "N7": {
                        pdfBuffer = await noticeService.generateN7Notice({
                            ...common,
                            details: String(args.details || ""),
                            terminationDate: String(args.terminationDate || ""),
                        });
                        description = `Impaired safety. Termination: ${args.terminationDate}`;
                        break;
                    }
                    case "N8": {
                        let latePayments: Array<{ period: string; dueDate: string; datePaid: string }> = [];
                        try {
                            latePayments = JSON.parse(String(args.latePayments || "[]"));
                        } catch {
                            latePayments = [{ period: "Current period", dueDate: "See pattern", datePaid: "Late" }];
                        }
                        pdfBuffer = await noticeService.generateN8Notice({
                            ...common,
                            latePayments,
                            terminationDate: String(args.terminationDate || ""),
                        });
                        description = `Persistent late payment (${latePayments.length} instances). Termination: ${args.terminationDate}`;
                        break;
                    }
                    case "N9": {
                        pdfBuffer = await noticeService.generateN9Notice({
                            ...common,
                            terminationDate: String(args.terminationDate || ""),
                        });
                        description = `Tenant's notice to end tenancy. Termination: ${args.terminationDate}`;
                        break;
                    }
                    case "N10": {
                        const cur10 = Number(args.currentRent) || 0;
                        const nw10 = Number(args.newRent) || 0;
                        pdfBuffer = await noticeService.generateN10Notice({
                            ...common,
                            currentRent: cur10,
                            newRent: nw10,
                            reason: String(args.reason || "capital_expenditure"),
                            details: String(args.details || ""),
                            effectiveDate: String(args.terminationDate || ""),
                            tenantSignedBy: String(args.tenantSignedBy || args.tenantName),
                        });
                        description = `Agreement to increase rent above guideline from $${cur10.toFixed(2)} to $${nw10.toFixed(2)} (${args.reason || "capital_expenditure"}). Effective: ${args.terminationDate}`;
                        break;
                    }
                    case "N11": {
                        pdfBuffer = await noticeService.generateN11Notice({
                            ...common,
                            tenantSignedBy: String(args.tenantSignedBy || args.tenantName),
                            terminationDate: String(args.terminationDate || ""),
                        });
                        description = `Mutual agreement to end tenancy. Termination: ${args.terminationDate}`;
                        break;
                    }
                    case "N12": {
                        pdfBuffer = await noticeService.generateN12Notice({
                            ...common,
                            reason: (String(args.reason) || "personal_use") as any,
                            occupantName: String(args.occupantName || args.landlordName),
                            relationship: args.relationship ? String(args.relationship) : undefined,
                            terminationDate: String(args.terminationDate || ""),
                        });
                        description = `Landlord/family/purchaser own use (${args.reason || "personal_use"}). Termination: ${args.terminationDate}`;
                        break;
                    }
                    case "N13": {
                        pdfBuffer = await noticeService.generateN13Notice({
                            ...common,
                            reason: String(args.reason || "repairs"),
                            details: String(args.details || ""),
                            terminationDate: String(args.terminationDate || ""),
                        });
                        description = `Demolition/repair/conversion (${args.reason || "repairs"}). Termination: ${args.terminationDate}`;
                        break;
                    }
                    default:
                        return { error: `Unsupported notice type: ${noticeType}` };
                }

                const base64 = pdfBuffer.toString("base64");
                return {
                    success: true,
                    noticeType,
                    fileName: `${noticeType}_Notice_${String(args.tenantName).replace(/\s+/g, "_")}.pdf`,
                    pdfBase64: base64,
                    message: `${noticeType} Notice generated for ${args.tenantName}. ${description}. The PDF is ready for download or can be sent via WhatsApp.`,
                };
            } catch (err) {
                return { error: `Failed to generate notice: ${(err as Error).message}` };
            }
        },
    };
}

/**
 * Register all built-in tools. Call this at startup.
 */
export function registerBuiltinTools(): ToolDefinition[] {
    return [
        // Data
        lookupTenantTool(),
        lookupUnitTool(),
        listMaintenanceTool(),
        createMaintenanceRequestTool(),
        updateMaintenanceStatusTool(),
        listContractorsTool(),
        lookupUtilityBillsTool(),
        getUtilityCredentialsTool(),
        conversationHistoryTool(),
        // Communication
        sendWhatsAppTool(),
        alertLandlordTool(),
        dispatchContractorTool(),
        // AI
        triageMessageTool(),
        draftReplyTool(),
        // Web search
        webSearchTool(),
        fetchPageContentTool(),
        // Green Button
        greenButtonTool(),
        // Utility
        rtaInfoTool(),
        currentTimeTool(),
        // Portfolio tools
        listTenantsTool(),
        listUnitsTool(),
        listRemindersTool(),
        expiringLeasesTool(),
        lookupLeaseTool(),
        maintenanceGuidanceTool(),
        // Financial tools
        recordPaymentTool(),
        listFinancialRecordsTool(),
        financialSummaryTool(),
        // Legal notice tools
        generateNoticeTool(),
    ];
}

// ═══════════════════════════════════════════════════════════
//  CONVERSATION HISTORY TOOL
// ═══════════════════════════════════════════════════════════

export function conversationHistoryTool(): ToolDefinition {
    return {
        name: "conversation_history",
        description: "Look up previous conversation history with a tenant or phone number. Use this to understand context from prior interactions — what was discussed, what issues were reported, what was resolved.",
        parameters: {
            phone: { type: "string", description: "Phone number to look up conversation history for" },
            limit: { type: "number", description: "Max messages to return (default 15)" },
        },
        required: ["phone"],
        category: "data",
        enabled: true,
        async execute(args) {
            const phone = String(args.phone);
            const limit = Number(args.limit) || 15;
            const history = await conversationMemory.getHistory({
                phone,
                landlordId: args.landlordId ? String(args.landlordId) : undefined,
                limit,
            });
            if (!history.length) {
                return { messages: [], note: "No previous conversation history found for this phone number." };
            }
            return {
                messages: history,
                count: history.length,
                formatted: conversationMemory.formatHistory(history, limit),
            };
        },
    };
}

// ═══════════════════════════════════════════════════════════
//  GREEN BUTTON TOOL — Utility Data
// ═══════════════════════════════════════════════════════════

export function greenButtonTool(): ToolDefinition {
    return {
        name: "green_button_usage",
        description: "Look up Green Button utility connections and usage data for a unit. Shows connected providers across Ontario (Toronto Hydro, Hydro One, Alectra, Enova Power, Energy+, Enbridge Gas, Hydro Ottawa, London Hydro, Elexicon, Oshawa PUC, NPEI, Burlington Hydro, Utilities Kingston, Sudbury Hydro, Thunder Bay Hydro) and can fetch recent usage/billing data from connected accounts.",
        parameters: {
            unitId: { type: "string", description: "Unit ID to check Green Button connections for" },
            action: { type: "string", description: "'list_connections' to see connected providers, 'list_providers' to see available Ontario providers, 'fetch_usage' to get usage data from a connected provider" },
            connectionId: { type: "string", description: "Connection ID for fetch_usage action (optional — fetches all if omitted)" },
        },
        required: ["action"],
        category: "data",
        enabled: true,
        async execute(args) {
            const action = String(args.action);

            if (action === "list_providers") {
                return {
                    providers: greenButton.GTA_PROVIDERS.map((p) => ({
                        id: p.id,
                        name: p.name,
                        utilityType: p.utilityType,
                        region: p.region,
                        supportsCMD: p.supportsCMD,
                        supportsDMD: p.supportsDMD,
                        customerPortalUrl: p.customerPortalUrl,
                        notes: p.notes,
                    })),
                    note: "These are the available Green Button providers across Ontario. CMD = automatic API access, DMD = manual XML file download. OEB mandated all Ontario LDCs to support Green Button by Nov 1, 2023.",
                };
            }

            if (action === "list_connections") {
                const where: any = {};
                if (args.unitId) where.unitId = String(args.unitId);
                if (args.landlordId) where.landlordId = String(args.landlordId);
                const connections = await db.greenButtonConnection.findMany({
                    where,
                    include: { unit: { select: { label: true } } },
                });
                if (!connections.length) {
                    return {
                        connections: [],
                        note: "No Green Button connections set up. The landlord can connect providers from the Utilities section in the dashboard.",
                        availableProviders: greenButton.GTA_PROVIDERS.map((p) => p.name + " (" + p.utilityType + ")"),
                    };
                }
                return {
                    connections: connections.map((c) => ({
                        id: c.id,
                        provider: c.provider,
                        providerName: greenButton.getProvider(c.provider)?.name || c.provider,
                        utilityType: c.utilityType,
                        unitLabel: (c as any).unit?.label,
                        status: c.status,
                        lastSyncAt: c.lastSyncAt,
                        accountNumber: c.accountNumber,
                    })),
                };
            }

            if (action === "fetch_usage") {
                const connectionId = args.connectionId ? String(args.connectionId) : undefined;
                if (!connectionId) {
                    return { error: "Please provide a connectionId. Use list_connections first to find the right connection." };
                }
                const conn = await db.greenButtonConnection.findUnique({ where: { id: connectionId } });
                if (!conn) return { error: "Connection not found" };
                if (conn.status !== "connected" || !conn.accessToken) {
                    return { error: `Connection status is '${conn.status}'. It needs to be 'connected' with valid OAuth tokens.` };
                }

                const provider = greenButton.getProvider(conn.provider);
                if (!provider) return { error: "Unknown provider" };

                try {
                    const startDate = new Date();
                    startDate.setMonth(startDate.getMonth() - 3);
                    const data = await greenButton.fetchUsageData(provider, {
                        accessToken: greenButton.decryptToken(conn.accessToken),
                        subscriptionId: conn.subscriptionId || undefined,
                        usagePointId: conn.usagePointId || undefined,
                        startDate,
                    });
                    return {
                        usagePoints: data.usagePoints,
                        intervalReadings: data.intervalReadings.slice(-30), // Last 30 readings
                        usageSummaries: data.usageSummaries,
                        note: `Fetched ${data.intervalReadings.length} interval readings and ${data.usageSummaries.length} billing summaries from ${provider.name}.`,
                    };
                } catch (err) {
                    return { error: `Failed to fetch usage data: ${(err as Error).message}` };
                }
            }

            return { error: "Unknown action. Use 'list_providers', 'list_connections', or 'fetch_usage'." };
        },
    };
}

// ═══════════════════════════════════════════════════════════
//  TENANT-FACING TOOLS — Limited subset for tenant interactions
// ═══════════════════════════════════════════════════════════

/**
 * Tool for tenants to check the status of their maintenance requests.
 * Only returns data that belongs to the requesting tenant.
 */
export function checkMyRequestStatusTool(): ToolDefinition {
    return {
        name: "check_my_request_status",
        description: "Check the status of the tenant's maintenance requests. Returns a list of their recent requests with current status, severity, and any AI-drafted responses. Use the tenant's phone number from context.",
        parameters: {
            tenantPhone: { type: "string", description: "The tenant's phone number (from conversation context)" },
        },
        required: ["tenantPhone"],
        category: "data",
        enabled: true,
        async execute(args) {
            const phone = String(args.tenantPhone).trim();
            if (!phone) return { error: "Tenant phone number is required" };

            const tenant = await repo.findTenantByPhone(phone, args.landlordId ? String(args.landlordId) : undefined);
            if (!tenant) return { requests: [], message: "No tenant found with this phone number." };

            const requests = await db.maintenanceRequest.findMany({
                where: { tenantId: tenant.id },
                orderBy: { createdAt: "desc" },
                take: 10,
                select: {
                    id: true,
                    message: true,
                    status: true,
                    createdAt: true,
                    updatedAt: true,
                    triageJson: true,
                    aiDraft: true,
                },
            });

            if (!requests.length) {
                return { requests: [], message: "You have no maintenance requests on file." };
            }

            return {
                requests: requests.map((r: any) => ({
                    id: r.id,
                    message: (r.message || "").substring(0, 200),
                    status: r.status || "open",
                    severity: r.triageJson?.classification?.severity || "unknown",
                    category: r.triageJson?.classification?.category || "unknown",
                    createdAt: r.createdAt,
                    updatedAt: r.updatedAt,
                    latestDraft: (r.aiDraft?.draft || "").substring(0, 200),
                })),
                total: requests.length,
            };
        },
    };
}

// ═══════════════════════════════════════════════════════════
//  TENANT PAYMENT CONFIRMATION TOOL
// ═══════════════════════════════════════════════════════════

export function confirmPaymentTool(): ToolDefinition {
    return {
        name: "confirm_payment",
        description:
            "Confirm that a tenant has paid their rent or utility bill. " +
            "Use this when the tenant says they paid, sends a payment screenshot, or says 'paid'. " +
            "Records the payment, updates the reminder status, and notifies the landlord.",
        parameters: {
            type: {
                type: "string",
                description: "Payment type: 'rent' or 'utility'",
            },
            amount: {
                type: "number",
                description: "Dollar amount paid (optional — will be auto-filled from records if omitted)",
            },
            tenantPhone: {
                type: "string",
                description: "The tenant's phone number (from the conversation context)",
            },
        },
        required: ["type", "tenantPhone"],
        category: "data",
        enabled: true,
        async execute(args) {
            const landlordId = args.landlordId as string;
            const phone = String(args.tenantPhone).trim();
            const type = String(args.type).toLowerCase();
            if (!["rent", "utility"].includes(type)) {
                return { error: "Type must be 'rent' or 'utility'" };
            }
            if (!phone) return { error: "Tenant phone number is required" };

            // 1. Look up the tenant
            const tenant = await repo.findTenantByPhone(phone, landlordId || undefined);
            if (!tenant) return { error: "No tenant found with this phone number." };

            // 2. Find the tenant's unit + rent amount
            const unitTenant = await db.unitTenant.findFirst({
                where: { tenantId: tenant.id },
                include: {
                    unit: { select: { id: true, label: true, address: true } },
                },
            });

            const unitLabel = unitTenant?.unit?.label || unitTenant?.unit?.address || "Unknown unit";
            let amount = args.amount ? Number(args.amount) : 0;

            // Auto-fill amount from records if not provided
            if (!amount && type === "rent" && unitTenant?.rentAmountCents) {
                amount = unitTenant.rentAmountCents / 100;
            }
            if (!amount && type === "utility" && unitTenant?.unit?.id) {
                const latestBill = await db.utilityBill.findFirst({
                    where: { unitId: unitTenant.unit.id },
                    orderBy: { billingPeriodEnd: "desc" },
                    select: { amountCents: true },
                });
                if (latestBill?.amountCents) {
                    // If shared, calculate share
                    const sharePercent = (unitTenant as any).utilitySharePercent || 100;
                    amount = (latestBill.amountCents * sharePercent) / 10000;
                }
            }

            // 3. Create financial record
            const recordType = type === "rent" ? "RENT_PAYMENT" : "OTHER";
            const description = `${type === "rent" ? "Rent" : "Utility"} payment confirmed by tenant via WhatsApp`;
            const effectiveLandlordId = landlordId || tenant.landlordId || "";
            const record = await repo.createFinancialRecord({
                landlordId: effectiveLandlordId,
                tenantName: tenant.name || undefined,
                tenantPhone: phone,
                unitLabel,
                type: recordType,
                amount: amount || 0,
                description,
            });

            // 4. Update matching reminder's lastConfirmedAt
            const now = new Date();
            try {
                const reminder = await db.reminder.findFirst({
                    where: {
                        landlordId: effectiveLandlordId,
                        type,
                        active: true,
                        ...(unitTenant?.unit?.id ? { unitId: unitTenant.unit.id } : {}),
                    },
                    orderBy: { lastSentAt: "desc" },
                });
                if (reminder) {
                    await db.reminder.update({
                        where: { id: reminder.id },
                        data: { lastConfirmedAt: now },
                    });
                }
            } catch (_err) {
                // Non-critical — continue even if reminder update fails
            }

            // 5. Alert landlord via WhatsApp + WebSocket
            const alertMsg =
                `Payment confirmed by *${tenant.name || phone}* (${unitLabel}):\n` +
                `Type: ${type === "rent" ? "Rent" : "Utility"}` +
                (amount ? `\nAmount: $${amount.toFixed(2)}` : "") +
                `\nConfirmed at: ${now.toLocaleString()}`;
            try {
                await whatsappService.alertLandlord(
                    effectiveLandlordId,
                    alertMsg,
                    { type: "PAYMENT_CONFIRMED", tenantPhone: phone },
                );
            } catch (_err) {
                // Non-critical
            }

            return {
                success: true,
                id: record?.id,
                tenantName: tenant.name,
                unitLabel,
                type,
                amount: amount || null,
                message: `Payment confirmed! ${type === "rent" ? "Rent" : "Utility"} payment${amount ? ` of $${amount.toFixed(2)}` : ""} recorded for ${tenant.name || phone} at ${unitLabel}. Your landlord has been notified.`,
            };
        },
    };
}

/**
 * Register the limited set of tools available to tenants.
 * Tenants get: web_search, triage_message, draft_reply, current_time,
 * check_my_request_status, conversation_history, and confirm_payment.
 * They do NOT get: lookup_tenant, lookup_unit, list_maintenance,
 * create/update maintenance, contractors, utility, send_whatsapp,
 * alert_landlord, dispatch_contractor, green_button, etc.
 */
export function registerTenantTools(): ToolDefinition[] {
    return [
        // Let the agent triage and draft internally
        triageMessageTool(),
        draftReplyTool(),
        // Tenant can check their own requests
        checkMyRequestStatusTool(),
        // Tenant can confirm payment
        confirmPaymentTool(),
        // Web search for general info
        webSearchTool(),
        // Conversation context
        conversationHistoryTool(),
        // Utility
        currentTimeTool(),
    ];
}