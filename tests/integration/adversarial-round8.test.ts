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
     * FALLO 1: createSale con customerID: 0 (usado por el POS para mesas y ventas sin cliente)
     * debe ser aceptado y no rechazado como INVALID_INPUT
     */
    it("FALLO 1: createSale with customerID = 0 (POS unassigned client) must succeed", async () => {
        loginAs("ADMIN", adminId);

        const res = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "MESA_1",
            0,
            "CASH"
        );

        // DEBE FALLAR: Actualmente customerID !== -1 && customerID <= 0 rechaza el 0 como INVALID_INPUT
        expect(res.success).toBe(true);
    });

    /**
     * FALLO 2: DebtorListItemSchema debe validar registros con fechas serializadas como string (RSC/JSON)
     */
    it("FALLO 2: DebtorListItemSchema must parse records with ISO date strings", () => {
        const item = {
            customerID: 1,
            customerName: "Juan Pérez",
            alias: null,
            lastConsumption: "2026-11-19T00:00:00.000Z",
            registeredDate: "2026-11-19T00:00:00.000Z",
            amount: 150,
        };

        const res = DebtorListItemSchema.safeParse(item);

        // DEBE FALLAR: DebtorListItemSchema exige estrictamente z.date() y rechaza string
        expect(res.success).toBe(true);
    });

    /**
     * FALLO 3: saveCustomer debe persistir el campo alias en la base de datos
     */
    it("FALLO 3: saveCustomer must persist the alias field in the database", async () => {
        loginAs("ADMIN", adminId);

        const res = await saveCustomer({
            customerName: "Roberto Gómez R8",
            alias: "Chespirito R8",
        });
        expect(res.success).toBe(true);

        const created = await prisma.customer.findFirst({
            where: { customerName: "Roberto Gómez R8" },
        });

        // DEBE FALLAR: Actualmente saveCustomer no incluye alias en pick ni en upsert, guardándolo como null
        expect(created?.alias).toBe("Chespirito R8");
    });

    /**
     * FALLO 4: createSale sin jornada abierta debe retornar message: 'NO_OPEN_JORNADA' compatible con alert del POS
     */
    it("FALLO 4: createSale without open jornada must return message NO_OPEN_JORNADA for POS UI alert", async () => {
        loginAs("ADMIN", adminId);

        // Cerrar la jornada activa
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

        // Reabrir jornada para otros tests
        await prisma.jornada.update({
            where: { id: openJornadaId },
            data: { status: "OPEN" },
        });

        // DEBE FALLAR: createSale solo retorna error: "NO_OPEN_JORNADA", dejando message undefined
        expect(res).toMatchObject({
            success: false,
            message: "NO_OPEN_JORNADA",
        });
    });
});
