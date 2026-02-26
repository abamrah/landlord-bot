import fs from "fs";
import path from "path";
import os from "os";
import { vertexAI, defaultModel } from "../config/gemini";
import { getProfile } from "../config/rtaProfiles";

type TriageResult = {
  summary: string;
  classification: {
    severity: "critical" | "high" | "normal" | "low";
    category: string;
    urgencyHours: number;
  };
  investigationQuestions: string[];
  selfResolutionSteps: string[];
  recommendedActions: string[];
  dataRequests: string[];
  rawModelText?: string;
};

type UtilityCheckResult = {
  usedSkill: boolean;
  status: "ok" | "pending" | "error";
  anomalyFound: boolean;
  notes: string;
  mcpRequest?: unknown;
  mcpResponse?: unknown;
  bills?: Array<{
    utilityType?: string;
    amountCents?: number;
    currency?: string;
    tenantShareCents?: number;
    landlordShareCents?: number;
    billingPeriodStart?: string;
    billingPeriodEnd?: string;
    screenshotUrl?: string;
    downloadedPdfUrl?: string;
    anomalyFlag?: boolean;
    anomalyNotes?: string;
  }>;
  error?: string;
};

type DraftResult = {
  draft: string;
  skillLoaded: boolean;
  generatedAt: string;
  source: "initial" | "refine";
  instructions?: string;
  baseDraftExcerpt?: string;
  notes?: string;
};

type ConversationEntry = {
  role?: string;
  content?: string;
  createdAt?: string;
};

function formatConversationLog(entries?: ConversationEntry[] | null, limit = 10) {
  if (!Array.isArray(entries) || !entries.length) return "";
  return entries
    .slice(-limit)
    .map((entry) => {
      const who = (entry.role || "unknown").toUpperCase();
      const when = entry.createdAt ? new Date(entry.createdAt).toISOString() : "(time unknown)";
      const text = entry.content || "(no content)";
      return `${when} | ${who}: ${text}`;
    })
    .join("\n");
}

const skillDir = path.join(process.cwd(), ".github", "skills");
const rtaSkillPath = path.join(skillDir, "rta-compliance", "SKILL.md");
const billingSkillPath = path.join(skillDir, "utility-billing", "SKILL.md");
const soulDir = path.join(process.cwd(), ".github", "souls");
const tenantSoulPath = path.join(soulDir, "tenant-replies.md");
const landlordSoulPath = path.join(soulDir, "landlord-assistant.md");

let cachedRtaSkill = "";
let cachedBillingSkill = "";
let cachedTenantSoul = "";
let cachedLandlordSoul = "";

function readSkill(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`Skill file missing: ${filePath}`);
    return "";
  }
}

function readSoul(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`Soul file missing: ${filePath}`);
    return "";
  }
}

function loadSkills() {
  if (!cachedRtaSkill) cachedRtaSkill = readSkill(rtaSkillPath);
  if (!cachedBillingSkill) cachedBillingSkill = readSkill(billingSkillPath);
  return { rtaSkill: cachedRtaSkill, billingSkill: cachedBillingSkill };
}

function loadSouls() {
  if (!cachedTenantSoul) cachedTenantSoul = readSoul(tenantSoulPath);
  if (!cachedLandlordSoul) cachedLandlordSoul = readSoul(landlordSoulPath);
  return { tenantSoul: cachedTenantSoul, landlordSoul: cachedLandlordSoul };
}

const modelAvailable = () => Boolean(vertexAI);

type UtilityCredential = {
  type: string;
  username?: string;
  password?: string;
  loginUrl?: string;
};

function loadUtilityCredentials(): UtilityCredential[] {
  const creds: UtilityCredential[] = [
    {
      type: "internet",
      username: process.env.UTILITY_INTERNET_USER,
      password: process.env.UTILITY_INTERNET_PASS,
      loginUrl: process.env.UTILITY_INTERNET_URL,
    },
    {
      type: "water_gas",
      username: process.env.UTILITY_WATER_GAS_USER,
      password: process.env.UTILITY_WATER_GAS_PASS,
      loginUrl: process.env.UTILITY_WATER_GAS_URL,
    },
    {
      type: "hydro",
      username: process.env.UTILITY_HYDRO_USER,
      password: process.env.UTILITY_HYDRO_PASS,
      loginUrl: process.env.UTILITY_HYDRO_URL,
    },
  ];

  return creds.filter((c) => c.username && c.password);
}

const tenantShareFraction = (() => {
  const raw = process.env.UTILITY_TENANT_SHARE;
  const parsed = raw ? Number(raw) : 0.6;
  if (Number.isNaN(parsed) || parsed <= 0 || parsed >= 1) return 0.6;
  return parsed;
})();

function ensureModel() {
  if (!vertexAI) {
    return null;
  }
  return vertexAI.getGenerativeModel({ model: defaultModel });
}

function delayMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryLlm(err: unknown) {
  const anyErr = err as { status?: number; statusText?: string; message?: string };
  const status = anyErr?.status;
  if (status === 429 || status === 503) return true;
  const message = `${anyErr?.statusText || ""} ${anyErr?.message || ""}`.toLowerCase();
  return message.includes("429") || message.includes("503") || message.includes("high demand");
}

function isLlmFallback(text: string) {
  return text === "llm_unavailable" || text === "vertex_not_configured";
}

export async function pingLlm() {
  const model = ensureModel();
  if (!model) return false;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await model.generateContent({
        contents: [
          {
            role: "user",
            parts: [{ text: "ping" }],
          },
        ],
      });
      const parts = result.response?.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => (p as { text?: string }).text || "").join("");
      return Boolean(text.trim());
    } catch (err) {
      if (attempt >= maxAttempts || !shouldRetryLlm(err)) {
        // eslint-disable-next-line no-console
        console.warn("LLM ping failed", err);
        return false;
      }
      const backoff = 600 * Math.pow(2, attempt - 1);
      // eslint-disable-next-line no-console
      console.log(`LLM ping attempt ${attempt} failed (503/429), retrying in ${backoff}ms…`);
      await delayMs(backoff);
    }
  }
  return false;
}

async function runGemini(prompt: string) {
  const model = ensureModel();
  if (!model) {
    return "vertex_not_configured";
  }
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await model.generateContent({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
      });
      const parts = result.response?.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => (p as { text?: string }).text || "").join("");
      return text.trim();
    } catch (err) {
      if (attempt >= maxAttempts || !shouldRetryLlm(err)) {
        // eslint-disable-next-line no-console
        console.warn("LLM request failed", err);
        return "llm_unavailable";
      }
      const backoff = 600 * Math.pow(2, attempt - 1);
      await delayMs(backoff);
    }
  }
  return "llm_unavailable";
}

async function runGeminiVision(prompt: string, image: { base64: string; mimeType: string }) {
  const model = ensureModel();
  if (!model) {
    return "vertex_not_configured";
  }

  // For PDFs, use the File API instead of inlineData to avoid "document has no pages"
  let mediaPart: any;
  if (image.mimeType === "application/pdf") {
    try {
      mediaPart = await uploadPdfForVision(image.base64);
    } catch {
      // Fall back to inlineData if File API fails
      mediaPart = { inlineData: { data: image.base64, mimeType: image.mimeType } };
    }
  } else {
    mediaPart = { inlineData: { data: image.base64, mimeType: image.mimeType } };
  }

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await model.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              mediaPart,
            ],
          },
        ],
      });
      const parts = result.response?.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => (p as { text?: string }).text || "").join("");
      return text.trim();
    } catch (err) {
      if (attempt >= maxAttempts || !shouldRetryLlm(err)) {
        // eslint-disable-next-line no-console
        console.warn("LLM vision request failed", err);
        return "llm_unavailable";
      }
      const backoff = 600 * Math.pow(2, attempt - 1);
      await delayMs(backoff);
    }
  }
  return "llm_unavailable";
}

/** Upload a PDF to the Google AI File API and return a fileData part */
async function uploadPdfForVision(base64: string): Promise<any> {
  const apiKey =
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GENERATIVE_AI_API_KEY ||
    "";
  if (!apiKey) throw new Error("No Google API key");

  const { GoogleAIFileManager } = require("@google/generative-ai/server");
  const fileManager = new GoogleAIFileManager(apiKey);

  const tmpFile = path.join(os.tmpdir(), `vision-pdf-${Date.now()}.pdf`);
  fs.writeFileSync(tmpFile, Buffer.from(base64, "base64"));

  try {
    const uploadResult = await fileManager.uploadFile(tmpFile, {
      mimeType: "application/pdf",
      displayName: `vision-upload-${Date.now()}.pdf`,
    });
    return {
      fileData: {
        mimeType: uploadResult.file.mimeType,
        fileUri: uploadResult.file.uri,
      },
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

function safeParseJSON(text: string) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

export async function triageMaintenance(params: {
  tenantMessage?: string;
  tenantId?: string;
  unitId?: string;
  province?: string;
}): Promise<TriageResult> {
  const { rtaSkill, billingSkill } = loadSkills();
  const tenantMessage = params.tenantMessage || "";
  const rtaProfile = getProfile(params.province || "ON");

  if (!modelAvailable()) {
    return {
      summary: tenantMessage,
      classification: { severity: "normal", category: "general", urgencyHours: 72 },
      investigationQuestions: [],
      selfResolutionSteps: [],
      recommendedActions: ["Manual review"],
      dataRequests: [],
      rawModelText: "vertex_not_configured",
    };
  }

  const prompt = [
    "You are a landlord maintenance triage agent. Return JSON only.",
    `Jurisdiction: ${rtaProfile.name} — ${rtaProfile.legislation}`,
    rtaProfile.promptAddendum,
    "Your job is to THOROUGHLY analyze a tenant's message and classify severity accurately.",
    "",
    "═══ SEVERITY CLASSIFICATION GUIDELINES — READ CAREFULLY ═══",
    "",
    "CRITICAL (urgencyHours: 0-4) — Immediate life/safety hazard:",
    "• Fire, gas leak, carbon monoxide alarm, or smell of gas",
    "• Flooding or sewage backup inside the unit",
    "• No heat when outdoor temperature is below 0°C / 32°F",
    "• Complete loss of electricity with no known outage",
    "• Structural collapse or severe structural damage",
    "• No running water at all",
    "• Electrical sparking, exposed wiring, burning smell from outlets",
    "• Security breach: broken exterior door, broken lock, break-in damage",
    "• Elevator entrapment (multi-unit buildings)",
    "",
    "HIGH (urgencyHours: 4-24) — Major habitability impact:",
    "• No hot water (but cold water works)",
    "• Significant water leak (ceiling dripping, pipe burst but contained)",
    "• Broken fridge/freezer (food spoilage risk)",
    "• Broken stove/oven (no way to cook)",
    "• Toilet not flushing (only toilet in unit)",
    "• Pest infestation (cockroaches, bedbugs, rodents)",
    "• Visible mold growth (health concern)",
    "• Broken window (security or weather exposure)",
    "• HVAC failure during extreme heat (above 35°C / 95°F)",
    "• Washing machine leaking actively",
    "",
    "NORMAL (urgencyHours: 24-72) — Standard maintenance:",
    "• Appliance malfunction (dishwasher, dryer, microwave — not urgent)",
    "• Minor plumbing leak (slow drip under sink, running toilet)",
    "• HVAC not optimal (works but not well, strange noise)",
    "• Light fixtures not working (not a safety hazard)",
    "• Door/window sticking or hard to open",
    "• Garbage disposal jammed",
    "• Shower/bathtub drain slow",
    "• Thermostat issues (not total failure)",
    "• Intercom/buzzer not working",
    "",
    "LOW (urgencyHours: 72-168) — Cosmetic / non-urgent:",
    "• Paint peeling, wall scuffs, minor cosmetic damage",
    "• Squeaky door, loose cabinet handle",
    "• Light bulb replacement in non-essential area",
    "• Landscaping, exterior cosmetic issues",
    "• Screen door damage",
    "• Caulking needs refresh",
    "• Minor carpet stain or wear",
    "• Mailbox issues",
    "",
    "═══ INVESTIGATION — CRITICAL ═══",
    "Before assigning severity, consider:",
    "• Is the tenant's description vague? If so, list questions to ask (in investigationQuestions).",
    "• Could the tenant resolve this themselves? If so, list steps (in selfResolutionSteps).",
    "• Is there a pattern (e.g., recurring leak)? Note it in the summary.",
    "• Does the message mention a specific product/model? Note it — the agent will search for manuals.",
    "",
    "═══ OUTPUT FORMAT (JSON) ═══",
    "{",
    '  "summary": "Short factual summary of the issue",',
    '  "classification": {',
    '    "severity": "critical|high|normal|low",',
    '    "category": "plumbing|electrical|hvac|appliance|structural|pest|security|general|cosmetic",',
    '    "urgencyHours": <number>',
    '  },',
    '  "investigationQuestions": ["Question 1 to ask tenant", "Question 2..."],',
    '  "selfResolutionSteps": ["Step the tenant can try themselves", "Step 2..."],',
    '  "recommendedActions": ["Action for landlord/agent"],',
    '  "dataRequests": ["Any additional info needed"]',
    "}",
    "",
    "IMPORTANT: Do NOT default to 'normal'. Carefully match against the severity criteria above.",
    "If the message is clearly about safety or habitability, it MUST be high or critical.",
    "If the message is vague, classify based on worst reasonable interpretation and add investigationQuestions.",
    "",
    "--- RTA SKILL ---",
    rtaSkill,
    "--- UTILITY BILLING SKILL ---",
    billingSkill,
    "--- TENANT MESSAGE ---",
    tenantMessage,
  ].join("\n");

  const text = await runGemini(prompt);
  if (isLlmFallback(text)) {
    return {
      summary: tenantMessage,
      classification: { severity: "normal", category: "general", urgencyHours: 72 },
      investigationQuestions: [],
      selfResolutionSteps: [],
      recommendedActions: ["Manual review"],
      dataRequests: [],
      rawModelText: text,
    };
  }

  const parsed = safeParseJSON(text);

  if (parsed) {
    return {
      summary: parsed.summary || tenantMessage,
      classification: parsed.classification || { severity: "normal", category: "general", urgencyHours: 72 },
      investigationQuestions: parsed.investigationQuestions || [],
      selfResolutionSteps: parsed.selfResolutionSteps || [],
      recommendedActions: parsed.recommendedActions || [],
      dataRequests: parsed.dataRequests || [],
      rawModelText: text,
    };
  }

  return {
    summary: tenantMessage,
    classification: { severity: "normal", category: "general", urgencyHours: 72 },
    investigationQuestions: [],
    selfResolutionSteps: [],
    recommendedActions: ["Manual review"],
    dataRequests: [],
    rawModelText: text,
  };
}

async function callMcpBrowser(task: Record<string, unknown>) {
  const server = process.env.MCP_BROWSER_SERVER || "http://localhost:5173";
  const path = process.env.MCP_BROWSER_TASK_PATH || "/tasks";
  const url = `${server}${path}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    });
    if (!response.ok) {
      return { error: `MCP browser responded ${response.status}` };
    }
    const data = await response.json();
    return { data };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function checkUtilityAnomaly(params: { tenantId?: string; unitId?: string }): Promise<UtilityCheckResult> {
  const { billingSkill } = loadSkills();
  const credentials = loadUtilityCredentials();
  const task = {
    action: "utility-bill-scan",
    guidance: billingSkill,
    tenantId: params.tenantId,
    unitId: params.unitId,
    utilities: credentials,
    needScreenshots: true,
    needPdf: true,
    maxStatements: 3,
    runAfterDayOfMonth: 18,
    headless: true,
    taskId: `util-${Date.now()}`,
  };

  const mcpResult = await callMcpBrowser(task);

  if (mcpResult.error) {
    return {
      usedSkill: Boolean(billingSkill),
      status: "pending",
      anomalyFound: false,
      notes: "Browser task not completed; manual follow-up needed.",
      // Avoid echoing passwords; only include utility types and usernames for traceability
      mcpRequest: {
        ...task,
        utilities: credentials.map((c) => ({ type: c.type, username: c.username })),
      },
      error: mcpResult.error,
    };
  }

  const payload = mcpResult.data as {
    anomalyFound?: boolean;
    notes?: string;
    bills?: Array<{
      utilityType?: string;
      amountCents?: number;
      currency?: string;
      billingPeriodStart?: string;
      billingPeriodEnd?: string;
      screenshotUrl?: string;
      downloadedPdfUrl?: string;
      anomalyFlag?: boolean;
      anomalyNotes?: string;
    }>;
  };

  const enrichedBills = (payload?.bills || []).map((bill) => {
    const amount = bill.amountCents ?? 0;
    const tenantShare = Math.round(amount * tenantShareFraction);
    const landlordShare = amount - tenantShare;
    return {
      ...bill,
      tenantShareCents: tenantShare,
      landlordShareCents: landlordShare,
    };
  });

  return {
    usedSkill: Boolean(billingSkill),
    status: "ok",
    anomalyFound: Boolean(payload?.anomalyFound),
    notes: payload?.notes || "Utility check completed via MCP browser.",
    mcpRequest: {
      ...task,
      utilities: credentials.map((c) => ({ type: c.type, username: c.username, loginUrl: c.loginUrl })),
    },
    mcpResponse: payload,
    bills: enrichedBills,
  };
}

export async function draftRtaResponse(params: {
  tenantMessage?: string;
  triage: TriageResult;
  utilityCheck: UtilityCheckResult;
  conversationLog?: ConversationEntry[] | null;
  landlordReply?: string | null;
  province?: string;
}): Promise<DraftResult> {
  const { rtaSkill } = loadSkills();
  const { tenantSoul } = loadSouls();
  const rtaProfile = getProfile(params.province || "ON");

  const basePayload = {
    skillLoaded: Boolean(rtaSkill),
    generatedAt: new Date().toISOString(),
  } as const;

  if (!modelAvailable()) {
    return {
      draft: "Vertex AI not configured. Set GOOGLE_PROJECT_ID/LOCATION to enable drafting.",
      ...basePayload,
      source: "initial",
      notes: "vertex_not_configured",
    };
  }

  const conversationBlock = formatConversationLog(params.conversationLog);
  const landlordPosition = (params.landlordReply || "").trim();

  const prompt = [
    "You are the landlord-side assistant. Draft a casual, legally-aware reply for the tenant.",
    `Jurisdiction: ${rtaProfile.name} — ${rtaProfile.legislation}`,
    rtaProfile.promptAddendum,
    "Keep it short and conversational. 2-4 sentences, max 70 words. No headings, bullet points, or signatures.",
    "Confirm you've seen the message, summarize the situation, outline the next concrete step with timing, and stay neutral about fault.",
    "Blend any recommended actions or information requests into normal sentences instead of labeled lists.",
    tenantSoul ? "--- TENANT SOUL ---\n" + tenantSoul : "",
    "Reference prior tenant or landlord notes so it feels like part of the ongoing chat, and only mention tenancy law if it truly helps.",
    "Do not send notices automatically; this is a draft for landlord approval.",
    "",
    "═══ CRITICAL — NO EMPTY PROMISES ═══",
    "NEVER promise to do something you cannot actually do in this response. Examples of what NOT to say:",
    "- 'I'll find the user manual and send it to you in an hour'",
    "- 'I'll look into this and get back to you with instructions'",
    "- 'I'll send you a link to the manual shortly'",
    "Instead, provide IMMEDIATE VALUE from your existing knowledge:",
    "- Share general troubleshooting steps you already know (reset procedures, common fixes)",
    "- Suggest the tenant check manufacturer website for their specific model",
    "- Give practical next steps like 'try resetting the thermostat by switching it off and on at the breaker'",
    "- If you recognize the product model, share what you know about common issues with it",
    "Be helpful NOW — don't defer help to a future action you can't take.",
    "",
    "--- RTA SKILL ---",
    rtaSkill,
    "--- TRIAGE ---",
    JSON.stringify(params.triage, null, 2),
    "--- UTILITY CHECK ---",
    JSON.stringify(params.utilityCheck, null, 2),
    conversationBlock ? "--- CONVERSATION CONTEXT ---\n" + conversationBlock : "",
    landlordPosition ? "--- LAST LANDLORD POSITION ---\n" + landlordPosition : "",
    "--- TENANT MESSAGE ---",
    params.tenantMessage || "",
  ].join("\n\n");

  const draft = await runGemini(prompt);

  if (isLlmFallback(draft)) {
    return {
      draft: "LLM temporarily unavailable. Please try again in a few minutes.",
      ...basePayload,
      source: "initial",
      notes: draft,
    };
  }

  return {
    draft,
    ...basePayload,
    source: "initial",
  };
}

type RefineDraftParams = {
  instructions: string;
  baseDraft?: string | null;
  triage?: TriageResult | null;
  tenantMessage?: string;
  conversationLog?: ConversationEntry[] | null;
  landlordReply?: string | null;
  province?: string;
};

export async function refineDraft(params: RefineDraftParams): Promise<DraftResult> {
  const { rtaSkill } = loadSkills();
  const { tenantSoul } = loadSouls();
  const trimmedInstructions = (params.instructions || "").trim();
  const baseDraft = (params.baseDraft || "").trim();
  const basePayload = {
    skillLoaded: Boolean(rtaSkill),
    generatedAt: new Date().toISOString(),
  } as const;

  if (!trimmedInstructions) {
    return {
      draft: baseDraft || "No instructions provided.",
      ...basePayload,
      source: "refine",
      notes: "missing_instructions",
    };
  }

  if (!baseDraft) {
    return {
      draft: "No existing draft to refine. Generate an initial draft first.",
      ...basePayload,
      source: "refine",
      instructions: trimmedInstructions,
      notes: "missing_base_draft",
    };
  }

  if (!modelAvailable()) {
    return {
      draft: baseDraft,
      ...basePayload,
      source: "refine",
      instructions: trimmedInstructions,
      notes: "vertex_not_configured",
    };
  }

  const conversationBlock = formatConversationLog(params.conversationLog, 12);
  const landlordPosition = (params.landlordReply || "").trim();

  const prompt = [
    "You are the landlord's assistant. Rewrite the draft per the landlord's instructions with an easygoing, human tone.",
    "Keep it short and conversational. 2-4 sentences, max 70 words. No headings, bullet points, or signatures.",
    "Work the triage next steps and any missing info into the prose instead of lists, and keep liability-neutral.",
    `Use conversation history to keep continuity and only mention ${params.province ? getProfile(params.province).legislation : "tenancy law"} if it genuinely supports the point.`,
    tenantSoul ? "--- TENANT SOUL ---\n" + tenantSoul : "",
    "--- TRIAGE ---",
    JSON.stringify(params.triage || {}, null, 2),
    "--- TENANT MESSAGE ---",
    params.tenantMessage || "",
    conversationBlock ? "--- CONVERSATION CONTEXT ---\n" + conversationBlock : "",
    landlordPosition ? "--- LAST LANDLORD POSITION ---\n" + landlordPosition : "",
    "--- CURRENT DRAFT ---",
    baseDraft,
    "--- LANDLORD INSTRUCTIONS ---",
    trimmedInstructions,
  ]
    .filter(Boolean)
    .join("\n\n");

  const refined = await runGemini(prompt);

  if (isLlmFallback(refined)) {
    return {
      draft: baseDraft || "LLM temporarily unavailable. Please try again later.",
      ...basePayload,
      source: "refine",
      instructions: trimmedInstructions,
      baseDraftExcerpt: baseDraft.slice(0, 160),
      notes: refined,
    };
  }

  return {
    draft: refined || baseDraft,
    ...basePayload,
    source: "refine",
    instructions: trimmedInstructions,
    baseDraftExcerpt: baseDraft.slice(0, 160),
  };
}

type AdvisorSuggestionParams = {
  instructions: string;
  baseDraft?: string | null;
  triage?: TriageResult | null;
  tenantMessage?: string;
  conversationLog?: ConversationEntry[] | null;
  landlordReply?: string | null;
  province?: string;
};

type ReminderMessageParams = {
  type: "rent" | "utility";
  style: "short" | "medium" | "professional" | "casual";
  dueLabel?: string;
};

export async function advisorSuggest(params: AdvisorSuggestionParams) {
  const { rtaSkill } = loadSkills();
  const { landlordSoul } = loadSouls();
  const trimmedInstructions = (params.instructions || "").trim();
  const baseDraft = (params.baseDraft || params.landlordReply || "").trim();
  const basePayload = {
    skillLoaded: Boolean(rtaSkill),
    generatedAt: new Date().toISOString(),
  } as const;

  if (!trimmedInstructions) {
    return {
      suggestion: "Add a note for the assistant first.",
      ...basePayload,
      notes: "missing_instructions",
    };
  }

  if (!modelAvailable()) {
    return {
      suggestion: "Vertex AI not configured. Set GOOGLE_PROJECT_ID/LOCATION to enable advisor chats.",
      ...basePayload,
      notes: "vertex_not_configured",
    };
  }

  const conversationBlock = formatConversationLog(params.conversationLog, 12);
  const prompt = [
    "You are the landlord's assistant coach.",
    "Reply with a short, conversational response only. Do not use JSON.",
    "2-3 sentences, max 60 words. No headings, bullet points, or sign-offs.",
    `Keep it casual and practical, weaving in ${params.province ? getProfile(params.province).legislation : "tenancy law"} only when essential.`,
    landlordSoul ? "--- LANDLORD SOUL ---\n" + landlordSoul : "",
    params.triage ? "--- TRIAGE ---\n" + JSON.stringify(params.triage, null, 2) : "",
    params.tenantMessage ? "--- TENANT MESSAGE ---\n" + params.tenantMessage : "",
    conversationBlock ? "--- CONVERSATION CONTEXT ---\n" + conversationBlock : "",
    baseDraft ? "--- CURRENT DRAFT ---\n" + baseDraft : "",
    "--- LANDLORD REQUEST ---",
    trimmedInstructions,
  ]
    .filter(Boolean)
    .join("\n\n");

  const suggestionRaw = await runGemini(prompt);
  if (isLlmFallback(suggestionRaw)) {
    return {
      suggestion: "LLM temporarily unavailable. Try again in a few minutes.",
      analysis: "LLM temporarily unavailable. Try again in a few minutes.",
      reply: baseDraft,
      rawModelText: suggestionRaw,
      ...basePayload,
      notes: suggestionRaw,
    };
  }
  const cleanReply = (suggestionRaw || "").trim();
  const fallbackAnalysis = cleanReply || "Couldn't come up with a fresh angle—try rephrasing your ask.";

  return {
    suggestion: fallbackAnalysis,
    analysis: fallbackAnalysis,
    reply: cleanReply,
    rawModelText: suggestionRaw,
    ...basePayload,
  };
}

export async function summarizeImage(params: { base64: string; mimeType?: string; prompt?: string }): Promise<string> {
  const prompt =
    (params.prompt || "").trim() ||
    "Describe what you see in the image that matters for property maintenance. Keep it short and factual.";
  const mimeType = params.mimeType || "image/jpeg";
  const text = await runGeminiVision(prompt, { base64: params.base64, mimeType });
  if (isLlmFallback(text)) return "";
  return text;
}

export async function generateReminderMessage(params: ReminderMessageParams) {
  const style = params.style || "short";
  const type = params.type || "rent";
  const dueLabel = params.dueLabel || "today";
  if (!modelAvailable()) {
    return { text: "", notes: "vertex_not_configured" };
  }

  const prompt = [
    "You are a landlord assistant sending payment reminders to tenants.",
    "Reply with a single short message only. No headings, bullet points, or sign-offs.",
    "Keep it polite and practical. One or two sentences max.",
    `Tone: ${style}.`,
    `Topic: ${type} payment due ${dueLabel}.`,
  ].join("\n");

  const text = await runGemini(prompt);
  if (isLlmFallback(text)) {
    return { text: "", notes: text };
  }
  return { text: text.trim(), notes: "ok" };
}

export default {
  triageMaintenance,
  checkUtilityAnomaly,
  draftRtaResponse,
  refineDraft,
  advisorSuggest,
  summarizeImage,
  generateReminderMessage,
  pingLlm,
};
