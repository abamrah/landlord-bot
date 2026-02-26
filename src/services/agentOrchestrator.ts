/**
 * agentOrchestrator.ts — Pre-configured agent runners for each use case.
 *
 * The orchestrator spins up a full ReAct agent loop with the right
 * tools and system prompt for the task. When a VerticalPlugin is active,
 * domain-specific tools and prompts are sourced from the plugin.
 */

import { runAgent, AgentRunResult } from "./agentFramework";
import { ToolRegistry } from "./toolRegistry";
import { registerBuiltinTools, registerTenantTools } from "./tools/builtinTools";
import { registerWebTools, closeBrowser } from "./tools/webAgent";
import { getProfile } from "../config/rtaProfiles";
import { db } from "../config/database";
import { getActivePlugin } from "./verticalPlugin";
import repo, { loadLandlordContext, LandlordPortfolio } from "./repository";
import conversationMemory from "./conversationMemory";

/** Build a fully-loaded tool registry based on the account's plan */
export function buildToolRegistry(plan: "FREE" | "PRO" | "ENTERPRISE" = "FREE"): ToolRegistry {
    const registry = new ToolRegistry();

    // Register domain tools: prefer plugin, fall back to built-in
    const plugin = getActivePlugin();
    if (plugin) {
        registry.registerMany(plugin.registerTools());
    } else {
        registry.registerMany(registerBuiltinTools());
    }

    // Web tools (puppeteer-based) — only register if the module is available
    try {
        registry.registerMany(registerWebTools());
    } catch (err) {
        console.warn("[Orchestrator] Web tools not available:", (err as Error).message);
    }

    // Apply plan restrictions
    registry.applyPlanRestrictions(plan);

    return registry;
}

/**
 * Build a restricted tool registry for tenant-facing interactions.
 * Tenants only get: web_search, triage, draft, current_time, check_my_request_status, conversation_history.
 * No landlord-only tools like lookup_tenant, list_maintenance, contractors, utility, whatsapp, etc.
 */
export function buildTenantToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.registerMany(registerTenantTools());
    return registry;
}

/** Get the account's plan and region from DB */
async function getAccountContext(accountId: string) {
    const landlord = await db.landlord.findUnique({
        where: { id: accountId },
        include: { settings: true },
    });
    return {
        plan: (landlord?.plan || "FREE") as "FREE" | "PRO" | "ENTERPRISE",
        province: landlord?.province || "ON",
        name: landlord?.name || "Landlord",
        company: landlord?.company || "",
    };
}
/** @deprecated Use getAccountContext */
const getLandlordContext = getAccountContext;

/** Format portfolio data into a concise text block for prompt injection */
function formatPortfolioSummary(p: LandlordPortfolio): string {
    const lines: string[] = [];
    lines.push(`Landlord: ${p.landlordName}${p.company ? ` (${p.company})` : ""}`);
    lines.push(`Plan: ${p.plan} | Province: ${p.province}`);
    lines.push(`Portfolio: ${p.totalUnits} unit(s), ${p.totalTenants} tenant(s), ${p.activeMaintenanceCount} active maintenance, ${p.remindersCount} active reminder(s)`);
    lines.push("");
    for (const u of p.units) {
        lines.push(`📍 Unit "${u.label}" — ${u.address}`);
        if (u.tenants.length === 0) {
            lines.push("   (vacant)");
        } else {
            for (const t of u.tenants) {
                const lease = t.leaseStart
                    ? ` | Lease: ${t.leaseStart} → ${t.leaseEnd || "ongoing"}`
                    : "";
                lines.push(`   • ${t.name} (${t.phone || "no phone"})${lease}`);
            }
        }
    }
    return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════
//  TENANT MESSAGE HANDLER — The heart of the agent system
// ═══════════════════════════════════════════════════════════

/**
 * Handle an inbound tenant message with the full agent loop.
 * The agent will:
 *  1. Look up the tenant and unit
 *  2. Triage the message
 *  3. Check conversation history
 *  4. Create a maintenance request if needed
 *  5. Draft a reply
 *  6. Decide whether to alert the landlord
 */
export async function handleTenantMessage(opts: {
    tenantPhone: string;
    message: string;
    landlordId: string;
    mediaDescription?: string;
    imageBase64?: string;
    /** Full multimodal media parts (images, audio, video) for the agent to process directly */
    mediaParts?: Array<{ base64: string; mimeType: string }>;
}): Promise<AgentRunResult> {
    const ctx = await getAccountContext(opts.landlordId);
    // Tenants get a restricted tool set — no landlord-only tools
    const registry = buildTenantToolRegistry();

    // Use plugin prompt if available, otherwise inline
    const plugin = getActivePlugin();
    const systemPrompt = plugin
        ? plugin.getSystemPrompt("tenant-message", {
            accountId: opts.landlordId,
            plan: ctx.plan,
            region: ctx.province,
            accountName: ctx.name,
            company: ctx.company,
        }) + (opts.mediaDescription ? `\n\nThe tenant also sent media: ${opts.mediaDescription}` : "")
        : buildFallbackTenantPrompt(ctx, opts.mediaDescription);

    // Collect multimodal parts: prefer new mediaParts, fall back to legacy imageBase64
    const mediaParts: Array<{ base64: string; mimeType: string }> = opts.mediaParts ?? [];
    if (!mediaParts.length && opts.imageBase64) {
        mediaParts.push({ base64: opts.imageBase64, mimeType: "image/jpeg" });
    }

    return runAgent({
        systemPrompt,
        userMessage: `Tenant phone: ${opts.tenantPhone}\nMessage: ${opts.message}`,
        tools: registry,
        context: { landlordId: opts.landlordId, province: ctx.province },
        maxIterations: 10,
        mediaParts: mediaParts.length ? mediaParts : undefined,
        taskType: "tenant-message",
    });
}

// ═══════════════════════════════════════════════════════════
//  UTILITY BILL CHECK — Automated web scraping agent
// ═══════════════════════════════════════════════════════════

/**
 * Run the utility bill agent. It will:
 *  1. Get stored credentials for the unit
 *  2. Navigate to the utility portal
 *  3. Log in and scrape the latest bill
 *  4. Save the bill to the database
 *  5. Flag anomalies
 */
export async function runUtilityBillAgent(opts: {
    landlordId: string;
    unitId: string;
    utilityType?: string;
}): Promise<AgentRunResult> {
    const ctx = await getAccountContext(opts.landlordId);
    const registry = buildToolRegistry(ctx.plan);

    const plugin = getActivePlugin();
    const systemPrompt = plugin
        ? plugin.getSystemPrompt("utility-check", {
            accountId: opts.landlordId,
            plan: ctx.plan,
            region: ctx.province,
        })
        : buildFallbackUtilityPrompt();

    const message = opts.utilityType
        ? `Check ${opts.utilityType} bill for unit ${opts.unitId}`
        : `Check all utility bills for unit ${opts.unitId}`;

    try {
        return await runAgent({
            systemPrompt,
            userMessage: message,
            tools: registry,
            context: { landlordId: opts.landlordId },
            maxIterations: 8,
            taskType: "utility-check",
        });
    } finally {
        // Clean up browser after utility scraping
        await closeBrowser().catch(() => { });
    }
}

// ═══════════════════════════════════════════════════════════
//  PAGE READER AGENT — Read & summarize any URL
// ═══════════════════════════════════════════════════════════

/**
 * Read and summarize a webpage using the mobile browser.
 * The agent will navigate, extract content, and provide a summary.
 */
export async function readPageAgent(opts: {
    url: string;
    question?: string;
    landlordId?: string;
}): Promise<AgentRunResult> {
    const plan = opts.landlordId
        ? (await getAccountContext(opts.landlordId)).plan
        : "FREE";
    const registry = buildToolRegistry(plan);
    // Enable web tools for page reading regardless of plan
    registry.enable("web_browse");
    registry.enable("web_read_page");

    const plugin = getActivePlugin();
    const systemPrompt = plugin
        ? plugin.getSystemPrompt("page-reader", {
            accountId: opts.landlordId || "",
            plan,
        })
        : buildFallbackPageReaderPrompt();

    const userMsg = opts.question
        ? `Read this page and answer: ${opts.question}\nURL: ${opts.url}`
        : `Read and summarize this page: ${opts.url}`;

    try {
        return await runAgent({
            systemPrompt,
            userMessage: userMsg,
            tools: registry,
            context: { landlordId: opts.landlordId },
            maxIterations: 4,
            taskType: "page-reader",
        });
    } finally {
        await closeBrowser().catch(() => { });
    }
}

// ═══════════════════════════════════════════════════════════
//  LANDLORD ASSISTANT — Interactive advisor agent
// ═══════════════════════════════════════════════════════════

/**
 * The landlord assistant agent. Unlike the simple advisorSuggest,
 * this can look up data, check maintenance history, and provide
 * informed recommendations.
 */
export async function landlordAssistantAgent(opts: {
    landlordId: string;
    question: string;
    maintenanceId?: string;
    /** Optional media parts for multimodal analysis */
    mediaParts?: Array<{ base64: string; mimeType: string }>;
    /** Channel origin — "whatsapp" or "dashboard" (default) */
    channel?: string;
    /** Sender phone for WhatsApp conversation history */
    senderPhone?: string;
}): Promise<AgentRunResult> {
    const ctx = await getAccountContext(opts.landlordId);
    const registry = buildToolRegistry(ctx.plan);

    // Load full portfolio context for injection into prompt
    const portfolio = await loadLandlordContext(opts.landlordId);
    const portfolioSummary = portfolio ? formatPortfolioSummary(portfolio) : undefined;

    // Load recent conversation history for continuity (use sender phone for WhatsApp, dashboard-agent for dashboard)
    const historyPhone = opts.channel === "whatsapp" && opts.senderPhone ? opts.senderPhone : "dashboard-agent";
    const recentHistory = await conversationMemory.getHistory({
        phone: historyPhone,
        landlordId: opts.landlordId,
        limit: 10,
    });
    const historyText = conversationMemory.formatHistory(recentHistory, 10);

    const plugin = getActivePlugin();
    let systemPrompt: string;

    if (plugin) {
        systemPrompt = plugin.getSystemPrompt("landlord-assistant", {
            accountId: opts.landlordId,
            plan: ctx.plan,
            region: ctx.province,
            accountName: ctx.name,
            company: ctx.company,
            portfolioSummary,
        });
        if (opts.maintenanceId) {
            systemPrompt += `\n\nContext: This is about maintenance request ID ${opts.maintenanceId}.`;
        }
    } else {
        systemPrompt = buildFallbackAssistantPrompt(ctx, opts.maintenanceId);
    }

    // Prepend conversation history to the user message for continuity
    const userMessage = historyText
        ? `[Previous Conversation]\n${historyText}\n\n[Current Question]\n${opts.question}`
        : opts.question;

    return runAgent({
        systemPrompt,
        userMessage,
        tools: registry,
        context: { landlordId: opts.landlordId, province: ctx.province },
        maxIterations: 10,
        mediaParts: opts.mediaParts,
        taskType: "landlord-assistant",
    });
}

export default {
    handleTenantMessage,
    runUtilityBillAgent,
    readPageAgent,
    landlordAssistantAgent,
    buildToolRegistry,
};

// ═══════════════════════════════════════════════════════════
//  FALLBACK PROMPTS — Used only when no plugin is loaded
// ═══════════════════════════════════════════════════════════

function buildFallbackTenantPrompt(
    ctx: { name: string; company: string; province: string },
    mediaDescription?: string,
): string {
    const profile = getProfile(ctx.province);
    return [
        `You are the AI property manager for ${ctx.name}${ctx.company ? ` (${ctx.company})` : ""}.`,
        `Jurisdiction: ${profile.name} — ${profile.legislation}.`,
        profile.promptAddendum,
        "",
        "A tenant has sent a WhatsApp message. Follow these steps IN ORDER:",
        "",
        "═══ STEP 0 — PAYMENT CHECK (DO THIS FIRST) ═══",
        "BEFORE doing anything else, check if this is a payment confirmation.",
        "If the message contains ANY of these signals, skip triage and go straight to confirm_payment:",
        "• Keywords: 'paid', 'payment sent', 'transferred', 'e-transfer sent', 'e-transfer', 'interac',",
        "  'here is proof', 'sent the money', 'receipt', 'proof of payment', 'just paid', 'already paid'",
        "• An attached screenshot or image (likely a payment receipt or e-transfer confirmation)",
        "• A short message like 'done', 'sent', 'paid' with or without media",
        "ACTION: Call lookup_tenant first to get their ID, then immediately call confirm_payment",
        "with their phone number and payment type ('rent' or 'utility').",
        "If they mention a specific amount, include it. Otherwise the system auto-fills from records.",
        "If a media/screenshot was attached, treat it as proof of payment — proceed with confirmation.",
        "After confirming, acknowledge warmly. Their landlord is notified automatically.",
        "DO NOT triage payment messages as maintenance. DO NOT create tickets for payments.",
        "",
        "═══ STEPS 1-8 — MAINTENANCE FLOW (only if NOT a payment) ═══",
        "1. Look up the tenant using lookup_tenant with their phone number.",
        "2. Check check_my_request_status with their phone to see ALL existing tickets.",
        "3. Check conversation_history for previous interactions to understand context.",
        "4. Triage the message using triage_message — this gives you severity, investigationQuestions, and selfResolutionSteps.",
        "5. INVESTIGATE before escalating (see INVESTIGATION PROTOCOL below).",
        "6. Only create a ticket using create_maintenance_request if investigation confirms it needs professional help.",
        "7. Draft a casual, legally-aware reply for the tenant using draft_reply.",
        "8. If severity is HIGH or CRITICAL after investigation, use alert_landlord to notify the landlord.",
        "",
        "═══ TICKET MANAGEMENT — CRITICAL RULES ═══",
        "• ALWAYS check existing tickets (check_my_request_status) BEFORE creating a new one.",
        "• Create ONE ticket per distinct issue — do NOT create duplicate tickets for the same problem.",
        "• If the tenant is following up on an existing issue, update the EXISTING ticket context — do NOT create a new ticket.",
        "• If the tenant reports a DIFFERENT issue, create a separate ticket for it.",
        "• Each ticket has a status: OPEN, PENDING, IN_TRIAGE, SCHEDULED, IN_PROGRESS, RESOLVED, CANCELLED.",
        "• ONLY discuss the issue relevant to the current conversation — stay focused on what the tenant is talking about.",
        "• Do NOT bring up RESOLVED or CANCELLED tickets unless the tenant specifically asks about them.",
        "• If the tenant asks 'what about my ...?' or 'any update on ...?' — check their tickets and respond about the matching active ticket.",
        "• If the tenant asks about past/completed work, THEN you can reference resolved tickets.",
        "• When there are multiple active tickets, be aware of all of them but respond to the one the tenant is asking about.",
        "",
        "═══ INVESTIGATION PROTOCOL — CRITICAL (DO THIS BEFORE CREATING TICKETS) ═══",
        "Your triage_message result includes investigationQuestions and selfResolutionSteps. USE THEM.",
        "",
        "For CRITICAL severity (fire, gas leak, flooding, no heat in winter, electrical sparking):",
        "• Create ticket IMMEDIATELY — do not delay for investigation.",
        "• Alert landlord IMMEDIATELY using alert_landlord.",
        "• Still provide any immediate safety instructions in your reply.",
        "",
        "For HIGH severity (no hot water, broken fridge, pest infestation, mold, toilet broken):",
        "• Create ticket right away — these affect habitability.",
        "• Alert landlord using alert_landlord.",
        "• Include troubleshooting steps in your reply if there are quick fixes to try while waiting.",
        "",
        "For NORMAL severity (appliance issues, minor leaks, HVAC not optimal):",
        "• Do NOT immediately create a ticket.",
        "• First, ask the tenant the investigationQuestions from triage to better understand the issue.",
        "• Suggest the selfResolutionSteps — guide them through troubleshooting.",
        "• Use web_search to find product manuals, troubleshooting guides, or YouTube tutorials.",
        "• Only create a ticket if: the tenant has tried self-resolution and it didn't work, OR the issue clearly requires professional intervention.",
        "",
        "For LOW severity (cosmetic issues, squeaky doors, paint peeling):",
        "• Do NOT create a ticket on first message.",
        "• Suggest self-resolution steps. If the tenant insists, create a ticket.",
        "",
        "GOLDEN RULE: Act as a helpful assistant who empowers the tenant to resolve simple issues themselves.",
        "Do NOT rush to create maintenance tickets for everything — investigate first, escalate when needed.",
        "",
        "═══ PROACTIVE RESEARCH — CRITICAL ═══",
        "When a tenant reports an issue involving a specific product, appliance, or piece of equipment:",
        "• Use web_search to find the product's user manual, troubleshooting guide, or relevant support page.",
        "• Include actual links and specific troubleshooting steps in your reply.",
        "NEVER promise to do something later that you can do RIGHT NOW with the tools available to you.",
        "",
        "Always be concise and natural. The tenant should feel heard, not processed.",
        "Do NOT send messages directly — just prepare the draft for landlord approval.",
        "",
        "═══ OUTPUT FORMAT — CRITICAL ═══",
        "Your final message MUST end with the tenant reply and NOTHING else after it.",
        "Use this exact format:",
        "",
        "[Your internal thinking, analysis, and summary of actions can go here]",
        "",
        "---DRAFT_REPLY---",
        "[The actual message to send to the tenant. ONLY this part will be sent. Keep it natural and concise.]",
        "",
        "IMPORTANT: Everything ABOVE ---DRAFT_REPLY--- is internal only. Everything BELOW it is sent to the tenant.",
        "The draft reply must be a standalone message — no markdown headers, no bullet points of actions taken.",
        "NEVER output an empty draft or placeholder text like '(No response)' — always write a real reply.",
        mediaDescription ? `\nThe tenant also sent media: ${mediaDescription}` : "",
    ].filter(Boolean).join("\n");
}

function buildFallbackUtilityPrompt(): string {
    return [
        "You are a utility bill management agent.",
        "Your task is to check for new utility bills by scraping the provider's website.",
        "",
        "Steps:",
        "1. Use get_utility_credentials to find login credentials for the unit.",
        "2. Use scrape_utility_bill with the credential ID to log in and extract bill data.",
        "3. Review the extracted data (amounts, dates, usage).",
        "4. Use lookup_utility_bills to compare with previous bills and check for anomalies.",
        "5. Report your findings — amount, billing period, any anomalies detected.",
    ].join("\n");
}

function buildFallbackPageReaderPrompt(): string {
    return [
        "You are a web reading assistant.",
        "Your task is to read a webpage and extract useful information.",
        "",
        "Steps:",
        "1. Use web_read_page to extract the page content.",
        "2. If the page has tables, analyze them.",
        "3. If a question was asked, answer it based on the page content.",
        "4. Provide a concise summary of the key information.",
    ].join("\n");
}

function buildFallbackAssistantPrompt(
    ctx: { name: string; company: string; province: string },
    maintenanceId?: string,
): string {
    const profile = getProfile(ctx.province);
    return [
        `You are the AI assistant for ${ctx.name}${ctx.company ? ` (${ctx.company})` : ""}.`,
        `Jurisdiction: ${profile.name} — ${profile.legislation}.`,
        profile.promptAddendum,
        "",
        "The landlord is asking you a question. You have access to tools to look up:",
        "- Maintenance requests (list_maintenance, update_maintenance_status, create_maintenance_request)",
        "- Tenants and units (lookup_tenant, lookup_unit, list_tenants, list_units)",
        "- Contractors (list_contractors, dispatch_contractor, create_contractor, message_contractor)",
        "- Utility bills (lookup_utility_bills)",
        "- Conversation history (conversation_history) — look up past interactions with any phone number",
        "- Tenancy law info (rta_info)",
        "- Current time (current_time)",
        "- Web search (web_search) — search Google for manuals, guides, pricing, regulations, product info, etc.",
        "- Page reader (fetch_page_content) — read a specific webpage to extract details",
        "",
        "═══ CONTRACTOR MANAGEMENT ═══",
        "• create_contractor — Save a new contractor with name, phone, email, and specialty/role.",
        "  When the landlord asks you to find a contractor, use web_search first, then create_contractor to save them.",
        "• message_contractor — Send a WhatsApp message to a contractor directly.",
        "• dispatch_contractor — Send a formal maintenance dispatch to a contractor.",
        "• list_contractors — View all saved contractors, filterable by specialty.",
        "",
        "═══ TICKET MANAGEMENT ═══",
        "• create_maintenance_request — Create new maintenance tickets, including on behalf of tenants.",
        "• update_maintenance_status — Change ticket status: OPEN, PENDING, IN_TRIAGE, SCHEDULED, IN_PROGRESS, RESOLVED, CANCELLED.",
        "• update_maintenance_severity — Change ticket severity/priority: CRITICAL, HIGH, NORMAL, LOW.",
        "• list_maintenance — View all tickets with filters (by status, unit, tenant).",
        "",
        "═══ WEB SEARCH — USE IT PROACTIVELY ═══",
        "When the landlord asks about products, appliances, regulations, or anything that needs external info:",
        "• Use web_search to look it up immediately — manuals, troubleshooting, pricing, reviews, legal info.",
        "• Use fetch_page_content to read relevant pages and extract key details.",
        "• Include actual URLs and specific facts in your answer.",
        "NEVER say \"I'll look into that\" or \"I'll get back to you\" — search NOW and answer NOW.",
        "",
        "Use tools to gather facts before answering. Be concise and practical.",
        maintenanceId ? `Context: This is about maintenance request ID ${maintenanceId}.` : "",
    ].filter(Boolean).join("\n");
}
