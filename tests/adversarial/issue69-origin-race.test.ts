import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("../helpers/database");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { cancelSaleAction, updateSaleQuantity } from "@/lib/actions/sales";
import { toDebt } from "@/lib/actions/debts";
import { loginAs, resetDb, seedBase } from "../helpers/database";

describe("issue 69 originating jornada race", () => {
    let adminId: number;
    let productId: number;
    let customerId: number;

    beforeEach(async () => {
        await resetDb();
        const { admin } = await seedBase();
        adminId = admin.id;
        loginAs("ADMIN", adminId);

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Carrera Jornada", currentBalanceCents: 0 },
        });
        customerId = customer.id;
        const product = await prisma.products.create({
            data: { name: "Producto Carrera Jornada", priceCents: 2500 },
        });
        productId = product.id;
    });

    afterEach(() => vi.restoreAllMocks());

    it.each([
        ["cancellation", "cancel"] as const,
        ["quantity edit", "update"] as const,
    ])("rejects a %s if a legacy sale becomes debt after its initial target read", async (_label, mutation) => {
        const sale = await prisma.sales.create({
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
                    }],
                },
            },
        });

        const originalTransaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
        let targetReadStarted!: () => void;
        let resumeMutation!: () => void;
        const targetRead = new Promise<void>((resolve) => { targetReadStarted = resolve; });
        const resume = new Promise<void>((resolve) => { resumeMutation = resolve; });
        let paused = false;

        vi.spyOn(prisma, "$transaction").mockImplementation((async (callback: unknown, options?: unknown) => {
            if (typeof callback !== "function") return originalTransaction(callback, options);
            return originalTransaction((async (tx: unknown) => {
                const wrappedTx = new Proxy(tx as object, {
                    get(target, key, receiver) {
                        if (key !== "sales") {
                            const value = Reflect.get(target, key, target);
                            return typeof value === "function" ? value.bind(target) : value;
                        }
                        const sales = Reflect.get(target, key, target) as object;
                        return new Proxy(sales, {
                            get(delegate, method) {
                                const value = Reflect.get(delegate, method, delegate);
                                if (method !== "findUnique") {
                                    return typeof value === "function" ? value.bind(delegate) : value;
                                }
                                return async (args: { select?: { jornadaId?: boolean; debtors?: unknown } }) => {
                                    const result = await value.call(delegate, args);
                                    if (!paused && args.select?.jornadaId && args.select?.debtors) {
                                        paused = true;
                                        targetReadStarted();
                                        await resume;
                                    }
                                    return result;
                                };
                            },
                        });
                    },
                });
                return (callback as (transaction: unknown) => Promise<unknown>)(wrappedTx);
            }), options);
        }) as typeof prisma.$transaction);

        const mutationResultPromise = mutation === "cancel"
            ? cancelSaleAction(sale.id)
            : updateSaleQuantity(sale.id, 2, productId);

        await targetRead;
        let debtResult;
        try {
            debtResult = await toDebt(customerId, [{ id: sale.id }], 2500);
        } finally {
            resumeMutation();
        }
        expect(debtResult).toMatchObject({ success: true });

        const mutationResult = await mutationResultPromise;
        expect(mutationResult).toEqual({ success: false, error: "SALES_CHANGED" });

        const persistedSale = await prisma.sales.findUniqueOrThrow({
            where: { id: sale.id },
            include: { sale_items: true, debtors: true },
        });
        expect(persistedSale.status).toBe("DEBT");
        expect(persistedSale.totalCents).toBe(BigInt(2500));
        expect(persistedSale.sale_items[0]?.quantity).toBe(1);
        expect(persistedSale.debtors?.status).toBe("DEBT");
        expect((await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).currentBalanceCents).toBe(BigInt(2500));
    });
});
