import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { DebtorListItemSchema } from "@/lib/actions/schemas";
import { createSale, Sale } from "@/lib/actions/sales";
import { saveCustomer } from "@/lib/actions/customers";

describe("Adversarial Round 8 Reproduction Tests (Must Fail Against Current Code)", () => {
    let adminId: number;
    let openJornadaId: number;
    let productId: number;
    let supplyId: number;

    beforeAll(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        openJornadaId = jornada.id;

        const supply = await prisma.supplies.create({
            data: { name: "Harina Round8", measureUnit: "kg", currentStock: 100, unitCost: 10 },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Torta Round8",
                price: 70,
                recipes: { create: [{ supplyID: supplyId, quantityUsed: 1 }] },
            },
        });
        productId = product.id;
    });

    /**
     * FINDING 1: createSale with customerID: 0 (used by the POS for tables and unassigned sales)
     * must be accepted rather than rejected as INVALID_INPUT
     */
    it("FINDING 1: createSale with customerID = 0 (POS unassigned client) must succeed", async () => {
        loginAs("ADMIN", adminId);

        const res = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "MESA_1",
            0,
            "CASH"
        );

        // MUST FAIL if customerID !== -1 && customerID <= 0 rejects 0 as INVALID_INPUT
        expect(res.success).toBe(true);
    });

    /**
     * FINDING 2: DebtorListItemSchema must validate records with string-serialized dates (RSC/JSON)
     */
    it("FINDING 2: DebtorListItemSchema must parse records with ISO date strings", () => {
        const item = {
            customerID: 1,
            customerName: "Juan Pérez",
            alias: null,
            lastConsumption: "2026-11-19T00:00:00.000Z",
            registeredDate: "2026-11-19T00:00:00.000Z",
            amount: 150,
        };

        const res = DebtorListItemSchema.safeParse(item);

        // MUST FAIL if DebtorListItemSchema strictly requires z.date() and rejects strings
        expect(res.success).toBe(true);
    });

    /**
     * FINDING 3: saveCustomer must persist the alias field in the database
     */
    it("FINDING 3: saveCustomer must persist the alias field in the database", async () => {
        loginAs("ADMIN", adminId);

        const res = await saveCustomer({
            customerName: "Roberto Gómez R8",
            alias: "Chespirito R8",
        });
        expect(res.success).toBe(true);

        const created = await prisma.customer.findFirst({
            where: { customerName: "Roberto Gómez R8" },
        });

        // MUST FAIL if saveCustomer omits alias from pick/upsert and stores it as null
        expect(created?.alias).toBe("Chespirito R8");
    });

    /**
     * FINDING 4: createSale without an open jornada must return message: 'NO_OPEN_JORNADA' for POS alerts
     */
    it("FINDING 4: createSale without open jornada must return message NO_OPEN_JORNADA for POS UI alert", async () => {
        loginAs("ADMIN", adminId);

        // Close the active jornada
        await prisma.jornada.update({
            where: { id: openJornadaId },
            data: { status: "CLOSED" },
        });

        const res = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "VENTA_LIBRE",
            -1
        );

        // Reopen jornada for subsequent tests
        await prisma.jornada.update({
            where: { id: openJornadaId },
            data: { status: "OPEN" },
        });

        // MUST FAIL if createSale only returns error: "NO_OPEN_JORNADA" with message undefined
        expect(res).toMatchObject({
            success: false,
            message: "NO_OPEN_JORNADA",
        });
    });
});
