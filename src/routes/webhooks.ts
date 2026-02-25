import express from "express";
import twilio from "twilio";
import maintenanceRouter from "./maintenance";
import agentService from "../services/agentService";
import repo from "../services/repository";
import whatsappService from "../services/whatsappService";
import { setWebhookStatus } from "../services/webhookStatus";
import orchestrator from "../services/agentOrchestrator";
import { processMedia, buildMediaEnrichedMessage, ExtractedMedia } from "../services/mediaService";
import conversationMemory from "../services/conversationMemory";
import { webhookRateLimit } from "../services/rateLimiter";
import { checkPlanLimit, incrementMessageCount } from "../services/planService";
import { db } from "../config/database";

const AGENTIC_MODE = process.env.AGENTIC_MODE === "true";

/**
 * Resolve the tenant's primary unit ID from the UnitTenant join table.
 * Returns the first unit's ID, or undefined if no unit assignment exists.
 */
async function resolveTenantUnitId(tenantId?: string): Promise<string | undefined> {
  if (!tenantId) return undefined;
  try {
    const ut = await db.unitTenant.findFirst({
      where: { tenantId },
      select: { unitId: true },
      orderBy: { startDate: "desc" },
    });
    return ut?.unitId || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract only the draft reply from the agent's full output.
 * The agent is instructed to use "---DRAFT_REPLY---" as a delimiter.
 * Falls back to heuristic extraction if the delimiter is missing.
 */
function extractDraftReply(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // Primary: look for the explicit delimiter
  const delimIdx = trimmed.indexOf("---DRAFT_REPLY---");
  if (delimIdx !== -1) {
    return trimmed.substring(delimIdx + "---DRAFT_REPLY---".length).trim();
  }

  // Fallback: look for common "Draft Reply" headers the model may produce
  const headerPatterns = [
    /###\s*Draft\s*Reply\s*(for\s*Tenant)?\s*\n/i,
    /\*\*Draft\s*Reply\s*(for\s*Tenant)?\*\*\s*\n/i,
    /Draft\s*Reply\s*(for\s*Tenant)?:\s*\n/i,
    /---+\s*\n\s*$/m, // last horizontal rule before the reply
  ];

  for (const pattern of headerPatterns) {
    const match = trimmed.match(pattern);
    if (match && match.index !== undefined) {
      const afterHeader = trimmed.substring(match.index + match[0].length).trim();
      if (afterHeader.length > 10) return afterHeader;
    }
  }

  // Last resort: if the output contains "Summary of Actions" or numbered lists
  // of internal steps, try to grab the last paragraph block
  if (/summary\s*of\s*actions|^\d+\.\s+\*.*?\*/im.test(trimmed)) {
    const paragraphs = trimmed.split(/\n{2,}/);
    const lastParagraph = paragraphs[paragraphs.length - 1]?.trim();
    // Only use if the last paragraph looks like a natural reply (no markdown headers, no numbered lists)
    if (lastParagraph && lastParagraph.length > 20 && !/^#{1,3}\s|^\d+\.\s+\*/m.test(lastParagraph)) {
      return lastParagraph;
    }
  }

  // Absolute fallback: strip markdown artifacts and return cleaned text
  // Remove tool-call artifacts, internal reasoning markers, and markdown headers
  const cleaned = trimmed
    .replace(/^#+\s+.*$/gm, "")               // remove markdown headers
    .replace(/\*\*[^*]+\*\*/g, (m) => m.replace(/\*\*/g, ""))  // remove bold markers
    .replace(/^\s*[-*]\s+(Action|Step|Tool|Called).*$/gim, "") // remove action/step lines
    .replace(/\n{3,}/g, "\n\n")                // collapse excess newlines
    .trim();
  if (cleaned.length > 10) {
    console.info("extractDraftReply: using cleaned fallback", { originalLength: trimmed.length, cleanedLength: cleaned.length });
    return cleaned;
  }

  // Last absolute fallback: return as-is
  return trimmed;
}

/**
 * Check whether a draft reply is valid to send to a tenant.
 * Rejects empty strings, internal error messages, placeholder text, and agent artifacts.
 */
function isValidTenantDraft(draft: string): boolean {
  if (!draft || draft.trim().length < 5) return false;
  const lower = draft.trim().toLowerCase();
  const invalidPatterns = [
    /^\(no\s*(response|reply|draft)/i,
    /^no\s*(response|reply|draft)\s*(from|available)/i,
    /^agent\s*error/i,
    /llm_unavailable|vertex_not_configured/i,
    /^\[?(internal|system|error|debug)\]?/i,
    /^undefined$/i,
    /^null$/i,
    /^todo:/i,
  ];
  return !invalidPatterns.some((p) => p.test(lower));
}

const router = express.Router();

// Twilio signature verification middleware.
router.use("/twilio", express.urlencoded({ extended: false }));
router.use("/twilio", (req, res, next) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN || "";
  const signature = req.get("X-Twilio-Signature") || "";
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

  const valid = authToken
    ? twilio.validateRequest(authToken, signature, url, req.body)
    : false;

  if (!authToken) {
    return res.status(500).json({ error: "twilio_auth_token_missing" });
  }

  if (!valid) {
    return res.status(403).json({ error: "invalid_signature" });
  }

  return next();
});

// Handle inbound SMS webhook and route into maintenance flow.
router.post("/twilio", async (req, res, next) => {
  try {
    const tenantMessage = req.body?.Body || "";
    const tenantPhone = req.body?.From || "";

    if (!tenantMessage) {
      return res.status(400).json({ error: "missing_message_body" });
    }

    // Reuse maintenance route handler logic by delegating internally.
    req.body = {
      tenantMessage,
      tenantId: tenantPhone, // placeholder mapping until DB mapping exists
      unitId: await resolveTenantUnitId(tenantPhone),
    };

    // Forward to maintenance router
    return (maintenanceRouter as unknown as express.RequestHandler)(req, res, next);
  } catch (err) {
    return next(err);
  }
});

const SAFE_AUTOPILOT_SEVERITIES = new Set(["low", "normal"]);
const CRITICAL_KEYWORDS = ["fire", "water leak", "gas leak", "gas", "no power", "no heat", "flood", "smoke"];
const DEFAULT_REPLY_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between replies per tenant (was 1 hour)
const pendingTenantReplies = new Map<
  string,
  {
    messages: { content: string; at: number; media: boolean }[];
    timer: NodeJS.Timeout;
    replyTo: string;
    isGroup: boolean;
    landlordId: string;
    /** Accumulated media payloads for multimodal agent input */
    mediaResults: ExtractedMedia[];
  }
>();
const lastReplySentAt = new Map<string, number>();

function normalizePhone(raw?: string) {
  if (!raw) return "";
  return raw.replace(/\D/g, "");
}

// Legacy: fall back to env var if no landlord found in DB
function landlordNumbers() {
  const raw = process.env.LANDLORD_WHATSAPP_NUMBERS || "";
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function isLandlordNumber(phone: string) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  return landlordNumbers().some((num) => normalizePhone(num) === normalized);
}

/**
 * Resolve whether the sender is a landlord, tenant, or contractor from the DB.
 * Falls back to env var for backwards compatibility.
 */
async function resolveContext(phone: string): Promise<{
  role: "landlord" | "tenant" | "contractor" | "unknown";
  landlordId: string | null;
  entity: any;
}> {
  // Check if sender IS a landlord
  const landlord = await repo.findLandlordByWhatsApp(phone);
  if (landlord) return { role: "landlord", landlordId: landlord.id, entity: landlord };

  // Check if sender is a tenant belonging to any landlord
  const tenant = await repo.findTenantByPhone(phone);
  if (tenant) return { role: "tenant", landlordId: tenant.landlordId || null, entity: tenant };

  // Check contractors
  const contractor = await repo.findContractorByPhone(phone);
  if (contractor) return { role: "contractor", landlordId: (contractor as any).landlordId || null, entity: contractor };

  // Legacy fallback: check env var
  if (isLandlordNumber(phone)) {
    return { role: "landlord", landlordId: null, entity: { phone, name: "Landlord (env)" } };
  }

  return { role: "unknown", landlordId: null, entity: null };
}

function extractWhatsAppText(payload: any): string {
  const data = payload?.data || payload;
  const candidate =
    data?.message?.conversation ||
    data?.message?.extendedTextMessage?.text ||
    data?.message?.text ||
    data?.message?.imageMessage?.caption ||
    data?.message?.videoMessage?.caption ||
    data?.text ||
    data?.message ||
    "";
  if (typeof candidate === "string") return candidate;
  if (typeof candidate === "number") return String(candidate);
  if (candidate && typeof candidate === "object") {
    if (typeof (candidate as any).text === "string") return (candidate as any).text;
    if (typeof (candidate as any).conversation === "string") return (candidate as any).conversation;
  }
  return "";
}

function extractWhatsAppMediaDescription(payload: any): string {
  const data = payload?.data || payload;
  const caption =
    data?.message?.imageMessage?.caption ||
    data?.message?.videoMessage?.caption ||
    data?.message?.documentMessage?.caption ||
    "";
  if (data?.message?.imageMessage) return `[image received] ${caption}`.trim();
  if (data?.message?.videoMessage) return `[video received] ${caption}`.trim();
  if (data?.message?.audioMessage || data?.message?.ptt) return `[voice note received]`.trim();
  if (data?.message?.documentMessage) return `[document received] ${caption}`.trim();
  return "";
}

type InlineImagePayload = { base64: string; mimeType: string };

function parseInlineImageData(raw: string, fallbackMimeType: string): InlineImagePayload {
  const trimmed = raw.trim().replace(/\s+/g, "");
  const match = /^data:(image\/[^;]+);base64,(.*)$/i.exec(trimmed);
  if (match?.[1] && match?.[2]) {
    return { base64: match[2], mimeType: match[1] };
  }
  return { base64: trimmed, mimeType: fallbackMimeType };
}

function extractWhatsAppImageBase64(payload: any): InlineImagePayload | null {
  const data = payload?.data || payload;
  const candidates = [
    data?.message?.imageMessage?.base64,
    data?.message?.imageMessage?.imageBase64,
    data?.message?.imageMessage?.media?.base64,
    data?.message?.imageMessage?.media?.data,
    data?.message?.imageMessage?.data,
    data?.message?.base64,
    data?.base64,
  ];
  const raw = candidates.find((entry) => typeof entry === "string" && entry.trim());
  if (!raw) return null;
  const mimeType =
    data?.message?.imageMessage?.mimetype ||
    data?.message?.imageMessage?.mimeType ||
    data?.mimeType ||
    "image/jpeg";
  return parseInlineImageData(raw, mimeType);
}

function formatRecentConversation(entries: any[], limit = 4) {
  if (!Array.isArray(entries) || !entries.length) return "";
  return entries
    .filter((entry) => entry?.role === "tenant" || entry?.role === "ai")
    .slice(-limit)
    .map((entry) => {
      const who = (entry?.role || "unknown").toUpperCase();
      const text = entry?.content || "";
      return `${who}: ${text}`.trim();
    })
    .filter(Boolean)
    .join("\n");
}

function extractWhatsAppSenderInfo(payload: any) {
  const data = payload?.data || payload;
  const remoteJid = data?.key?.remoteJid || data?.from || data?.sender || data?.remoteJid || "";
  const participant = data?.key?.participant || data?.participant || "";
  const isGroup = typeof remoteJid === "string" && remoteJid.endsWith("@g.us");
  const sender = isGroup
    ? whatsappService.normalizeWhatsAppNumber(participant)
    : whatsappService.normalizeWhatsAppNumber(remoteJid);
  const replyTo = whatsappService.normalizeWhatsAppNumber(remoteJid || sender);
  return { remoteJid, participant, isGroup, sender, replyTo };
}

function containsCriticalKeyword(text: string) {
  const normalized = text.toLowerCase();
  return CRITICAL_KEYWORDS.some((kw) => normalized.includes(kw));
}

/**
 * Build a landlord notification message. For HIGH/CRITICAL severity,
 * includes AI recommendation and prompts landlord to reply "approve" or "deny".
 */
function buildLandlordAlert(opts: {
  tenantName: string;
  tenantPhone: string;
  message: string;
  severity: string;
  draft: string;
  isNewTicket?: boolean;
}): string {
  const sev = (opts.severity || "normal").toLowerCase();
  const isEscalated = sev === "high" || sev === "critical" || containsCriticalKeyword(opts.message);
  const effectiveSeverity = isEscalated ? (sev === "critical" ? "CRITICAL" : "HIGH") : sev.toUpperCase();
  const ticketLabel = opts.isNewTicket ? "🆕 NEW TICKET" : "📩 TENANT MESSAGE";

  let alert = `${ticketLabel}\n`;
  alert += `👤 ${opts.tenantName} (${opts.tenantPhone})\n`;
  alert += `⚠️ Severity: ${effectiveSeverity}\n`;
  alert += `💬 Message: ${opts.message}\n`;

  if (isEscalated) {
    alert += `\n🤖 AI Recommendation:\n${opts.draft || "(No draft available yet)"}\n`;
    alert += `\n⚡ This is a ${effectiveSeverity} severity issue. Auto-reply has been HELD for your review.`;
    alert += `\n\n👉 Reply "approve" to send the AI draft to the tenant`;
    alert += `\n👉 Reply "deny" to block the auto-reply`;
  } else {
    alert += `\n🤖 AI Draft: ${opts.draft || "(agent handled)"}\n`;
    if (opts.draft) {
      alert += `✅ Auto-reply was sent to tenant (severity: ${effectiveSeverity}).`;
    }
  }

  return alert;
}

function isFromMe(payload: any): boolean {
  const data = payload?.data || payload;
  return Boolean(data?.key?.fromMe || data?.fromMe);
}

async function maybeRunAutopilot(record: any, triage: any, aiDraft: any, reason = "tenant_message") {
  if (!record?.id || !record.autopilotEnabled) return false;
  const severity = (triage?.classification?.severity || record?.triageJson?.classification?.severity || "unknown")
    .toString()
    .toLowerCase();
  await repo.logAutopilotEvent({
    id: record.id,
    type: "system",
    message: "Autopilot evaluating latest activity",
    status: "evaluating",
    meta: { severity, reason },
  });
  if (!SAFE_AUTOPILOT_SEVERITIES.has(severity)) {
    await repo.logAutopilotEvent({
      id: record.id,
      type: "skip",
      message: `Autopilot blocked at severity ${severity}`,
      status: "blocked_severity",
      meta: { severity, reason },
    });
    return false;
  }
  const chatLog = Array.isArray(record.chatLog) ? record.chatLog : [];
  const lastEntry = chatLog[chatLog.length - 1];
  if (lastEntry?.role !== "tenant") {
    await repo.logAutopilotEvent({
      id: record.id,
      type: "skip",
      message: "Autopilot idle (no tenant awaiting reply)",
      status: "idle",
      meta: { severity, reason },
    });
    return false;
  }
  const text = (aiDraft?.draft || record?.aiDraft?.draft || "").trim();
  if (!text) {
    await repo.logAutopilotEvent({
      id: record.id,
      type: "skip",
      message: "Autopilot waiting for draft content",
      status: "awaiting_draft",
      meta: { severity, reason },
    });
    return false;
  }
  await repo.appendChatMessage({
    id: record.id,
    role: "ai",
    content: text,
    meta: { autopilot: true, severity, reason },
    setLandlordReply: text,
  });
  await repo.logAutopilotEvent({
    id: record.id,
    type: "auto_reply",
    message: "Autopilot sent reply using latest draft",
    status: "auto_replied",
    meta: { severity, reason, length: text.length },
  });
  return true;
}

async function computeDelayMs(tenantId: string, severity: string, text: string, landlordId?: string) {
  const now = Date.now();
  if (severity === "high" || severity === "critical" || containsCriticalKeyword(text)) return 0;
  const last = lastReplySentAt.get(tenantId) || 0;
  const cooldownSetting = await repo.getGlobalAutoReplyCooldownMinutes(landlordId);
  const cooldownMs = Math.max(0, Math.round(cooldownSetting.minutes * 60 * 1000)) || DEFAULT_COOLDOWN_MS;
  const cooldownTarget = last + cooldownMs;
  const delaySetting = await repo.getGlobalAutoReplyDelayMinutes(landlordId);
  const delayMs = Math.max(0, Math.round(delaySetting.minutes * 60 * 1000)) || DEFAULT_REPLY_DELAY_MS;
  const baseTarget = now + delayMs;
  // eslint-disable-next-line no-console
  console.info("computeDelayMs", { tenantId, severity, landlordId, cooldownMin: cooldownSetting.minutes, delayMin: delaySetting.minutes, resultMs: Math.max(baseTarget, cooldownTarget) - now });
  return Math.max(baseTarget, cooldownTarget) - now;
}

function queueTenantReply(params: {
  tenantId: string;
  replyTo: string;
  isGroup: boolean;
  tenantMessage: string;
  media: boolean;
  delayMs: number;
  landlordId: string;
  /** Extracted media payload to carry through to flush */
  mediaResult?: ExtractedMedia | null;
}) {
  const bucket = pendingTenantReplies.get(params.tenantId);
  const messages = bucket?.messages || [];
  const updatedMessages = [...messages, { content: params.tenantMessage, at: Date.now(), media: params.media }];
  const mediaResults = bucket?.mediaResults || [];
  if (params.mediaResult) {
    mediaResults.push(params.mediaResult);
  }

  if (bucket?.timer) {
    clearTimeout(bucket.timer);
  }

  const timer = setTimeout(() => {
    flushTenantReply({ tenantId: params.tenantId }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("flush tenant reply failed", err);
    });
  }, params.delayMs);

  pendingTenantReplies.set(params.tenantId, {
    messages: updatedMessages,
    timer,
    replyTo: params.replyTo,
    isGroup: params.isGroup,
    landlordId: params.landlordId,
    mediaResults,
  });
}

async function flushTenantReply(params: { tenantId: string }) {
  // eslint-disable-next-line no-console
  console.info("flushTenantReply TRIGGERED", { tenantId: params.tenantId });
  const bucket = pendingTenantReplies.get(params.tenantId);
  if (!bucket) {
    // eslint-disable-next-line no-console
    console.warn("flushTenantReply: no bucket found", { tenantId: params.tenantId });
    return null;
  }
  clearTimeout(bucket.timer);
  pendingTenantReplies.delete(params.tenantId);

  const tenant = await repo.getTenantById(params.tenantId);
  if (!tenant) return null;
  const landlordId = bucket.landlordId || tenant.landlordId || "";
  const globalAutoReply = await repo.getGlobalAutoReplyEnabled(landlordId);
  const canAutoReply = globalAutoReply.enabled && tenant.autoReplyEnabled !== false;

  const combinedMessage = bucket.messages.map((m) => m.content).join("\n---\n").trim();

  // ── AGENTIC PATH ──
  if (AGENTIC_MODE && landlordId) {
    try {
      // Save tenant message to conversation memory
      await conversationMemory.saveMessage({
        phone: tenant.phone || bucket.replyTo,
        landlordId,
        role: "tenant",
        content: combinedMessage,
        meta: { channel: bucket.isGroup ? "whatsapp_group" : "whatsapp", batched: bucket.messages.length > 1 },
      });

      // Load conversation history for context
      const history = await conversationMemory.getHistory({
        phone: tenant.phone || bucket.replyTo,
        landlordId,
        limit: 15,
      });
      const historyText = conversationMemory.formatHistory(history, 10);

      // Build media description and multimodal parts from accumulated media
      const allMedia = bucket.mediaResults || [];
      const mediaDescriptions = allMedia
        .map((m) => {
          if (m.transcription) return `[Voice note]: "${m.transcription}"`;
          if (m.description) return `[${m.type} analysis]: ${m.description}`;
          return `[${m.type} received]`;
        })
        .filter(Boolean);
      const mediaParts = allMedia
        .filter((m) => m.base64 && m.mimeType)
        .map((m) => ({ base64: m.base64, mimeType: m.mimeType }));

      // Inject conversation history into the message for context
      const enrichedMessage = historyText
        ? `[Conversation History]\n${historyText}\n\n[Current Message]\n${combinedMessage}`
        : combinedMessage;

      const agentResult = await orchestrator.handleTenantMessage({
        tenantPhone: tenant.phone || "",
        message: enrichedMessage,
        landlordId,
        mediaDescription: mediaDescriptions.length ? mediaDescriptions.join("\n") : undefined,
        mediaParts: mediaParts.length ? mediaParts : undefined,
      });
      // eslint-disable-next-line no-console
      console.info("agentic flush (tenant batch)", {
        tenantId: tenant.id,
        toolCalls: agentResult.toolCallCount,
        steps: agentResult.steps.length,
        tokens: agentResult.totalTokensEstimate,
      });

      let draftText = extractDraftReply(agentResult.finalAnswer || "");
      // If the agent returned an error (e.g. LLM 503), use a friendly fallback
      if (/^Agent error:/i.test(draftText) || /llm_unavailable|vertex_not_configured/i.test(draftText)) {
        console.warn("LLM unavailable for tenant reply (agentic batch), using fallback", { tenantId: tenant.id, raw: draftText.substring(0, 100) });
        draftText = "Thanks for your message! Our AI assistant is temporarily experiencing high demand. Your message has been logged and your landlord has been notified. We'll get back to you shortly.";
      }

      // Retry once if the draft is empty or invalid (e.g. agent returned internal artifacts)
      if (!isValidTenantDraft(draftText)) {
        console.warn("invalid draft from agent (agentic batch), retrying once", { tenantId: tenant.id, raw: (draftText || "").substring(0, 80) });
        try {
          const retryResult = await orchestrator.handleTenantMessage({
            tenantPhone: tenant.phone || "",
            message: enrichedMessage,
            landlordId,
            mediaDescription: mediaDescriptions.length ? mediaDescriptions.join("\n") : undefined,
            mediaParts: mediaParts.length ? mediaParts : undefined,
          });
          const retryDraft = extractDraftReply(retryResult.finalAnswer || "");
          if (isValidTenantDraft(retryDraft)) {
            draftText = retryDraft;
            console.info("retry succeeded (agentic batch)", { tenantId: tenant.id, draftLength: draftText.length });
          } else {
            console.warn("retry also produced invalid draft (agentic batch) — suppressing reply", { tenantId: tenant.id });
            draftText = ""; // Suppress — don't send garbage to tenant
          }
        } catch (retryErr) {
          console.warn("retry failed (agentic batch)", { error: (retryErr as Error).message });
          draftText = ""; // Suppress
        }
      }
      // eslint-disable-next-line no-console
      console.info("draft reply extracted", {
        tenantId: tenant.id,
        fullLength: (agentResult.finalAnswer || "").length,
        draftLength: draftText.length,
      });
      // Try to get severity from the latest maintenance record
      const latestRecord = await repo.findLatestMaintenanceForTenantId(tenant.id);
      const batchSeverity = ((latestRecord?.triageJson as any)?.classification?.severity || "normal").toString().toLowerCase();
      const isHighCriticalBatch = batchSeverity === "high" || batchSeverity === "critical";

      if (draftText && canAutoReply && !isHighCriticalBatch) {
        const sendResult = await whatsappService.sendWhatsAppText({ to: bucket.replyTo, text: draftText, landlordId });
        if (!sendResult.ok) {
          // eslint-disable-next-line no-console
          console.error("auto-reply send FAILED (agentic batch)", { tenantId: tenant.id, replyTo: bucket.replyTo, error: sendResult.error, response: sendResult.response });
        } else {
          lastReplySentAt.set(tenant.id, Date.now());
          // Save AI reply to conversation memory
          await conversationMemory.saveMessage({
            phone: tenant.phone || bucket.replyTo,
            landlordId,
            role: "ai",
            content: draftText,
          });
          // eslint-disable-next-line no-console
          console.info("auto-reply sent (agentic batch)", { tenantId: tenant.id, replyTo: bucket.replyTo });
        }
      } else if (isHighCriticalBatch && draftText) {
        // HIGH/CRITICAL: Hold the auto-reply for landlord approval
        // eslint-disable-next-line no-console
        console.info("auto-reply HELD for landlord approval (agentic batch)", { tenantId: tenant.id, severity: batchSeverity });
        // Store the draft in the maintenance record so approve/deny can forward it
        if (latestRecord?.id) {
          await repo.updateMaintenanceAnalysis({ id: latestRecord.id, aiDraft: { draft: draftText } as any });
        }
      } else {
        // eslint-disable-next-line no-console
        console.info("auto-reply skipped (agentic batch)", { tenantId: tenant.id, hasDraft: Boolean(draftText), canAutoReply });
      }

      // Notify landlord about tenant message (batched agentic path)
      const agentAlert = buildLandlordAlert({
        tenantName: tenant.name,
        tenantPhone: tenant.phone || bucket.replyTo,
        message: combinedMessage,
        severity: batchSeverity,
        draft: draftText || "(agent handled)",
        isNewTicket: !latestRecord,
      });
      if (landlordId) {
        await whatsappService.alertLandlord(landlordId, agentAlert, {
          type: batchSeverity === "high" || batchSeverity === "critical" ? "APPROVAL_REQUEST" : "MAINTENANCE_NEW",
          maintenanceId: latestRecord?.id,
          tenantPhone: tenant.phone || bucket.replyTo,
          severity: batchSeverity,
        });
      }

      return null;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("agentic flush failed, falling back to linear", err);
      // Fall through to linear path
    }
  }

  // ── LINEAR PATH (original) ──
  const existing = await repo.findLatestMaintenanceForTenantId(tenant.id);
  const conversationLog = Array.isArray(existing?.chatLog) ? (existing?.chatLog as any[]) : [];

  const resolvedUnitId = await resolveTenantUnitId(tenant.id);
  const triage = await agentService.triageMaintenance({
    tenantMessage: combinedMessage,
    tenantId: tenant.id,
    unitId: resolvedUnitId,
  });
  const utilityCheck = await agentService.checkUtilityAnomaly({ tenantId: tenant.id, unitId: resolvedUnitId });
  const draftResponse = await agentService.draftRtaResponse({
    tenantMessage: combinedMessage,
    triage,
    utilityCheck,
    conversationLog: [...conversationLog, { role: "tenant", content: combinedMessage, createdAt: new Date().toISOString() }],
    landlordReply: existing?.landlordReply,
  });
  // eslint-disable-next-line no-console
  console.info("llm invoked (tenant batch)", {
    tenantId: tenant.id,
    draftAvailable: Boolean((draftResponse?.draft || "").trim()),
    rawModelText: Boolean((triage as any)?.rawModelText || (draftResponse as any)?.notes),
  });

  let record = existing;
  if (record?.id) {
    await repo.updateMaintenanceAnalysis({ id: record.id, triage, aiDraft: draftResponse });
    await repo.updateMaintenanceUtility({ maintenanceId: record.id, utilityCheck });
    await repo.appendChatMessage({
      id: record.id,
      role: "tenant",
      content: combinedMessage,
      meta: { channel: bucket.isGroup ? "whatsapp_group" : "whatsapp", sender: tenant.phone, media: bucket.messages.some((m) => m.media) },
    });
  } else {
    record = await repo.createMaintenanceRequest({
      tenantId: tenant.id,
      unitId: resolvedUnitId,
      landlordId,
      message: combinedMessage,
      triage,
      aiDraft: draftResponse,
      autopilotEnabled: true,
    });
    if (record?.id) {
      await repo.updateMaintenanceUtility({ maintenanceId: record.id, utilityCheck });
      await repo.appendChatMessage({
        id: record.id,
        role: "tenant",
        content: combinedMessage,
        meta: { channel: bucket.isGroup ? "whatsapp_group" : "whatsapp", sender: tenant.phone, media: bucket.messages.some((m) => m.media) },
      });
    }
  }

  let draftText = (draftResponse?.draft || "").trim();
  // Validate draft with the same rules as agentic paths
  if (!isValidTenantDraft(draftText)) {
    draftText = "";
    console.warn("Invalid/empty draft from linear batch — suppressing reply", { tenantId: tenant.id });
  }

  const triageJson: any = record?.triageJson || triage || {};
  const aiDraft: any = record?.aiDraft || draftResponse || {};
  const linearBatchSeverity = (triageJson?.classification?.severity || "normal").toString().toLowerCase();
  const isHighCriticalLinearBatch = linearBatchSeverity === "high" || linearBatchSeverity === "critical";

  if (draftText && canAutoReply && !isHighCriticalLinearBatch) {
    const sendResult = await whatsappService.sendWhatsAppText({ to: bucket.replyTo, text: draftText, landlordId });
    if (!sendResult.ok) {
      // eslint-disable-next-line no-console
      console.error("auto-reply send FAILED (linear batch)", { tenantId: tenant.id, replyTo: bucket.replyTo, error: sendResult.error, response: sendResult.response });
    } else {
      if (record?.id) {
        await repo.appendChatMessage({
          id: record.id,
          role: "ai",
          content: draftText,
          meta: { channel: bucket.isGroup ? "whatsapp_group" : "whatsapp", batched: true },
        });
      }
      lastReplySentAt.set(tenant.id, Date.now());
      // eslint-disable-next-line no-console
      console.info("auto-reply sent (linear batch)", { tenantId: tenant.id, replyTo: bucket.replyTo });
    }
  } else if (isHighCriticalLinearBatch && draftText) {
    // HIGH/CRITICAL: Hold the auto-reply for landlord approval
    console.info("auto-reply HELD for landlord approval (linear batch)", { tenantId: tenant.id, severity: linearBatchSeverity });
    if (record?.id) {
      await repo.updateMaintenanceAnalysis({ id: record.id, aiDraft: { draft: draftText } as any });
    }
  } else if (draftText && !canAutoReply) {
    // eslint-disable-next-line no-console
    console.info("auto-reply disabled for tenant", { tenantId: tenant.id });
  }
  const severity = (triageJson?.classification?.severity || "normal").toString().toLowerCase();
  const draft = aiDraft?.draft || "(no draft yet)";
  const alert = buildLandlordAlert({
    tenantName: tenant.name,
    tenantPhone: tenant.phone || bucket.replyTo,
    message: combinedMessage,
    severity,
    draft,
    isNewTicket: !existing,
  });
  if (landlordId) {
    await whatsappService.alertLandlord(landlordId, alert, {
      type: severity === "high" || severity === "critical" ? "APPROVAL_REQUEST" : "MAINTENANCE_NEW",
      maintenanceId: record?.id,
      tenantPhone: tenant.phone || bucket.replyTo,
      severity,
    });
  } else {
    for (const number of landlordNumbers()) {
      await whatsappService.sendWhatsAppText({ to: number, text: alert });
    }
  }

  return record;
}

/**
 * Extract the Evolution API instance name from the webhook payload.
 * Evolution API includes this in the webhook body.
 */
function extractInstanceName(payload: any): string {
  return payload?.instance || payload?.instanceName || payload?.data?.instance || payload?.server_url || "";
}

/**
 * Resolve the landlord who owns a given Evolution API instance.
 */
async function resolveLandlordByInstance(instanceName: string) {
  if (!instanceName) return null;
  try {
    return await repo.findLandlordByInstance(instanceName);
  } catch { return null; }
}

// Evolution API may post to /whatsapp or /whatsapp/evolution depending on instance config
const evolutionWebhookHandler: express.RequestHandler = async (req, res) => {
  try {
    let llmInvoked = false;
    let autoReplySent = false;
    let autoReplyReason: string | undefined;
    const text = extractWhatsAppText(req.body)?.trim();
    const mediaNote = extractWhatsAppMediaDescription(req.body)?.trim();
    const imagePayload = extractWhatsAppImageBase64(req.body);
    const inboundContent = [text, mediaNote].filter(Boolean).join(" ").trim();
    if (!inboundContent && !imagePayload) return res.json({ ok: true, ignored: "no_text" });
    const { remoteJid, participant, isGroup, sender, replyTo } = extractWhatsAppSenderInfo(req.body);
    if (!sender) {
      // For groups, ignore when no participant phone is available.
      return res.json({ ok: true, ignored: isGroup ? "no_group_participant" : "no_sender" });
    }
    const fromMe = isFromMe(req.body);

    // ── Instance Resolution ──
    const instanceName = extractInstanceName(req.body);
    let instanceLandlord = instanceName ? await resolveLandlordByInstance(instanceName) : null;

    let resolvedLandlordId = instanceLandlord?.id || "";

    // ── Group message handling ──
    // If the message comes from a known unit WhatsApp group, route it to the
    // landlord's agent. Otherwise ignore group chatter.
    let groupUnit: Awaited<ReturnType<typeof repo.findUnitByGroupJid>> | null = null;
    if (isGroup) {
      groupUnit = await repo.findUnitByGroupJid(remoteJid);
      // Fallback: try trimmed/lowercased JID if exact match fails
      if (!groupUnit && remoteJid) {
        groupUnit = await repo.findUnitByGroupJid(remoteJid.trim().toLowerCase());
      }
      if (!groupUnit) {
        // eslint-disable-next-line no-console
        console.warn("group message from UNKNOWN group — dropping. To enable, set whatsappGroupJid on the unit record.", {
          remoteJid,
          sender,
          participant,
          hint: "Add this group JID to a unit's whatsappGroupJid field in the database to start receiving messages from this group.",
        });
        return res.json({ ok: true, ignored: "group_message", groupJid: remoteJid });
      }
      // We have a recognized unit group — resolve landlord from unit owner and
      // treat the sender (participant) as the speaking tenant.  Fall through to
      // the normal tenant processing flow below.
      // Also override landlord from the unit if the instance resolution failed
      if (!instanceLandlord && groupUnit.landlordId) {
        instanceLandlord = await db.landlord.findUnique({ where: { id: groupUnit.landlordId } });
        if (instanceLandlord) resolvedLandlordId = instanceLandlord.id;
      }
      // eslint-disable-next-line no-console
      console.info("group message from known unit", {
        unitId: groupUnit.id,
        unitLabel: groupUnit.label,
        sender,
        groupJid: remoteJid,
        tenantCount: groupUnit.tenants?.length || 0,
      });
    }

    // Ignore bot-echoed/own messages (except landlord self-chat)
    if (fromMe) {
      // In groups, fromMe means the connected device (bot) sent it — always skip
      if (isGroup) {
        return res.json({ ok: true, ignored: "from_me_group_echo" });
      }
      if (!instanceLandlord && !isLandlordNumber(sender)) return res.json({ ok: true, ignored: "from_me" });
      if (text?.startsWith("AI Assistance:")) return res.json({ ok: true, ignored: "from_me_ai_echo" });
      // landlord self-test allowed to proceed
    }

    // ── Multi-landlord resolution ──
    // First try to resolve by Evolution API instance name (most reliable for multi-tenant)
    // IMPORTANT: Scope tenant/contractor lookups to the instance landlord to prevent cross-tenant data leaks
    const effectiveLandlordId = resolvedLandlordId || "";

    let ctx = await resolveContext(sender);
    // If sender is unknown but we know the instance, resolve via instance owner
    if (ctx.role === "unknown" && instanceLandlord) {
      // Sender is a tenant/unknown person messaging a landlord's WhatsApp — treat as tenant
      ctx = { role: "unknown", landlordId: instanceLandlord.id, entity: null };
    }
    // If sender was resolved as a tenant of a DIFFERENT landlord but the message arrived
    // on THIS landlord's instance, override: treat as unknown to this instance owner
    if (ctx.role === "tenant" && effectiveLandlordId && ctx.landlordId && ctx.landlordId !== effectiveLandlordId) {
      ctx = { role: "unknown", landlordId: effectiveLandlordId, entity: null };
    }

    const isLandlord = ctx.role === "landlord";
    const landlordId = effectiveLandlordId || ctx.landlordId || "";
    const effectiveReplyTo = replyTo;

    const respond = (payload: Record<string, unknown>) => {
      // Track AI usage for plan limits (increment counter when LLM was invoked)
      if (llmInvoked && landlordId) {
        incrementMessageCount(landlordId).catch(() => {});
      }
      setWebhookStatus({
        receivedAt: new Date().toISOString(),
        routed: typeof payload.routed === "string" ? payload.routed : undefined,
        llmInvoked,
        autoReplySent,
        autoReplyReason,
        delayMs: typeof (payload as any).delayMs === "number" ? (payload as any).delayMs : undefined,
        sender,
        isGroup,
        isLandlord,
      });
      return res.json(payload);
    };

    // ── Plan usage limit (Gemini API calls) ──
    // FREE plan: 30 AI calls/month. Checked before any LLM invocation.
    let planLimitExceeded = false;
    if (landlordId) {
      const limit = await checkPlanLimit(landlordId, "messages");
      if (!limit.allowed) {
        planLimitExceeded = true;
        // eslint-disable-next-line no-console
        console.warn("plan limit exceeded — skipping AI", { landlordId, current: limit.current, max: limit.max, plan: limit.plan });
      }
    }

    if (isLandlord) {
      const record = await repo.findLatestOpenMaintenance(landlordId || undefined);
      // If there IS an active maintenance record, attach landlord message to it
      if (record) {
        await repo.appendChatMessage({
          id: record.id,
          role: "landlord",
          content: text,
          meta: { channel: "whatsapp", sender },
          setLandlordReply: text,
        });
      }

      // ── AGENTIC LANDLORD PATH (works with or without active maintenance) ──
      if (AGENTIC_MODE && landlordId) {
        // Enforce plan limit before LLM call
        if (planLimitExceeded) {
          await whatsappService.sendWhatsAppText({
            to: effectiveReplyTo,
            text: "You\u2019ve reached your free plan\u2019s monthly AI limit (30 messages). Upgrade to Pro for unlimited AI-powered responses.",
            landlordId,
          });
          return respond({ ok: true, routed: "landlord_plan_limit", llmInvoked: false, autoReplySent: false });
        }
        try {
          // Save landlord message to conversation memory
          await conversationMemory.saveMessage({
            phone: sender,
            landlordId,
            role: "landlord",
            content: text || "",
          });

          const agentResult = await orchestrator.landlordAssistantAgent({
            landlordId,
            question: text || "",
            maintenanceId: record?.id,
            channel: "whatsapp",
            senderPhone: sender,
          });
          llmInvoked = true;

          const reply = (agentResult.finalAnswer || "").trim() || "I'm here. Ask me anything about your properties.";
          await whatsappService.sendWhatsAppText({ to: effectiveReplyTo, text: `AI Assistance: ${reply}`, landlordId });
          if (record) {
            await repo.appendChatMessage({
              id: record.id,
              role: "ai",
              content: `AI Assistance: ${reply}`,
              meta: { channel: "whatsapp", assistant: true, agentic: true, toolCalls: agentResult.toolCallCount, tokens: agentResult.totalTokensEstimate },
            });
          }

          // Save AI reply to landlord conversation memory
          await conversationMemory.saveMessage({
            phone: sender,
            landlordId,
            role: "ai",
            content: reply,
          });

          // Approval / Deny path (agentic mode)
          if (record) {
            const approved = /approve|approved|send it|ok to send/i.test(text || "");
            const denied = /deny|denied|reject|block/i.test(text || "");
            const forwardDraft = ((record.aiDraft as any)?.draft || "").trim();
            if (approved && record.tenantId && forwardDraft) {
              const tenantForForward = await repo.getTenantById(record.tenantId);
              if (tenantForForward?.phone) {
                await whatsappService.sendWhatsAppText({ to: tenantForForward.phone, text: forwardDraft, landlordId });
                await repo.appendChatMessage({
                  id: record.id,
                  role: "ai",
                  content: forwardDraft,
                  meta: { channel: "whatsapp", forwarded: true, approvedBy: sender },
                });
                await whatsappService.sendWhatsAppText({ to: effectiveReplyTo, text: "\u2705 Draft approved and sent to tenant.", landlordId });
              }
            } else if (denied && record.tenantId) {
              await repo.appendChatMessage({
                id: record.id,
                role: "landlord",
                content: "[DENIED] Landlord rejected the AI draft.",
                meta: { channel: "whatsapp", denied: true, deniedBy: sender },
              });
              await whatsappService.sendWhatsAppText({ to: effectiveReplyTo, text: "\u274c Draft denied. The auto-reply was NOT sent to the tenant.", landlordId });
            }
          }

          return respond({ ok: true, routed: "landlord_agentic", llmInvoked, autoReplySent, autoReplyReason });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("agentic landlord failed, falling back to linear", err);
          // Fall through to linear path
        }
      }

      // If no record and not agentic, just send a friendly message
      if (!record) {
        await whatsappService.sendWhatsAppText({
          to: effectiveReplyTo,
          text: "No active tenant requests right now. You can still ask me anything via the dashboard.",
          landlordId,
        });
        return respond({ ok: true, routed: "landlord_no_active", llmInvoked, autoReplySent });
      }

      // ── LINEAR LANDLORD PATH (original) ──
      const chatLog = Array.isArray(record.chatLog) ? (record.chatLog as any[]) : [];
      const augmentedLog = [
        ...chatLog,
        { role: "landlord", content: text, createdAt: new Date().toISOString() },
      ];
      const lastTenantMessage = [...augmentedLog].reverse().find((c) => c.role === "tenant")?.content || "";
      const triageJson: any = record.triageJson || { summary: record.message };
      const utilityCheck: any = record.utilityAnomaly
        ? { status: "ok", anomalyFound: true, notes: record.utilityNotes }
        : { status: "ok", anomalyFound: false };
      const baseDraft = (record.aiDraft as any)?.draft || "";
      const wantsDraft = /(draft|tenant\s*reply|tenant\s*message|forward|send to tenant|ok to send|approve|push)/i.test(text || "");
      let tenantDraft: string | undefined;
      if (wantsDraft) {
        const landlordAssist = await agentService.advisorSuggest({
          instructions: text || "",
          baseDraft,
          triage: triageJson,
          tenantMessage: lastTenantMessage,
          conversationLog: augmentedLog,
          landlordReply: text,
        });
        llmInvoked = true;
        const analysis = (() => {
          if (typeof (landlordAssist as any)?.analysis === "string") return (landlordAssist as any).analysis.trim();
          if (typeof (landlordAssist as any)?.suggestion === "string") return (landlordAssist as any).suggestion.trim();
          return "";
        })();
        tenantDraft = (() => {
          if (typeof (landlordAssist as any)?.reply === "string") return (landlordAssist as any).reply.trim();
          if (typeof (landlordAssist as any)?.draft === "string") return (landlordAssist as any).draft.trim();
          if (typeof baseDraft === "string") return baseDraft.trim();
          return "";
        })();
        const labeledAiReply = `AI Assistance:\nAction: ${analysis || "No analysis"}\nTenant draft: ${tenantDraft || "No draft yet"}`;
        await whatsappService.sendWhatsAppText({ to: effectiveReplyTo, text: labeledAiReply, landlordId });
        await repo.appendChatMessage({
          id: record.id,
          role: "ai",
          content: labeledAiReply,
          meta: { channel: "whatsapp", assistant: true },
        });
        await repo.updateAiDraft({
          id: record.id,
          aiDraft: {
            ...(record.aiDraft as any),
            draft: tenantDraft || baseDraft,
            analysis,
            source: "advisor",
          },
        });
      } else {
        const landlordChat = await agentService.advisorSuggest({
          instructions: text || "",
          baseDraft: baseDraft || undefined,
          triage: triageJson,
          tenantMessage: lastTenantMessage,
          conversationLog: augmentedLog,
          landlordReply: text,
        });
        llmInvoked = true;
        const chatReplyRaw = (() => {
          if (typeof (landlordChat as any)?.reply === "string") return (landlordChat as any).reply.trim();
          if (typeof (landlordChat as any)?.analysis === "string") return (landlordChat as any).analysis.trim();
          if (typeof (landlordChat as any)?.suggestion === "string") return (landlordChat as any).suggestion.trim();
          return "I’m here. Ask anything about the issue, approvals, or next steps.";
        })();
        const chatReply = (() => {
          const raw = chatReplyRaw || "";
          if (/^\s*\{/.test(raw)) {
            try {
              const parsed = JSON.parse(raw);
              if (typeof parsed?.reply === "string" && parsed.reply.trim()) return parsed.reply.trim();
              if (typeof parsed?.analysis === "string" && parsed.analysis.trim()) return parsed.analysis.trim();
            } catch (_) {
              // fall through
            }
          }
          return raw || "I’m here. Ask anything about the issue, approvals, or next steps.";
        })();
        await whatsappService.sendWhatsAppText({ to: effectiveReplyTo, text: `AI Assistance: ${chatReply}`, landlordId });
        await repo.appendChatMessage({
          id: record.id,
          role: "ai",
          content: `AI Assistance: ${chatReply}`,
          meta: { channel: "whatsapp", assistant: true },
        });
      }

      // Approval / Deny path: landlord can forward or block the AI draft.
      const approved = /approve|approved|send it|ok to send/i.test(text || "");
      const denied = /deny|denied|reject|block/i.test(text || "");
      const forwardDraft = (tenantDraft || (record.aiDraft as any)?.draft || "").trim();
      if (approved && record.tenantId && forwardDraft) {
        const tenant = await repo.getTenantById(record.tenantId);
        if (tenant?.phone) {
          await whatsappService.sendWhatsAppText({ to: tenant.phone, text: forwardDraft, landlordId });
          await repo.appendChatMessage({
            id: record.id,
            role: "ai",
            content: forwardDraft,
            meta: { channel: "whatsapp", forwarded: true, approvedBy: sender },
          });
          await whatsappService.sendWhatsAppText({ to: effectiveReplyTo, text: "\u2705 Draft approved and sent to tenant.", landlordId });
        }
      } else if (denied && record.tenantId) {
        await repo.appendChatMessage({
          id: record.id,
          role: "landlord",
          content: "[DENIED] Landlord rejected the AI draft.",
          meta: { channel: "whatsapp", denied: true, deniedBy: sender },
        });
        await whatsappService.sendWhatsAppText({ to: effectiveReplyTo, text: "\u274c Draft denied. The auto-reply was NOT sent to the tenant.", landlordId });
      }
      return respond({ ok: true, routed: "landlord", llmInvoked, autoReplySent, autoReplyReason });
    }

    // Scope tenant lookup to THIS landlord's instance to prevent cross-tenant data leaks
    // For group messages, first try to resolve the participant from the unit's tenant list
    // (more reliable than phone matching since we already confirmed the group JID)
    let tenant: Awaited<ReturnType<typeof repo.findTenantByPhone>> = null;
    if (isGroup && groupUnit?.tenants?.length) {
      const senderDigits = sender.replace(/\D/g, "");
      for (const ut of groupUnit.tenants) {
        const t = (ut as any).tenant;
        if (!t?.phone) continue;
        const tDigits = t.phone.replace(/\D/g, "");
        // Match if sender digits end with tenant digits or vice versa (handles country code differences)
        if (senderDigits === tDigits || senderDigits.endsWith(tDigits) || tDigits.endsWith(senderDigits)) {
          tenant = t;
          // eslint-disable-next-line no-console
          console.info("group tenant resolved via unit tenant list", { tenantId: t.id, tenantName: t.name, sender });
          break;
        }
      }
      // If participant phone didn't match any tenant in the unit, pick the first tenant
      // (group messages from the unit group should always be routed to the unit's context)
      if (!tenant && groupUnit.tenants.length > 0) {
        tenant = (groupUnit.tenants[0] as any).tenant;
        // eslint-disable-next-line no-console
        console.info("group tenant fallback to first unit tenant", { tenantId: tenant?.id, tenantName: tenant?.name, sender });
      }
    }
    // Standard phone-based lookup for 1:1 chats or if group resolution failed
    if (!tenant) {
      tenant = await repo.findTenantByPhone(sender, landlordId || undefined);
    }
    if (!tenant) {
      const contractor = await repo.findContractorByPhone(sender);
      if (contractor) {
        const contractorLandlordId = (contractor as any).landlordId || "";
        const note = `Contractor ${contractor.name} (${contractor.phone}) says: ${inboundContent}`;
        if (contractorLandlordId) {
          await whatsappService.alertLandlord(contractorLandlordId, note);
        } else {
          for (const number of landlordNumbers()) {
            await whatsappService.sendWhatsAppText({ to: number, text: note });
          }
        }
        // eslint-disable-next-line no-console
        console.info("whatsapp routed contractor message", { sender, remoteJid, participant, isGroup });
        return respond({ ok: true, routed: "contractor", llmInvoked, autoReplySent, autoReplyReason });
      }
      // Notify landlord about unknown sender instead of silently ignoring
      // eslint-disable-next-line no-console
      console.warn("whatsapp unknown sender — notifying landlord", { sender, remoteJid, participant, isGroup });
      // Try to find which landlord this instance belongs to and alert them
      if (landlordId) {
        try {
          await db.notification.create({
            data: {
              landlordId,
              type: "info",
              title: "Message from unregistered number",
              body: `An unregistered number (${sender}) sent a message: "${(inboundContent || "").substring(0, 200)}". Register them as a tenant to enable AI responses.`,
              data: { phone: sender, message: (inboundContent || "").substring(0, 500) } as any,
            },
          });
        } catch (e) { console.warn("failed to create unknown-sender notification", e); }
      }
      return respond({ ok: true, ignored: "unknown_sender", llmInvoked, autoReplySent, autoReplyReason });
    }

    let record = await repo.findLatestMaintenanceForTenantId(tenant.id);
    const baseConversationLog = Array.isArray(record?.chatLog) ? (record?.chatLog as any[]) : [];
    // Instance-resolved landlordId takes priority to prevent cross-tenant routing
    const tenantLandlordId = landlordId || tenant.landlordId || "";

    // ── Plan limit check for tenant messages ──
    // Re-check against the tenant's landlord (may differ from initially resolved landlordId)
    if (!planLimitExceeded && tenantLandlordId) {
      const tLimit = await checkPlanLimit(tenantLandlordId, "messages");
      if (!tLimit.allowed) planLimitExceeded = true;
    }
    if (planLimitExceeded) {
      // Still log the message but skip all AI processing
      if (record?.id) {
        await repo.appendChatMessage({
          id: record.id,
          role: "tenant",
          content: inboundContent || "[media received]",
          meta: { channel: isGroup ? "whatsapp_group" : "whatsapp", sender, planLimited: true },
        });
      }
      await whatsappService.sendWhatsAppText({
        to: replyTo,
        text: "Your landlord\u2019s free plan AI limit has been reached for this month. Your message has been recorded and your landlord will be notified directly.",
        landlordId: tenantLandlordId,
      });
      // Alert landlord about the message even though AI is limited
      if (tenantLandlordId) {
        await whatsappService.alertLandlord(tenantLandlordId, `\u26a0\ufe0f Message from ${tenant.name} (${tenant.phone || sender}): "${(inboundContent || "").substring(0, 300)}"\n\nAI limit reached \u2014 upgrade to Pro for unlimited AI responses.`);
      }
      return respond({ ok: true, routed: "tenant_plan_limit", llmInvoked: false, autoReplySent: false });
    }

    // ── UNIFIED MEDIA PROCESSING ──
    // processMedia handles image vision, audio transcription, video analysis,
    // and document detection—all via Gemini multimodal capabilities.
    let mediaResult: ExtractedMedia | null = null;
    try {
      mediaResult = await processMedia(req.body, text, instanceName);
      if (mediaResult) {
        llmInvoked = true;
        // eslint-disable-next-line no-console
        console.info("media processed", {
          type: mediaResult.type,
          hasTranscription: Boolean(mediaResult.transcription),
          hasDescription: Boolean(mediaResult.description),
          sender,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("media processing failed, continuing with text only", err);
    }

    // Build the enriched message combining text + media analysis
    const enrichedMessage = buildMediaEnrichedMessage(text, mediaResult);
    const chatContent = enrichedMessage || "[media received]";
    const tenantMessage = enrichedMessage || text || "[media received]";
    const hasMedia = Boolean(mediaResult);
    const immediateUnitId = (isGroup && groupUnit?.id) ? groupUnit.id : await resolveTenantUnitId(tenant.id);
    const triage = await agentService.triageMaintenance({
      tenantMessage,
      tenantId: tenant.id,
      unitId: immediateUnitId,
    });
    llmInvoked = true;

    const delayMs = await computeDelayMs(
      tenant.id,
      (triage?.classification?.severity || "normal").toString().toLowerCase(),
      tenantMessage,
      tenantLandlordId
    );
    const isImmediate = delayMs <= 0;

    // Always log the inbound tenant message to the conversation.
    if (record?.id) {
      record = await repo.appendChatMessage({
        id: record.id,
        role: "tenant",
        content: chatContent,
        meta: {
          channel: isGroup ? "whatsapp_group" : "whatsapp",
          sender,
          media: hasMedia,
          mediaType: mediaResult?.type,
          mediaDescription: mediaResult?.description || mediaResult?.transcription,
        },
      });
    } else {
      record = await repo.createMaintenanceRequest({
        tenantId: tenant.id,
        unitId: immediateUnitId,
        landlordId: tenantLandlordId,
        message: inboundContent || tenantMessage,
        triage,
        autopilotEnabled: true,
      });
    }

    if (record?.id) {
      await repo.updateMaintenanceAnalysis({ id: record.id, triage });
    }

    if (!isImmediate) {
      queueTenantReply({
        tenantId: tenant.id,
        replyTo,
        isGroup,
        tenantMessage,
        media: hasMedia,
        delayMs,
        landlordId: tenantLandlordId,
        mediaResult,
      });
      autoReplyReason = "queued_delay";
      return respond({ ok: true, routed: "tenant_queued", delayMs, llmInvoked, autoReplySent, autoReplyReason });
    }

    const conversationLog = Array.isArray(record?.chatLog) ? (record?.chatLog as any[]) : [];

    // ── AGENTIC IMMEDIATE PATH ──
    if (AGENTIC_MODE && tenantLandlordId) {
      try {
        // Build multimodal parts for agent (raw base64 images/audio/video)
        const mediaParts = mediaResult?.base64
          ? [{ base64: mediaResult.base64, mimeType: mediaResult.mimeType }]
          : undefined;
        const mediaDescription = mediaResult
          ? (mediaResult.transcription
            ? `[Voice note]: "${mediaResult.transcription}"`
            : mediaResult.description
              ? `[${mediaResult.type} analysis]: ${mediaResult.description}`
              : `[${mediaResult.type} received]`)
          : undefined;

        const agentResult = await orchestrator.handleTenantMessage({
          tenantPhone: sender,
          message: tenantMessage,
          landlordId: tenantLandlordId,
          mediaDescription,
          mediaParts,
        });
        llmInvoked = true;

        let agentDraft = extractDraftReply(agentResult.finalAnswer || "");
        // If the agent returned an error (e.g. LLM 503), use a friendly fallback instead
        if (/^Agent error:/i.test(agentDraft) || /llm_unavailable|vertex_not_configured/i.test(agentDraft)) {
          console.warn("LLM unavailable for tenant reply, using fallback", { tenantId: tenant.id, raw: agentDraft.substring(0, 100) });
          agentDraft = "Thanks for your message! Our AI assistant is temporarily experiencing high demand. Your message has been logged and your landlord has been notified. We'll get back to you shortly.";
        }

        // Retry once if the draft is empty or invalid
        if (!isValidTenantDraft(agentDraft)) {
          console.warn("invalid draft from agent (agentic immediate), retrying once", { tenantId: tenant.id, raw: (agentDraft || "").substring(0, 80) });
          try {
            const retryResult = await orchestrator.handleTenantMessage({
              tenantPhone: sender,
              message: tenantMessage,
              landlordId: tenantLandlordId,
              mediaDescription,
              mediaParts,
            });
            const retryDraft = extractDraftReply(retryResult.finalAnswer || "");
            if (isValidTenantDraft(retryDraft)) {
              agentDraft = retryDraft;
              console.info("retry succeeded (agentic immediate)", { tenantId: tenant.id });
            } else {
              console.warn("retry also produced invalid draft — suppressing reply", { tenantId: tenant.id });
              agentDraft = "";
            }
          } catch (retryErr) {
            console.warn("retry failed (agentic immediate)", { error: (retryErr as Error).message });
            agentDraft = "";
          }
        }

        const globalAutoReply = await repo.getGlobalAutoReplyEnabled(tenantLandlordId);
        const canAutoReply = globalAutoReply.enabled && tenant.autoReplyEnabled !== false;
        const agentSeverity = (triage?.classification?.severity || "normal").toString().toLowerCase();
        const isHighCriticalImm = agentSeverity === "high" || agentSeverity === "critical";

        if (agentDraft && canAutoReply && !isHighCriticalImm) {
          const sendResult = await whatsappService.sendWhatsAppText({ to: replyTo, text: agentDraft, landlordId: tenantLandlordId });
          if (!sendResult.ok) {
            // eslint-disable-next-line no-console
            console.error("auto-reply send FAILED (agentic immediate)", { tenantId: tenant.id, replyTo, error: sendResult.error, response: sendResult.response });
            autoReplyReason = "send_failed";
          } else {
            lastReplySentAt.set(tenant.id, Date.now());
            autoReplySent = true;
            autoReplyReason = "agentic_draft_sent";
          }
        } else if (isHighCriticalImm && agentDraft) {
          // HIGH/CRITICAL: Hold the auto-reply for landlord approval
          // eslint-disable-next-line no-console
          console.info("auto-reply HELD for landlord approval (agentic immediate)", { tenantId: tenant.id, severity: agentSeverity });
          // Store the draft so approve/deny can forward it
          if (record?.id) {
            await repo.updateMaintenanceAnalysis({ id: record.id, aiDraft: { draft: agentDraft } as any });
          }
          autoReplyReason = "held_for_approval";
        } else if (!canAutoReply) {
          autoReplyReason = "auto_reply_disabled";
        } else {
          autoReplyReason = "no_agentic_draft";
        }

        // eslint-disable-next-line no-console
        console.info("agentic immediate reply", {
          tenantId: tenant.id,
          toolCalls: agentResult.toolCallCount,
          steps: agentResult.steps.length,
          autoReplySent,
          severity: agentSeverity,
          heldForApproval: isHighCriticalImm,
        });

        // Notify landlord about tenant message (agentic path)
        const agentAlert = buildLandlordAlert({
          tenantName: tenant.name,
          tenantPhone: tenant.phone || sender,
          message: tenantMessage,
          severity: agentSeverity,
          draft: agentDraft || "(agent handled)",
          isNewTicket: !record,
        });
        if (tenantLandlordId) {
          await whatsappService.alertLandlord(tenantLandlordId, agentAlert, {
            type: agentSeverity === "high" || agentSeverity === "critical" ? "APPROVAL_REQUEST" : "MAINTENANCE_NEW",
            maintenanceId: record?.id,
            tenantPhone: tenant.phone || sender,
            severity: agentSeverity,
          });
        }

        return respond({ ok: true, routed: "tenant_agentic", llmInvoked, autoReplySent, autoReplyReason });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("agentic immediate failed, falling back to linear", err);
        // Fall through to linear path
      }
    }

    // ── LINEAR IMMEDIATE PATH (original) ──
    const utilityCheck = await agentService.checkUtilityAnomaly({ tenantId: tenant.id, unitId: immediateUnitId });

    const draftResponse = await agentService.draftRtaResponse({
      tenantMessage,
      triage,
      utilityCheck,
      conversationLog,
      landlordReply: record?.landlordReply,
    });
    llmInvoked = true;

    if (record?.id) {
      await repo.updateMaintenanceAnalysis({ id: record.id, triage, aiDraft: draftResponse });
      await repo.updateMaintenanceUtility({ maintenanceId: record.id, utilityCheck });
    }

    const globalAutoReply = await repo.getGlobalAutoReplyEnabled(tenantLandlordId);
    const canAutoReply = globalAutoReply.enabled && tenant.autoReplyEnabled !== false;
    let draftText = (draftResponse?.draft || "").trim();
    // Validate draft with the same rules as agentic paths
    if (!isValidTenantDraft(draftText)) {
      draftText = "";
      console.warn("Invalid/empty draft from linear immediate — suppressing reply", { tenantId: tenant.id });
    }

    const linearImmSeverity = (triage?.classification?.severity || "normal").toString().toLowerCase();
    const isHighCriticalLinearImm = linearImmSeverity === "high" || linearImmSeverity === "critical";

    if (draftText && canAutoReply && !isHighCriticalLinearImm) {
      const sendResult = await whatsappService.sendWhatsAppText({
        to: replyTo,
        text: draftText,
        landlordId: tenantLandlordId,
      });
      if (!sendResult.ok) {
        // eslint-disable-next-line no-console
        console.error("auto-reply send FAILED (linear immediate)", { tenantId: tenant.id, replyTo, error: sendResult.error, response: sendResult.response });
        autoReplyReason = "send_failed";
      } else {
        lastReplySentAt.set(tenant.id, Date.now());
        autoReplySent = true;
        autoReplyReason = "draft_sent";
      }
    } else if (isHighCriticalLinearImm && draftText) {
      // HIGH/CRITICAL: Hold the auto-reply for landlord approval
      console.info("auto-reply HELD for landlord approval (linear immediate)", { tenantId: tenant.id, severity: linearImmSeverity });
      if (record?.id) {
        await repo.updateMaintenanceAnalysis({ id: record.id, aiDraft: { draft: draftText } as any });
      }
      autoReplyReason = "held_for_approval";
    } else if (draftText && !canAutoReply) {
      // eslint-disable-next-line no-console
      console.info("auto-reply disabled for tenant", { tenantId: tenant.id });
      autoReplyReason = "auto_reply_disabled";
    } else if (!draftText) {
      // eslint-disable-next-line no-console
      console.warn("auto-reply skipped: AI returned empty draft (immediate)", { tenantId: tenant.id });
      autoReplyReason = "no_draft";
    }

    const triageJson: any = record?.triageJson || triage || {};
    const aiDraft: any = record?.aiDraft || draftResponse || {};
    const immSeverity = (triageJson?.classification?.severity || "normal").toString().toLowerCase();
    const draft = aiDraft?.draft || "(no draft yet)";
    const immAlert = buildLandlordAlert({
      tenantName: tenant.name,
      tenantPhone: tenant.phone || sender,
      message: tenantMessage,
      severity: immSeverity,
      draft,
      isNewTicket: !record || record.id === (await repo.findLatestMaintenanceForTenantId(tenant.id))?.id,
    });
    if (tenantLandlordId) {
      await whatsappService.alertLandlord(tenantLandlordId, immAlert, {
        type: immSeverity === "high" || immSeverity === "critical" ? "APPROVAL_REQUEST" : "MAINTENANCE_NEW",
        maintenanceId: record?.id,
        tenantPhone: tenant.phone || sender,
        severity: immSeverity,
      });
    } else {
      for (const number of landlordNumbers()) {
        await whatsappService.sendWhatsAppText({ to: number, text: immAlert });
      }
    }

    return respond({ ok: true, routed: "tenant", llmInvoked, autoReplySent, autoReplyReason });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("whatsapp webhook failed", err);
    return res.status(500).json({ error: "whatsapp_webhook_failed", detail: (err as Error).message });
  }
};

router.post("/whatsapp", evolutionWebhookHandler);
router.post("/whatsapp/evolution", evolutionWebhookHandler);

// GET handler for Evolution API webhook verification / health checks
router.get("/whatsapp", (_req, res) => res.json({ status: "ok" }));
router.get("/whatsapp/evolution", (_req, res) => res.json({ status: "ok" }));

export default router;
