import express from "express";
import { z } from "zod";
import repo from "../services/repository";
import { MaintenanceStatus, UtilityType, UnitUtilityType } from "@prisma/client";
import whatsappService from "../services/whatsappService";
import agentService from "../services/agentService";
import { getWebhookStatus } from "../services/webhookStatus";
import { addReminder, deleteReminder, listReminders, toggleReminder } from "../services/reminderService";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { checkPlanLimit, incrementMessageCount } from "../services/planService";
import { createCheckoutSession } from "../services/stripeService";
import { listProvinces } from "../config/rtaProfiles";
import orchestrator from "../services/agentOrchestrator";
import { readPage } from "../services/pageReader";
import conversationMemory from "../services/conversationMemory";
import { db } from "../config/database";
import { findExpiringLeases, sendLeaseExpiryAlerts } from "../services/leaseExpiryService";
import { agentRateLimit } from "../services/rateLimiter";
import greenButton from "../services/greenButtonService";

const router = express.Router();

// Helper to resolve Evolution API instance for a landlord
async function resolveInstanceForLandlord(landlordId: string): Promise<string> {
  try {
    const landlord = await db.landlord.findUnique({ where: { id: landlordId }, select: { evolutionInstanceName: true } });
    if (landlord?.evolutionInstanceName) return landlord.evolutionInstanceName;
  } catch { /* ignore */ }
  return (process.env.EVOLUTION_API_INSTANCE || process.env.EVOLUTION_API_SESSION || "default").trim();
}

// All admin routes require authentication
router.use(requireAuth);

const tenantSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "name required"),
  phone: z.string().optional(),
  email: z.string().optional(),
  unitId: z.string().optional(),
  autoReplyEnabled: z.boolean().optional(),
  role: z.enum(["tenant", "resident"]).optional(),
  utilitySharePercent: z.number().min(0).max(100).optional(),
  rentAmountCents: z.number().int().min(0).optional(),
});

const tenantUpdateSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  unitId: z.string().nullable().optional(),
  autoReplyEnabled: z.boolean().optional(),
});

const contractorSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "name required"),
  phone: z.string().min(5, "phone required"),
  email: z.string().optional(),
  role: z.string().optional(),
});

const contractorUpdateSchema = contractorSchema.partial();

const unitSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1, "label required"),
  address: z.string().optional().default(""),
  propertyId: z.string().optional(),
  utilityType: z.enum(["SINGLE", "SHARED"]).optional(),
});

const unitUpdateSchema = z.object({
  label: z.string().optional(),
  address: z.string().optional(),
  propertyId: z.string().nullable().optional(),
  utilityType: z.enum(["SINGLE", "SHARED"]).optional(),
});

const propertySchema = z.object({
  address: z.string().min(1, "address required"),
});

const unitTenantUpdateSchema = z.object({
  role: z.enum(["tenant", "resident"]).optional(),
  utilitySharePercent: z.number().min(0).max(100).nullable().optional(),
  rentAmountCents: z.number().int().min(0).nullable().optional(),
});

const tenantContactSchema = z.object({
  phone: z.string().optional(),
  email: z.string().optional(),
}).refine((data) => Boolean(data.phone || data.email), {
  message: "phone or email required",
});

const whatsappTestSchema = z.object({
  to: z.string().min(5, "destination required"),
  message: z.string().min(1, "message required"),
  session: z.string().optional(),
});

const utilityCredentialSchema = z.object({
  unitId: z.string().min(1, "unit required"),
  utilityType: z.enum(["INTERNET", "WATER_GAS", "HYDRO"]),
  username: z.string().optional(),
  password: z.string().optional(),
  url: z.string().optional(),
  notes: z.string().optional(),
});

const utilityCredentialUpdateSchema = z.object({
  username: z.string().optional(),
  password: z.string().optional(),
  url: z.string().optional(),
  notes: z.string().optional(),
});

const utilityBillSchema = z.object({
  unitId: z.string().optional(),
  tenantId: z.string().optional(),
  maintenanceId: z.string().optional(),
  utilityType: z.nativeEnum(UtilityType),
  amountCents: z.number().min(0),
  currency: z.string().optional(),
  billingPeriodStart: z.string().optional(),
  billingPeriodEnd: z.string().optional(),
  statementUrl: z.string().optional(),
  portalUsername: z.string().optional(),
  anomalyFlag: z.boolean().optional(),
  anomalyNotes: z.string().optional(),
  rawData: z.any().optional(),
});

const utilityBillUpdateSchema = utilityBillSchema.partial().omit({ utilityType: true }).extend({ amountCents: z.number().optional() });


router.post("/tenants", async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: "db_disabled" });
  }
  const authReq = req as unknown as AuthRequest;
  const parsed = tenantSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  }
  if (parsed.data.phone) {
    const existing = await repo.findTenantByPhone(parsed.data.phone, authReq.landlordId);
    if (existing) return res.status(409).json({ error: "phone_in_use" });
  }
  if (parsed.data.email) {
    const existing = await repo.findTenantByEmail(parsed.data.email, authReq.landlordId);
    if (existing) return res.status(409).json({ error: "email_in_use" });
  }
  if (parsed.data.unitId) {
    const unit = await repo.getUnitById(parsed.data.unitId);
    if (!unit) return res.status(400).json({ error: "unit_not_found" });
  }
  const tenant = await repo.createTenant({ ...parsed.data, landlordId: authReq.landlordId });
  if (!tenant) return res.status(500).json({ error: "tenant_create_failed" });

  // Set role, utilitySharePercent, and rentAmountCents on UnitTenant if provided
  if (parsed.data.unitId && (parsed.data.role || parsed.data.utilitySharePercent !== undefined || parsed.data.rentAmountCents !== undefined)) {
    try {
      const unitTenants = await db.unitTenant.findMany({ where: { tenantId: tenant.id, unitId: parsed.data.unitId } });
      if (unitTenants.length > 0) {
        await repo.updateUnitTenant({
          id: unitTenants[0].id,
          role: parsed.data.role,
          utilitySharePercent: parsed.data.utilitySharePercent,
          rentAmountCents: parsed.data.rentAmountCents,
        });
      }
    } catch (err) {
      console.warn("Failed to update unit-tenant role/share:", (err as Error).message);
    }
  }

  // Check if unit already has multiple occupants — if so, skip individual welcome (wait for group)
  let skipIndividualWelcome = false;
  if (parsed.data.unitId) {
    try {
      const unitOccupants = await db.unitTenant.count({ where: { unitId: parsed.data.unitId } });
      if (unitOccupants > 1) skipIndividualWelcome = true;
    } catch { /* ignore */ }
  }

  // Send automated welcome message in background (don't block tenant creation)
  if (parsed.data.phone && !skipIndividualWelcome) {
    const welcomePhone = parsed.data.phone;
    const welcomeLandlordId = authReq.landlordId;
    const welcomeTenantName = parsed.data.name;
    setImmediate(async () => {
      try {
        const landlord = await db.landlord.findUnique({ where: { id: welcomeLandlordId }, select: { name: true, company: true } });
        const landlordName = landlord?.company || landlord?.name || "Your Landlord";
        const welcomeMsg = `*Welcome to ${landlordName}'s Property Management!*\n\nHi ${welcomeTenantName}, your landlord has decided to use NestMind — an AI-powered platform for property management, making communication faster and easier for everyone.\n\n*How it works:*\n• Send a message here anytime to report maintenance issues\n• You'll receive rent reminders before due dates\n• AI-assisted support means faster response times\n\n*Dos:*\n✅ Report maintenance issues promptly — attach photos if possible\n✅ Respond to rent reminders and payment confirmations\n✅ Keep this chat for property-related communication\n\n*Don'ts:*\n❌ Don't share personal financial info (bank passwords, SIN, etc.)\n❌ Don't ignore maintenance follow-ups\n\nWe're here to help! Send \"Hi\" anytime to get started.`;
        await whatsappService.sendWhatsAppText({ to: welcomePhone, text: welcomeMsg, landlordId: welcomeLandlordId });
        await conversationMemory.saveMessage({
          phone: welcomePhone,
          landlordId: welcomeLandlordId,
          role: "system",
          content: welcomeMsg,
        });
      } catch (welcomeErr) {
        console.warn("Failed to send welcome message:", (welcomeErr as Error).message);
      }
    });
  }

  res.json({ tenant });
});

router.patch("/tenants/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyTenantOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const parsed = tenantUpdateSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  const updated = await repo.updateTenant({ id: req.params.id, ...parsed.data });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json({ tenant: updated });
});

router.delete("/tenants/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyTenantOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const deleted = await repo.deleteTenant({ id: req.params.id, hard: req.query?.hard === "true" });
  if (!deleted) return res.status(404).json({ error: "not_found" });
  res.json({ deleted: true });
});

router.post("/contractors", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const parsed = contractorSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  }
  const contractor = await repo.createContractor({ ...parsed.data, landlordId: authReq.landlordId });
  res.json({ contractor });
});

router.patch("/contractors/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyContractorOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const parsed = contractorUpdateSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  const contractor = await repo.updateContractor({ id: req.params.id, ...parsed.data });
  if (!contractor) return res.status(404).json({ error: "not_found" });
  res.json({ contractor });
});

router.delete("/contractors/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyContractorOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const contractor = await repo.deleteContractor({ id: req.params.id, hard: req.query?.hard === "true" });
  if (!contractor) return res.status(404).json({ error: "not_found" });
  res.json({ deleted: true });
});

router.patch("/tenants/:id/contact", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyTenantOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const parsed = tenantContactSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  }
  const updated = await repo.updateTenantContact({ id: req.params.id, ...parsed.data });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json({ tenant: updated });
});

router.get("/tenants", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const tenants = await repo.listTenants(authReq.landlordId);
  res.json({ items: tenants });
});

/** POST /admin/tenants/:id/message — Send a direct message to a tenant via WhatsApp */
router.post("/tenants/:id/message", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyTenantOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const msgSchema = z.object({ text: z.string().min(1, "message required") });
  const parsed = msgSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  const tenant = await db.tenant.findUnique({ where: { id: req.params.id }, select: { phone: true, name: true } });
  if (!tenant?.phone) return res.status(400).json({ error: "tenant_has_no_phone", message: "Tenant does not have a phone number" });
  try {
    const result = await whatsappService.sendWhatsAppText({ to: tenant.phone, text: parsed.data.text, landlordId: authReq.landlordId });
    if (!result.ok) return res.status(500).json({ error: "send_failed", details: result.error });
    // Log the message in conversation history
    await conversationMemory.saveMessage({
      phone: tenant.phone,
      landlordId: authReq.landlordId,
      role: "landlord",
      content: parsed.data.text,
    });
    res.json({ sent: true, to: tenant.phone });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/contractors", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const contractors = await repo.listContractors(authReq.landlordId);
  res.json({ items: contractors });
});

router.post("/units", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const parsed = unitSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  }
  // Check plan limit
  const limit = await checkPlanLimit(authReq.landlordId, "units");
  if (!limit.allowed) {
    return res.status(403).json({ error: "plan_limit_reached", message: `Your ${limit.plan} plan allows ${limit.max} units. You have ${limit.current}.`, current: limit.current, max: limit.max });
  }
  const unit = await repo.createUnit({
    ...parsed.data,
    utilityType: (parsed.data.utilityType as UnitUtilityType) || undefined,
    landlordId: authReq.landlordId,
  });
  res.json({ unit });
});

router.patch("/units/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyUnitOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const parsed = unitUpdateSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  const unit = await repo.updateUnit({
    id: req.params.id,
    ...parsed.data,
    utilityType: (parsed.data.utilityType as UnitUtilityType) || undefined,
    propertyId: parsed.data.propertyId ?? undefined,
  });
  if (!unit) return res.status(404).json({ error: "not_found" });
  res.json({ unit });
});

router.delete("/units/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyUnitOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const unit = await repo.deleteUnit({ id: req.params.id, hard: req.query?.hard === "true" });
  if (!unit) return res.status(404).json({ error: "not_found" });
  res.json({ deleted: true });
});

router.get("/units", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const units = await repo.listUnits(authReq.landlordId);
  res.json({ items: units });
});

// ── Property CRUD ────────────────────────────────────────

router.post("/properties", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const parsed = propertySchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  const property = await repo.createProperty({ address: parsed.data.address, landlordId: authReq.landlordId });
  if (!property) return res.status(500).json({ error: "property_create_failed" });
  res.json({ property });
});

router.get("/properties", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const properties = await repo.listProperties(authReq.landlordId);
  res.json({ items: properties });
});

router.delete("/properties/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyPropertyOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const deleted = await repo.deleteProperty(req.params.id);
  if (!deleted) return res.status(404).json({ error: "not_found" });
  res.json({ deleted: true });
});

// ── UnitTenant Management ────────────────────────────────

router.patch("/unit-tenants/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  // Verify via unit ownership
  const ut = await db.unitTenant.findUnique({ where: { id: req.params.id }, include: { unit: true } });
  if (!ut || ut.unit.landlordId !== authReq.landlordId) return res.status(403).json({ error: "forbidden" });
  const parsed = unitTenantUpdateSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  const updated = await repo.updateUnitTenant({ id: req.params.id, ...parsed.data });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json({ unitTenant: updated });
});

/** POST /admin/units/:id/utility-shares — Set utility share percentages for all occupants */
router.post("/units/:id/utility-shares", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyUnitOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });

  // Accept two formats:
  // Format A (dashboard): { shares: [{ unitTenantId, percent }] }
  // Format B (onboarding): { shares: { tenantId: percent, ... } }
  const body = req.body || {};
  let sharesArray: { unitTenantId: string; percent: number }[] = [];

  if (Array.isArray(body.shares)) {
    // Format A
    const schema = z.object({
      shares: z.array(z.object({
        unitTenantId: z.string(),
        percent: z.number().min(0).max(100),
      })),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
    sharesArray = parsed.data.shares;
  } else if (body.shares && typeof body.shares === "object") {
    // Format B: { tenantId: percent } — resolve tenantId to unitTenantId
    const unitId = req.params.id;
    const unitTenants = await db.unitTenant.findMany({ where: { unitId } });
    for (const [tenantId, pct] of Object.entries(body.shares)) {
      const ut = unitTenants.find((u) => u.tenantId === tenantId);
      if (!ut) return res.status(400).json({ error: "tenant_not_in_unit", tenantId });
      sharesArray.push({ unitTenantId: ut.id, percent: Number(pct) || 0 });
    }
  } else {
    return res.status(400).json({ error: "validation_failed", message: "shares must be an array or object" });
  }

  if (sharesArray.length === 0) return res.status(400).json({ error: "no_shares_provided" });
  // Validate total = 100
  const total = sharesArray.reduce((sum, s) => sum + s.percent, 0);
  if (Math.abs(total - 100) > 0.01) return res.status(400).json({ error: "shares_must_total_100", total });
  const ok = await repo.setUtilityShares(req.params.id, sharesArray);
  if (!ok) return res.status(500).json({ error: "set_shares_failed" });
  res.json({ ok: true });
});

/** GET /admin/units/:id/occupants — Get unit with all occupants, roles, and share percentages */
router.get("/units/:id/occupants", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyUnitOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const unit = await repo.getUnitWithOccupants(req.params.id);
  if (!unit) return res.status(404).json({ error: "not_found" });
  res.json({ unit });
});

/** POST /admin/units/:id/whatsapp-group — Create a WhatsApp group for a unit's occupants */
router.post("/units/:id/whatsapp-group", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyUnitOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const unit = await repo.getUnitWithOccupants(req.params.id);
  if (!unit) return res.status(404).json({ error: "unit_not_found" });

  // Collect phone numbers from all occupants
  const phones = unit.tenants
    .map((ut: any) => ut.tenant?.phone)
    .filter(Boolean) as string[];
  if (phones.length < 2) return res.status(400).json({ error: "need_at_least_2_members", message: "Need at least 2 occupants with phone numbers to create a group" });

  // Also add landlord's own WhatsApp number(s) to the group
  const landlord = await db.landlord.findUnique({ where: { id: authReq.landlordId }, select: { whatsappNumbers: true, name: true, company: true } });
  const landlordPhones = landlord?.whatsappNumbers || [];
  const allParticipants = [...new Set([...landlordPhones, ...phones])];

  // Resolve instance name
  const instanceName = await resolveInstanceForLandlord(authReq.landlordId);

  // Build group name from unit label and property address
  const propertyAddress = (unit as any).property?.address || unit.address || "";
  const groupSubject = propertyAddress
    ? `${unit.label} - ${propertyAddress}`
    : unit.label;

  const result = await whatsappService.createWhatsAppGroup(instanceName, groupSubject, allParticipants);
  if (!result.ok) return res.status(500).json({ error: "group_creation_failed", details: result.error });

  // Save the group JID on the unit
  await repo.updateUnit({ id: unit.id, whatsappGroupJid: result.groupJid || "" });

  // Send welcome message to the group
  const landlordName = landlord?.company || landlord?.name || "Your Landlord";
  const occupantNames = unit.tenants.map((ut: any) => ut.tenant?.name).filter(Boolean).join(", ");
  const welcomeMsg = `*Welcome to ${landlordName}'s Property Group — ${unit.label}!*\n\nHi ${occupantNames}, your landlord has set up this group for property communication regarding your unit.\n\n*How it works:*\n• Report maintenance issues here or in your personal chat\n• Utility reminders and updates will be sent to this group\n• AI-assisted support for faster responses\n\n*Dos:*\n✅ Report maintenance issues promptly\n✅ Respond to utility and rent reminders\n✅ Keep this group for property-related communication\n\n*Don'ts:*\n❌ Don't share personal financial info\n❌ Don't ignore follow-ups\n\nWelcome aboard! 🏠`;

  await whatsappService.sendWhatsAppGroupText({
    groupJid: result.groupJid || "",
    text: welcomeMsg,
    landlordId: authReq.landlordId,
  });

  res.json({ ok: true, groupJid: result.groupJid });
});

router.post("/utilities/credentials", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const parsed = utilityCredentialSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  }
  const credential = await repo.createUtilityCredential({ ...parsed.data, landlordId: authReq.landlordId });
  res.json({ credential });
});

router.patch("/utilities/credentials/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyUtilityCredentialOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const parsed = utilityCredentialUpdateSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  const credential = await repo.updateUtilityCredential({ id: req.params.id, ...parsed.data });
  if (!credential) return res.status(404).json({ error: "not_found" });
  res.json({ credential });
});

router.delete("/utilities/credentials/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyUtilityCredentialOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const credential = await repo.deleteUtilityCredential({ id: req.params.id });
  if (!credential) return res.status(404).json({ error: "not_found" });
  res.json({ deleted: true });
});

/** Fetch bill using saved credential — LLM-driven agentic browser for multi-step logins */
router.post("/utilities/credentials/:id/fetch-bill", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  try {
    // Ownership check
    if (!(await repo.verifyUtilityCredentialOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });

    // 1. Load credential
    const cred = await db.utilityCredential.findUnique({ where: { id: req.params.id } });
    if (!cred) return res.status(404).json({ error: "Credential not found" });

    // 2. Decrypt password
    const password = await repo.getDecryptedUtilityPassword(cred.id);
    if (!cred.username || !password) {
      return res.status(400).json({ error: "Credential missing username or password. Please update it." });
    }

    const loginUrl = cred.url || "";
    if (!loginUrl) {
      return res.status(400).json({ error: "No portal URL saved. Edit the credential and add the login URL." });
    }

    // 3. Try undetected-chromedriver (Python) first — best bot-detection bypass
    //    Falls back to agentic browser, then simple Puppeteer
    try {
      const { execFile } = require("child_process");
      const path = require("path");
      const scriptPath = path.join(__dirname, "../../scripts/fetchBill.py");

      // Check if the script exists
      const fs = require("fs");
      if (fs.existsSync(scriptPath)) {
        const ucResult: any = await new Promise((resolve, reject) => {
          const child = execFile(
            "python",
            [scriptPath, "--url", loginUrl, "--stdin", "--timeout", "300", "--debug"],
            { timeout: 600000, maxBuffer: 20 * 1024 * 1024 },
            (err: any, stdout: string, stderr: string) => {
              if (stderr) console.log("[FetchBill/UC] stderr:", stderr); // eslint-disable-line no-console
              if (err && !stdout) return reject(err);
              try {
                resolve(JSON.parse(stdout));
              } catch (parseErr) {
                reject(new Error(`Failed to parse Python output: ${stdout?.slice(0, 500)}`));
              }
            },
          );
          // Send credentials + Gemini key + notes via stdin (more secure than command args)
          const geminiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
          console.log(`[FetchBill] Sending to Python: username=${cred.username ? "YES(" + cred.username.length + " chars)" : "EMPTY"}, password=${password ? "YES(" + password.length + " chars)" : "EMPTY"}, geminiKey=${geminiKey ? "YES" : "EMPTY"}, url=${loginUrl}`); // eslint-disable-line no-console
          child.stdin?.write(JSON.stringify({ username: cred.username, password, geminiKey, notes: cred.notes || "" }));
          child.stdin?.end();
        });

        if (ucResult) {
          // Check if 2FA is required
          if (ucResult.needs2fa) {
            return res.json({
              ok: false,
              needs2fa: true,
              mode: "undetected-chrome",
              utilityType: cred.utilityType,
              unitId: cred.unitId,
              credentialId: cred.id,
              tfaChannel: ucResult.tfaChannel || "Unknown",
              sessionFile: ucResult.sessionFile || "",
              screenshot: ucResult.screenshot || undefined,
              pageText: (ucResult.pageText || "").slice(0, 4000),
              pageTitle: ucResult.pageTitle || "",
              url: ucResult.url || loginUrl,
              stepsUsed: ucResult.steps?.length || 0,
              stepSummary: ucResult.steps || [],
              note: ucResult.note || "2FA verification required. Enter the code sent to your device.",
            });
          }

          // ── Auto-save bill to database if billing data was extracted ──
          let savedBill: any = null;
          if (ucResult.ok && ucResult.billingData) {
            const bd = ucResult.billingData;
            const amountStr = bd.totalAmountDue || bd.allAmounts?.[0] || "";
            const amountNum = parseFloat(String(amountStr).replace(/[$,]/g, ""));
            if (!isNaN(amountNum) && amountNum > 0) {
              try {
                savedBill = await repo.createUtilityBill({
                  unitId: cred.unitId || undefined,
                  utilityType: cred.utilityType,
                  amountCents: Math.round(amountNum * 100),
                  currency: "CAD",
                  billingPeriodStart: bd.billingPeriod ? new Date() : undefined,
                  billingPeriodEnd: bd.dueDate ? new Date(bd.dueDate) : undefined,
                  portalUsername: cred.username || undefined,
                  rawData: ucResult.billingData,
                });
                console.log(`[FetchBill] Auto-saved bill: $${amountNum} for ${cred.utilityType}`); // eslint-disable-line no-console
              } catch (billErr) {
                console.warn("[FetchBill] Failed to auto-save bill:", (billErr as Error).message); // eslint-disable-line no-console
              }
            }
          }

          return res.json({
            ok: ucResult.ok,
            mode: "undetected-chrome",
            utilityType: cred.utilityType,
            unitId: cred.unitId,
            pageTitle: ucResult.pageTitle || "",
            url: ucResult.url || loginUrl,
            amountsFound: ucResult.amountsFound || [],
            datesFound: ucResult.datesFound || [],
            billingData: ucResult.billingData || undefined,
            savedBill: savedBill || undefined,
            pageText: (ucResult.pageText || "").slice(0, 8000),
            screenshot: ucResult.screenshot || undefined,
            stepsUsed: ucResult.steps?.length || 0,
            error: ucResult.error,
            stepSummary: ucResult.steps || [],
            note: ucResult.ok
              ? (savedBill
                ? `Bill of $${(savedBill.amountCents / 100).toFixed(2)} auto-saved to utilities.`
                : "Undetected Chrome successfully navigated the portal. Review the data and create a bill from the Bills tab.")
              : `Undetected Chrome could not complete login. ${ucResult.error || "Check step details."}`,
          });
        }
      }
    } catch (ucErr) {
      const ucErrMsg = (ucErr as Error).message || "";
      console.warn("[FetchBill] Undetected-chromedriver failed, falling back:", ucErrMsg); // eslint-disable-line no-console

      // Don't retry with other methods if credentials are wrong
      if (ucErrMsg.includes("Login failed") || ucErrMsg.includes("credentials") || ucErrMsg.includes("Invalid")) {
        return res.json({
          ok: false,
          mode: "undetected-chrome",
          utilityType: cred.utilityType,
          unitId: cred.unitId,
          error: "Login failed: credentials may be incorrect. Please update the username/password.",
          stepSummary: [],
          note: "Login credentials appear to be incorrect. Please edit the credential and update the username/password.",
        });
      }
    }

    // 4. Try agentic browser (LLM-powered), fall back to simple Puppeteer
    const { vertexAI, defaultModel } = require("../config/gemini");

    if (vertexAI) {
      // ── AGENTIC BROWSER MODE — handles multi-step logins, CAPTCHAs, etc. ──
      try {
        const { AgenticNavigator, createGeminiProvider } = require("../../packages/agentic-browser/src");
        const model = vertexAI.getGenerativeModel({ model: defaultModel });
        const llm = createGeminiProvider(model);

        const navigator = new AgenticNavigator({
          llm,
          headless: true,
          debug: process.env.AGENTIC_BROWSER_DEBUG === "true",
          timeout: 45000,
          captcha: {
            provider: (process.env.CAPTCHA_PROVIDER as any) || "none",
            apiKey: process.env.CAPTCHA_API_KEY || undefined,
            useLLMVision: true,
          },
        });

        const utilityLabel = cred.utilityType === "INTERNET" ? "internet/telecom"
          : cred.utilityType === "WATER_GAS" ? "water/gas"
            : "hydro/electricity";

        const result = await navigator.run({
          goal: `Log into this ${utilityLabel} provider portal and find the latest bill. Extract: the total amount owing/due, the billing period or statement date, and any usage data shown. If there is an account overview or billing summary page, navigate to it. Report all dollar amounts and dates you find.`,
          startUrl: loginUrl,
          credentials: { username: cred.username, password },
          maxSteps: 20,
        });

        // Build response
        const extractedAmounts: string[] = [];
        const extractedDates: string[] = [];
        let pageText = "";

        // Parse extracted data from the LLM
        if (result.extractedData) {
          const data = typeof result.extractedData === "string" ? result.extractedData : JSON.stringify(result.extractedData, null, 2);
          pageText = data;
          // Extract dollar amounts
          const amountMatches = data.match(/\$[\d,]+\.?\d{0,2}/g) || [];
          extractedAmounts.push(...amountMatches);
          // Extract dates
          const dateMatches = data.match(/\b(?:\w+ \d{1,2},?\s*\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/g) || [];
          extractedDates.push(...dateMatches);
        }

        // Get the final screenshot
        const lastStepWithScreenshot = [...result.steps].reverse().find((s: any) => s.screenshot);
        const screenshot = result.finalScreenshot || lastStepWithScreenshot?.screenshot;

        return res.json({
          ok: result.success,
          mode: "agentic",
          utilityType: cred.utilityType,
          unitId: cred.unitId,
          pageTitle: result.steps?.[result.steps.length - 1]?.pageTitle || "",
          url: result.finalUrl || loginUrl,
          amountsFound: extractedAmounts.slice(0, 20),
          datesFound: extractedDates.slice(0, 20),
          extractedData: result.extractedData,
          pageText: pageText.slice(0, 8000),
          screenshot: screenshot ? `data:image/png;base64,${screenshot}` : undefined,
          stepsUsed: result.steps?.length || 0,
          totalTimeMs: result.totalTimeMs,
          error: result.error,
          stepSummary: (result.steps || []).map((s: any) => ({
            step: s.stepNumber,
            action: s.action?.type,
            description: s.action?.description || s.action?.result || s.action?.reason,
          })),
          note: result.success
            ? "AI agent successfully navigated the portal. Review the extracted data and create a bill from the Bills tab."
            : "AI agent could not complete the task. Check the step summary for details.",
        });
      } catch (agenticErr) {
        console.warn("[FetchBill] Agentic browser failed, falling back to simple scraper:", (agenticErr as Error).message); // eslint-disable-line no-console
        // Fall through to simple Puppeteer below
      }
    }

    // ── SIMPLE PUPPETEER FALLBACK — for when Gemini is not configured ──
    let puppeteer: any;
    try {
      const pExtra = require("puppeteer-extra");
      const StealthPlugin = require("puppeteer-extra-plugin-stealth");
      pExtra.use(StealthPlugin());
      puppeteer = pExtra;
    } catch {
      try {
        puppeteer = require("puppeteer");
      } catch {
        try { puppeteer = require("puppeteer-core"); } catch {
          return res.status(500).json({ error: "Puppeteer not installed on server." });
        }
      }
    }

    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--window-size=1280,800",
        "--lang=en-US,en",
      ],
    });

    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

      // Extra anti-bot evasion
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        // @ts-ignore
        window.chrome = { runtime: { onMessage: { addListener: () => { }, removeListener: () => { } }, sendMessage: () => { } }, loadTimes: () => { }, csi: () => { } };
        Object.defineProperty(navigator, "plugins", { get: () => [{ name: "Chrome PDF Plugin" }, { name: "Chrome PDF Viewer" }, { name: "Native Client" }] });
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      });

      await page.goto(loginUrl, { waitUntil: "networkidle2", timeout: 30000 });
      // Small human delay after page loads
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));

      // Try to find and fill login — handle multi-step forms
      for (let attempt = 0; attempt < 3; attempt++) {
        const fields = await page.evaluate(() => {
          const userFields = document.querySelectorAll(
            'input[type="text"], input[type="email"], input[name*="user"], input[name*="email"], input[id*="user"], input[id*="email"], input[name*="login"], input[id*="login"]'
          );
          const passFields = document.querySelectorAll('input[type="password"]');
          return {
            hasUsername: userFields.length > 0,
            hasPassword: passFields.length > 0,
            userSelector: userFields.length > 0 ? `input[type="${(userFields[0] as any).type}"]` : null,
            pageTitle: document.title,
          };
        });

        // Step 1: Fill username if visible and no password yet (multi-step)
        if (fields.hasUsername && !fields.hasPassword) {
          await page.click(fields.userSelector!);
          await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
          await page.type(fields.userSelector!, cred.username, { delay: 50 + Math.random() * 80 });
          await new Promise(r => setTimeout(r, 800 + Math.random() * 800));
          // Click Continue/Next/Submit button
          const continueBtn = await page.$('button[type="submit"], button:not([type]), input[type="submit"]');
          if (continueBtn) { await continueBtn.click(); }
          else { await page.keyboard.press("Enter"); }
          await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => { });
          await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
          continue;
        }

        // Step 2: Fill password if visible
        if (fields.hasPassword) {
          // If username field is still visible (single-step login), fill it too
          if (fields.hasUsername) {
            const usernameEmpty = await page.evaluate((sel: string) => {
              const el = document.querySelector(sel) as HTMLInputElement;
              return el ? !el.value : true;
            }, fields.userSelector!);
            if (usernameEmpty) {
              await page.click(fields.userSelector!);
              await page.type(fields.userSelector!, cred.username, { delay: 30 });
            }
          }
          await page.click("input[type='password']");
          await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
          await page.type("input[type='password']", password, { delay: 50 + Math.random() * 80 });
          await new Promise(r => setTimeout(r, 800 + Math.random() * 800));
          const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
          if (submitBtn) { await submitBtn.click(); } else { await page.keyboard.press("Enter"); }
          await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => { });
          break;
        }

        // Neither field found — break
        break;
      }

      // Extract billing data
      const billingData = await page.evaluate(() => {
        const text = document.body?.innerText || "";
        const amounts = text.match(/\$[\d,]+\.?\d{0,2}/g) || [];
        const dates = text.match(/\b(?:\w+ \d{1,2},?\s*\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/g) || [];
        return {
          pageText: text.slice(0, 8000),
          pageTitle: document.title,
          amountsFound: amounts.slice(0, 20),
          datesFound: dates.slice(0, 20),
          url: window.location.href,
        };
      });

      const screenshot = await page.screenshot({ encoding: "base64", type: "png" });

      res.json({
        ok: true,
        mode: "simple",
        utilityType: cred.utilityType,
        unitId: cred.unitId,
        ...billingData,
        screenshot: `data:image/png;base64,${screenshot}`,
        note: "Review the scraped data. If amounts are correct, you can manually create a bill from the Bills tab.",
      });
    } finally {
      await page.close();
      await browser.close();
    }
  } catch (err) {
    res.status(500).json({ error: `Fetch failed: ${(err as Error).message}` });
  }
});

// ── 2FA Resume endpoint — send verification code to complete login ──
router.post("/utilities/credentials/:id/fetch-bill-2fa", async (req, res) => {
  try {
    const authReq = req as unknown as AuthRequest;
    if (!(await repo.verifyUtilityCredentialOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });

    const { code, sessionFile } = req.body || {};
    if (!code || !sessionFile) {
      return res.status(400).json({ error: "Verification code and sessionFile are required" });
    }

    const cred = await db.utilityCredential.findUnique({ where: { id: req.params.id } });
    if (!cred) return res.status(404).json({ error: "Credential not found" });

    const loginUrl = cred.url || "";
    if (!loginUrl) {
      return res.status(400).json({ error: "No portal URL saved." });
    }

    const { execFile } = require("child_process");
    const path = require("path");
    const fs = require("fs");
    const scriptPath = path.join(__dirname, "../../scripts/fetchBill.py");

    if (!fs.existsSync(scriptPath)) {
      return res.status(500).json({ error: "fetchBill.py script not found" });
    }

    // Verify session file exists
    if (!fs.existsSync(sessionFile)) {
      return res.status(400).json({ error: "Session expired or file not found. Please re-fetch the bill." });
    }

    const ucResult: any = await new Promise((resolve, reject) => {
      const child = execFile(
        "python",
        [
          scriptPath,
          "--url", loginUrl,
          "--resume",
          "--session-file", sessionFile,
          "--stdin",
          "--timeout", "300",
          "--debug",
        ],
        { timeout: 600000, maxBuffer: 20 * 1024 * 1024 },
        (err: any, stdout: string, stderr: string) => {
          if (stderr) console.log("[FetchBill/2FA] stderr:", stderr); // eslint-disable-line no-console
          if (err && !stdout) return reject(err);
          try {
            resolve(JSON.parse(stdout));
          } catch (parseErr) {
            reject(new Error(`Failed to parse Python output: ${stdout?.slice(0, 500)}`));
          }
        },
      );
      // Send the verification code + Gemini key + notes via stdin
      const geminiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
      child.stdin?.write(JSON.stringify({ code: String(code), geminiKey, notes: cred.notes || "" }));
      child.stdin?.end();
    });

    // Clean up session file
    try { fs.unlinkSync(sessionFile); } catch { }

    // ── Auto-save bill to database if billing data was extracted after 2FA ──
    let savedBill: any = null;
    if (ucResult.ok && ucResult.billingData) {
      const bd = ucResult.billingData;
      const amountStr = bd.totalAmountDue || bd.allAmounts?.[0] || "";
      const amountNum = parseFloat(String(amountStr).replace(/[$,]/g, ""));
      if (!isNaN(amountNum) && amountNum > 0) {
        try {
          savedBill = await repo.createUtilityBill({
            unitId: cred.unitId || undefined,
            utilityType: cred.utilityType,
            amountCents: Math.round(amountNum * 100),
            currency: "CAD",
            billingPeriodStart: bd.billingPeriod ? new Date() : undefined,
            billingPeriodEnd: bd.dueDate ? new Date(bd.dueDate) : undefined,
            portalUsername: cred.username || undefined,
            rawData: ucResult.billingData,
          });
          console.log(`[FetchBill/2FA] Auto-saved bill: $${amountNum} for ${cred.utilityType}`); // eslint-disable-line no-console
        } catch (billErr) {
          console.warn("[FetchBill/2FA] Failed to auto-save bill:", (billErr as Error).message); // eslint-disable-line no-console
        }
      }
    }

    return res.json({
      ok: ucResult.ok,
      mode: "undetected-chrome",
      utilityType: cred.utilityType,
      unitId: cred.unitId,
      pageTitle: ucResult.pageTitle || "",
      url: ucResult.url || loginUrl,
      amountsFound: ucResult.amountsFound || [],
      datesFound: ucResult.datesFound || [],
      billingData: ucResult.billingData || undefined,
      savedBill: savedBill || undefined,
      pageText: (ucResult.pageText || "").slice(0, 8000),
      screenshot: ucResult.screenshot || undefined,
      stepsUsed: ucResult.steps?.length || 0,
      error: ucResult.error,
      stepSummary: ucResult.steps || [],
      note: ucResult.ok
        ? (savedBill
          ? `2FA verification successful! Bill of $${(savedBill.amountCents / 100).toFixed(2)} auto-saved to utilities.`
          : "2FA verification successful! Review the data and create a bill from the Bills tab.")
        : `2FA verification completed but could not extract bill data. ${ucResult.error || "Check step details."}`,
    });
  } catch (err) {
    res.status(500).json({ error: `2FA verification failed: ${(err as Error).message}` });
  }
});

router.get("/utilities/credentials", async (req, res) => {
  const unitId = typeof req.query?.unitId === "string" ? req.query.unitId : undefined;
  const utilityType = typeof req.query?.utilityType === "string" ? req.query.utilityType : undefined;
  const items = await repo.listUtilityCredentials({ unitId, utilityType });
  res.json({ items });
});

router.get("/utilities/bills", async (req, res) => {
  const unitId = typeof req.query?.unitId === "string" ? req.query.unitId : undefined;
  const tenantId = typeof req.query?.tenantId === "string" ? req.query.tenantId : undefined;
  const limit = req.query?.limit ? Number(req.query.limit) : undefined;
  const items = await repo.listUtilityBills({ unitId, tenantId, limit });
  res.json({ items });
});

router.post("/utilities/bills", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const parsed = utilityBillSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  const bill = await repo.createUtilityBill({
    ...parsed.data,
    landlordId: authReq.landlordId,
    billingPeriodStart: parsed.data.billingPeriodStart ? new Date(parsed.data.billingPeriodStart) : undefined,
    billingPeriodEnd: parsed.data.billingPeriodEnd ? new Date(parsed.data.billingPeriodEnd) : undefined,
  });
  res.json({ bill });
});

router.patch("/utilities/bills/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyUtilityBillOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const parsed = utilityBillUpdateSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  const bill = await repo.updateUtilityBill({
    id: req.params.id,
    ...parsed.data,
    billingPeriodStart: parsed.data.billingPeriodStart ? new Date(parsed.data.billingPeriodStart) : undefined,
    billingPeriodEnd: parsed.data.billingPeriodEnd ? new Date(parsed.data.billingPeriodEnd) : undefined,
  });
  if (!bill) return res.status(404).json({ error: "not_found" });
  res.json({ bill });
});

router.delete("/utilities/bills/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyUtilityBillOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const bill = await repo.deleteUtilityBill({ id: req.params.id });
  if (!bill) return res.status(404).json({ error: "not_found" });
  res.json({ deleted: true });
});

router.post("/whatsapp/test", async (req, res) => {
  const parsed = whatsappTestSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  }
  const result = await whatsappService.sendWhatsAppText({ to: parsed.data.to, text: parsed.data.message, session: parsed.data.session });
  if (!result.ok) return res.status(400).json({ error: result.error || "send_failed", response: result.response });
  res.json({ ok: true, response: result.response });
});

router.get("/landlord-numbers", (req, res) => {
  const authReq = req as unknown as AuthRequest;
  res.json({ numbers: authReq.landlord.whatsappNumbers });
});

router.post("/landlord-numbers", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const numbers = Array.isArray(req.body?.numbers) ? req.body.numbers : typeof req.body?.numbers === "string" ? req.body.numbers.split(",").map((v: string) => v.trim()).filter(Boolean) : [];
  const { db } = require("../config/database");
  await db.landlord.update({ where: { id: authReq.landlordId }, data: { whatsappNumbers: numbers } });
  res.json({ numbers });
});

const statusSchema = z.object({
  status: z.nativeEnum(MaintenanceStatus),
});

router.patch("/maintenance/:id/status", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyMaintenanceOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const parsed = statusSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  }
  const updated = await repo.updateMaintenanceStatus({ id: req.params.id, status: parsed.data.status });
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json({ maintenance: updated });
});

router.delete("/maintenance/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyMaintenanceOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const deleted = await repo.deleteMaintenance({ id: req.params.id });
  if (!deleted) return res.status(404).json({ error: "not_found" });
  res.json({ deleted: true });
});

router.get("/auto-reply", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const setting = await repo.getGlobalAutoReplyEnabled(authReq.landlordId);
  res.json({ enabled: setting.enabled, source: setting.source });
});

router.get("/auto-reply-delay", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const setting = await repo.getGlobalAutoReplyDelayMinutes(authReq.landlordId);
  res.json({ minutes: setting.minutes, source: setting.source });
});

router.get("/auto-reply-cooldown", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const setting = await repo.getGlobalAutoReplyCooldownMinutes(authReq.landlordId);
  res.json({ minutes: setting.minutes, source: setting.source });
});

router.patch("/auto-reply", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const schema = z.object({ enabled: z.boolean() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  const updated = await repo.setGlobalAutoReplyEnabled({ enabled: parsed.data.enabled, landlordId: authReq.landlordId });
  if (!updated) return res.status(500).json({ error: "auto_reply_update_failed" });
  res.json({ enabled: parsed.data.enabled });
});

router.patch("/auto-reply-delay", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const schema = z.object({ minutes: z.number().min(0).max(120) });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  const updated = await repo.setGlobalAutoReplyDelayMinutes({ minutes: parsed.data.minutes, landlordId: authReq.landlordId });
  if (!updated) return res.status(500).json({ error: "auto_reply_delay_update_failed" });
  res.json({ minutes: parsed.data.minutes });
});

router.patch("/auto-reply-cooldown", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const schema = z.object({ minutes: z.number().min(0).max(240) });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  const updated = await repo.setGlobalAutoReplyCooldownMinutes({ minutes: parsed.data.minutes, landlordId: authReq.landlordId });
  if (!updated) return res.status(500).json({ error: "auto_reply_cooldown_update_failed" });
  res.json({ minutes: parsed.data.minutes });
});

router.get("/health", async (_req, res) => {
  const whatsappReady = Boolean(process.env.EVOLUTION_API_BASE_URL && process.env.EVOLUTION_API_TOKEN);
  const llmReady = await agentService.pingLlm();
  const utilityReady = Boolean(process.env.UTILITY_AGENT_URL);
  const jeffyReady = Boolean(process.env.JEFFY_API_URL);
  res.json({
    llm: llmReady ? "connected" : "disconnected",
    whatsapp: whatsappReady ? "connected" : "disconnected",
    utility: utilityReady ? "connected" : "disconnected",
    jeffy: jeffyReady ? "connected" : "disconnected",
  });
});

router.get("/webhook-status", (_req, res) => {
  res.json({ status: getWebhookStatus() });
});

router.get("/reminders", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const items = await listReminders(authReq.landlordId);
  res.json({ items });
});

router.post("/reminders", async (req, res) => {
  const schema = z.object({
    type: z.enum(["rent", "utility"]),
    dayOfMonth: z.number().min(1).max(28),
    timeUtc: z.string().min(4),
    style: z.enum(["short", "medium", "professional", "casual"]),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  const authReq = req as unknown as AuthRequest;
  const reminder = await addReminder({ id: `rem-${Date.now()}`, landlordId: authReq.landlordId, ...parsed.data });
  res.json({ reminder });
});

router.delete("/reminders/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyReminderOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const deleted = await deleteReminder(req.params.id);
  if (!deleted) return res.status(404).json({ error: "not_found" });
  res.json({ deleted: true });
});

router.patch("/reminders/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyReminderOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const active = typeof req.body?.active === "boolean" ? req.body.active : undefined;
  if (active === undefined) return res.status(400).json({ error: "missing_active_flag" });
  const updated = await toggleReminder(req.params.id, active);
  if (!updated) return res.status(404).json({ error: "not_found" });
  res.json({ reminder: updated });
});

router.post("/utilities/bills/:id/send-whatsapp", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (!(await repo.verifyUtilityBillOwnership(req.params.id, authReq.landlordId))) return res.status(403).json({ error: "forbidden" });
  const number = typeof req.body?.to === "string" ? req.body.to : undefined;
  const statementUrl = typeof req.body?.statementUrl === "string" ? req.body.statementUrl : undefined;
  const text = typeof req.body?.message === "string" ? req.body.message : "Utility bill available";
  if (!number) return res.status(400).json({ error: "destination_required" });
  const payloadText = statementUrl ? `${text}\n${statementUrl}` : text;
  const sent = await whatsappService.sendWhatsAppText({ to: number, text: payloadText, session: req.body?.session });
  if (!sent.ok) return res.status(400).json({ error: sent.error || "send_failed", response: sent.response });
  res.json({ ok: true, response: sent.response });
});

// ── Billing / Plans ─────────────────────────────────────

router.post("/billing/checkout", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const schema = z.object({ plan: z.enum(["PRO", "ENTERPRISE"]) });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });
  const result = await createCheckoutSession(authReq.landlordId, parsed.data.plan);
  if (result.error) return res.status(400).json(result);
  res.json({ url: result.url });
});

router.get("/billing/plans", (_req, res) => {
  const { PLANS } = require("../services/planService");
  res.json({ plans: PLANS });
});

// ── Profile ──────────────────────────────────────────────────
router.get("/profile", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  try {
    const landlord = await db.landlord.findUnique({
      where: { id: authReq.landlordId },
      select: { id: true, email: true, name: true, company: true, phone: true, plan: true, province: true, whatsappNumbers: true, evolutionInstanceName: true, createdAt: true },
    });
    if (!landlord) return res.status(404).json({ error: "not_found" });
    const { PLANS } = require("../services/planService");
    const planLimits = PLANS[landlord.plan] || PLANS.FREE;
    res.json({ ...landlord, limits: planLimits });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Province / RTA ──────────────────────────────────────

router.get("/provinces", (_req, res) => {
  res.json({ provinces: listProvinces() });
});

// ═══════════════════════════════════════════════════════════
//  AGENTIC ENDPOINTS — Tool-use agent loops
// ═══════════════════════════════════════════════════════════

/** Ask the landlord assistant agent a question (tool-use loop) */
router.post("/agent/ask", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const schema = z.object({
    question: z.string().min(1),
    maintenanceId: z.string().optional(),
    mediaBase64: z.string().optional(),
    mediaMimeType: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });

  try {
    // Save the user's question to conversation memory
    await conversationMemory.saveMessage({
      phone: "dashboard-agent",
      landlordId: authReq.landlordId,
      role: "landlord",
      content: parsed.data.question,
    });

    // Build media parts if provided
    const mediaParts: Array<{ base64: string; mimeType: string }> = [];
    if (parsed.data.mediaBase64 && parsed.data.mediaMimeType) {
      mediaParts.push({ base64: parsed.data.mediaBase64, mimeType: parsed.data.mediaMimeType });
    }

    // Check message limit before proceeding
    const msgLimit = await checkPlanLimit(authReq.landlordId, "messages");
    if (!msgLimit.allowed) {
      return res.status(429).json({
        error: "message_limit_reached",
        message: `You've reached your monthly message limit (${msgLimit.current}/${msgLimit.max}). Upgrade your plan for more messages.`,
        usage: { current: msgLimit.current, max: msgLimit.max, plan: msgLimit.plan },
      });
    }

    const result = await orchestrator.landlordAssistantAgent({
      landlordId: authReq.landlordId,
      question: parsed.data.question,
      maintenanceId: parsed.data.maintenanceId,
      mediaParts: mediaParts.length ? mediaParts : undefined,
    });

    // Increment message count after successful agent response
    incrementMessageCount(authReq.landlordId).catch(() => { });

    // Save the AI response to conversation memory
    await conversationMemory.saveMessage({
      phone: "dashboard-agent",
      landlordId: authReq.landlordId,
      role: "ai",
      content: result.finalAnswer || "",
      meta: { toolCalls: result.toolCallCount, steps: result.steps.length },
    });

    // Extract any PDF artifacts from tool results (for download in dashboard)
    const pdfArtifacts: Array<{ pdfBase64: string; fileName: string }> = [];
    for (const step of result.steps || []) {
      for (const tr of step.toolResults || []) {
        const r = tr.result as any;
        if (r && r.pdfBase64 && r.fileName) {
          pdfArtifacts.push({ pdfBase64: r.pdfBase64, fileName: r.fileName });
        }
      }
    }

    res.json({ ...result, pdfArtifacts });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /admin/agent/history — Retrieve dashboard agent chat history */
router.get("/agent/history", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const history = await conversationMemory.getHistory({
      phone: "dashboard-agent",
      landlordId: authReq.landlordId,
      limit,
    });
    res.json({ messages: history, total: history.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** DELETE /admin/agent/history — Clear dashboard agent chat history */
router.delete("/agent/history", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  try {
    const result = await db.conversationMessage.deleteMany({
      where: { phone: "dashboard-agent", landlordId: authReq.landlordId },
    });
    res.json({ ok: true, deleted: result.count });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Run the utility bill scraper agent */
router.post("/agent/utility-check", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const schema = z.object({
    unitId: z.string().min(1),
    utilityType: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });

  try {
    const result = await orchestrator.runUtilityBillAgent({
      landlordId: authReq.landlordId,
      unitId: parsed.data.unitId,
      utilityType: parsed.data.utilityType,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Utility chat — conversational utility assistant */
router.post("/agent/utility-chat", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const schema = z.object({
    question: z.string().min(1),
    unitId: z.string().optional(),
    utilityType: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });

  try {
    const context: string[] = [];
    if (parsed.data.unitId) context.push(`Unit ID: ${parsed.data.unitId}`);
    if (parsed.data.utilityType) context.push(`Utility type: ${parsed.data.utilityType}`);

    const userMessage = context.length
      ? `[Context: ${context.join(", ")}]\n\n${parsed.data.question}`
      : parsed.data.question;

    const result = await orchestrator.landlordAssistantAgent({
      landlordId: authReq.landlordId,
      question: userMessage,
    });
    res.json({ answer: result.finalAnswer, steps: result.steps.length, toolCalls: result.toolCallCount });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Read and summarize a webpage (mobile browser) */
router.post("/agent/read-page", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const schema = z.object({
    url: z.string().url(),
    question: z.string().optional(),
    summarize: z.boolean().optional(),
    mobile: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });

  try {
    if (parsed.data.summarize !== false) {
      // Use the agent loop for intelligent page reading
      const result = await orchestrator.readPageAgent({
        url: parsed.data.url,
        question: parsed.data.question,
        landlordId: authReq.landlordId,
      });
      return res.json(result);
    }

    // Raw page read (no AI)
    const page = await readPage(parsed.data.url, { mobile: parsed.data.mobile });
    res.json(page);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Standalone web search — search the web for manuals, guides, product info */
router.post("/agent/web-search", agentRateLimit, async (req, res) => {
  const schema = z.object({
    query: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });

  try {
    const authReq = req as unknown as AuthRequest;
    const landlord = await repo.getLandlordById(authReq.landlordId);
    const plan = (landlord?.plan || "FREE") as "FREE" | "PRO" | "ENTERPRISE";
    const registry = orchestrator.buildToolRegistry(plan);
    const searchTool = registry.get("web_search");
    if (!searchTool) return res.status(400).json({ error: "web_search tool not available" });

    const result = await searchTool.execute({ query: parsed.data.query });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** List available tools for the current plan */
router.get("/agent/tools", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const landlord = await repo.getLandlordById(authReq.landlordId);
  const plan = (landlord?.plan || "FREE") as "FREE" | "PRO" | "ENTERPRISE";
  const registry = orchestrator.buildToolRegistry(plan);
  const tools = registry.listEnabled().map(t => ({
    name: t.name,
    description: t.description,
    category: t.category,
    parameters: t.parameters,
  }));
  res.json({ plan, tools });
});

// ═══════════════════════════════════════════════════════════
//  CONVERSATION HISTORY
// ═══════════════════════════════════════════════════════════

/** Get conversation history for a phone number */
router.get("/conversations/:phone", async (req: any, res) => {
  const authReq = req as unknown as AuthRequest;
  const limit = Number(req.query.limit) || 30;
  const messages = await conversationMemory.getHistory({
    phone: req.params.phone,
    landlordId: authReq.landlordId,
    limit,
  });
  res.json({ phone: req.params.phone, messages, count: messages.length });
});

// ═══════════════════════════════════════════════════════════
//  AGENT USAGE / TOKEN TRACKING
// ═══════════════════════════════════════════════════════════

/** Get agent usage stats for the current landlord */
router.get("/agent/usage", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const days = Number(req.query.days) || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const usage = await db.agentUsage.findMany({
      where: {
        landlordId: authReq.landlordId,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    const summary = {
      totalCalls: usage.length,
      totalTokens: usage.reduce((sum: number, u: any) => sum + u.totalTokens, 0),
      totalToolCalls: usage.reduce((sum: number, u: any) => sum + u.toolCalls, 0),
      avgDurationMs: usage.length ? Math.round(usage.reduce((sum: number, u: any) => sum + u.durationMs, 0) / usage.length) : 0,
      byTaskType: {} as Record<string, { calls: number; tokens: number }>,
    };

    for (const u of usage) {
      const tt = u.taskType || "unknown";
      if (!summary.byTaskType[tt]) summary.byTaskType[tt] = { calls: 0, tokens: 0 };
      summary.byTaskType[tt].calls++;
      summary.byTaskType[tt].tokens += u.totalTokens;
    }

    res.json({ days, since: since.toISOString(), summary, recent: usage.slice(0, 20) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════
//  LEASE EXPIRY MANAGEMENT
// ═══════════════════════════════════════════════════════════

/** Get leases expiring soon */
router.get("/leases/expiring", async (req, res) => {
  const days = Number(req.query.days) || 60;
  try {
    const authReq = req as unknown as AuthRequest;
    const allLeases = await findExpiringLeases(days);
    // Filter to only this landlord's leases
    const leases = allLeases.filter((l) => l.landlordId === authReq.landlordId);
    res.json({ leases, count: leases.length, daysAhead: days });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Manually trigger lease expiry alerts */
router.post("/leases/send-alerts", async (req, res) => {
  try {
    const sent = await sendLeaseExpiryAlerts();
    res.json({ ok: true, alertsSent: sent });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════
//  GREEN BUTTON — Utility Data Integration
// ═══════════════════════════════════════════════════════════

/** List available Green Button providers across Ontario */
router.get("/green-button/providers", (_req, res) => {
  const providers = greenButton.GTA_PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    shortName: p.shortName,
    utilityType: p.utilityType,
    region: p.region,
    supportsCMD: p.supportsCMD,
    supportsDMD: p.supportsDMD,
    supportsInterval: p.supportsInterval,
    supportsBilling: p.supportsBilling,
    customerPortalUrl: p.customerPortalUrl,
    registrationUrl: p.registrationUrl,
    notes: p.notes,
  }));
  res.json({ providers });
});

/** List connections for this landlord */
router.get("/green-button/connections", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  try {
    const connections = await db.greenButtonConnection.findMany({
      where: { landlordId: authReq.landlordId },
      include: { unit: { select: { id: true, label: true, address: true } } },
      orderBy: { createdAt: "desc" },
    });
    // Strip tokens from response
    const safe = connections.map((c) => ({
      ...c,
      accessToken: c.accessToken ? "••••••" : null,
      refreshToken: c.refreshToken ? "••••••" : null,
    }));
    res.json({ items: safe });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Create a new Green Button connection (initiate OAuth or manual) */
router.post("/green-button/connections", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const schema = z.object({
    provider: z.string().min(1),
    unitId: z.string().min(1),
    utilityType: z.nativeEnum(UtilityType),
    accountNumber: z.string().optional(),
    meterNumber: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });

  const provider = greenButton.getProvider(parsed.data.provider);
  if (!provider) return res.status(400).json({ error: "unknown_provider" });

  try {
    const connection = await db.greenButtonConnection.create({
      data: {
        provider: parsed.data.provider,
        utilityType: parsed.data.utilityType,
        unitId: parsed.data.unitId,
        landlordId: authReq.landlordId,
        accountNumber: parsed.data.accountNumber,
        meterNumber: parsed.data.meterNumber,
        status: "pending",
      },
    });

    // If provider supports CMD, build auth URL
    let authUrl: string | undefined;
    const clientId = process.env[`GB_${parsed.data.provider.toUpperCase()}_CLIENT_ID`];
    const redirectUri = process.env.GB_REDIRECT_URI || `${req.protocol}://${req.get("host")}/admin/green-button/callback`;
    if (provider.supportsCMD && clientId) {
      authUrl = greenButton.buildAuthorizationUrl(provider, {
        clientId,
        redirectUri,
        state: connection.id,
      });
    }

    res.json({
      connection,
      authUrl,
      provider: {
        name: provider.name,
        supportsCMD: provider.supportsCMD,
        supportsDMD: provider.supportsDMD,
        customerPortalUrl: provider.customerPortalUrl,
      },
    });
  } catch (err: any) {
    if (err.code === "P2002") return res.status(409).json({ error: "connection_exists", message: "A connection for this provider, unit, and utility type already exists." });
    res.status(500).json({ error: (err as Error).message });
  }
});

/** OAuth callback — exchange code for tokens */
router.get("/green-button/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Authorization denied: ${error}`);
  if (!code || !state) return res.status(400).send("Missing code or state parameter");

  try {
    const connection = await db.greenButtonConnection.findUnique({ where: { id: String(state) } });
    if (!connection) return res.status(404).send("Connection not found");

    const provider = greenButton.getProvider(connection.provider);
    if (!provider) return res.status(400).send("Unknown provider");

    const clientId = process.env[`GB_${connection.provider.toUpperCase()}_CLIENT_ID`] || "";
    const clientSecret = process.env[`GB_${connection.provider.toUpperCase()}_CLIENT_SECRET`] || "";
    const redirectUri = process.env.GB_REDIRECT_URI || `${req.protocol}://${req.get("host")}/admin/green-button/callback`;

    const tokens = await greenButton.exchangeCodeForTokens(provider, {
      code: String(code),
      clientId,
      clientSecret,
      redirectUri,
    });

    await db.greenButtonConnection.update({
      where: { id: connection.id },
      data: {
        accessToken: greenButton.encryptToken(tokens.accessToken),
        refreshToken: greenButton.encryptToken(tokens.refreshToken),
        tokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
        subscriptionId: tokens.subscriptionId,
        status: "connected",
        lastError: null,
      },
    });

    // Redirect back to dashboard
    res.redirect("/dashboard.html#utilities");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Green Button OAuth callback failed", err);
    res.status(500).send(`OAuth exchange failed: ${(err as Error).message}`);
  }
});

/** Sync (fetch) latest usage data from a connected provider */
router.post("/green-button/sync/:connectionId", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  try {
    const connection = await db.greenButtonConnection.findUnique({ where: { id: req.params.connectionId } });
    if (!connection || connection.landlordId !== authReq.landlordId) return res.status(404).json({ error: "not_found" });
    if (connection.status !== "connected" || !connection.accessToken) {
      return res.status(400).json({ error: "not_connected", message: "Connection is not authorized. Complete OAuth flow first." });
    }

    const provider = greenButton.getProvider(connection.provider);
    if (!provider) return res.status(400).json({ error: "unknown_provider" });

    // Check if token needs refresh
    let accessToken = greenButton.decryptToken(connection.accessToken);
    if (connection.tokenExpiresAt && connection.tokenExpiresAt < new Date()) {
      if (!connection.refreshToken) {
        await db.greenButtonConnection.update({ where: { id: connection.id }, data: { status: "expired", lastError: "Token expired, no refresh token" } });
        return res.status(401).json({ error: "token_expired" });
      }
      const clientId = process.env[`GB_${connection.provider.toUpperCase()}_CLIENT_ID`] || "";
      const clientSecret = process.env[`GB_${connection.provider.toUpperCase()}_CLIENT_SECRET`] || "";
      const refreshed = await greenButton.refreshAccessToken(provider, {
        refreshToken: greenButton.decryptToken(connection.refreshToken),
        clientId,
        clientSecret,
      });
      accessToken = refreshed.accessToken;
      await db.greenButtonConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: greenButton.encryptToken(refreshed.accessToken),
          refreshToken: greenButton.encryptToken(refreshed.refreshToken),
          tokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        },
      });
    }

    // Fetch usage data
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 3); // Last 3 months
    const data = await greenButton.fetchUsageData(provider, {
      accessToken,
      subscriptionId: connection.subscriptionId || undefined,
      usagePointId: connection.usagePointId || undefined,
      startDate,
    });

    // Convert to bills and save
    const bills = greenButton.convertToBills(data, {
      unitId: connection.unitId,
      landlordId: authReq.landlordId,
      provider: connection.provider,
      utilityType: connection.utilityType as "HYDRO" | "WATER_GAS",
    });

    let savedCount = 0;
    for (const bill of bills) {
      // Avoid duplicates: check if bill already exists for this period + unit + type
      const existing = await db.utilityBill.findFirst({
        where: {
          unitId: bill.unitId,
          utilityType: bill.utilityType as UtilityType,
          billingPeriodStart: bill.billingPeriodStart,
          billingPeriodEnd: bill.billingPeriodEnd,
        },
      });
      if (!existing) {
        await db.utilityBill.create({ data: bill as any });
        savedCount++;
      }
    }

    await db.greenButtonConnection.update({
      where: { id: connection.id },
      data: { lastSyncAt: new Date(), lastError: null },
    });

    res.json({
      ok: true,
      usagePoints: data.usagePoints.length,
      intervalReadings: data.intervalReadings.length,
      usageSummaries: data.usageSummaries.length,
      billsSaved: savedCount,
      totalBillsFound: bills.length,
    });
  } catch (err) {
    // Update connection with error
    await db.greenButtonConnection.update({
      where: { id: req.params.connectionId },
      data: { lastError: (err as Error).message, status: "error" },
    }).catch(() => { });
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Upload Green Button XML file (Download My Data) */
router.post("/green-button/upload", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const schema = z.object({
    xml: z.string().min(10),
    unitId: z.string().min(1),
    provider: z.string().min(1),
    utilityType: z.nativeEnum(UtilityType),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });

  try {
    const data = greenButton.parseUploadedGreenButtonFile(parsed.data.xml);
    const bills = greenButton.convertToBills(data, {
      unitId: parsed.data.unitId,
      landlordId: authReq.landlordId,
      provider: parsed.data.provider,
      utilityType: parsed.data.utilityType as "HYDRO" | "WATER_GAS",
    });

    let savedCount = 0;
    for (const bill of bills) {
      const existing = await db.utilityBill.findFirst({
        where: {
          unitId: bill.unitId,
          utilityType: bill.utilityType as UtilityType,
          billingPeriodStart: bill.billingPeriodStart,
          billingPeriodEnd: bill.billingPeriodEnd,
        },
      });
      if (!existing) {
        await db.utilityBill.create({ data: bill as any });
        savedCount++;
      }
    }

    res.json({
      ok: true,
      parsed: {
        usagePoints: data.usagePoints.length,
        intervalReadings: data.intervalReadings.length,
        usageSummaries: data.usageSummaries.length,
      },
      billsSaved: savedCount,
      totalBillsFound: bills.length,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Delete a Green Button connection */
router.delete("/green-button/connections/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  try {
    const connection = await db.greenButtonConnection.findUnique({ where: { id: req.params.id } });
    if (!connection || connection.landlordId !== authReq.landlordId) return res.status(404).json({ error: "not_found" });
    await db.greenButtonConnection.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════
// Evolution API — WhatsApp Instance & QR Code Management
// ═══════════════════════════════════════════════════════════

function getEvolutionConfig() {
  return {
    baseUrl: (process.env.EVOLUTION_API_BASE_URL || "").replace(/\/+$/, ""),
    token: (process.env.EVOLUTION_API_TOKEN || "").trim(),
    tokenHeader: (process.env.EVOLUTION_API_TOKEN_HEADER || "apikey").trim(),
  };
}

async function evoFetch(path: string, opts: { method?: string; body?: unknown } = {}) {
  const cfg = getEvolutionConfig();
  if (!cfg.baseUrl || !cfg.token) throw new Error("Evolution API not configured. Set EVOLUTION_API_BASE_URL and EVOLUTION_API_TOKEN.");
  const url = `${cfg.baseUrl}${path}`;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      [cfg.tokenHeader]: cfg.token,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.message || (data as any)?.error || `Evolution API error ${res.status}`);
  return data;
}

/** Create a new Evolution API instance (or return existing) for the logged-in landlord */
router.post("/whatsapp/instance/create", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const instanceName = req.body?.instanceName || `nestmind-${authReq.landlordId}`;
  try {
    // Enforce plan limit on WhatsApp numbers / instances
    const { PLANS } = require("../services/planService");
    const landlord = await db.landlord.findUnique({ where: { id: authReq.landlordId }, select: { plan: true, evolutionInstanceName: true, whatsappNumbers: true } });
    const plan = PLANS[(landlord?.plan || "FREE")] || PLANS.FREE;
    const currentCount = (landlord?.whatsappNumbers?.length || 0) + (landlord?.evolutionInstanceName ? 1 : 0);
    // If landlord already has an instance, allow reconnecting it; only block truly new ones.
    if (landlord?.evolutionInstanceName && landlord.evolutionInstanceName !== instanceName) {
      if (currentCount >= plan.maxWhatsAppNumbers) {
        return res.status(403).json({ error: "plan_limit_reached", message: `Your ${landlord.plan || "FREE"} plan allows ${plan.maxWhatsAppNumbers} WhatsApp instance(s). Upgrade to add more.`, max: plan.maxWhatsAppNumbers });
      }
    }
    // Use WEBHOOK_URL (Railway internal) to avoid egress costs & HTTPS redirect issues
    const webhookBase = process.env.WEBHOOK_URL || process.env.APP_PUBLIC_URL || process.env.APP_URL || req.protocol + "://" + req.get("host");
    const webhookUrl = `${webhookBase}/webhooks/whatsapp/evolution`;
    const result = await evoFetch("/instance/create", {
      method: "POST",
      body: {
        instanceName,
        integration: "WHATSAPP-BAILEYS",
        qrcode: true,
        rejectCall: false,
        groupsIgnore: false, // Process group messages for unit group chats
        alwaysOnline: true,
        readMessages: true,
        readStatus: true,
        syncFullHistory: false,
        webhook: {
          url: webhookUrl,
          byEvents: false,
          base64: true,
          events: [
            "MESSAGES_UPSERT",
            "MESSAGES_UPDATE",
            "CONNECTION_UPDATE",
            "QRCODE_UPDATED",
          ],
        },
      },
    });
    // Save instance name to landlord record
    if ((result as any)?.instance?.instanceName) {
      await db.landlord.update({
        where: { id: authReq.landlordId },
        data: { evolutionInstanceName: (result as any).instance.instanceName },
      }).catch(() => { });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Get the current landlord's instance name from the DB */
router.get("/whatsapp/instance/mine", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  try {
    const landlord = await db.landlord.findUnique({ where: { id: authReq.landlordId }, select: { evolutionInstanceName: true } });
    if (!landlord?.evolutionInstanceName) return res.json({ instanceName: null });
    // Also fetch current state
    let state = "unknown";
    try {
      const s = await evoFetch(`/instance/connectionState/${encodeURIComponent(landlord.evolutionInstanceName)}`);
      state = (s as any)?.instance?.state || "unknown";
    } catch { }
    res.json({ instanceName: landlord.evolutionInstanceName, state });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Sync Evolution API instance settings (groupsIgnore=false, readMessages=true, webhook URL).
 *  Call this if group messages aren't being received. */
router.post("/whatsapp/instance/sync", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  try {
    const landlord = await db.landlord.findUnique({ where: { id: authReq.landlordId }, select: { evolutionInstanceName: true } });
    if (!landlord?.evolutionInstanceName) return res.status(404).json({ error: "no_instance", message: "No Evolution API instance configured." });
    const webhookBase = process.env.WEBHOOK_URL || process.env.APP_PUBLIC_URL || process.env.APP_URL || req.protocol + "://" + req.get("host");
    const webhookUrl = `${webhookBase.replace(/\/+$/, "")}/webhooks/whatsapp/evolution`;
    const result = await whatsappService.syncEvolutionInstanceSettings(landlord.evolutionInstanceName, webhookUrl);
    res.json({ ok: result.ok, instanceName: landlord.evolutionInstanceName, details: result.error });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Get QR code / pairing code to connect an existing instance.
 *  Pass ?number=+1234567890 to request a pairing code (useful on mobile). */
router.get("/whatsapp/instance/connect/:instanceName", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const landlord = await db.landlord.findUnique({ where: { id: authReq.landlordId }, select: { evolutionInstanceName: true } });
  if (landlord?.evolutionInstanceName !== req.params.instanceName) return res.status(403).json({ error: "forbidden" });
  try {
    // Ensure webhook URL is up-to-date — use internal Railway URL if set
    const wbBase = process.env.WEBHOOK_URL || process.env.APP_PUBLIC_URL || process.env.APP_URL || req.protocol + "://" + req.get("host");
    const currentWebhookUrl = `${wbBase}/webhooks/whatsapp/evolution`;
    evoFetch(`/webhook/set/${encodeURIComponent(req.params.instanceName)}`, {
      method: "POST",
      body: {
        url: currentWebhookUrl,
        byEvents: false,
        base64: true,
        events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
      },
    }).then(() => console.log("[WhatsApp] Webhook URL updated to:", currentWebhookUrl))
      .catch((e: any) => console.warn("[WhatsApp] Webhook update failed (non-blocking):", e.message));

    // Ensure groupsIgnore is OFF and readMessages is ON for existing instances
    whatsappService.syncEvolutionInstanceSettings(req.params.instanceName, currentWebhookUrl)
      .then((r) => console.log("[WhatsApp] Instance settings synced on connect:", r))
      .catch((e: any) => console.warn("[WhatsApp] Instance settings sync failed (non-blocking):", e.message));

    const phoneNumber = (req.query.number as string || "").replace(/[^0-9]/g, "");

    if (phoneNumber) {
      // Request 8-digit WhatsApp link/pairing code (not QR code data)
      let pairingCode: string | null = null;
      let base64: string | null = null;
      let rawResult: any = null;

      // Helper: check if a value looks like a real 8-digit pairing code (e.g. "ABCD-EFGH" or "12345678")
      const isShortPairingCode = (v: any) => typeof v === "string" && v.length <= 20 && /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i.test(v.trim());

      // Method 1: GET with query param (correct Evolution API v2 approach)
      try {
        const r1 = await evoFetch(`/instance/connect/${encodeURIComponent(req.params.instanceName)}?number=${phoneNumber}`);
        rawResult = r1;
        // Check all possible fields for a short pairing code
        for (const candidate of [r1?.pairingCode, r1?.code, r1?.data?.pairingCode, r1?.data?.code]) {
          if (isShortPairingCode(candidate)) { pairingCode = candidate; break; }
        }
        base64 = r1?.base64 || r1?.data?.base64 || null;
      } catch (e1) {
        console.warn("[WhatsApp] GET connect with number failed:", (e1 as Error).message);
      }

      // Method 2: Fallback — POST with body (older API versions)
      if (!pairingCode) {
        try {
          const r2 = await evoFetch(`/instance/connect/${encodeURIComponent(req.params.instanceName)}`, {
            method: "POST",
            body: { number: phoneNumber },
          });
          rawResult = rawResult || r2;
          for (const candidate of [r2?.pairingCode, r2?.code, r2?.data?.pairingCode, r2?.data?.code]) {
            if (isShortPairingCode(candidate)) { pairingCode = candidate; break; }
          }
        } catch (e2) {
          console.warn("[WhatsApp] POST connect with number fallback failed:", (e2 as Error).message);
        }
      }

      // Log what we found for debugging
      const allKeys = rawResult ? Object.keys(rawResult) : [];
      const pcVal = rawResult?.pairingCode;
      const pcLen = typeof pcVal === "string" ? pcVal.length : 0;
      console.log("[WhatsApp] Pairing code response:", { keys: allKeys, pairingCodeLen: pcLen, shortCodeFound: !!pairingCode, pairingCode });

      return res.json({ pairingCode, base64, raw: rawResult });
    }

    // No phone number — return QR code (desktop flow)
    const result = await evoFetch(`/instance/connect/${encodeURIComponent(req.params.instanceName)}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Get connection state of an instance */
router.get("/whatsapp/instance/state/:instanceName", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const landlord = await db.landlord.findUnique({ where: { id: authReq.landlordId }, select: { evolutionInstanceName: true } });
  if (landlord?.evolutionInstanceName !== req.params.instanceName) return res.status(403).json({ error: "forbidden" });
  try {
    const result = await evoFetch(`/instance/connectionState/${encodeURIComponent(req.params.instanceName)}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Fetch all instances (filtered to current landlord if possible) */
router.get("/whatsapp/instance/list", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  try {
    const result = await evoFetch("/instance/fetchInstances");
    // Filter to only this landlord's instance(s)
    const landlord = await db.landlord.findUnique({ where: { id: authReq.landlordId }, select: { evolutionInstanceName: true } });
    if (landlord?.evolutionInstanceName && Array.isArray(result)) {
      const mine = (result as any[]).filter((i: any) => i?.instance?.instanceName === landlord.evolutionInstanceName);
      return res.json(mine);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Logout (disconnect) an instance */
router.delete("/whatsapp/instance/logout/:instanceName", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const landlord = await db.landlord.findUnique({ where: { id: authReq.landlordId }, select: { evolutionInstanceName: true } });
  if (landlord?.evolutionInstanceName !== req.params.instanceName) return res.status(403).json({ error: "forbidden" });
  try {
    const result = await evoFetch(`/instance/logout/${encodeURIComponent(req.params.instanceName)}`, { method: "DELETE" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Restart an instance */
router.put("/whatsapp/instance/restart/:instanceName", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const landlord = await db.landlord.findUnique({ where: { id: authReq.landlordId }, select: { evolutionInstanceName: true } });
  if (landlord?.evolutionInstanceName !== req.params.instanceName) return res.status(403).json({ error: "forbidden" });
  try {
    const result = await evoFetch(`/instance/restart/${encodeURIComponent(req.params.instanceName)}`, { method: "PUT" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Permanently deletes the landlord account and ALL associated data:
 *  - Tenants, units, contractors, maintenance requests
 *  - Utility credentials/bills, reminders, conversation history
 *  - Agent usage, settings, green-button connections
 *  - Evolution API instances (main + bot)
 * Requires confirmation body: { confirm: "DELETE" }
 */
router.delete("/account", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  if (req.body?.confirm !== "DELETE") {
    return res.status(400).json({ error: "confirmation_required", message: "Send { confirm: \"DELETE\" } to confirm permanent account deletion." });
  }
  try {
    // 1. Wipe all database records and get instance names
    const { instanceNames } = await repo.deleteAllLandlordData(authReq.landlordId);

    // 2. Delete Evolution API instances
    for (const name of instanceNames) {
      try {
        await evoFetch(`/instance/logout/${encodeURIComponent(name)}`, { method: "DELETE" });
      } catch { /* instance may already be gone */ }
      try {
        await evoFetch(`/instance/delete/${encodeURIComponent(name)}`, { method: "DELETE" });
      } catch { /* best effort */ }
    }

    // 3. Clear auth cookie
    res.clearCookie("token");
    res.json({ ok: true, message: "Account and all associated data permanently deleted." });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Account deletion failed:", err);
    res.status(500).json({ error: "deletion_failed", message: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════
//  NOTIFICATIONS — In-app + push notification management
// ═══════════════════════════════════════════════════════════

/** GET /admin/notifications — List notifications (paginated) */
router.get("/notifications", async (req, res) => {
  try {
    const authReq = req as AuthRequest;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const unreadOnly = req.query.unread === "true";

    const where: any = { landlordId: authReq.landlordId };
    if (unreadOnly) where.read = false;

    const [notifications, total] = await Promise.all([
      db.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      db.notification.count({ where }),
    ]);

    res.json({ notifications, total, limit, offset });
  } catch (err) {
    res.status(500).json({ error: "fetch_failed", message: (err as Error).message });
  }
});

/** GET /admin/notifications/unread-count — Quick badge count */
router.get("/notifications/unread-count", async (req, res) => {
  try {
    const authReq = req as AuthRequest;
    const count = await db.notification.count({
      where: { landlordId: authReq.landlordId, read: false },
    });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: "fetch_failed", message: (err as Error).message });
  }
});

/** POST /admin/notifications/:id/read — Mark one notification as read */
router.post("/notifications/:id/read", async (req, res) => {
  try {
    const authReq = req as unknown as AuthRequest;
    await db.notification.updateMany({
      where: { id: req.params.id, landlordId: authReq.landlordId },
      data: { read: true },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "update_failed", message: (err as Error).message });
  }
});

/** POST /admin/notifications/read-all — Mark all notifications as read */
router.post("/notifications/read-all", async (req, res) => {
  try {
    const authReq = req as AuthRequest;
    const result = await db.notification.updateMany({
      where: { landlordId: authReq.landlordId, read: false },
      data: { read: true },
    });
    res.json({ ok: true, updated: result.count });
  } catch (err) {
    res.status(500).json({ error: "update_failed", message: (err as Error).message });
  }
});

// ── Push subscription management ──

/** POST /admin/push/subscribe — Register a push subscription */
router.post("/push/subscribe", async (req, res) => {
  try {
    const authReq = req as AuthRequest;
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: "Invalid push subscription data" });
    }

    await db.pushSubscription.upsert({
      where: {
        landlordId_endpoint: {
          landlordId: authReq.landlordId,
          endpoint,
        },
      },
      create: {
        landlordId: authReq.landlordId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
      update: {
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "subscribe_failed", message: (err as Error).message });
  }
});

/** DELETE /admin/push/unsubscribe — Remove a push subscription */
router.delete("/push/unsubscribe", async (req, res) => {
  try {
    const authReq = req as AuthRequest;
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: "endpoint required" });

    await db.pushSubscription.deleteMany({
      where: { landlordId: authReq.landlordId, endpoint },
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "unsubscribe_failed", message: (err as Error).message });
  }
});

/** GET /admin/push/vapid-key — Return the public VAPID key for pusher registration */
router.get("/push/vapid-key", (_req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY || "";
  res.json({ vapidPublicKey: key });
});

// ═══════════════════════════════════════════════════════════
//  LEASE DOCUMENT UPLOAD & AI EXTRACTION
// ═══════════════════════════════════════════════════════════

/** POST /admin/leases/upload — Upload a lease PDF and extract key terms via AI */
router.post("/leases/upload", async (req, res) => {
  const authReq = req as AuthRequest;
  const schema = z.object({
    unitTenantId: z.string().min(1),
    fileName: z.string().min(1),
    fileBase64: z.string().min(1),
    mimeType: z.string().default("application/pdf"),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "validation_failed", details: parsed.error.flatten() });

  try {
    // Verify the UnitTenant belongs to this landlord
    const ut = await db.unitTenant.findUnique({
      where: { id: parsed.data.unitTenantId },
      include: { unit: true, tenant: true },
    });
    if (!ut || ut.unit?.landlordId !== authReq.landlordId) {
      return res.status(404).json({ error: "unit_tenant_not_found" });
    }

    // Clean up base64 — strip any data URI prefix and whitespace
    const cleanBase64 = parsed.data.fileBase64.replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
    const fileBuffer = Buffer.from(cleanBase64, "base64");

    // Use Gemini to extract lease terms from the PDF
    let extractedTerms: any = null;
    let summary: string | null = null;
    try {
      const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || process.env.GENERATIVE_AI_API_KEY || "";
      if (apiKey) {
        console.log("[Lease] Starting AI extraction for", parsed.data.fileName, "mimeType:", parsed.data.mimeType, "file size:", fileBuffer.length, "bytes");

        // Use the Files API to upload the PDF first (avoids "document has no pages" error with inlineData)
        const { GoogleAIFileManager } = await import("@google/generative-ai/server");
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const fs = await import("fs");
        const os = await import("os");
        const path = await import("path");

        const fileManager = new GoogleAIFileManager(apiKey);
        const gemini = new GoogleGenerativeAI(apiKey);
        const modelName = process.env.GOOGLE_VERTEX_MODEL || "gemini-2.5-pro";

        // Write buffer to a temp file (Files API requires a file path)
        const tmpDir = os.tmpdir();
        const tmpFile = path.join(tmpDir, `lease-${Date.now()}-${parsed.data.fileName}`);
        fs.writeFileSync(tmpFile, fileBuffer);

        let uploadedFile: any;
        try {
          console.log("[Lease] Uploading file to Gemini Files API...");
          const uploadResult = await fileManager.uploadFile(tmpFile, {
            mimeType: parsed.data.mimeType || "application/pdf",
            displayName: parsed.data.fileName,
          });
          uploadedFile = uploadResult.file;
          console.log("[Lease] File uploaded:", uploadedFile.name, "state:", uploadedFile.state);

          // Wait for file to finish processing (ACTIVE state)
          let attempts = 0;
          while (uploadedFile.state === "PROCESSING" && attempts < 30) {
            await new Promise((r) => setTimeout(r, 2000));
            const check = await fileManager.getFile(uploadedFile.name);
            uploadedFile = check;
            attempts++;
          }

          if (uploadedFile.state !== "ACTIVE") {
            console.warn("[Lease] File not ACTIVE after waiting, state:", uploadedFile.state);
          }
        } finally {
          // Clean up temp file
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }

        if (uploadedFile?.state === "ACTIVE") {
          const model = gemini.getGenerativeModel({ model: modelName });
          const result = await model.generateContent({
            contents: [{
              role: "user",
              parts: [
                { fileData: { fileUri: uploadedFile.uri, mimeType: uploadedFile.mimeType } },
                {
                  text: `Extract key lease terms from this document. Return a JSON object with these fields (use null for missing):
{
  "rentAmount": number or null (monthly rent in dollars),
  "rentCurrency": "CAD" or "USD",
  "startDate": "YYYY-MM-DD" or null,
  "endDate": "YYYY-MM-DD" or null,
  "securityDeposit": number or null,
  "tenantNames": ["name1", "name2"],
  "landlordName": "name" or null,
  "propertyAddress": "address" or null,
  "latePaymentFee": number or null,
  "parkingIncluded": boolean,
  "petsAllowed": boolean,
  "utilityResponsibilities": {"electricity": "tenant"|"landlord", "water": "tenant"|"landlord", "gas": "tenant"|"landlord", "internet": "tenant"|"landlord"},
  "specialClauses": ["clause 1", "clause 2"],
  "renewalTerms": "description" or null,
  "noticeToVacateDays": number or null
}

Also provide a 2-3 sentence plain-text summary of the lease.
Return ONLY valid JSON wrapped in \`\`\`json ... \`\`\` followed by the summary.` },
              ],
            }],
          });

          // Safely extract response text
          let responseText = "";
          try {
            const parts = result.response?.candidates?.[0]?.content?.parts || [];
            responseText = parts.map((p: any) => p.text || "").join("");
          } catch {
            try { responseText = result.response?.text?.() || ""; } catch { /* blocked or empty */ }
          }
          console.log("[Lease] Gemini response length:", responseText.length, "preview:", responseText.substring(0, 200));

          if (responseText) {
            // Strategy 1: ```json ... ```
            const jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/);
            if (jsonMatch?.[1]) {
              try { extractedTerms = JSON.parse(jsonMatch[1].trim()); } catch (e) { console.warn("[Lease] JSON parse from code fence failed:", e); }
            }
            // Strategy 2: ``` ... ```
            if (!extractedTerms) {
              const genericFence = responseText.match(/```\s*([\s\S]*?)```/);
              if (genericFence?.[1]) {
                try { extractedTerms = JSON.parse(genericFence[1].trim()); } catch { /* not valid JSON */ }
              }
            }
            // Strategy 3: raw { ... }
            if (!extractedTerms) {
              const braceMatch = responseText.match(/\{[\s\S]*\}/);
              if (braceMatch) {
                try { extractedTerms = JSON.parse(braceMatch[0]); } catch { /* not valid JSON */ }
              }
            }
            // Extract summary
            if (extractedTerms) {
              const summaryMatch = responseText.match(/```[\s\S]*?```\s*([\s\S]+)/);
              summary = summaryMatch?.[1]?.trim() || null;
              if (!summary && !jsonMatch) {
                const afterJson = responseText.replace(/\{[\s\S]*\}/, "").trim();
                if (afterJson.length > 20) summary = afterJson;
              }
              console.log("[Lease] Extracted terms:", JSON.stringify(extractedTerms).substring(0, 300));
            } else {
              console.warn("[Lease] Could not parse JSON from response:", responseText.substring(0, 500));
            }
          } else {
            console.warn("[Lease] Empty response from Gemini");
          }

          // Clean up uploaded file from Gemini
          try { await fileManager.deleteFile(uploadedFile.name); } catch { /* ignore */ }
        }
      } else {
        console.warn("[Lease] GOOGLE_API_KEY not configured — skipping AI extraction");
      }
    } catch (err) {
      console.warn("[Lease] AI extraction failed, saving without terms:", (err as Error).message);
    }

    // Save the lease document
    const doc = await db.leaseDocument.create({
      data: {
        unitTenantId: parsed.data.unitTenantId,
        fileName: parsed.data.fileName,
        fileSize: fileBuffer.length,
        mimeType: parsed.data.mimeType,
        fileData: fileBuffer,
        extractedTerms: extractedTerms || undefined,
        summary,
      },
    });

    // Update UnitTenant dates from extracted terms if available
    if (extractedTerms?.startDate || extractedTerms?.endDate) {
      const updateData: any = {};
      if (extractedTerms.startDate) updateData.startDate = new Date(extractedTerms.startDate);
      if (extractedTerms.endDate) updateData.endDate = new Date(extractedTerms.endDate);
      await db.unitTenant.update({ where: { id: parsed.data.unitTenantId }, data: updateData });
    }

    res.json({
      ok: true,
      documentId: doc.id,
      extractedTerms,
      summary,
      fileName: doc.fileName,
      fileSize: doc.fileSize,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /admin/leases/:unitTenantId — Get lease documents for a unit-tenant assignment */
router.get("/leases/:unitTenantId", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  try {
    const ut = await db.unitTenant.findUnique({
      where: { id: req.params.unitTenantId },
      include: { unit: true, tenant: true, leaseDocuments: { select: { id: true, fileName: true, fileSize: true, mimeType: true, extractedTerms: true, summary: true, uploadedAt: true } } },
    });
    if (!ut || ut.unit?.landlordId !== authReq.landlordId) {
      return res.status(404).json({ error: "not_found" });
    }
    res.json({
      unitTenantId: ut.id,
      tenant: ut.tenant?.name,
      unit: ut.unit?.label,
      startDate: ut.startDate,
      endDate: ut.endDate,
      documents: ut.leaseDocuments,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /admin/portfolio — Get full landlord portfolio summary */
router.get("/portfolio", async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { loadLandlordContext } = await import("../services/repository");
    const portfolio = await loadLandlordContext(authReq.landlordId);
    if (!portfolio) return res.status(404).json({ error: "not_found" });
    res.json(portfolio);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════
//  FINANCIAL RECORDS ENDPOINTS
// ═══════════════════════════════════════════════════════════

/** POST /admin/financial/records — Create a financial record */
router.post("/financial/records", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const schema = z.object({
    type: z.enum(["RENT_PAYMENT", "EXPENSE", "DEPOSIT", "REFUND", "OTHER"]),
    amount: z.number().positive(),
    tenantName: z.string().optional(),
    tenantPhone: z.string().optional(),
    unitLabel: z.string().optional(),
    description: z.string().optional(),
    date: z.string().optional(),
    currency: z.string().optional(),
    receiptBase64: z.string().optional(),
    receiptMimeType: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "validation_error", details: parsed.error.issues });

  try {
    const { createFinancialRecord } = await import("../services/repository");
    const record = await createFinancialRecord({
      landlordId: authReq.landlordId,
      type: parsed.data.type,
      amount: parsed.data.amount,
      tenantName: parsed.data.tenantName,
      tenantPhone: parsed.data.tenantPhone,
      unitLabel: parsed.data.unitLabel,
      description: parsed.data.description,
      date: parsed.data.date ? new Date(parsed.data.date) : undefined,
      currency: parsed.data.currency,
      receiptData: parsed.data.receiptBase64 ? Buffer.from(parsed.data.receiptBase64, "base64") : undefined,
      receiptMimeType: parsed.data.receiptMimeType,
    });
    res.json({ ok: true, record });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /admin/financial/records — List financial records */
router.get("/financial/records", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  try {
    const { listFinancialRecords } = await import("../services/repository");
    const records = await listFinancialRecords(authReq.landlordId, {
      type: req.query.type as string | undefined,
      tenantName: req.query.tenantName as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ records, total: records.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** DELETE /admin/financial/records/:id — Delete a financial record */
router.delete("/financial/records/:id", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  try {
    const record = await db.financialRecord.findFirst({
      where: { id: req.params.id, landlordId: authReq.landlordId },
    });
    if (!record) return res.status(404).json({ error: "not_found" });
    await db.financialRecord.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /admin/financial/summary — Financial summary */
router.get("/financial/summary", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  try {
    const { getFinancialSummary } = await import("../services/repository");
    const summary = await getFinancialSummary(authReq.landlordId);
    res.json(summary || { error: "no_data" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════
//  LEGAL NOTICE PDF GENERATION ENDPOINT
// ═══════════════════════════════════════════════════════════

/** POST /admin/notices/generate — Generate Ontario LTB notice PDF (N1–N14) */
router.post("/notices/generate", async (req, res) => {
  const authReq = req as unknown as AuthRequest;
  const schema = z.object({
    noticeType: z.enum(["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "N10", "N11", "N12", "N13", "N14"]),
    tenantName: z.string().min(1),
    rentalUnitAddress: z.string().min(1),
    landlordName: z.string().min(1),
    landlordPhone: z.string().optional(),
    terminationDate: z.string().optional(),
    // Rent increase fields (N1/N2/N3/N10)
    currentRent: z.number().optional(),
    newRent: z.number().optional(),
    paymentPeriod: z.string().optional(),
    // N1-specific
    increaseType: z.string().optional(),
    aboveGuidelineReason: z.string().optional(),
    aboveGuidelineAmount: z.number().optional(),
    // N3-specific
    rentWillIncrease: z.boolean().optional(),
    rentIncreaseApproval: z.string().optional(),
    careChargesIncrease: z.boolean().optional(),
    newCareCharge: z.number().optional(),
    totalNewAmount: z.number().optional(),
    // N4 fields
    rentOwingPeriods: z.array(z.object({
      periodFrom: z.string(),
      periodTo: z.string(),
      rentCharged: z.number(),
      rentPaid: z.number(),
    })).optional(),
    // Legacy N4 single-period fields
    rentOwingPeriod: z.string().optional(),
    rentCharged: z.number().optional(),
    rentPaid: z.number().optional(),
    // N5/N6/N7/N8/N10/N12/N13 fields
    reason: z.string().optional(),
    details: z.string().optional(),
    // N5-specific
    damageAmount: z.number().optional(),
    otherAmount: z.number().optional(),
    overcrowdingExplanation: z.string().optional(),
    // N5/N6/N7 events
    events: z.array(z.object({
      dateTime: z.string(),
      description: z.string(),
    })).optional(),
    // N8 fields
    latePayments: z.array(z.object({
      period: z.string(),
      dueDate: z.string(),
      datePaid: z.string(),
    })).optional(),
    noticeDetail: z.string().optional(),
    // N10/N11 fields
    tenantSignedBy: z.string().optional(),
    // N12 fields
    occupantName: z.string().optional(),
    relationship: z.string().optional(),
    whoWillOccupy: z.string().optional(),
    isCareProvider: z.boolean().optional(),
    careRecipient: z.string().optional(),
    // N13 fields
    workPlan: z.string().optional(),
    permitsStatus: z.string().optional(),
    // N14 fields
    originalTenantName: z.string().optional(),
    periodEndDate: z.string().optional(),
    moveOutDate: z.string().optional(),
    paymentDueDate: z.string().optional(),
    amountOwed: z.number().optional(),
    payPeriod: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "validation_error", details: parsed.error.issues });

  try {
    const noticeService = await import("../services/noticeService");
    const d = parsed.data;
    const dateGiven = new Date().toISOString().split("T")[0];
    const common = {
      tenantName: d.tenantName,
      rentalUnitAddress: d.rentalUnitAddress,
      landlordName: d.landlordName,
      landlordPhone: d.landlordPhone,
      dateGiven,
      signedBy: d.landlordName,
    };

    let pdfBuffer: Buffer;

    switch (d.noticeType) {
      case "N1":
        pdfBuffer = await noticeService.generateN1Notice({
          ...common,
          currentRent: d.currentRent || 0,
          newRent: d.newRent || 0,
          effectiveDate: d.terminationDate || "",
          increaseType: d.increaseType,
          aboveGuidelineReason: d.aboveGuidelineReason,
          aboveGuidelineAmount: d.aboveGuidelineAmount,
          paymentPeriod: d.paymentPeriod,
        });
        break;
      case "N2":
        pdfBuffer = await noticeService.generateN2Notice({
          ...common,
          currentRent: d.currentRent || 0,
          newRent: d.newRent || 0,
          effectiveDate: d.terminationDate || "",
          exemptionReason: d.reason || "post_nov_2018",
          paymentPeriod: d.paymentPeriod,
        });
        break;
      case "N3":
        pdfBuffer = await noticeService.generateN3Notice({
          ...common,
          currentRent: d.currentRent || 0,
          newRent: d.newRent || 0,
          effectiveDate: d.terminationDate || "",
          rentWillIncrease: d.rentWillIncrease,
          rentIncreaseApproval: d.rentIncreaseApproval,
          careChargesIncrease: d.careChargesIncrease,
          newCareCharge: d.newCareCharge,
          totalNewAmount: d.totalNewAmount,
          paymentPeriod: d.paymentPeriod,
        });
        break;
      case "N4": {
        let rentOwingArr: Array<{ periodFrom: string; periodTo: string; rentCharged: number; rentPaid: number; rentOwing: number }> = [];
        if (d.rentOwingPeriods && d.rentOwingPeriods.length > 0) {
          rentOwingArr = d.rentOwingPeriods.map(p => ({
            periodFrom: p.periodFrom,
            periodTo: p.periodTo,
            rentCharged: p.rentCharged,
            rentPaid: p.rentPaid,
            rentOwing: p.rentCharged - p.rentPaid,
          }));
        } else {
          const rentCharged = d.rentCharged || 0;
          const rentPaid = d.rentPaid || 0;
          rentOwingArr = [{
            periodFrom: d.rentOwingPeriod || "Current period",
            periodTo: d.rentOwingPeriod || "Current period",
            rentCharged,
            rentPaid,
            rentOwing: rentCharged - rentPaid,
          }];
        }
        const totalOwing = rentOwingArr.reduce((sum, r) => sum + r.rentOwing, 0);
        pdfBuffer = await noticeService.generateN4Notice({
          ...common,
          rentOwing: rentOwingArr,
          totalOwing,
          terminationDate: d.terminationDate || "",
        });
        break;
      }
      case "N5":
        pdfBuffer = await noticeService.generateN5Notice({
          ...common,
          reason: d.reason || "interference",
          details: d.details || "",
          events: d.events,
          damageAmount: d.damageAmount,
          otherAmount: d.otherAmount,
          overcrowdingExplanation: d.overcrowdingExplanation,
          terminationDate: d.terminationDate || "",
        });
        break;
      case "N6":
        pdfBuffer = await noticeService.generateN6Notice({
          ...common,
          reason: d.reason || "illegal_act_unit",
          details: d.details || "",
          events: d.events,
          terminationDate: d.terminationDate || "",
        });
        break;
      case "N7":
        pdfBuffer = await noticeService.generateN7Notice({
          ...common,
          reason: d.reason,
          details: d.details || "",
          events: d.events,
          terminationDate: d.terminationDate || "",
        });
        break;
      case "N8":
        pdfBuffer = await noticeService.generateN8Notice({
          ...common,
          reason: d.reason,
          latePayments: d.latePayments || [{ period: "Current period", dueDate: "See pattern", datePaid: "Late" }],
          noticeDetail: d.noticeDetail,
          terminationDate: d.terminationDate || "",
        });
        break;
      case "N9":
        pdfBuffer = await noticeService.generateN9Notice({
          ...common,
          terminationDate: d.terminationDate || "",
        });
        break;
      case "N10":
        pdfBuffer = await noticeService.generateN10Notice({
          ...common,
          currentRent: d.currentRent || 0,
          newRent: d.newRent || 0,
          reason: d.reason || "capital_expenditure",
          details: d.details || "",
          effectiveDate: d.terminationDate || "",
          tenantSignedBy: d.tenantSignedBy || d.tenantName,
        });
        break;
      case "N11":
        pdfBuffer = await noticeService.generateN11Notice({
          ...common,
          tenantSignedBy: d.tenantSignedBy || d.tenantName,
          terminationDate: d.terminationDate || "",
        });
        break;
      case "N12":
        pdfBuffer = await noticeService.generateN12Notice({
          ...common,
          reason: (d.reason || "personal_use") as any,
          occupantName: d.occupantName || d.landlordName,
          relationship: d.relationship,
          whoWillOccupy: d.whoWillOccupy,
          isCareProvider: d.isCareProvider,
          careRecipient: d.careRecipient,
          terminationDate: d.terminationDate || "",
        });
        break;
      case "N13":
        pdfBuffer = await noticeService.generateN13Notice({
          ...common,
          reason: d.reason || "repairs",
          details: d.details || "",
          workPlan: d.workPlan,
          permitsStatus: d.permitsStatus,
          terminationDate: d.terminationDate || "",
        });
        break;
      case "N14":
        pdfBuffer = await noticeService.generateN14Notice({
          spouseName: d.tenantName,
          landlordName: d.landlordName,
          landlordPhone: d.landlordPhone,
          rentalUnitAddress: d.rentalUnitAddress,
          originalTenantName: d.originalTenantName || "",
          periodEndDate: d.periodEndDate || "",
          moveOutDate: d.moveOutDate || "",
          paymentDueDate: d.paymentDueDate || d.terminationDate || "",
          amountOwed: d.amountOwed,
          currentRent: d.currentRent,
          payPeriod: d.payPeriod,
          dateGiven,
          signedBy: d.landlordName,
        });
        break;
      default:
        return res.status(400).json({ error: `Unsupported notice type: ${d.noticeType}` });
    }

    const fileName = `${d.noticeType}_Notice_${d.tenantName.replace(/\s+/g, "_")}.pdf`;

    res.json({
      ok: true,
      noticeType: d.noticeType,
      fileName,
      pdfBase64: pdfBuffer.toString("base64"),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
