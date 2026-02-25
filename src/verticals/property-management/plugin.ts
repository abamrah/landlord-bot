/**
 * Property Management Vertical Plugin
 *
 * First-party plugin that wraps all existing property-management logic
 * (tenants, units, maintenance, RTA profiles, contractors, utility bills)
 * into the VerticalPlugin interface.
 *
 * This is the reference implementation — future verticals (dental, legal,
 * restaurant, etc.) follow the same shape.
 */

import { Router } from "express";
import {
    VerticalPlugin,
    ResolvedRole,
    RoleDefinition,
    InboundMessageContext,
    OwnerMessageContext,
    PromptContext,
    UseCaseDefinition,
    VerticalPlanLimits,
} from "../../services/verticalPlugin";
import { ToolDefinition } from "../../services/toolRegistry";
import { AgentRunResult } from "../../services/agentFramework";

// Domain-specific imports
import { registerBuiltinTools } from "../../services/tools/builtinTools";
import { getProfile, listProvinces, RtaProfile } from "../../config/rtaProfiles";
import repo from "../../services/repository";
import { db } from "../../config/database";

// ═══════════════════════════════════════════════════════════
//  ROLE DEFINITIONS
// ═══════════════════════════════════════════════════════════

const ROLES: RoleDefinition[] = [
    {
        role: "landlord",
        label: "Landlord / Owner",
        aiEnabled: true,
        description: "Property owner or manager — the business account holder",
    },
    {
        role: "tenant",
        label: "Tenant",
        aiEnabled: true,
        description: "Resident who rents a unit from the landlord",
    },
    {
        role: "contractor",
        label: "Contractor",
        aiEnabled: false,
        description: "Maintenance or repair professional dispatched by the landlord",
    },
];

// ═══════════════════════════════════════════════════════════
//  USE CASES
// ═══════════════════════════════════════════════════════════

const USE_CASES: UseCaseDefinition[] = [
    {
        id: "tenant-message",
        label: "Tenant Message Handler",
        description: "Triage inbound tenant messages, create maintenance requests, draft legally-aware replies",
        forRoles: ["tenant"],
    },
    {
        id: "landlord-assistant",
        label: "Landlord Assistant",
        description: "Interactive AI advisor — look up data, answer questions, manage properties",
        forRoles: ["landlord"],
    },
    {
        id: "utility-check",
        label: "Utility Bill Checker",
        description: "Scrape utility portals, extract bills, detect anomalies",
        forRoles: ["landlord"],
    },
    {
        id: "page-reader",
        label: "Page Reader",
        description: "Read and summarize webpages with property-management focus",
        forRoles: ["landlord"],
    },
];

// ═══════════════════════════════════════════════════════════
//  PLAN LIMITS (property-management-specific resources)
// ═══════════════════════════════════════════════════════════

const PLAN_LIMITS: VerticalPlanLimits = {
    FREE: {
        maxUnits: 3,
        utilityTracking: false,
        contractorDispatch: false,
        maxWhatsAppNumbers: 1,
    },
    PRO: {
        maxUnits: 25,
        utilityTracking: true,
        contractorDispatch: true,
        maxWhatsAppNumbers: 3,
    },
    ENTERPRISE: {
        maxUnits: Infinity,
        utilityTracking: true,
        contractorDispatch: true,
        maxWhatsAppNumbers: 10,
    },
};

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════

/** Fetch landlord context from DB (used by prompt builders) */
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

// ═══════════════════════════════════════════════════════════
//  PLUGIN IMPLEMENTATION
// ═══════════════════════════════════════════════════════════

export const propertyManagementPlugin: VerticalPlugin = {
    id: "property-management",
    name: "Property Management",
    version: "1.0.0",

    // ── Tools ────────────────────────────────────────────

    registerTools(): ToolDefinition[] {
        return registerBuiltinTools();
    },

    // ── Roles & Routing ─────────────────────────────────

    roleDefinitions: ROLES,

    async resolveRole(phone: string, accountId: string): Promise<ResolvedRole | null> {
        // Check if sender IS the landlord (account owner)
        const landlord = await repo.findLandlordByWhatsApp(phone);
        if (landlord && landlord.id === accountId) {
            return {
                role: "landlord",
                personId: landlord.id,
                personName: landlord.name || "Owner",
                metadata: { province: landlord.province, plan: landlord.plan },
            };
        }

        // Check if sender is a tenant belonging to this account
        const tenant = await repo.findTenantByPhone(phone, accountId);
        if (tenant) {
            return {
                role: "tenant",
                personId: tenant.id,
                personName: tenant.name || "Tenant",
                metadata: {
                    unitId: (tenant as any).unitId,
                    autoReplyEnabled: (tenant as any).autoReplyEnabled,
                },
            };
        }

        // Check contractors
        const contractor = await repo.findContractorByPhone(phone);
        if (contractor && (contractor as any).landlordId === accountId) {
            return {
                role: "contractor",
                personId: contractor.id,
                personName: contractor.name || "Contractor",
                metadata: { role: (contractor as any).role },
            };
        }

        return null;
    },

    // ── Message Handling ────────────────────────────────

    async handleInboundMessage(ctx: InboundMessageContext): Promise<AgentRunResult> {
        // Lazy-import orchestrator to avoid circular deps
        const orchestrator = require("../../services/agentOrchestrator").default;

        if (ctx.sender.role === "tenant") {
            return orchestrator.handleTenantMessage({
                tenantPhone: ctx.phone,
                message: ctx.message,
                landlordId: ctx.accountId,
                mediaDescription: ctx.imageDescription,
                imageBase64: ctx.imageBase64,
            });
        }

        // For non-tenant roles, use the landlord assistant
        return orchestrator.landlordAssistantAgent({
            landlordId: ctx.accountId,
            question: ctx.message,
        });
    },

    async handleOwnerMessage(ctx: OwnerMessageContext): Promise<AgentRunResult | null> {
        const orchestrator = require("../../services/agentOrchestrator").default;
        return orchestrator.landlordAssistantAgent({
            landlordId: ctx.accountId,
            question: ctx.message,
        });
    },

    // ── System Prompts ──────────────────────────────────

    getSystemPrompt(useCase: string, context: PromptContext): string {
        const province = (context.region || "ON") as string;
        const profile = getProfile(province);
        const accountName = (context.accountName as string) || "Property Manager";
        const company = (context.company as string) || "";
        const portfolioSummary = (context as any).portfolioSummary as string | undefined;

        switch (useCase) {
            case "tenant-message":
                return buildTenantMessagePrompt(accountName, company, profile);

            case "landlord-assistant":
                return buildLandlordAssistantPrompt(accountName, company, profile, portfolioSummary);

            case "utility-check":
                return buildUtilityCheckPrompt();

            case "page-reader":
                return buildPageReaderPrompt();

            default:
                return `You are an AI property management assistant for ${accountName}. Be helpful and concise.`;
        }
    },

    listUseCases(): UseCaseDefinition[] {
        return USE_CASES;
    },

    // ── Knowledge Base ──────────────────────────────────

    getKnowledge(context: { region?: string; accountId?: string }): string {
        const profile = getProfile(context.region || "ON");
        return [
            `## Tenancy Law: ${profile.name}`,
            `Legislation: ${profile.legislation}`,
            `Entry notice: ${profile.noticePeriodsEntry}`,
            `Emergency repair max hours: ${profile.emergencyRepairMaxHours}`,
            `Rent increase rules: ${profile.rentIncreaseRules}`,
            `Dispute body: ${profile.disputeBody}`,
            "",
            profile.promptAddendum,
        ].join("\n");
    },

    // ── Plan Limits ─────────────────────────────────────

    planLimits: PLAN_LIMITS,

    // ── Routes ──────────────────────────────────────────

    getRouter(): Router {
        // The admin routes are already defined in routes/admin.ts.
        // In a fully decoupled future, domain-specific routes would move here.
        // For now, return an empty router — the existing admin routes work.
        const router = Router();

        // Province / RTA endpoint (domain-specific)
        router.get("/provinces", (_req, res) => {
            res.json({ provinces: listProvinces() });
        });

        return router;
    },

    // ── Lifecycle ───────────────────────────────────────

    async initialize(): Promise<void> {
        console.log("[PropertyManagement] Plugin initialized");
    },

    async shutdown(): Promise<void> {
        console.log("[PropertyManagement] Plugin shut down");
    },
};

// ═══════════════════════════════════════════════════════════
//  PROMPT BUILDERS (extracted from agentOrchestrator.ts)
// ═══════════════════════════════════════════════════════════

function buildTenantMessagePrompt(
    accountName: string,
    company: string,
    profile: RtaProfile,
): string {
    return [
        `You are the AI property manager for ${accountName}${company ? ` (${company})` : ""}.`,
        `Jurisdiction: ${profile.name} — ${profile.legislation}.`,
        profile.promptAddendum,
        "",
        "A tenant has sent a WhatsApp message. Follow these steps IN ORDER:",
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
        "• Still provide any immediate safety instructions in your reply (e.g., 'turn off the water main').",
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
        "• Example: 'My dishwasher won't start' → Ask what model, check if it's plugged in, search for the model's reset procedure, suggest trying it. If that doesn't work, THEN create a ticket.",
        "",
        "For LOW severity (cosmetic issues, squeaky doors, paint peeling):",
        "• Do NOT create a ticket on first message.",
        "• Suggest self-resolution steps (e.g., WD-40 for squeaky hinges, touch-up paint).",
        "• If the tenant insists or the issue is beyond DIY, create a ticket.",
        "",
        "GOLDEN RULE: Act as a helpful assistant who empowers the tenant to resolve simple issues themselves.",
        "Do NOT rush to create maintenance tickets for everything — investigate first, escalate when needed.",
        "",
        "═══ PAYMENT CONFIRMATION ═══",
        "When a tenant says they have paid rent or a utility bill, or sends a payment screenshot/receipt:",
        "• Use confirm_payment with their phone number and payment type ('rent' or 'utility').",
        "• If they mention a specific amount, include it. Otherwise the system will auto-fill from records.",
        "• Keywords: 'paid', 'payment sent', 'transferred', 'e-transfer sent', 'here is proof', screenshot of payment.",
        "• After confirming, acknowledge their payment warmly — their landlord will be notified automatically.",
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
    ].join("\n");
}

function buildLandlordAssistantPrompt(
    accountName: string,
    company: string,
    profile: RtaProfile,
    portfolioSummary?: string,
): string {
    return [
        `You are the AI assistant for ${accountName}${company ? ` (${company})` : ""}.`,
        `Jurisdiction: ${profile.name} — ${profile.legislation}.`,
        profile.promptAddendum,
        "",
        portfolioSummary ? `═══ YOUR LANDLORD'S PORTFOLIO ═══\n${portfolioSummary}\n` : "",
        "═══ IMPORTANT: CONTEXT AWARENESS ═══",
        "You already know this landlord's portfolio from the context above.",
        "When they ask about a tenant, unit, or lease — check your portfolio context FIRST before calling tools.",
        "Do NOT keep asking for unit IDs, phone numbers, or tenant names if the info is already in your context.",
        "If they say a partial name (e.g., 'John'), fuzzy-match against your portfolio context.",
        "If the request is ambiguous, ask a clarifying follow-up question instead of guessing.",
        "",
        "═══ CONVERSATIONAL STYLE ═══",
        "Be conversational and natural — you're their property management partner, not a form.",
        "Ask follow-up questions when needed to understand their intent better.",
        "Proactively mention relevant info: upcoming lease expirations, pending maintenance, overdue reminders.",
        "Remember the conversation context — don't ask the same thing twice.",
        "",
        "The landlord is asking you a question. You have access to tools to look up:",
        "- Maintenance requests (list_maintenance, update_maintenance_status, create_maintenance_request)",
        "- Tenants and units (lookup_tenant, lookup_unit, list_tenants, list_units)",
        "- Lease info and documents (lookup_lease, expiring_leases)",
        "- Contractors (list_contractors, dispatch_contractor, create_contractor, message_contractor)",
        "- Utility bills (lookup_utility_bills)",
        "- Reminders (list_reminders)",
        "- Conversation history (conversation_history) — look up past interactions with any phone number",
        "- Tenancy law info (rta_info)",
        "- Current time (current_time)",
        "- Web search (web_search) — search Google for manuals, guides, pricing, regulations, product info, etc.",
        "- Page reader (fetch_page_content) — read a specific webpage to extract details",
        "- Maintenance guidance (maintenance_guidance) — seasonal checklists, preventive maintenance schedules",
        "",
        "═══ CONTRACTOR MANAGEMENT ═══",
        "• create_contractor — Save a new contractor with name, phone, email, and specialty/role.",
        "  When the landlord asks you to find a contractor, use web_search to find one on Google,",
        "  then use create_contractor to save them to the database.",
        "• message_contractor — Send a WhatsApp message directly to a contractor.",
        "  Use this when the landlord wants to communicate with a contractor about a job.",
        "  Only message contractors who have a phone number on file.",
        "• dispatch_contractor — Send a formal maintenance dispatch to a contractor with job details.",
        "• list_contractors — View all saved contractors, filterable by specialty.",
        "",
        "═══ TICKET MANAGEMENT ═══",
        "• create_maintenance_request — Create new maintenance tickets, including on behalf of tenants.",
        "  The landlord can say 'create a ticket for unit 2 about a broken window' and you create it.",
        "• update_maintenance_status — Change ticket status: OPEN, PENDING, IN_TRIAGE, SCHEDULED, IN_PROGRESS, RESOLVED, CANCELLED.",
        "  The landlord can say 'mark that as resolved' or 'change ticket status to scheduled'.",
        "• update_maintenance_severity — Change ticket severity/priority: CRITICAL, HIGH, NORMAL, LOW.",
        "  The landlord can say 'escalate that to high' or 'change severity to critical'.",
        "• list_maintenance — View all tickets with filters (by status, unit, tenant).",
        "• Each ticket has timestamps (created, updated) — include these when discussing tickets.",
        "",
        "═══ WEB SEARCH — USE IT PROACTIVELY ═══",
        "When the landlord asks about products, appliances, regulations, or anything that needs external info:",
        "• Use web_search to look it up immediately — manuals, troubleshooting, pricing, reviews, legal info.",
        "• Use fetch_page_content to read relevant pages and extract key details.",
        "• Include actual URLs and specific facts in your answer.",
        "NEVER say \"I'll look into that\" or \"I'll get back to you\" — search NOW and answer NOW.",
        "",
        "═══ GENERATING N-FORM NOTICES ═══",
        "Use the generate_notice tool to create official Ontario LTB notices (N1 through N14).",
        "BEFORE calling generate_notice, you MUST gather ALL required information from the landlord.",
        "Each form has specific required fields — follow this guide:\n",
        "N1 (Rent Increase):",
        "  Ask: tenant name, unit address, current rent, new rent, effective date, payment period (monthly/weekly),",
        "  is increase at/below guideline or above? If above: have you applied to the LTB or plan to? Above-guideline amount?\n",
        "N2 (Rent Increase – Partially Exempt Unit):",
        "  Ask: tenant name, unit address, current rent, new rent, effective date, payment period\n",
        "N3 (Rent Increase – Care Home):",
        "  Ask: tenant name, unit, current rent, new rent, effective date, payment period,",
        "  will rent increase? Does increase need LTB approval? Will care/meals charges increase? New care charge amount? Total new amount?\n",
        "N4 (Non-Payment of Rent):",
        "  Ask: tenant name, unit, termination date, then for EACH unpaid period: period start date, end date, rent charged, rent paid.",
        "  Provide as rentOwingPeriods JSON array. Calculate totals automatically.\n",
        "N5 (Interference / Damage / Overcrowding):",
        "  Ask: tenant name, unit, termination date, reason (interference/damage/overcrowding),",
        "  describe each incident with date, time, and what happened (up to 3 events).",
        "  If damage: how much for repairs? If overcrowding: explain the situation.\n",
        "N6 (Illegal Acts / Misrepresentation):",
        "  Ask: tenant name, unit, termination date, reason (illegal act at unit/illegal act at complex/misrepresentation),",
        "  describe each incident with date, time, what happened (up to 3 events).\n",
        "N7 (Impaired Safety / Serious Problems):",
        "  Ask: tenant name, unit, termination date, reason (impaired safety/illegal drugs at unit/drugs at complex/serious impairment),",
        "  describe each incident with date, time, what happened (up to 3 events).\n",
        "N8 (End of Term):",
        "  Ask: tenant name, unit, termination date, reason (persistent late payment/no longer qualifies for subsidized/",
        "  employment ended/no longer needs rehab/gave notice but didn't move).",
        "  For late payment: list each payment with period, due date, and date actually paid. Any additional details?\n",
        "N9 (Tenant's Notice to End Tenancy):",
        "  Ask: tenant name, unit, termination date.\n",
        "N10 (Agreement to Increase Rent Above Guideline):",
        "  Ask: tenant name, unit, current rent, new rent, effective date,",
        "  reason (capital expenditure/new services/both), description of work/services. Tenant must sign.\n",
        "N11 (Mutual Agreement to End Tenancy):",
        "  Ask: tenant name, unit, agreed termination date. Tenant must sign.\n",
        "N12 (Landlord/Family/Purchaser Own Use):",
        "  Ask: tenant name, unit, termination date, who will occupy (me/spouse/child/parent/spouse's child/spouse's parent),",
        "  the occupant's name. Is this a care provider situation? If yes, who gets the care?\n",
        "N13 (Demolition / Repairs / Conversion):",
        "  Ask: tenant name, unit, termination date, reason (demolition/conversion/repairs),",
        "  work plan description, detailed work description, permits status (obtained/will obtain/not needed).\n",
        "N14 (Notice to Spouse of Tenant Who Vacated):",
        "  Ask: spouse name, unit address, landlord info, original tenant name who vacated,",
        "  rental period end date, move-out date, payment due date, amount owed, current rent, pay period (daily/weekly/monthly).\n",
        "IMPORTANT: Don't send the form until you've asked ALL the questions above for that form type.",
        "Ask naturally and conversationally — group related questions together instead of one at a time.",
        "If the landlord has already provided some info in context (portfolio, previous messages), don't re-ask.",
        "",
        "Use tools to gather facts before answering. Be concise and practical.",
        "If the landlord asks about a specific maintenance issue, look it up.",
        "Keep responses conversational — 2-4 sentences usually, more only if detailed info is requested.",
    ].join("\n");
}

function buildUtilityCheckPrompt(): string {
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
        "",
        "If the scraper can't find the login form or encounters an error, explain what went wrong.",
        "Be factual about dollar amounts and dates.",
    ].join("\n");
}

function buildPageReaderPrompt(): string {
    return [
        "You are a web reading assistant for a property manager.",
        "Your task is to read a webpage and extract useful information.",
        "",
        "Steps:",
        "1. Use web_read_page to extract the page content.",
        "2. If the page has tables (like bills or statements), analyze them.",
        "3. If a question was asked, answer it based on the page content.",
        "4. Provide a concise summary of the key information.",
        "",
        "Focus on information relevant to property management: bills, regulations, prices, dates.",
    ].join("\n");
}

export default propertyManagementPlugin;
