const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

async function main() {
    // Check if LeaseDocument table exists
    const tables = await db.$queryRawUnsafe(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%lease%'"
    );
    console.log("Lease-related tables:", tables);

    if (tables.length === 0) {
        console.log("\n❌ LeaseDocument table does NOT exist in production!");
        console.log("Run: npx prisma migrate deploy");
        return;
    }

    const cols = await db.$queryRawUnsafe(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='LeaseDocument'"
    );
    console.log("\nLeaseDocument columns:", cols);

    // Check pending migrations
    const migrations = await db.$queryRawUnsafe(
        "SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 10"
    );
    console.log("\nRecent migrations:", migrations);
}

main().catch(e => console.error(e)).finally(() => db.$disconnect());
