/**
 * Seed a PRO test account.
 * Run: node scripts/seedProAccount.js
 *
 * This creates or updates the admin@nestmind.ca PRO account.
 * Uses DATABASE_URL from .env or environment variables.
 */
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const EMAIL = "admin@nestmind.ca";
const PASSWORD = "NestMind2026!";
const NAME = "NestMind Admin";

async function main() {
    // Show which database we're connecting to (masked)
    const dbUrl = process.env.DATABASE_URL || "(not set)";
    const maskedUrl = dbUrl.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
    console.log("Connecting to:", maskedUrl);

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
            console.log(`✅ Updated existing account ${EMAIL} to PRO plan (id: ${existing.id})`);
        } else {
            const hash = await bcrypt.hash(PASSWORD, 12);
            const landlord = await db.landlord.create({
                data: {
                    email: EMAIL,
                    passwordHash: hash,
                    name: NAME,
                    plan: "PRO",
                    province: "ON",
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
            console.log(`✅ Created PRO account: ${EMAIL} (id: ${landlord.id})`);
        }

        // Verify the account works
        const verify = await db.landlord.findUnique({ where: { email: EMAIL } });
        if (!verify) {
            console.error("❌ Verification failed: account not found after create/update!");
            process.exit(1);
        }
        const passwordValid = await bcrypt.compare(PASSWORD, verify.passwordHash);
        console.log(`🔑 Password verification: ${passwordValid ? "PASS ✅" : "FAIL ❌"}`);
        console.log(`📋 Plan: ${verify.plan}, Province: ${verify.province}`);
        console.log(`\n🔐 Login credentials:\n   Email: ${EMAIL}\n   Password: ${PASSWORD}`);

        if (!passwordValid) {
            console.error("❌ Password hash mismatch! Something went wrong with bcrypt.");
            process.exit(1);
        }
    } finally {
        await db.$disconnect();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
