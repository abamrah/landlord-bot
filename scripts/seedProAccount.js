/**
 * Seed a PRO test account.
 * Run: node scripts/seedProAccount.js
 */
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const EMAIL = "admin@nestmind.ca";
const PASSWORD = "NestMind2026!";
const NAME = "NestMind Admin";

async function main() {
  const db = new PrismaClient();
  try {
    const existing = await db.landlord.findUnique({ where: { email: EMAIL } });
    if (existing) {
      // Update to PRO and reset password
      const hash = await bcrypt.hash(PASSWORD, 12);
      await db.landlord.update({
        where: { id: existing.id },
        data: { plan: "PRO", passwordHash: hash, messageCountThisMonth: 0 },
      });
      console.log(`Updated existing account ${EMAIL} to PRO plan.`);
    } else {
      const hash = await bcrypt.hash(PASSWORD, 12);
      const landlord = await db.landlord.create({
        data: {
          email: EMAIL,
          passwordHash: hash,
          name: NAME,
          plan: "PRO",
          whatsappNumbers: [],
        },
      });
      await db.landlordSettings.create({
        data: {
          landlordId: landlord.id,
          globalAutoReplyEnabled: false,
          batchDelaySeconds: 300,
          cooldownMinutes: 60,
        },
      });
      console.log(`Created PRO account: ${EMAIL}`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
