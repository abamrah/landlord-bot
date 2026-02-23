type SendTextParams = {
  to: string;
  text: string;
  session?: string;
  landlordId?: string;
};

type SendResult = {
  ok: boolean;
  error?: string;
  response?: unknown;
};

function getConfig() {
  return {
    baseUrl: (process.env.EVOLUTION_API_BASE_URL || "").trim(),
    token: (process.env.EVOLUTION_API_TOKEN || "").trim(),
    tokenHeader: (process.env.EVOLUTION_API_TOKEN_HEADER || "apikey").trim(),
    sendPath: (process.env.EVOLUTION_API_SEND_PATH || "/message/sendText").trim(),
    session: (process.env.EVOLUTION_API_SESSION || "default").trim(),
    instance: (process.env.EVOLUTION_API_INSTANCE || "").trim(),
  };
}

/**
 * Resolve the Evolution API instance name for a given landlord.
 * Falls back to the env var EVOLUTION_API_SESSION / EVOLUTION_API_INSTANCE.
 */
async function resolveInstance(landlordId?: string): Promise<string> {
  if (landlordId) {
    try {
      const { db } = require("../config/database");
      const landlord = await db.landlord.findUnique({ where: { id: landlordId }, select: { evolutionInstanceName: true } });
      if (landlord?.evolutionInstanceName) return landlord.evolutionInstanceName;
    } catch { }
  }
  // Fallback to env var
  const cfg = getConfig();
  return cfg.instance || cfg.session;
}

function buildSendUrl(baseUrl: string, path: string, session: string) {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  let fullPath = path.startsWith("/") ? path : `/${path}`;
  if (fullPath.includes("{session}")) {
    fullPath = fullPath.replace("{session}", encodeURIComponent(session));
  }
  return `${normalizedBase}${fullPath}`;
}

export function normalizeWhatsAppNumber(raw: string) {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.includes("@")) {
    return trimmed.split("@")[0];
  }
  return trimmed.replace(/\s+/g, "");
}

/**
 * Send a WhatsApp text message via Evolution API.
 * Now accepts optional landlordId for multi-tenant instance routing (future use).
 */
export async function sendWhatsAppText(params: SendTextParams): Promise<SendResult> {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.token) {
    // eslint-disable-next-line no-console
    console.error("sendWhatsAppText BLOCKED: Evolution API not configured", { baseUrl: Boolean(cfg.baseUrl), token: Boolean(cfg.token) });
    return { ok: false, error: "evolution_api_not_configured" };
  }
  // Resolve instance for this landlord (per-landlord instance routing)
  const instanceName = params.session || await resolveInstance(params.landlordId);
  const url = buildSendUrl(cfg.baseUrl, cfg.sendPath, instanceName);
  const payload: Record<string, unknown> = {
    number: normalizeWhatsAppNumber(params.to),
    text: params.text,
  };
  // eslint-disable-next-line no-console
  console.info("sendWhatsAppText →", { url, to: payload.number, textLen: (params.text || "").length });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [cfg.tokenHeader]: cfg.token,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error("sendWhatsAppText FAILED", { status: res.status, error: data?.error || data?.message, url });
      return { ok: false, error: data?.error || `send_failed_${res.status}`, response: data };
    }
    // eslint-disable-next-line no-console
    console.info("sendWhatsAppText OK", { to: payload.number, status: res.status });
    return { ok: true, response: data };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("sendWhatsAppText EXCEPTION", { error: (err as Error).message, url });
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Send a notification to the landlord via WhatsApp self-chat and web dashboard.
 * WhatsApp: sends to each of the landlord's whatsappNumbers (self-chat).
 * Web: pushes a real-time notification via WebSocket if available.
 */
export async function alertLandlord(landlordId: string, text: string, extra?: { type?: string; maintenanceId?: string; tenantPhone?: string; severity?: string }): Promise<void> {
  // Import dynamically to avoid circular deps
  const { db } = require("../config/database");
  try {
    const landlord = await db.landlord.findUnique({
      where: { id: landlordId },
      select: { whatsappNumbers: true },
    });
    if (!landlord) return;

    // Send to each whatsapp number (self-chat)
    if (landlord.whatsappNumbers?.length) {
      for (const number of landlord.whatsappNumbers) {
        await sendWhatsAppText({ to: number, text, landlordId });
      }
    }

    // Push web notification via WebSocket
    try {
      const { broadcastToLandlord, createNotification } = require("./websocketService");
      const notifType = extra?.type || "TENANT_MESSAGE";
      const title = notifType === "APPROVAL_REQUEST" ? "Approval Request"
        : notifType === "MAINTENANCE_NEW" ? "New Maintenance Request"
          : notifType === "CONTRACTOR_MESSAGE" ? "Contractor Message"
            : "Tenant Message";
      await createNotification({
        landlordId,
        type: notifType,
        title,
        body: text.substring(0, 500),
        data: { maintenanceId: extra?.maintenanceId, tenantPhone: extra?.tenantPhone, severity: extra?.severity },
      });
    } catch (_wsErr) {
      // WebSocket service not available — silently skip
    }
  } catch (err) {
    console.warn("alertLandlord failed", err); // eslint-disable-line no-console
  }
}

// ── Send WhatsApp Document (PDF, images, etc.) ──

type SendDocumentParams = {
  to: string;
  document: string; // base64-encoded file content
  fileName: string;
  mimeType?: string;
  caption?: string;
  session?: string;
  landlordId?: string;
};

export async function sendWhatsAppDocument(params: SendDocumentParams): Promise<SendResult> {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.token) {
    console.error("sendWhatsAppDocument BLOCKED: Evolution API not configured");
    return { ok: false, error: "evolution_api_not_configured" };
  }
  const instanceName = params.session || await resolveInstance(params.landlordId);
  const url = buildSendUrl(cfg.baseUrl, "/message/sendMedia", instanceName);
  const payload: Record<string, unknown> = {
    number: normalizeWhatsAppNumber(params.to),
    mediatype: "document",
    media: `data:${params.mimeType || "application/pdf"};base64,${params.document}`,
    fileName: params.fileName,
    caption: params.caption || "",
  };
  console.info("sendWhatsAppDocument →", { url, to: payload.number, fileName: params.fileName });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [cfg.tokenHeader]: cfg.token,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("sendWhatsAppDocument FAILED", { status: res.status, error: data?.error || data?.message });
      return { ok: false, error: data?.error || `send_failed_${res.status}`, response: data };
    }
    console.info("sendWhatsAppDocument OK", { to: payload.number, status: res.status });
    return { ok: true, response: data };
  } catch (err) {
    console.error("sendWhatsAppDocument EXCEPTION", { error: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
}

export default {
  sendWhatsAppText,
  sendWhatsAppDocument,
  normalizeWhatsAppNumber,
  alertLandlord,
};
