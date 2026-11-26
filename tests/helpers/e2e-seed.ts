/**
 * Deterministic seed for the e2e suite. Wipes the e2e database and creates
 * the minimum data the specs rely on: an admin (email/password) and a staff
 * user (username/pin), a couple of products and supplies, one customer, an
 * open jornada and enough bills to exercise server-side expenses pagination.
 *
 * Run with: DATABASE_URL=... npx tsx tests/helpers/e2e-seed.ts
 */
import { PrismaClient } from "@/app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { createPinLookupHash } from "../../lib/auth-crypto";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

export const E2E = {
    adminEmail: "admin@e2e.local",
    adminPassword: "admin123456789",
    staffUsername: "TEST1",
    staffPin: "123456",
    supervisorUsername: "SUPERVISOR1",
    supervisorPin: "654321",
    seedBills: 35,
};

async function main() {
    await prisma.$executeRaw`TRUNCATE TABLE "cash_count" RESTART IDENTITY CASCADE`;
    await prisma.$transaction([
        prisma.goal_contribution.deleteMany(),
        prisma.savings_goal.deleteMany(),
        prisma.savings_movement.deleteMany(),
        prisma.debtors.deleteMany(),
        prisma.sale_item_consumptions.deleteMany(),
        prisma.sale_items.deleteMany(),
        prisma.sales.deleteMany(),
        prisma.recipes.deleteMany(),
        prisma.products.deleteMany(),
        prisma.supplies.deleteMany(),
        prisma.salary.deleteMany(),
        prisma.bill.deleteMany(),
        prisma.jornada.deleteMany(),
        prisma.customer.deleteMany(),
        prisma.terminalSession.deleteMany(),
        prisma.terminalRequest.deleteMany(),
        prisma.terminal.deleteMany(),
        prisma.rolePermission.deleteMany(),
        prisma.authRateLimit.deleteMany(),
        prisma.securityAudit.deleteMany(),
        prisma.setting.deleteMany({ where: { OR: [{ key: { startsWith: "AUTH_LOCKOUT:" } }, { key: { in: ["CASH_COUNT_TOLERANCE_CENTS", "CLABE"] } }] } }),
        prisma.users.deleteMany(),
    ]);

    const admin = await prisma.users.create({
        data: {
            name: "Admin E2E",
            email: E2E.adminEmail,
            username: "ADMIN1",
            password: await bcrypt.hash(E2E.adminPassword, 10),
            role: "ADMIN",
            active: true,
        },
    });

    await prisma.users.create({
        data: {
            name: "Staff E2E",
            username: E2E.staffUsername,
            pin: await bcrypt.hash(E2E.staffPin, 10),
            pinLookupHash: createPinLookupHash(E2E.staffPin),
            role: "STAFF",
            active: true,
        },
    });

    await prisma.users.create({
        data: {
            name: "Supervisor E2E", username: E2E.supervisorUsername,
            pin: await bcrypt.hash(E2E.supervisorPin, 10),
            pinLookupHash: createPinLookupHash(E2E.supervisorPin),
            role: "SUPERVISOR", active: true,
        },
    });
    await prisma.installationState.upsert({
        where: { id: 1 }, create: { id: 1, initializedAt: new Date() },
        update: { initializedAt: new Date() },
    });

    const cheese = await prisma.supplies.create({
        data: { name: "Queso E2E", measureUnit: "kg", currentStockMilliunits: 100000, unitCostCents: 5000 },
    });
    await prisma.supplies.create({
        data: { name: "Harina E2E", measureUnit: "kg", currentStockMilliunits: 50000, unitCostCents: 2000 },
    });

    await prisma.products.create({ data: { name: "Taco Pastor", priceCents: 2500 } });
    await prisma.products.create({
        data: {
            name: "Quesadilla Grande",
            priceCents: 3500,
            recipes: { create: [{ supplyID: cheese.id, quantityUsedMilliunits: 1000 }] },
        },
    });

    await prisma.customer.create({
        data: { customerName: "Cliente Uno E2E", phone: "555-000-11", currentBalanceCents: 0 },
    });

    const jornada = await prisma.jornada.create({
        data: { openedBy: admin.id, openingAmountCents: 50000, status: "OPEN" },
    });

    await prisma.bill.createMany({
        data: Array.from({ length: E2E.seedBills }, (_, i) => ({
            amountCents: 1000,
            category: "Otros",
            description: `Gasto seed ${i + 1}`,
            date: new Date(),
            registered_by: admin.id,
            jornadaId: jornada.id,
            payment_method: "CASH" as const,
        })),
    });

    console.log("e2e seed done");
}

main().finally(() => prisma.$disconnect());
