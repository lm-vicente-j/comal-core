import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return {
        auth: authMock,
        signIn: vi.fn(),
        signOut: vi.fn(),
    };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";
import prisma from "@/lib/prisma";
import { loginAs, resetDb, seedBase } from "./helpers";
import { createSale, cancelSaleAction, updateSaleQuantity } from "@/lib/actions/sales";
import { toDebt } from "@/lib/actions/debts";
import { closeJornada } from "@/lib/actions/jornada";
import { getCustomerPage } from "@/lib/actions/customers";
import { getJornadaCashSummary } from "@/lib/jornada-cash";
import { customerSource } from "@/lib/pos-source";

describe("Adversarial Round 16 — Judge Verified Production Defects (Issue #30 Round 2)", () => {
    let adminId: number;
    let jornadaId: number;
    let supplyId: number;
    let productId: number;

    beforeEach(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;

        const supply = await prisma.supplies.create({
            data: {
                name: "Insumo R16",
                measureUnit: "kg",
                currentStockMilliunits: 50_000,
                unitCostCents: 100,
                active: true,
            },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Producto R16",
                priceCents: 2500,
                recipes: {
                    create: [{ supplyID: supplyId, quantityUsedMilliunits: 1000 }],
                },
            },
        });
        productId = product.id;

        loginAs("ADMIN", adminId);
        vi.mocked(revalidatePath).mockClear();
    });

    // -------------------------------------------------------------------------
    // Accepted Finding 1 (High — R2-F1 / R1-F1):
    // TOCTOU race on customer.currentBalanceCents and debtors aggregates when
    // modifying/cancelling DEBT sales with jornadaId = null
    // -------------------------------------------------------------------------
    it("R16-1a: concurrent updateSaleQuantity on legacy DEBT sales (jornadaId = null) must not overflow customer balance or open debts beyond MAX_SAFE_INTEGER", async () => {
        const unitPrice = BigInt("100000000000000"); // 1e14
        const highProduct = await prisma.products.create({
            data: { name: "Producto Alto R16", priceCents: unitPrice },
        });

        const customer = await prisma.customer.create({
            data: {
                customerName: "Cliente TOCTOU Positivo",
                currentBalanceCents: BigInt("8500000000000000"), // 8.5e15
            },
        });

        const saleA = await prisma.sales.create({
            data: {
                totalCents: BigInt("4500000000000000"),
                status: "DEBT",
                source_type: customerSource(customer.id),
                customerID: customer.id,
                placedBy: adminId,
                jornadaId: null,
                sale_items: {
                    create: [{
                        productID: highProduct.id,
                        quantity: 45,
                        unitPriceCents: unitPrice,
                        subtotalCents: BigInt("4500000000000000"),
                        consumptionRecorded: true,
                    }],
                },
                debtors: {
                    create: {
                        customer: { connect: { id: customer.id } },
                        createdJornada: { connect: { id: jornadaId } },
                        amountCents: BigInt("4500000000000000"),
                        status: "DEBT",
                    },
                },
            },
        });

        const saleB = await prisma.sales.create({
            data: {
                totalCents: BigInt("4000000000000000"),
                status: "DEBT",
                source_type: customerSource(customer.id),
                customerID: customer.id,
                placedBy: adminId,
                jornadaId: null,
                sale_items: {
                    create: [{
                        productID: highProduct.id,
                        quantity: 40,
                        unitPriceCents: unitPrice,
                        subtotalCents: BigInt("4000000000000000"),
                        consumptionRecorded: true,
                    }],
                },
                debtors: {
                    create: {
                        customer: { connect: { id: customer.id } },
                        createdJornada: { connect: { id: jornadaId } },
                        amountCents: BigInt("4000000000000000"),
                        status: "DEBT",
                    },
                },
            },
        });

        // Warm two pool connections so both concurrent transactions actually overlap.
        await Promise.all([
            prisma.$queryRaw`SELECT 1`,
            prisma.$queryRaw`SELECT 1`,
        ]);

        // Each adds +4e14: 8.5e15 + 4e14 = 8.9e15 <= MAX_SAFE_INTEGER individually,
        // but 8.5e15 + 8e14 = 9.3e15 > MAX_SAFE_INTEGER together.
        const [resA, resB] = await Promise.all([
            updateSaleQuantity(saleA.id, 49, highProduct.id),
            updateSaleQuantity(saleB.id, 44, highProduct.id),
        ]);

        expect(resA.success || resB.success).toBe(true);
        const updatedCustomer = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
        expect(updatedCustomer.currentBalanceCents <= BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);

        const openDebtsAgg = await prisma.debtors.aggregate({
            where: { status: "DEBT" },
            _sum: { amountCents: true },
        });
        expect((openDebtsAgg._sum.amountCents ?? BigInt(0)) <= BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
        await expect(getCustomerPage({})).resolves.toBeDefined();
        await expect(getJornadaCashSummary(jornadaId, 50000)).resolves.toBeDefined();
    });

    it("R16-1b: concurrent cancelSaleAction on legacy DEBT sales (jornadaId = null) must not underflow customer balance below MIN_SAFE_INTEGER", async () => {
        const customer = await prisma.customer.create({
            data: {
                customerName: "Cliente TOCTOU Negativo",
                currentBalanceCents: BigInt("-5000000000000000"), // -5e15
            },
        });

        const createLegacyDebt = async (source: string) => prisma.sales.create({
            data: {
                totalCents: BigInt("4000000000000000"),
                status: "DEBT",
                source_type: source,
                customerID: customer.id,
                placedBy: adminId,
                jornadaId: null,
                sale_items: {
                    create: [{
                        productID: productId,
                        quantity: 1,
                        unitPriceCents: BigInt("4000000000000000"),
                        subtotalCents: BigInt("4000000000000000"),
                        consumptionRecorded: true,
                    }],
                },
                debtors: {
                    create: {
                        customer: { connect: { id: customer.id } },
                        createdJornada: { connect: { id: jornadaId } },
                        amountCents: BigInt("4000000000000000"),
                        status: "DEBT",
                    },
                },
            },
        });

        const [saleA, saleB] = await Promise.all([
            createLegacyDebt(customerSource(customer.id)),
            createLegacyDebt(customerSource(customer.id)),
        ]);

        // Each subtracts 4e15: -5e15 - 4e15 = -9e15 >= MIN_SAFE_INTEGER individually,
        // but -5e15 - 8e15 = -13e15 < MIN_SAFE_INTEGER together.
        const [resA, resB] = await Promise.all([
            cancelSaleAction(saleA.id),
            cancelSaleAction(saleB.id),
        ]);

        expect(resA.success || resB.success).toBe(true);
        const updatedCustomer = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
        expect(updatedCustomer.currentBalanceCents >= BigInt(Number.MIN_SAFE_INTEGER)).toBe(true);
        await expect(getCustomerPage({})).resolves.toBeDefined();
    });

    // -------------------------------------------------------------------------
    // Accepted Finding 2 (Medium — R1-F2):
    // Bypass of JORNADA_CLOSED check when sale.jornadaId === null but
    // debtors.createdJornadaId belongs to a CLOSED jornada
    // -------------------------------------------------------------------------
    it("R16-2a: cancelSaleAction must reject JORNADA_CLOSED for a DEBT sale with jornadaId = null whose debtors.createdJornadaId is closed", async () => {
        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Jornada Cerrada Cancel", currentBalanceCents: BigInt(0) },
        });

        const legacyUnpaid = await prisma.sales.create({
            data: {
                totalCents: 2500,
                status: "UNPAID",
                source_type: "MESA_1",
                placedBy: adminId,
                jornadaId: null,
                sale_items: {
                    create: [{
                        productID: productId,
                        quantity: 1,
                        unitPriceCents: 2500,
                        subtotalCents: 2500,
                        consumptionRecorded: true,
                        consumptions: {
                            create: [{ supplyID: supplyId, quantityUsedMilliunits: 1000 }],
                        },
                    }],
                },
            },
        });

        const debtRes = await toDebt(customer.id, [{ id: legacyUnpaid.id }]);
        expect(debtRes.success).toBe(true);

        const closeRes = await closeJornada(jornadaId, 50000);
        expect(closeRes.success).toBe(true);

        const cancelRes = await cancelSaleAction(legacyUnpaid.id);
        expect(cancelRes).toEqual({ success: false, error: "JORNADA_CLOSED" });
    });

    it("R16-2b: updateSaleQuantity must reject JORNADA_CLOSED for a DEBT sale with jornadaId = null whose debtors.createdJornadaId is closed", async () => {
        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Jornada Cerrada Update", currentBalanceCents: BigInt(0) },
        });

        const legacyUnpaid = await prisma.sales.create({
            data: {
                totalCents: 2500,
                status: "UNPAID",
                source_type: "MESA_2",
                placedBy: adminId,
                jornadaId: null,
                sale_items: {
                    create: [{
                        productID: productId,
                        quantity: 1,
                        unitPriceCents: 2500,
                        subtotalCents: 2500,
                        consumptionRecorded: true,
                        consumptions: {
                            create: [{ supplyID: supplyId, quantityUsedMilliunits: 1000 }],
                        },
                    }],
                },
            },
        });

        const debtRes = await toDebt(customer.id, [{ id: legacyUnpaid.id }]);
        expect(debtRes.success).toBe(true);

        const closeRes = await closeJornada(jornadaId, 50000);
        expect(closeRes.success).toBe(true);

        const updateRes = await updateSaleQuantity(legacyUnpaid.id, 3, productId);
        expect(updateRes).toEqual({ success: false, error: "JORNADA_CLOSED" });
    });

    // -------------------------------------------------------------------------
    // Accepted Finding 3 (Low — R2-F4 / R1-F5):
    // Incomplete path revalidation (/admin/menu, /admin/jornada, /admin/crm)
    // and unconditional /debtors revalidation on non-DEBT createSale
    // -------------------------------------------------------------------------
    it("R16-3a: createSale must revalidate /admin/menu, /admin/jornada, /admin/crm (for customer sales) and avoid /debtors when status is PAID", async () => {
        const paidRes = await createSale(
            [{ productID: productId, quantity: 1 }],
            "PAID",
            "VENTA_LIBRE",
            -1,
            "CASH",
        );
        expect(paidRes.success).toBe(true);
        expect(revalidatePath).toHaveBeenCalledWith("/admin/menu");
        expect(revalidatePath).toHaveBeenCalledWith("/admin/jornada");
        expect(revalidatePath).not.toHaveBeenCalledWith("/debtors");

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Revalidacion", currentBalanceCents: BigInt(0) },
        });
        vi.mocked(revalidatePath).mockClear();

        const debtRes = await createSale(
            [{ productID: productId, quantity: 1 }],
            "DEBT",
            customerSource(customer.id),
            customer.id,
        );
        expect(debtRes.success).toBe(true);
        expect(revalidatePath).toHaveBeenCalledWith("/admin/crm");
        expect(revalidatePath).toHaveBeenCalledWith("/admin/jornada");
        expect(revalidatePath).toHaveBeenCalledWith("/admin/menu");
    });

    it("R16-3b: updateSaleQuantity and cancelSaleAction on DEBT sales must revalidate /admin/menu, /admin/jornada, and /admin/crm", async () => {
        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Revalidacion Mutate", currentBalanceCents: BigInt(0) },
        });

        const debtRes = await createSale(
            [{ productID: productId, quantity: 2 }],
            "DEBT",
            customerSource(customer.id),
            customer.id,
        );
        expect(debtRes.success).toBe(true);
        if (!debtRes.success) return;

        vi.mocked(revalidatePath).mockClear();
        const updRes = await updateSaleQuantity(debtRes.data.saleId, 3, productId);
        expect(updRes.success).toBe(true);
        expect(revalidatePath).toHaveBeenCalledWith("/admin/menu");
        expect(revalidatePath).toHaveBeenCalledWith("/admin/jornada");
        expect(revalidatePath).toHaveBeenCalledWith("/admin/crm");

        vi.mocked(revalidatePath).mockClear();
        const canRes = await cancelSaleAction(debtRes.data.saleId);
        expect(canRes.success).toBe(true);
        expect(revalidatePath).toHaveBeenCalledWith("/admin/menu");
        expect(revalidatePath).toHaveBeenCalledWith("/admin/jornada");
        expect(revalidatePath).toHaveBeenCalledWith("/admin/crm");
    });
});
