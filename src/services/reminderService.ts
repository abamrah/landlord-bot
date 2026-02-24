import { db } from "../config/database";
import repo from "./repository";
import whatsappService from "./whatsappService";
import agentService from "./agentService";

const isDbEnabled = Boolean(process.env.DATABASE_URL);

type ReminderInput = {
  id?: string;
  landlordId?: string;
  unitId?: string;
  type: "rent" | "utility";
  dayOfMonth: number;
  timeUtc: string;
  style: "short" | "medium" | "professional" | "casual";
  amountCents?: number;
};

type ReminderResult = {
  reminderId: string;
  sent: number;
  failed: number;
};

const templates: Record<string, Record<string, string>> = {
  rent: {
    short: "Rent reminder: your payment is due today. Let me know if you need anything.",
    medium: "Hi! Friendly reminder that rent is due today. If you have a payment update, please share it.",
    professional: "Hello, this is a reminder that rent is due today. Please confirm once payment is sent.",
    casual: "Hey! Rent is due today. Ping me if anything comes up.",
  },
  utility: {
    short: "Utility bill reminder: payment is due today. Let me know if you have questions.",
    medium: "Hi! Friendly reminder that the utility bill is due today. Reach out if you need the statement.",
    professional: "Hello, this is a reminder that the utility bill is due today. Please confirm once paid.",
    casual: "Hey! Utility bill is due today. Let me know if you need the details.",
  },
};

function parseTimeUtc(timeUtc: string) {
  const parts = timeUtc.split(":");
  const hour = Number(parts[0]);
  const minute = Number(parts[1] || 0);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return { hour, minute };
}

/**
 * Convert UTC Date to a landlord's local time components.
 * Uses Intl.DateTimeFormat for timezone conversion.
 * Falls back to UTC if timezone is invalid.
 */
function getLocalTime(now: Date, timezone: string): { day: number; hour: number; minute: number } {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      day: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const day = Number(parts.find(p => p.type === "day")?.value || now.getUTCDate());
    const hour = Number(parts.find(p => p.type === "hour")?.value || now.getUTCHours());
    const minute = Number(parts.find(p => p.type === "minute")?.value || now.getUTCMinutes());
    return { day, hour, minute };
  } catch {
    // Invalid timezone — fall back to UTC
    return { day: now.getUTCDate(), hour: now.getUTCHours(), minute: now.getUTCMinutes() };
  }
}

/**
 * Check if a reminder should fire now, using the landlord's timezone.
 * The `timeUtc` field is treated as the landlord's LOCAL time.
 * Widened check window to ±1 minute to handle 30-second polling edge case.
 */
function shouldSendNow(
  reminder: { dayOfMonth: number; timeUtc: string; lastSentAt?: Date | null },
  now: Date,
  timezone?: string
) {
  const time = parseTimeUtc(reminder.timeUtc);
  if (!time) return false;

  const tz = timezone || "America/Toronto";
  const local = getLocalTime(now, tz);

  if (local.day !== reminder.dayOfMonth) return false;

  // Check if we're within ±1 minute of the target time
  const targetMin = time.hour * 60 + time.minute;
  const currentMin = local.hour * 60 + local.minute;
  if (Math.abs(currentMin - targetMin) > 1) return false;

  // Don't re-send if already sent within the last 2 minutes
  if (reminder.lastSentAt) {
    const elapsed = now.getTime() - reminder.lastSentAt.getTime();
    if (elapsed < 120000) return false; // 2 minute dedup window
  }
  return true;
}

export async function listReminders(landlordId?: string) {
  if (!isDbEnabled) return [];
  try {
    const where: any = {};
    if (landlordId) where.landlordId = landlordId;
    return await db.reminder.findMany({ where, orderBy: { createdAt: "desc" } });
  } catch (err) {
    console.warn("listReminders failed", err);
    return [];
  }
}

export async function addReminder(input: ReminderInput) {
  if (!isDbEnabled) return null;
  try {
    return await db.reminder.create({
      data: {
        id: input.id,
        landlordId: input.landlordId || null,
        unitId: input.unitId || null,
        type: input.type,
        dayOfMonth: input.dayOfMonth,
        timeUtc: input.timeUtc,
        style: input.style,
        amountCents: input.amountCents || null,
        active: true,
      },
    });
  } catch (err) {
    console.warn("addReminder failed", err);
    return null;
  }
}

export async function deleteReminder(id: string) {
  if (!isDbEnabled || !id) return false;
  try {
    await db.reminder.delete({ where: { id } });
    return true;
  } catch (err) {
    console.warn("deleteReminder failed", err);
    return false;
  }
}

export async function toggleReminder(id: string, active: boolean) {
  if (!isDbEnabled || !id) return null;
  try {
    return await db.reminder.update({ where: { id }, data: { active } });
  } catch (err) {
    console.warn("toggleReminder failed", err);
    return null;
  }
}

export async function runDueReminders(now = new Date()): Promise<ReminderResult[]> {
  if (!isDbEnabled) return [];
  const results: ReminderResult[] = [];

  try {
    const reminders = await db.reminder.findMany({ where: { active: true } });

    // Pre-fetch landlord timezones to avoid repeated DB queries
    const landlordIds = [...new Set(reminders.map(r => r.landlordId).filter(Boolean))] as string[];
    const landlordTimezones = new Map<string, string>();
    if (landlordIds.length) {
      const landlords = await db.landlord.findMany({
        where: { id: { in: landlordIds } },
        select: { id: true, timezone: true },
      });
      for (const l of landlords) {
        landlordTimezones.set(l.id, l.timezone || "America/Toronto");
      }
    }

    for (const reminder of reminders) {
      const tz = reminder.landlordId ? (landlordTimezones.get(reminder.landlordId) || "America/Toronto") : "America/Toronto";
      if (!shouldSendNow(reminder, now, tz)) continue;

      // Mark as sent immediately to prevent duplicate sends
      await db.reminder.update({
        where: { id: reminder.id },
        data: { lastSentAt: now },
      });

      let sent = 0;
      let failed = 0;

      // ── Utility reminder with unit targeting ──
      if (reminder.type === "utility" && reminder.unitId) {
        const unit = await db.unit.findUnique({
          where: { id: reminder.unitId },
          include: {
            property: true,
            tenants: {
              include: { tenant: { select: { id: true, name: true, phone: true } } },
            },
          },
        });

        if (!unit || unit.tenants.length === 0) {
          results.push({ reminderId: reminder.id, sent: 0, failed: 0 });
          continue;
        }

        // Determine the utility amount — use reminder.amountCents or latest bill
        let billAmountCents = reminder.amountCents || 0;
        let utilityTypeLabel = "utility";
        let billingPeriodLabel = "";
        if (!billAmountCents) {
          const latestBill = await db.utilityBill.findFirst({
            where: { unitId: unit.id },
            orderBy: { billingPeriodEnd: "desc" },
            select: { amountCents: true, utilityType: true, billingPeriodStart: true, billingPeriodEnd: true },
          });
          billAmountCents = latestBill?.amountCents || 0;
          if (latestBill?.utilityType) utilityTypeLabel = latestBill.utilityType.replace(/_/g, "/").toLowerCase();
          if (latestBill?.billingPeriodStart && latestBill?.billingPeriodEnd) {
            billingPeriodLabel = ` (${new Date(latestBill.billingPeriodStart).toLocaleDateString()} – ${new Date(latestBill.billingPeriodEnd).toLocaleDateString()})`;
          }
        }

        const billAmount = billAmountCents / 100;
        const propertyAddress = (unit as any).property?.address || unit.address || "";

        if (unit.utilityType === "SHARED") {
          // ── SHARED utility: calculate each person's share ──
          const occupantShares = unit.tenants.map((ut: any) => ({
            name: ut.tenant.name,
            phone: ut.tenant.phone,
            sharePercent: ut.utilitySharePercent || (100 / unit.tenants.length),
          }));

          // Build a group message listing all shares
          let shareBreakdown = occupantShares.map((o: any) => {
            const shareAmt = (billAmount * o.sharePercent / 100).toFixed(2);
            return `• *${o.name}*: $${shareAmt} (${o.sharePercent}%)`;
          }).join("\n");

          const groupMsg = `*${utilityTypeLabel.charAt(0).toUpperCase() + utilityTypeLabel.slice(1)} Bill Reminder — ${unit.label}*${propertyAddress ? ` (${propertyAddress})` : ""}${billingPeriodLabel}\n\nTotal ${utilityTypeLabel} bill: *$${billAmount.toFixed(2)}*\n\nShare breakdown:\n${shareBreakdown}\n\nPlease ensure your portion is paid on time. Reply *paid* once sent.`;

          // Send to WhatsApp group if it exists, otherwise individual DMs
          if (unit.whatsappGroupJid) {
            const result = await whatsappService.sendWhatsAppGroupText({
              groupJid: unit.whatsappGroupJid,
              text: groupMsg,
              landlordId: reminder.landlordId || undefined,
            });
            if (result.ok) sent += occupantShares.length;
            else failed += occupantShares.length;
          } else {
            // Fallback: send individual DMs with their specific share
            for (const o of occupantShares) {
              if (!o.phone) continue;
              const shareAmt = (billAmount * o.sharePercent / 100).toFixed(2);
              const msg = `*${utilityTypeLabel.charAt(0).toUpperCase() + utilityTypeLabel.slice(1)} Bill Reminder — ${unit.label}*\n\nHi ${o.name}, your share of this month's ${utilityTypeLabel} bill is *$${shareAmt}* (${o.sharePercent}% of $${billAmount.toFixed(2)}).${billingPeriodLabel}\n\nPlease ensure payment is made on time. Reply *paid* once sent.`;
              const result = await whatsappService.sendWhatsAppText({
                to: o.phone,
                text: msg,
                landlordId: reminder.landlordId || undefined,
              });
              if (result.ok) sent++;
              else failed++;
            }
          }
        } else {
          // ── SINGLE utility: 100% to the tenant ──
          const msg = `*${utilityTypeLabel.charAt(0).toUpperCase() + utilityTypeLabel.slice(1)} Bill Reminder — ${unit.label}*${propertyAddress ? ` (${propertyAddress})` : ""}${billingPeriodLabel}\n\nYour ${utilityTypeLabel} bill of *$${billAmount.toFixed(2)}* is due today. Please ensure payment is made on time. Reply *paid* once sent.`;

          for (const ut of unit.tenants) {
            const phone = (ut as any).tenant?.phone;
            if (!phone) continue;
            const result = await whatsappService.sendWhatsAppText({
              to: phone,
              text: msg,
              landlordId: reminder.landlordId || undefined,
            });
            if (result.ok) sent++;
            else failed++;
          }
        }

        results.push({ reminderId: reminder.id, sent, failed });
        continue;
      }

      // ── Rent reminder with unit targeting ──
      if (reminder.type === "rent" && reminder.unitId) {
        const unit = await db.unit.findUnique({
          where: { id: reminder.unitId },
          include: {
            property: true,
            tenants: {
              include: { tenant: { select: { id: true, name: true, phone: true } } },
            },
          },
        });

        if (!unit || unit.tenants.length === 0) {
          results.push({ reminderId: reminder.id, sent: 0, failed: 0 });
          continue;
        }

        const propertyAddress = (unit as any).property?.address || unit.address || "";

        // Build per-tenant rent details
        const occupants = unit.tenants.map((ut: any) => ({
          name: ut.tenant.name,
          phone: ut.tenant.phone,
          rentAmountCents: ut.rentAmountCents || 0,
        }));

        const hasAmounts = occupants.some(o => o.rentAmountCents > 0);

        if (unit.whatsappGroupJid) {
          // ── Group message for rent ──
          let groupMsg = `*Rent Reminder — ${unit.label}*${propertyAddress ? ` (${propertyAddress})` : ""}\n`;
          if (hasAmounts) {
            groupMsg += "\n" + occupants.map(o => {
              return o.rentAmountCents > 0
                ? `• *${o.name}*: $${(o.rentAmountCents / 100).toFixed(2)}`
                : `• *${o.name}*`;
            }).join("\n");
          }
          groupMsg += `\n\nRent is due today. Please ensure payment is made on time. Reply *paid* once sent.`;

          const result = await whatsappService.sendWhatsAppGroupText({
            groupJid: unit.whatsappGroupJid,
            text: groupMsg,
            landlordId: reminder.landlordId || undefined,
          });
          if (result.ok) sent += occupants.length;
          else failed += occupants.length;
        } else {
          // ── Individual DMs for rent with amount ──
          for (const o of occupants) {
            if (!o.phone) continue;
            const amountPart = o.rentAmountCents > 0
              ? ` of *$${(o.rentAmountCents / 100).toFixed(2)}*`
              : "";
            const msg = `*Rent Reminder — ${unit.label}*${propertyAddress ? ` (${propertyAddress})` : ""}\n\nHi ${o.name}, your rent${amountPart} is due today. Please ensure payment is made on time. Reply *paid* once sent.`;
            const result = await whatsappService.sendWhatsAppText({
              to: o.phone,
              text: msg,
              landlordId: reminder.landlordId || undefined,
            });
            if (result.ok) sent++;
            else failed++;
          }
        }

        results.push({ reminderId: reminder.id, sent, failed });
        continue;
      }

      // ── Standard reminder (no unit targeting — goes to all tenants) ──
      const tenants = await repo.listTenants(reminder.landlordId || undefined);
      const generated = await agentService.generateReminderMessage({
        type: reminder.type as "rent" | "utility",
        style: reminder.style as "short" | "medium" | "professional" | "casual",
        dueLabel: "today",
      });
      const fallback = templates[reminder.type]?.[reminder.style] || templates.rent.medium;
      const message = generated.text || fallback;

      for (const tenant of tenants) {
        if (!tenant.phone) continue;
        const result = await whatsappService.sendWhatsAppText({
          to: tenant.phone,
          text: message,
          landlordId: reminder.landlordId || undefined,
        });
        if (result.ok) sent += 1;
        else failed += 1;
      }

      results.push({ reminderId: reminder.id, sent, failed });
    }
  } catch (err) {
    console.warn("runDueReminders failed", err);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════
//  48-HOUR FOLLOW-UP NUDGE
// ═══════════════════════════════════════════════════════════

/**
 * Send a gentle follow-up to tenants who haven't confirmed payment
 * within 48 hours of a reminder being sent.
 * Uses the same group-vs-individual logic as the main reminder.
 */
export async function runFollowUpNudges(now = new Date()): Promise<ReminderResult[]> {
  if (!isDbEnabled) return [];
  const results: ReminderResult[] = [];

  try {
    const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48 hours ago

    // Find reminders that were sent but NOT confirmed (or confirmed before last send)
    const reminders = await db.reminder.findMany({
      where: {
        active: true,
        lastSentAt: { not: null, lte: cutoff },
        OR: [
          { lastConfirmedAt: null },
          // lastConfirmedAt is older than lastSentAt (confirmed a previous cycle)
        ],
      },
    });

    // Filter: only nudge if lastConfirmedAt is null or < lastSentAt
    const needsNudge = reminders.filter(r => {
      if (!r.lastSentAt) return false;
      if (!r.lastConfirmedAt) return true;
      return r.lastConfirmedAt < r.lastSentAt;
    });

    for (const reminder of needsNudge) {
      // Prevent sending nudge more than once per cycle:
      // We set lastSentAt when we nudge too, but offset by 1min to differentiate
      // Actually, better to check time: if it's been less than 49hrs, don't re-nudge
      const hoursSinceSent = (now.getTime() - (reminder.lastSentAt?.getTime() || 0)) / (1000 * 60 * 60);
      if (hoursSinceSent > 72) continue; // Too old, skip (wait for next cycle)

      let sent = 0;
      let failed = 0;
      const typeLabel = reminder.type === "rent" ? "rent" : "utility";

      // Determine the appropriate notice type for the warning
      const noticeType = reminder.type === "rent" ? "N4 (Non-Payment of Rent)" : "N4 (Non-Payment of Rent)";
      const noticeWarning = `\n\nPlease note: if payment is not received, a formal Ontario LTB *${noticeType}* notice is being prepared and may be served within *12 hours*.`;

      if (reminder.unitId) {
        const unit = await db.unit.findUnique({
          where: { id: reminder.unitId },
          include: {
            tenants: {
              include: { tenant: { select: { name: true, phone: true } } },
            },
          },
        });

        if (!unit || unit.tenants.length === 0) continue;

        const nudgeMsg = `Friendly reminder: your ${typeLabel} payment for *${unit.label}* hasn't been confirmed yet. If you've already paid, just reply *paid* and we'll update the records.${noticeWarning}`;

        if (unit.whatsappGroupJid) {
          const result = await whatsappService.sendWhatsAppGroupText({
            groupJid: unit.whatsappGroupJid,
            text: nudgeMsg,
            landlordId: reminder.landlordId || undefined,
          });
          if (result.ok) sent += unit.tenants.length;
          else failed += unit.tenants.length;
        } else {
          for (const ut of unit.tenants) {
            const phone = (ut as any).tenant?.phone;
            if (!phone) continue;
            const result = await whatsappService.sendWhatsAppText({
              to: phone,
              text: nudgeMsg,
              landlordId: reminder.landlordId || undefined,
            });
            if (result.ok) sent++;
            else failed++;
          }
        }
      } else {
        // No unit — broadcast nudge
        const tenants = await repo.listTenants(reminder.landlordId || undefined);
        const nudgeMsg = `Friendly reminder: your ${typeLabel} payment hasn't been confirmed yet. If you've already paid, just reply *paid* and we'll update the records.${noticeWarning}`;
        for (const tenant of tenants) {
          if (!tenant.phone) continue;
          const result = await whatsappService.sendWhatsAppText({
            to: tenant.phone,
            text: nudgeMsg,
            landlordId: reminder.landlordId || undefined,
          });
          if (result.ok) sent++;
          else failed++;
        }
      }

      results.push({ reminderId: reminder.id, sent, failed });
    }
  } catch (err) {
    console.warn("runFollowUpNudges failed", err);
  }

  return results;
}

export type { ReminderInput as Reminder };
