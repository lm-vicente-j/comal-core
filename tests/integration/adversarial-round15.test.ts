import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
import { getProductPage } from "@/lib/actions/products";

describe("Adversarial Round 15 — Issue #30 Review Findings", () => {
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
                name: "Insumo R15",
                measureUnit: "kg",
                currentStockMilliunits: 50_000,
                unitCostCents: 100,
                active: true,
            },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Producto R15",
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

    afterEach(async () => {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS adv15_fail_commit_sales ON "sales";`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS adv15_fail_commit_fn();`);
    });

    // -------------------------------------------------------------------------
    // Finding 1 (High — R2-2 / R1-4): TOCTOU race on supplies without FOR UPDATE or lock when jornadaId = null
    // -------------------------------------------------------------------------
    it("R15-1: concurrent cancelSaleAction on legacy sales with jornadaId = null must not overflow supply stock beyond MAX_SAFE_INTEGER", async () => {
        await prisma.supplies.update({
            where: { id: supplyId },
            data: { currentStockMilliunits: BigInt("5000000000000000") },
        });
        await prisma.recipes.update({
            where: { productID_supplyID: { productID: productId, supplyID: supplyId } },
            data: { quantityUsedMilliunits: BigInt("1000000000000000") },
        });

        // Create two legacy/jornada-less UNPAID sales, each with 4e15 snapshotted consumption.
        // Individually 5e15 + 4e15 = 9e15 <= MAX_SAFE_INTEGER, but together 5e15 + 8e15 = 13e15 > MAX_SAFE_INTEGER.
        const saleA = await prisma.sales.create({
            data: {
                totalCents: 10000,
                status: "UNPAID",
                source_type: "MESA_1",
                placedBy: adminId,
                jornadaId: null,
                sale_items: {
                    create: [{
                        productID: productId,
                        quantity: 4,
                        unitPriceCents: 2500,
                        subtotalCents: 10000,
                        consumptionRecorded: true,
                        consumptions: {
                            create: [{ supplyID: supplyId, quantityUsedMilliunits: BigInt("1000000000000000") }],
                        },
                    }],
                },
            },
        });
        const saleB = await prisma.sales.create({
            data: {
                totalCents: 10000,
                status: "UNPAID",
                source_type: "MESA_2",
                placedBy: adminId,
                jornadaId: null,
                sale_items: {
                    create: [{
                        productID: productId,
                        quantity: 4,
                        unitPriceCents: 2500,
                        subtotalCents: 10000,
                        consumptionRecorded: true,
                        consumptions: {
                            create: [{ supplyID: supplyId, quantityUsedMilliunits: BigInt("1000000000000000") }],
                        },
                    }],
                },
            },
        });

        await Promise.all([
            cancelSaleAction(saleA.id),
            cancelSaleAction(saleB.id),
        ]);

        const updatedSupply = await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } });
        expect(updatedSupply.currentStockMilliunits <= BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
        await expect(getProductPage({})).resolves.toBeDefined();
    });

    // -------------------------------------------------------------------------
    // Finding 2: paid sales are immutable even when legacy payment metadata is missing
    // -------------------------------------------------------------------------
    it("R15-2: updateSaleQuantity rejects a legacy PAID sale with null payment_method without changing it", async () => {
        const highProduct = await prisma.products.create({
            data: {
                name: "Producto Alto R15",
                priceCents: BigInt("100000000000000"),
            },
        });

        await prisma.sales.create({
            data: {
                totalCents: BigInt("9000000000000000"),
                status: "PAID",
                source_type: "VENTA_LIBRE",
                placedBy: adminId,
                payment_method: "CASH",
                jornadaId,
            },
        });

        const legacyPaidSale = await prisma.sales.create({
            data: {
                totalCents: BigInt("100000000000000"),
                status: "PAID",
                source_type: "VENTA_LIBRE",
                placedBy: adminId,
                payment_method: null,
                jornadaId,
                sale_items: {
                    create: [{
                        productID: highProduct.id,
                        quantity: 1,
                        unitPriceCents: BigInt("100000000000000"),
                        subtotalCents: BigInt("100000000000000"),
                        consumptionRecorded: true,
                    }],
                },
            },
        });

        const res = await updateSaleQuantity(legacyPaidSale.id, 10, highProduct.id);
        expect(res).toMatchObject({ success: false, error: "CANNOT_MODIFY_PAID_SALE" });
        expect(await prisma.sales.findUniqueOrThrow({ where: { id: legacyPaidSale.id } })).toMatchObject({ status: "PAID", totalCents: BigInt("100000000000000") });
        expect(await prisma.sale_items.findMany({ where: { saleID: legacyPaidSale.id } })).toMatchObject([{ quantity: 1 }]);
    });

    // -------------------------------------------------------------------------
    // Finding 3 (Medium — R1-2): createSale does not revalidate /admin/inventory after deducting stock
    // -------------------------------------------------------------------------
    it("R15-3: createSale must revalidate /admin/inventory after deducting recipe supply stock", async () => {
        const res = await createSale(
            [{ productID: productId, quantity: 2 }],
            "PAID",
            "VENTA_LIBRE",
            -1,
            "CASH",
        );
        expect(res.success).toBe(true);
        expect(revalidatePath).toHaveBeenCalledWith("/admin/inventory");
    });

    // -------------------------------------------------------------------------
    // Finding 4 (Low — R1-3 / R2-6): cancelSaleAction and updateSaleQuantity call revalidatePath inside prisma.$transaction before COMMIT
    // -------------------------------------------------------------------------
    it("R15-4: cancelSaleAction and updateSaleQuantity must not call revalidatePath if the transaction fails on COMMIT", async () => {
        const s1 = await createSale([{ productID: productId, quantity: 2 }], "UNPAID", "MESA_1", -1);
        const s2 = await createSale([{ productID: productId, quantity: 2 }], "UNPAID", "MESA_2", -1);
        expect(s1.success && s2.success).toBe(true);
        if (!s1.success || !s2.success) return;

        await prisma.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION adv15_fail_commit_fn() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'Simulated COMMIT failure';
            END;
            $$ LANGUAGE plpgsql;
        `);
        await prisma.$executeRawUnsafe(`
            CREATE CONSTRAINT TRIGGER adv15_fail_commit_sales
            AFTER UPDATE ON "sales"
            DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW
            EXECUTE FUNCTION adv15_fail_commit_fn();
        `);

        vi.mocked(revalidatePath).mockClear();
        const cancelRes = await cancelSaleAction(s1.data.saleId);
        expect(cancelRes.success).toBe(false);
        expect(revalidatePath).not.toHaveBeenCalled();

        vi.mocked(revalidatePath).mockClear();
        const updateRes = await updateSaleQuantity(s2.data.saleId, 5, productId);
        expect(updateRes.success).toBe(false);
        expect(revalidatePath).not.toHaveBeenCalled();
    });
});
