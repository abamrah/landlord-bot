const express = require("express");
const agentService = require("../services/agentService").default || require("../services/agentService");
const repo = require("../services/repository").default || require("../services/repository");
const whatsappService = require("../services/whatsappService").default || require("../services/whatsappService");
const { z } = require("zod");

const maintenanceSchema = z.object({
  tenantMessage: z.string().min(1, "tenantMessage required"),
  tenantId: z.string().optional(),
  unitId: z.string().optional(),
});

const chatSchema = z.object({
  role: z.enum(["tenant", "landlord", "ai"]),
  content: z.string().min(1, "content required"),
  sendToTenant: z.boolean().optional(),
});

const refineSchema = z.object({
  instructions: z.string().min(5, "instructions required"),
  baseText: z.string().optional(),
});

const advisorSchema = z.object({
  instructions: z.string().min(3, "instructions required"),
  baseText: z.string().optional(),
});

const autopilotSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().optional(),
  runNow: z.boolean().optional(),
});

const SAFE_AUTOPILOT_SEVERITIES = new Set(["low", "normal"]);

function latestSeverity(triage, fallbackRecord) {
  const fromTriage = triage?.classification?.severity;
  const fromRecord = fallbackRecord?.triageJson?.classification?.severity;
  return (fromTriage || fromRecord || "").toString().toLowerCase();
}

function lastMessageIsTenant(record) {
  const chatLog = Array.isArray(record?.chatLog) ? record.chatLog : [];
  if (!chatLog.length) return false;
  const lastEntry = chatLog[chatLog.length - 1];
  return lastEntry?.role === "tenant";
}

async function maybeRunAutopilot({ record, triage, aiDraft, reason = "tenant_message" }) {
  if (!record || !record.id || !record.autopilotEnabled) return { ran: false };
  const severity = latestSeverity(triage, record) || "unknown";
  const meta = { severity, reason };

  await repo.logAutopilotEvent({
    id: record.id,
    type: "system",
    message: "Autopilot evaluating latest activity",
    status: "evaluating",
    meta,
  });

  if (!SAFE_AUTOPILOT_SEVERITIES.has(severity)) {
    await repo.logAutopilotEvent({
      id: record.id,
      type: "skip",
      message: `Autopilot blocked at severity ${severity}`,
      status: "blocked_severity",
      meta,
    });
    return { ran: false };
  }

  if (!lastMessageIsTenant(record)) {
    await repo.logAutopilotEvent({
      id: record.id,
      type: "skip",
      message: "Autopilot idle (no tenant awaiting reply)",
      status: "idle",
      meta,
    });
    return { ran: false };
  }

  const text = (aiDraft?.draft || record?.aiDraft?.draft || "").trim();
  if (!text) {
    await repo.logAutopilotEvent({
      id: record.id,
      type: "skip",
      message: "Autopilot waiting for draft content",
      status: "awaiting_draft",
      meta,
    });
    return { ran: false };
  }

  const tenantId = record.tenantId;
  const tenant = tenantId ? await repo.getTenantById(tenantId) : null;
  const to = tenant?.phone;
  if (!tenant || !to) {
    await repo.logAutopilotEvent({
      id: record.id,
      type: "skip",
      message: "Autopilot blocked: missing tenant phone",
      status: "missing_contact",
      meta: { ...meta, tenantId },
    });
    return { ran: false };
  }

  const sent = await whatsappService.sendWhatsAppText({ to, text });
  if (!sent.ok) {
    await repo.logAutopilotEvent({
      id: record.id,
      type: "error",
      message: "Autopilot send failed",
      status: "send_failed",
      meta: { ...meta, to, error: sent.error, response: sent.response },
    });
    return { ran: false };
  }

  await repo.appendChatMessage({
    id: record.id,
    role: "ai",
    content: text,
    meta: { autopilot: true, severity, reason, to },
    setLandlordReply: text,
  });
  await repo.logAutopilotEvent({
    id: record.id,
    type: "auto_reply",
    message: "Autopilot sent reply via WhatsApp",
    status: "auto_replied",
    meta: { ...meta, to, length: text.length },
  });

  return { ran: true, to };
}

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const landlordId = req.landlordId;
    if (!landlordId) return res.status(401).json({ error: "unauthorized" });
    const parsed = maintenanceSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
    }

    const { tenantMessage, tenantId, unitId } = parsed.data;

    const triage = await agentService.triageMaintenance({
      tenantMessage,
      tenantId,
      unitId,
    });

    const utilityCheck = await agentService.checkUtilityAnomaly({ tenantId, unitId });

    const conversationSeed = [
      {
        role: "tenant",
        content: tenantMessage,
        createdAt: new Date().toISOString(),
      },
    ];

    const draftResponse = await agentService.draftRtaResponse({
      tenantMessage,
      triage,
      utilityCheck,
      conversationLog: conversationSeed,
    });

    const maintenanceRecord = await repo.createMaintenanceRequest({
      tenantId,
      unitId,
      message: tenantMessage,
      triage,
      aiDraft: draftResponse,
      landlordId,
    });

    if (maintenanceRecord?.id) {
      await repo.updateMaintenanceUtility({
        maintenanceId: maintenanceRecord.id,
        utilityCheck,
      });
    }

    res.json({ triage, utilityCheck, draftResponse, maintenanceId: maintenanceRecord?.id });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("maintenance route error", err);
    res.status(500).json({ error: "maintenance_flow_failed", detail: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const landlordId = req.landlordId;
    if (!landlordId) return res.status(401).json({ error: "unauthorized" });
    const record = await repo.getMaintenanceById(req.params.id);
    if (!record) return res.status(404).json({ error: "not_found" });
    if (record.landlordId && record.landlordId !== landlordId) return res.status(403).json({ error: "forbidden" });
    res.json({ item: record });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("maintenance get error", err);
    res.status(500).json({ error: "maintenance_get_failed", detail: err.message });
  }
});

router.post("/:id/chat", async (req, res) => {
  const parsed = chatSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  }
  try {
    const landlordId = req.landlordId;
    if (!landlordId) return res.status(401).json({ error: "unauthorized" });
    const record = await repo.getMaintenanceById(req.params.id);
    if (!record) return res.status(404).json({ error: "not_found" });
    if (record.landlordId && record.landlordId !== landlordId) return res.status(403).json({ error: "forbidden" });

    const updated = await repo.appendChatMessage({
      id: record.id,
      role: parsed.data.role,
      content: parsed.data.content,
      setLandlordReply: parsed.data.role === "landlord" ? parsed.data.content : undefined,
    });
    if (!updated) return res.status(404).json({ error: "not_found" });

    if (parsed.data.role !== "tenant") {
      // If landlord explicitly wants to send this message to the tenant via WhatsApp
      if (parsed.data.sendToTenant && parsed.data.role === "landlord" && record.tenantId) {
        try {
          const tenant = await repo.getTenantById(record.tenantId);
          if (tenant && tenant.phone) {
            const sendResult = await whatsappService.sendWhatsAppText({
              to: tenant.phone,
              text: parsed.data.content,
              landlordId: landlordId,
            });
            if (!sendResult.ok) {
              console.error("Draft send to tenant FAILED", { tenantId: record.tenantId, phone: tenant.phone, error: sendResult.error });
              return res.status(500).json({ error: "whatsapp_send_failed", details: sendResult.error, item: updated });
            }
            // Log the sent message as an AI/forwarded message in the chat
            await repo.appendChatMessage({
              id: record.id,
              role: "ai",
              content: parsed.data.content,
              meta: { channel: "whatsapp", forwarded: true, approvedBy: "dashboard" },
            });
            console.info("Draft sent to tenant via WhatsApp (dashboard approval)", { tenantId: record.tenantId, phone: tenant.phone });
            return res.json({ item: updated, sentToTenant: true, to: tenant.phone });
          } else {
            return res.status(400).json({ error: "tenant_no_phone", message: "Tenant does not have a phone number", item: updated });
          }
        } catch (sendErr) {
          console.error("Draft send to tenant EXCEPTION", { error: sendErr.message });
          return res.status(500).json({ error: "whatsapp_send_exception", details: sendErr.message, item: updated });
        }
      }
      return res.json({ item: updated });
    }

    try {
      const triage = await agentService.triageMaintenance({
        tenantMessage: parsed.data.content,
        tenantId: record.tenantId,
        unitId: record.unitId,
      });

      const utilityCheck = await agentService.checkUtilityAnomaly({
        tenantId: record.tenantId,
        unitId: record.unitId,
      });

      const chatLog = Array.isArray(updated.chatLog) ? updated.chatLog : [];
      const draftResponse = await agentService.draftRtaResponse({
        tenantMessage: parsed.data.content,
        triage,
        utilityCheck,
        conversationLog: chatLog,
        landlordReply: updated.landlordReply,
      });

      await repo.updateMaintenanceUtility({ maintenanceId: record.id, utilityCheck });
      const refreshed =
        (await repo.updateMaintenanceAnalysis({ id: record.id, triage, aiDraft: draftResponse })) || updated;
      await maybeRunAutopilot({ record: refreshed, triage, aiDraft: draftResponse, reason: "tenant_message" });
      const finalRecord = (await repo.getMaintenanceById(record.id)) || refreshed;

      return res.json({ item: finalRecord, triage, aiDraft: draftResponse });
    } catch (followupErr) {
      // eslint-disable-next-line no-console
      console.error("follow-up analysis failed", followupErr);
      return res.json({ item: updated, warning: "analysis_failed" });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("maintenance chat error", err);
    res.status(500).json({ error: "maintenance_chat_failed", detail: err.message });
  }
});

router.post("/:id/refine", async (req, res) => {
  const parsed = refineSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  }
  try {
    const landlordId = req.landlordId;
    if (!landlordId) return res.status(401).json({ error: "unauthorized" });
    const record = await repo.getMaintenanceById(req.params.id);
    if (!record) return res.status(404).json({ error: "not_found" });
    if (record.landlordId && record.landlordId !== landlordId) return res.status(403).json({ error: "forbidden" });

    const aiDraft = record.aiDraft && typeof record.aiDraft === "object" ? record.aiDraft : null;
    const storedDraft = aiDraft && typeof aiDraft.draft === "string" ? aiDraft.draft : "";
    const landlordReply = typeof record.landlordReply === "string" ? record.landlordReply : "";
    const incoming = typeof parsed.data.baseText === "string" ? parsed.data.baseText.trim() : "";
    const baseDraft = incoming || landlordReply || storedDraft;

    if (!baseDraft) {
      return res.status(400).json({ error: "no_draft_available" });
    }

    const refined = await agentService.refineDraft({
      instructions: parsed.data.instructions,
      baseDraft,
      triage: record.triageJson,
      tenantMessage: record.message,
      conversationLog: Array.isArray(record.chatLog) ? record.chatLog : null,
      landlordReply: record.landlordReply,
    });

    const updated = await repo.updateAiDraft({ id: record.id, aiDraft: refined });

    res.json({ draft: refined, maintenance: updated || record });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("maintenance refine error", err);
    res.status(500).json({ error: "maintenance_refine_failed", detail: err.message });
  }
});

router.post("/:id/advisor", async (req, res) => {
  const parsed = advisorSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  }
  try {
    const landlordId = req.landlordId;
    if (!landlordId) return res.status(401).json({ error: "unauthorized" });
    const record = await repo.getMaintenanceById(req.params.id);
    if (!record) return res.status(404).json({ error: "not_found" });
    if (record.landlordId && record.landlordId !== landlordId) return res.status(403).json({ error: "forbidden" });

    const aiDraft = record.aiDraft && typeof record.aiDraft === "object" ? record.aiDraft : null;
    const storedDraft = aiDraft && typeof aiDraft.draft === "string" ? aiDraft.draft : "";
    const landlordReply = typeof record.landlordReply === "string" ? record.landlordReply : "";
    const incoming = typeof parsed.data.baseText === "string" ? parsed.data.baseText.trim() : "";
    const baseDraft = incoming || landlordReply || storedDraft;

    const suggestion = await agentService.advisorSuggest({
      instructions: parsed.data.instructions,
      baseDraft,
      triage: record.triageJson,
      tenantMessage: record.message,
      conversationLog: Array.isArray(record.chatLog) ? record.chatLog : null,
      landlordReply: record.landlordReply,
    });

    res.json({ suggestion, maintenance: record });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("maintenance advisor error", err);
    res.status(500).json({ error: "maintenance_advisor_failed", detail: err.message });
  }
});

router.patch("/:id/autopilot", async (req, res) => {
  const parsed = autopilotSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  }
  try {
    const landlordId = req.landlordId;
    if (!landlordId) return res.status(401).json({ error: "unauthorized" });
    const record = await repo.getMaintenanceById(req.params.id);
    if (!record) return res.status(404).json({ error: "not_found" });
    if (record.landlordId && record.landlordId !== landlordId) return res.status(403).json({ error: "forbidden" });

    const toggled = await repo.setAutopilotEnabled({
      id: record.id,
      enabled: parsed.data.enabled,
      note: parsed.data.reason,
    });
    const baseRecord = toggled || record;
    const shouldRunNow = parsed.data.runNow ?? parsed.data.enabled;
    if (shouldRunNow) {
      await maybeRunAutopilot({ record: baseRecord, triage: baseRecord.triageJson, aiDraft: baseRecord.aiDraft, reason: "manual_run" });
    }
    const refreshed = (await repo.getMaintenanceById(baseRecord.id)) || baseRecord;
    return res.json({ maintenance: refreshed });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("autopilot toggle failed", err);
    res.status(500).json({ error: "autopilot_toggle_failed", detail: err.message });
  }
});

module.exports = router;
