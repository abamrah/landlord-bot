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
  } else if (session) {
    // Evolution API v2 requires instance name in the URL path
    fullPath = `${fullPath}/${encodeURIComponent(session)}`;
  }
  return `${normalizedBase}${fullPath}`;
}

export function normalizeWhatsAppNumber(raw: string) {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Preserve group JIDs (e.g. 120363...@g.us) — they must be sent as-is
  if (trimmed.endsWith("@g.us")) return trimmed;
  if (trimmed.includes("@")) {
    return trimmed.split("@")[0];
  }
  return trimmed.replace(/\s+/g, "");
}

/**
 * Convert markdown-style formatting to WhatsApp native formatting.
 * **bold** → *bold*, __italic__ → _italic_, ~~strike~~ → ~strike~
 */
export function formatWhatsAppText(text: string): string {
  if (!text) return text;
  // Convert **bold** to *bold* (WhatsApp native bold)
  let formatted = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
  // Convert __italic__ to _italic_ (WhatsApp native italic)
  formatted = formatted.replace(/__(.+?)__/g, '_$1_');
  // Convert ~~strike~~ to ~strike~ (WhatsApp native strikethrough)
  formatted = formatted.replace(/~~(.+?)~~/g, '~$1~');
  return formatted;
}

/**
 * Send a WhatsApp text message via Evolution API.
 * Now accepts optional landlordId for multi-tenant instance routing (future use).
 * Automatically applies WhatsApp rich text formatting.
 * Includes retry logic for transient 500 errors (e.g. disconnected sessions).
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
    text: formatWhatsAppText(params.text),
  };
  // eslint-disable-next-line no-console
  console.info("sendWhatsAppText →", { url, to: payload.number, textLen: (params.text || "").length });

  const MAX_RETRIES = 2;
  let lastError: SendResult = { ok: false, error: "unknown" };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [cfg.tokenHeader]: cfg.token,
        },
        body: JSON.stringify(payload),
      });
      let data: any;
      const rawBody = await res.text().catch(() => "");
      try { data = JSON.parse(rawBody); } catch { data = { rawBody: rawBody?.substring(0, 500) }; }
      if (!res.ok) {
        const errorDetail = data?.error || data?.message || data?.response?.message || data?.rawBody || "unknown";
        // eslint-disable-next-line no-console
        console.error(`sendWhatsAppText FAILED (attempt ${attempt + 1}/${MAX_RETRIES + 1})`, {
          status: res.status, error: errorDetail, url, instance: instanceName, fullResponse: JSON.stringify(data).substring(0, 500),
        });
        lastError = { ok: false, error: typeof errorDetail === "string" ? errorDetail : `send_failed_${res.status}`, response: data };

        // Retry on 500/502/503 (transient errors, usually disconnected session)
        if (res.status >= 500 && attempt < MAX_RETRIES) {
          // On first 500 failure, attempt to reconnect the instance before retrying
          if (attempt === 0) {
            console.warn(`[AutoReconnect] Attempting instance restart for ${instanceName} after 500 error`);
            try {
              await attemptInstanceReconnect(instanceName);
            } catch (reconnErr) {
              console.warn(`[AutoReconnect] Reconnect attempt failed:`, (reconnErr as Error).message);
            }
          }
          const backoffMs = (attempt + 1) * 2000;
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        return lastError;
      }
      // eslint-disable-next-line no-console
      console.info("sendWhatsAppText OK", { to: payload.number, status: res.status, attempt: attempt + 1 });
      return { ok: true, response: data };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`sendWhatsAppText EXCEPTION (attempt ${attempt + 1}/${MAX_RETRIES + 1})`, { error: (err as Error).message, url });
      lastError = { ok: false, error: (err as Error).message };
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
    }
  }
  return lastError;
}

// ── WhatsApp Group Management ──

type CreateGroupResult = {
  ok: boolean;
  groupJid?: string;
  error?: string;
  response?: unknown;
};

/**
 * Create a WhatsApp group via Evolution API.
 * @param instanceName Evolution API instance name
 * @param subject Group name/subject (e.g. "Unit 201 - 123 Main St")
 * @param participants Array of phone numbers to add to the group
 */
export async function createWhatsAppGroup(
  instanceName: string,
  subject: string,
  participants: string[]
): Promise<CreateGroupResult> {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.token) {
    console.error("createWhatsAppGroup BLOCKED: Evolution API not configured");
    return { ok: false, error: "evolution_api_not_configured" };
  }
  const url = buildSendUrl(cfg.baseUrl, "/group/create", instanceName);
  const payload = {
    subject,
    participants: participants.map((p) => normalizeWhatsAppNumber(p)),
  };
  console.info("createWhatsAppGroup →", { url, subject, participantCount: participants.length });
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
      console.error("createWhatsAppGroup FAILED", { status: res.status, error: data?.error || data?.message });
      return { ok: false, error: data?.error || `create_group_failed_${res.status}`, response: data };
    }
    // Evolution API returns the group JID in the response
    const groupJid = data?.id || data?.groupJid || data?.jid || data?.group?.id || "";
    console.info("createWhatsAppGroup OK", { subject, groupJid });
    return { ok: true, groupJid, response: data };
  } catch (err) {
    console.error("createWhatsAppGroup EXCEPTION", { error: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Send a text message to a WhatsApp group.
 * Uses the same sendText endpoint but with the group JID.
 */
export async function sendWhatsAppGroupText(params: {
  groupJid: string;
  text: string;
  landlordId?: string;
}): Promise<SendResult> {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.token) {
    return { ok: false, error: "evolution_api_not_configured" };
  }
  const instanceName = await resolveInstance(params.landlordId);
  const url = buildSendUrl(cfg.baseUrl, cfg.sendPath, instanceName);
  const payload = {
    number: params.groupJid,
    text: formatWhatsAppText(params.text),
  };
  console.info("sendWhatsAppGroupText →", { url, groupJid: params.groupJid, textLen: params.text.length });

  const MAX_RETRIES = 2;
  let lastError: SendResult = { ok: false, error: "unknown" };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [cfg.tokenHeader]: cfg.token,
        },
        body: JSON.stringify(payload),
      });
      let data: any;
      const rawBody = await res.text().catch(() => "");
      try { data = JSON.parse(rawBody); } catch { data = { rawBody: rawBody?.substring(0, 500) }; }
      if (!res.ok) {
        const errorDetail = data?.error || data?.message || data?.rawBody || "unknown";
        console.error(`sendWhatsAppGroupText FAILED (attempt ${attempt + 1}/${MAX_RETRIES + 1})`, {
          status: res.status, error: errorDetail, url, instance: instanceName,
          fullResponse: JSON.stringify(data).substring(0, 500),
        });
        lastError = { ok: false, error: typeof errorDetail === "string" ? errorDetail : `send_failed_${res.status}`, response: data };
        if (res.status >= 500 && attempt < MAX_RETRIES) {
          if (attempt === 0) {
            try { await attemptInstanceReconnect(instanceName); } catch { }
          }
          await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
          continue;
        }
        return lastError;
      }
      console.info("sendWhatsAppGroupText OK", { groupJid: params.groupJid, status: res.status, attempt: attempt + 1 });
      return { ok: true, response: data };
    } catch (err) {
      console.error(`sendWhatsAppGroupText EXCEPTION (attempt ${attempt + 1})`, { error: (err as Error).message });
      lastError = { ok: false, error: (err as Error).message };
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
    }
  }
  return lastError;
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
      await createNotification(landlordId, {
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

/**
 * Attempt to reconnect a disconnected Evolution API instance.
 * Tries restart first, then falls back to connect.
 */
export async function attemptInstanceReconnect(instanceName: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.token) return { ok: false, error: "not_configured" };
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [cfg.tokenHeader]: cfg.token,
  };
  const inst = encodeURIComponent(instanceName);

  // 1. Check current connection state
  try {
    const stateRes = await fetch(`${base}/instance/connectionState/${inst}`, { headers });
    const stateData = await stateRes.json().catch(() => ({}));
    const state = (stateData as any)?.instance?.state || "unknown";
    console.info(`[AutoReconnect] Instance ${instanceName} state: ${state}`);
    if (state === "open") return { ok: true }; // already connected
  } catch { /* continue with restart attempt */ }

  // 2. Try restart
  try {
    const restartRes = await fetch(`${base}/instance/restart/${inst}`, { method: "PUT", headers });
    if (restartRes.ok) {
      console.info(`[AutoReconnect] Instance ${instanceName} restarted successfully`);
      // Wait for reconnection
      await new Promise(r => setTimeout(r, 3000));
      return { ok: true };
    }
    const restartData = await restartRes.json().catch(() => ({}));
    console.warn(`[AutoReconnect] Restart failed for ${instanceName}:`, restartData);
  } catch (err) {
    console.warn(`[AutoReconnect] Restart exception for ${instanceName}:`, (err as Error).message);
  }

  // 3. Try connect endpoint as fallback
  try {
    const connectRes = await fetch(`${base}/instance/connect/${inst}`, { headers });
    if (connectRes.ok) {
      console.info(`[AutoReconnect] Instance ${instanceName} connect initiated`);
      await new Promise(r => setTimeout(r, 3000));
      return { ok: true };
    }
  } catch (err) {
    console.warn(`[AutoReconnect] Connect exception for ${instanceName}:`, (err as Error).message);
  }

  return { ok: false, error: "reconnect_failed" };
}

/**
 * Periodic health check for all Evolution API instances.
 * Logs connection state and attempts reconnect for disconnected instances.
 */
export async function healthCheckAllInstances(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.token) return;
  const { db: database } = require("../config/database");
  try {
    const landlords = await database.landlord.findMany({
      where: { evolutionInstanceName: { not: null } },
      select: { id: true, evolutionInstanceName: true, name: true },
    });
    if (!landlords.length) return;

    const base = cfg.baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      [cfg.tokenHeader]: cfg.token,
    };

    for (const ll of landlords) {
      if (!ll.evolutionInstanceName) continue;
      try {
        const inst = encodeURIComponent(ll.evolutionInstanceName);
        const res = await fetch(`${base}/instance/connectionState/${inst}`, { headers });
        const data = await res.json().catch(() => ({}));
        const state = (data as any)?.instance?.state || "unknown";
        if (state !== "open") {
          console.warn(`[HealthCheck] Instance ${ll.evolutionInstanceName} (${ll.name}) is ${state} — attempting reconnect`);
          await attemptInstanceReconnect(ll.evolutionInstanceName);
        }
      } catch (err) {
        console.warn(`[HealthCheck] Failed to check ${ll.evolutionInstanceName}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn("[HealthCheck] Instance health check failed:", (err as Error).message);
  }
}

/**
 * Sync Evolution API instance settings to ensure group messages are
 * forwarded to the webhook. This sets:
 *   groupsIgnore: false   — process group messages
 *   readMessages: true    — mark messages as read (required for groups)
 *   readStatus: true      — receive status updates
 *   alwaysOnline: true    — keep connection alive
 * Also updates the webhook URL and subscribed events.
 */
export async function syncEvolutionInstanceSettings(instanceName: string, webhookUrl?: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = getConfig();
  if (!cfg.baseUrl || !cfg.token) {
    return { ok: false, error: "evolution_api_not_configured" };
  }

  const base = cfg.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [cfg.tokenHeader]: cfg.token,
  };

  const results: string[] = [];

  // 1. Update instance settings (groupsIgnore, readMessages, etc.)
  try {
    const res = await fetch(`${base}/instance/update/${encodeURIComponent(instanceName)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        groupsIgnore: false,
        readMessages: true,
        readStatus: true,
        alwaysOnline: true,
        rejectCall: false,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      results.push("instance_settings_updated");
      console.log(`[EvoSync] Instance ${instanceName}: settings updated (groupsIgnore=false, readMessages=true)`);
    } else {
      results.push(`instance_settings_failed: ${(data as any)?.message || res.status}`);
      console.warn(`[EvoSync] Instance ${instanceName}: settings update failed`, data);
    }
  } catch (err) {
    results.push(`instance_settings_error: ${(err as Error).message}`);
    console.warn(`[EvoSync] Instance ${instanceName}: settings update error`, (err as Error).message);
  }

  // 2. Update webhook URL and events
  if (webhookUrl) {
    try {
      const res = await fetch(`${base}/webhook/set/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          url: webhookUrl,
          byEvents: false,
          base64: true,
          events: [
            "MESSAGES_UPSERT",
            "MESSAGES_UPDATE",
            "CONNECTION_UPDATE",
            "QRCODE_UPDATED",
          ],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        results.push("webhook_updated");
        console.log(`[EvoSync] Instance ${instanceName}: webhook updated → ${webhookUrl}`);
      } else {
        results.push(`webhook_failed: ${(data as any)?.message || res.status}`);
        console.warn(`[EvoSync] Instance ${instanceName}: webhook update failed`, data);
      }
    } catch (err) {
      results.push(`webhook_error: ${(err as Error).message}`);
      console.warn(`[EvoSync] Instance ${instanceName}: webhook update error`, (err as Error).message);
    }
  }

  return { ok: results.some(r => r.includes("updated")), error: results.join("; ") };
}

/**
 * Sync settings for ALL landlord Evolution API instances.
 * Called on server startup to ensure group messages work.
 */
export async function syncAllInstanceSettings(): Promise<void> {
  const { db: database } = require("../config/database");
  const webhookBase = process.env.WEBHOOK_URL || process.env.APP_PUBLIC_URL || process.env.APP_URL || "";
  const webhookUrl = webhookBase ? `${webhookBase.replace(/\/+$/, "")}/webhooks/whatsapp/evolution` : undefined;

  try {
    const landlords = await database.landlord.findMany({
      where: { evolutionInstanceName: { not: null } },
      select: { id: true, evolutionInstanceName: true, name: true },
    });
    if (!landlords.length) {
      console.log("[EvoSync] No landlords with Evolution instances found — skipping");
      return;
    }
    console.log(`[EvoSync] Syncing settings for ${landlords.length} Evolution instance(s)...`);
    for (const ll of landlords) {
      if (!ll.evolutionInstanceName) continue;
      await syncEvolutionInstanceSettings(ll.evolutionInstanceName, webhookUrl);
    }
    console.log("[EvoSync] All instance settings synced.");
  } catch (err) {
    console.warn("[EvoSync] Failed to sync instance settings on startup:", (err as Error).message);
  }
}

export default {
  sendWhatsAppText,
  sendWhatsAppDocument,
  normalizeWhatsAppNumber,
  alertLandlord,
  formatWhatsAppText,
  createWhatsAppGroup,
  sendWhatsAppGroupText,
  syncEvolutionInstanceSettings,
  syncAllInstanceSettings,
  attemptInstanceReconnect,
  healthCheckAllInstances,
};
