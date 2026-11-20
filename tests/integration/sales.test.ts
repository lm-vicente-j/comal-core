import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { customerSource } from "@/lib/pos-source";
import {
    cancelSaleAction,
    closeAccountAction,
    createSale,
    nextFreeSaleTicket,
    updateSaleQuantity,
} from "@/lib/actions/sales";

describe("sales actions", () => {
    let adminId: number;
    let jornadaId: number;
    let supplyId: number;
    let productId: number;
    let customerId: number;

    beforeAll(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;

        const supply = await prisma.supplies.create({
            data: { name: "Masa", measureUnit: "kg", currentStock: 100, unitCost: 5 },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Sope",
                price: 50,
                recipes: { create: [{ supplyID: supplyId, quantityUsed: 2 }] },
            },
        });
        productId = product.id;

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Venta", phone: "123", currentBalance: 0 },
        });
        customerId = customer.id;
    });

    it("rejects createSale without a session", async () => {
        logout();
        const res = await createSale([{ productID: productId, quantity: 1 }], "PAID", "VENTA_LIBRE", -1);
        expect(res).toMatchObject({ success: false, error: "UNAUTHORIZED" });
        expect(await prisma.sales.count()).toBe(0);
    });

    it("creates a sale with items, totals and stock decrement", async () => {
        loginAs("ADMIN", adminId);
        const res = await createSale([{ productID: productId, quantity: 2 }], "PAID", "VENTA_LIBRE", -1, "CASH");
        expect(res).toMatchObject({ success: true });

        const sale = await prisma.sales.findFirstOrThrow({ include: { sale_items: true } });
        expect(Number(sale.total)).toBe(100);
        expect(sale.status).toBe("PAID");
        expect(sale.payment_method).toBe("CASH");
        expect(sale.jornadaId).toBe(jornadaId);
        expect(sale.placedBy).toBe(adminId);
        expect(sale.sale_items).toHaveLength(1);
        expect(sale.sale_items[0].quantity).toBe(2);
        expect(Number(sale.sale_items[0].unitPrice)).toBe(50);
        expect(Number(sale.sale_items[0].subtotal)).toBe(100);

        // recipe uses 2 per unit -> 2 units * 2 = 4 consumed
        const supply = await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } });
        expect(Number(supply.currentStock)).toBe(96);
    });

    it("registers a debtor entry when the sale goes to debt", async () => {
        loginAs("ADMIN", adminId);
        const res = await createSale([{ productID: productId, quantity: 1 }], "DEBT", `CL- Cliente Venta`, customerId);
        expect(res).toMatchObject({ success: true });

        const saleId = (res as { saleId: number }).saleId;
        const sale = await prisma.sales.findUniqueOrThrow({ where: { id: saleId } });
        expect(sale.status).toBe("DEBT");
        expect(sale.payment_method).toBeNull();

        const debtor = await prisma.debtors.findUniqueOrThrow({ where: { saleID: saleId } });
        expect(debtor.customerID).toBe(customerId);
        expect(Number(debtor.amount)).toBe(50);
        expect(debtor.status).toBe("DEBT");
        expect(debtor.createdJornadaId).toBe(sale.jornadaId);
        expect(debtor.paidJornadaId).toBeNull();
        expect(debtor.paidAt).toBeNull();

        const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
        expect(customer.lastConsumption).not.toBeNull();
        expect(Number(customer.currentBalance)).toBe(50);
    });

    it("keeps a table order UNPAID until the account is closed", async () => {
        loginAs("ADMIN", adminId);
        const res = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_2", -1);
        expect(res).toMatchObject({ success: true });

        const saleId = (res as { saleId: number }).saleId;
        const sale = await prisma.sales.findUniqueOrThrow({ where: { id: saleId } });
        expect(sale.status).toBe("UNPAID");
        // The method is only known when the account is actually settled.
        expect(sale.payment_method).toBeNull();

        const close = await closeAccountAction("MESA_2", "TRANSFER");
        expect(close).toMatchObject({ success: true });

        const paid = await prisma.sales.findUniqueOrThrow({ where: { id: saleId } });
        expect(paid.status).toBe("PAID");
        expect(paid.payment_method).toBe("TRANSFER");
    });

    it("updateSaleQuantity adjusts item, totals and stock", async () => {
        loginAs("ADMIN", adminId);
        const sale = await prisma.sales.findFirstOrThrow({ orderBy: { id: "asc" } });
        const stockBefore = Number(
            (await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStock
        );

        // quantity 2 -> 3: one extra unit consumes 2 more of the supply
        const res = await updateSaleQuantity(sale.id, 3, productId);
        expect(res).toMatchObject({ success: true });

        const item = await prisma.sale_items.findFirstOrThrow({ where: { saleID: sale.id, productID: productId } });
        expect(item.quantity).toBe(3);
        expect(Number(item.subtotal)).toBe(150);

        const updatedSale = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
        expect(Number(updatedSale.total)).toBe(150);

        const supply = await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } });
        expect(Number(supply.currentStock)).toBe(stockBefore - 2);
    });

    it("cancelSaleAction marks the sale cancelled and replenishes stock", async () => {
        loginAs("ADMIN", adminId);
        const sale = await prisma.sales.findFirstOrThrow({ orderBy: { id: "asc" } });
        const stockBefore = Number(
            (await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStock
        );

        const res = await cancelSaleAction(sale.id);
        expect(res).toMatchObject({ success: true });

        const cancelled = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
        expect(cancelled.status).toBe("CANCELLED");

        // 3 units * 2 per unit replenished
        const supply = await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } });
        expect(Number(supply.currentStock)).toBe(stockBefore + 6);
    });

    it("cancelling a debt sale closes its debtor row and lowers the balance", async () => {
        loginAs("ADMIN", adminId);
        const before = Number(
            (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).currentBalance
        );
        const res = await createSale([{ productID: productId, quantity: 1 }], "DEBT", "CL- Cliente Venta", customerId);
        const saleId = (res as { saleId: number }).saleId;

        expect(await cancelSaleAction(saleId)).toMatchObject({ success: true });

        const debtor = await prisma.debtors.findUniqueOrThrow({ where: { saleID: saleId } });
        expect(debtor.status).toBe("CANCELLED");
        const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
        expect(Number(customer.currentBalance)).toBe(before);
    });

    it("closeAccountAction pays every unpaid sale of a source", async () => {
        loginAs("ADMIN", adminId);
        await prisma.sales.create({
            data: {
                total: 70, status: "UNPAID", source_type: "MESA_4", placedBy: adminId, jornadaId,
            },
        });

        const res = await closeAccountAction("MESA_4", "TRANSFER");
        expect(res).toMatchObject({ success: true });

        const rows = await prisma.sales.findMany({ where: { source_type: "MESA_4" } });
        expect(rows.every((r) => r.status === "PAID" && r.payment_method === "TRANSFER")).toBe(true);
    });

    it("closeAccountAction leaves orphan unpaid sales of past jornadas untouched", async () => {
        loginAs("ADMIN", adminId);

        // An unpaid sale stranded in an already-closed jornada for the same table.
        const closedJornada = await prisma.jornada.create({
            data: { openedBy: adminId, openingAmount: 100, status: "CLOSED", closedAt: new Date(), closedBy: adminId },
        });
        const orphan = await prisma.sales.create({
            data: { total: 99, status: "UNPAID", source_type: "MESA_7", placedBy: adminId, jornadaId: closedJornada.id },
        });
        // Today's account on the same table, in the open jornada.
        const current = await prisma.sales.create({
            data: { total: 40, status: "UNPAID", source_type: "MESA_7", placedBy: adminId, jornadaId },
        });

        const res = await closeAccountAction("MESA_7", "CASH");
        expect(res).toMatchObject({ success: true });

        const orphanAfter = await prisma.sales.findUniqueOrThrow({ where: { id: orphan.id } });
        expect(orphanAfter.status).toBe("UNPAID");
        expect(orphanAfter.payment_method).toBeNull();

        const currentAfter = await prisma.sales.findUniqueOrThrow({ where: { id: current.id } });
        expect(currentAfter.status).toBe("PAID");
        expect(currentAfter.payment_method).toBe("CASH");
    });

    it("closeAccountAction fails with DIFFERENT_JORNADA when unpaid sales belong to another jornada", async () => {
        loginAs("ADMIN", adminId);

        // A closed jornada with an unpaid sale for MESA_9
        const closedJornada = await prisma.jornada.create({
            data: { openedBy: adminId, openingAmount: 100, status: "CLOSED", closedAt: new Date(), closedBy: adminId },
        });
        const orphan = await prisma.sales.create({
            data: { total: 75, status: "UNPAID", source_type: "MESA_9", placedBy: adminId, jornadaId: closedJornada.id },
        });

        // Current open jornada has NO sales for MESA_9
        const res = await closeAccountAction("MESA_9", "CASH");
        expect(res).toMatchObject({ success: false, message: "DIFFERENT_JORNADA" });

        // Ensure the orphan sale remains UNPAID
        const orphanAfter = await prisma.sales.findUniqueOrThrow({ where: { id: orphan.id } });
        expect(orphanAfter.status).toBe("UNPAID");
        expect(orphanAfter.payment_method).toBeNull();
    });

    it("keeps several walk-in tickets open at once and charges them one by one", async () => {
        loginAs("ADMIN", adminId);

        const first = await nextFreeSaleTicket();
        expect(first).toMatchObject({ success: true, sourceType: "VL-1" });

        const saleOne = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "VL-1", -1);
        const idOne = (saleOne as { saleId: number }).saleId;

        // A second walk-in customer arrives before the first one has paid:
        // they get their own ticket instead of joining the open one.
        const second = await nextFreeSaleTicket();
        expect(second).toMatchObject({ success: true, sourceType: "VL-2" });

        const saleTwo = await createSale([{ productID: productId, quantity: 2 }], "UNPAID", "VL-2", -1);
        const idTwo = (saleTwo as { saleId: number }).saleId;

        expect(await nextFreeSaleTicket()).toMatchObject({ sourceType: "VL-3" });

        // Charging one ticket settles only its own sales...
        const close = await closeAccountAction("VL-2", "TRANSFER");
        expect(close).toMatchObject({ success: true, count: 1 });

        const charged = await prisma.sales.findUniqueOrThrow({ where: { id: idTwo } });
        expect(charged.status).toBe("PAID");
        expect(charged.payment_method).toBe("TRANSFER");
        // ...and the ticket number stops being an origin of its own, so
        // history and reports keep grouping walk-in sales as before.
        expect(charged.source_type).toBe("VENTA_LIBRE");

        const stillOpen = await prisma.sales.findUniqueOrThrow({ where: { id: idOne } });
        expect(stillOpen.status).toBe("UNPAID");
        expect(stillOpen.source_type).toBe("VL-1");

        // The number the charged ticket gave back is handed out again.
        expect(await nextFreeSaleTicket()).toMatchObject({ sourceType: "VL-2" });

        expect(await closeAccountAction("VL-1", "CASH")).toMatchObject({ success: true, count: 1 });
    });

    it("closeAccountAction fails with NO_OPEN_JORNADA when none is open", async () => {
        loginAs("ADMIN", adminId);
        await prisma.jornada.updateMany({ where: { status: "OPEN" }, data: { status: "CLOSED" } });

        const res = await closeAccountAction("MESA_7", "CASH");
        expect(res).toMatchObject({ success: false, message: "NO_OPEN_JORNADA" });

        await prisma.jornada.update({ where: { id: jornadaId }, data: { status: "OPEN" } });
    });

    it("fails with NO_OPEN_JORNADA when the jornada is closed", async () => {
        loginAs("ADMIN", adminId);
        await prisma.jornada.update({ where: { id: jornadaId }, data: { status: "CLOSED" } });

        const res = await createSale([{ productID: productId, quantity: 1 }], "PAID", "VENTA_LIBRE", -1);
        expect(res.success).toBe(false);

        // Walk-in ticket numbers are scoped to the open jornada too.
        expect(await nextFreeSaleTicket()).toMatchObject({ success: false, message: "NO_OPEN_JORNADA" });

        await prisma.jornada.update({ where: { id: jornadaId }, data: { status: "OPEN" } });
    });

    it("rejects malformed input before touching the database", async () => {
        loginAs("ADMIN", adminId);
        const before = await prisma.sales.count();
        const items = [{ productID: productId, quantity: 1 }];
        const rejected = [
            await createSale(items, "PAID", "VENTA_LIBRE", -1, "CHEQUE" as never),
            await createSale(items, "CANCELLED" as never, "VENTA_LIBRE", -1),
            await createSale([{ productID: productId, quantity: 0 }], "PAID", "VENTA_LIBRE", -1),
            await createSale(items, "PAID", "", -1),
            await createSale(items, "PAID", "VENTA_LIBRE", 1.5),
        ];
        for (const res of rejected) expect(res).toMatchObject({ success: false, error: "INVALID_INPUT" });
        expect(await closeAccountAction("MESA_1", "CHEQUE" as never)).toMatchObject({ success: false, message: "INVALID_INPUT" });
        expect(await cancelSaleAction(1.5)).toMatchObject({ success: false, error: "INVALID_INPUT" });
        expect(await updateSaleQuantity(1, 1.5, productId)).toMatchObject({ success: false, message: "INVALID_INPUT" });
        expect(await prisma.sales.count()).toBe(before);
    });

    it("isolates customer accounts by customer ID when two customers share the same name", async () => {
        loginAs("ADMIN", adminId);

        // 1. Create two customers with the same customerName and different aliases
        const c1 = await prisma.customer.create({
            data: { customerName: "Juan Duplicado", alias: "Taller", currentBalance: 0 }
        });
        const c2 = await prisma.customer.create({
            data: { customerName: "Juan Duplicado", alias: "Oficina", currentBalance: 0 }
        });

        expect(c1.id).not.toBe(c2.id);

        const source1 = customerSource(c1.id);
        const source2 = customerSource(c2.id);

        expect(source1).toBe(`CL- ${c1.id}`);
        expect(source2).toBe(`CL- ${c2.id}`);
        expect(source1).not.toBe(source2);

        // 2. Create an UNPAID sale for Customer 1
        const res1 = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", source1, c1.id);
        expect(res1.success).toBe(true);
        const sale1Id = (res1 as { saleId: number }).saleId;

        // 3. Create an UNPAID sale for Customer 2
        const res2 = await createSale([{ productID: productId, quantity: 2 }], "UNPAID", source2, c2.id);
        expect(res2.success).toBe(true);
        const sale2Id = (res2 as { saleId: number }).saleId;

        // 4. Verify sales are isolated per customer
        const c1Sales = await prisma.sales.findMany({
            where: { source_type: source1, status: "UNPAID" }
        });
        expect(c1Sales).toHaveLength(1);
        expect(c1Sales[0].id).toBe(sale1Id);
        expect(c1Sales[0].customerID).toBe(c1.id);

        const c2Sales = await prisma.sales.findMany({
            where: { source_type: source2, status: "UNPAID" }
        });
        expect(c2Sales).toHaveLength(1);
        expect(c2Sales[0].id).toBe(sale2Id);
        expect(c2Sales[0].customerID).toBe(c2.id);

        // 5. Close Customer 1's account
        const closeRes = await closeAccountAction(source1, "CASH");
        expect(closeRes).toMatchObject({ success: true, count: 1 });

        // Customer 1's sale is now PAID
        const sale1Updated = await prisma.sales.findUniqueOrThrow({ where: { id: sale1Id } });
        expect(sale1Updated.status).toBe("PAID");

        // Customer 2's sale remains UNPAID
        const sale2Updated = await prisma.sales.findUniqueOrThrow({ where: { id: sale2Id } });
        expect(sale2Updated.status).toBe("UNPAID");
    });
});
