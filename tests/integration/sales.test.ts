import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

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
    getTodaySalesHistory,
    nextFreeSaleTicket,
    releaseTicketReservationAction,
    updateSaleQuantity,
} from "@/lib/actions/sales";
import { businessDate, businessMidnight, shiftCalendarDate } from "@/lib/analytics";
import { payAccount, toDebt } from "@/lib/actions/debts";
import { closeJornada } from "@/lib/actions/jornada";
import {
    TICKET_RESERVATION_PREFIX,
    TICKET_RESERVATION_TTL_MS,
    reservationKey,
    resetAllTicketReservations,
} from "@/lib/ticket-reservations";

describe("sales actions", () => {
    let adminId: number;
    let staffId: number;
    let jornadaId: number;
    let supplyId: number;
    let productId: number;
    let customerId: number;

    beforeAll(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;

        const staff = await prisma.users.create({
            data: { name: "Staff Test", email: "staff@test.local", username: "staff_tickets", role: "STAFF", active: true },
        });
        staffId = staff.id;

        const supply = await prisma.supplies.create({
            data: { name: "Masa", measureUnit: "kg", currentStockMilliunits: 100000, unitCostCents: 500 },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Sope",
                priceCents: 5000,
                recipes: { create: [{ supplyID: supplyId, quantityUsedMilliunits: 5 }] },
            },
        });
        productId = product.id;

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Venta", phone: "123", currentBalanceCents: 0 },
        });
        customerId = customer.id;
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await resetAllTicketReservations();
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
        expect(Number(sale.totalCents)).toBe(10000);
        expect(sale.status).toBe("PAID");
        expect(sale.payment_method).toBe("CASH");
        expect(sale.jornadaId).toBe(jornadaId);
        expect(sale.placedBy).toBe(adminId);
        expect(sale.sale_items).toHaveLength(1);
        expect(sale.sale_items[0].quantity).toBe(2);
        expect(Number(sale.sale_items[0].unitPriceCents)).toBe(5000);
        expect(Number(sale.sale_items[0].subtotalCents)).toBe(10000);

        // The recipe uses 5 milliunits per product, so two products consume 10 milliunits.
        const supply = await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } });
        expect(Number(supply.currentStockMilliunits)).toBe(99_990);
    });

    it("registers a debtor entry when the sale goes to debt", async () => {
        loginAs("ADMIN", adminId);
        const res = await createSale([{ productID: productId, quantity: 1 }], "DEBT", `CL- Cliente Venta`, customerId);
        expect(res).toMatchObject({ success: true });
        if (!res.success) return;

        const saleId = res.data.saleId;
        const sale = await prisma.sales.findUniqueOrThrow({ where: { id: saleId } });
        expect(sale.status).toBe("DEBT");
        expect(sale.payment_method).toBeNull();

        const debtor = await prisma.debtors.findUniqueOrThrow({ where: { saleID: saleId } });
        expect(debtor.customerID).toBe(customerId);
        expect(Number(debtor.amountCents)).toBe(5000);
        expect(debtor.status).toBe("DEBT");
        expect(debtor.createdJornadaId).toBe(sale.jornadaId);
        expect(debtor.paidJornadaId).toBeNull();
        expect(debtor.paidAt).toBeNull();

        const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
        expect(customer.lastConsumption).not.toBeNull();
        expect(Number(customer.currentBalanceCents)).toBe(5000);
    });

    it("keeps a table order UNPAID until the account is closed", async () => {
        loginAs("ADMIN", adminId);
        const res = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_2", -1);
        expect(res).toMatchObject({ success: true });
        if (!res.success) return;

        const saleId = res.data.saleId;
        const sale = await prisma.sales.findUniqueOrThrow({ where: { id: saleId } });
        expect(sale.status).toBe("UNPAID");
        // The method is only known when the account is actually settled.
        expect(sale.payment_method).toBeNull();

        const close = await closeAccountAction("MESA_2", "TRANSFER", [saleId], 5000);
        expect(close).toMatchObject({ success: true });

        const paid = await prisma.sales.findUniqueOrThrow({ where: { id: saleId } });
        expect(paid.status).toBe("PAID");
        expect(paid.payment_method).toBe("TRANSFER");
    });

    it("updateSaleQuantity adjusts item, totals and stock", async () => {
        loginAs("ADMIN", adminId);
        const created = await createSale([{ productID: productId, quantity: 2 }], "UNPAID", "MESA_6", -1);
        if (!created.success) throw new Error("Expected sale creation");
        const sale = await prisma.sales.findUniqueOrThrow({ where: { id: created.data.saleId } });
        const stockBefore = Number(
            (await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits
        );

        // Increasing the quantity from 2 to 3 consumes another 5 milliunits.
        const res = await updateSaleQuantity(sale.id, 3, productId);
        expect(res).toMatchObject({ success: true });

        const item = await prisma.sale_items.findFirstOrThrow({ where: { saleID: sale.id, productID: productId } });
        expect(item.quantity).toBe(3);
        expect(Number(item.subtotalCents)).toBe(15000);

        const updatedSale = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
        expect(Number(updatedSale.totalCents)).toBe(15000);

        const supply = await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } });
        expect(Number(supply.currentStockMilliunits)).toBe(stockBefore - 5);
    });

    it("cancelSaleAction marks the sale cancelled and replenishes stock", async () => {
        loginAs("ADMIN", adminId);
        const created = await createSale([{ productID: productId, quantity: 3 }], "UNPAID", "MESA_7", -1);
        if (!created.success) throw new Error("Expected sale creation");
        const sale = await prisma.sales.findUniqueOrThrow({ where: { id: created.data.saleId } });
        const stockBefore = Number(
            (await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits
        );

        const res = await cancelSaleAction(sale.id);
        expect(res).toMatchObject({ success: true });

        const cancelled = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
        expect(cancelled.status).toBe("CANCELLED");

        // Cancelling three products restores 15 milliunits.
        const supply = await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } });
        expect(Number(supply.currentStockMilliunits)).toBe(stockBefore + 15);
    });

    it("cancelling a debt sale closes its debtor row and lowers the balance", async () => {
        loginAs("ADMIN", adminId);
        const before = Number(
            (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).currentBalanceCents
        );
        const res = await createSale([{ productID: productId, quantity: 1 }], "DEBT", "CL- Cliente Venta", customerId);
        if (!res.success) throw new Error("Expected sale creation");
        const saleId = res.data.saleId;

        expect(await cancelSaleAction(saleId)).toMatchObject({ success: true });

        const debtor = await prisma.debtors.findUniqueOrThrow({ where: { saleID: saleId } });
        expect(debtor.status).toBe("CANCELLED");
        const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
        expect(Number(customer.currentBalanceCents)).toBe(before);
    });

    it("closeAccountAction pays the nominated sale by transfer", async () => {
        loginAs("ADMIN", adminId);
        const sale = await prisma.sales.create({
            data: {
                totalCents: 7000, status: "UNPAID", source_type: "MESA_4", placedBy: adminId, jornadaId,
            },
        });

        const res = await closeAccountAction("MESA_4", "TRANSFER", [sale.id], 7000);
        expect(res).toMatchObject({ success: true });

        const rows = await prisma.sales.findMany({ where: { source_type: "MESA_4" } });
        expect(rows.every((r) => r.status === "PAID" && r.payment_method === "TRANSFER")).toBe(true);
    });

    it("leaves an account unpaid when a terminal changes the quoted total", async () => {
        loginAs("ADMIN", adminId);
        const sale = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_4", -1);
        expect(sale.success).toBe(true);
        if (!sale.success) return;
        const saleId = sale.data.saleId;
        expect(await updateSaleQuantity(saleId, 2, productId)).toMatchObject({ success: true });
        expect(await closeAccountAction("MESA_4", "CASH", [saleId], 5000)).toMatchObject({
            success: false, error: "SALES_CHANGED",
        });
        expect(await prisma.sales.findUniqueOrThrow({ where: { id: saleId } })).toMatchObject({ status: "UNPAID" });
        expect(await closeAccountAction("MESA_4", "CASH", [saleId], 10000)).toMatchObject({ success: true, data: { count: 1 } });
    });

    it("keeps a legacy customer account accessible by its customer ID", async () => {
        loginAs("ADMIN", adminId);
        const sale = await prisma.sales.create({
            data: { totalCents: 5000, status: "UNPAID", source_type: "CL- Cliente Venta", customerID: customerId, placedBy: adminId, jornadaId },
        });
        const source = customerSource(customerId);
        expect((await getTodaySalesHistory()).find((entry) => entry.id === sale.id)).toMatchObject({
            source_type: source, jornadaId,
        });
        expect(await closeAccountAction(source, "CASH", [sale.id], 5000)).toMatchObject({ success: true, data: { count: 1 } });
    });

    it("closeAccountAction closes only the nominated sale IDs when provided", async () => {
        loginAs("ADMIN", adminId);

        const saleOne = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_5", -1);
        if (!saleOne.success) throw new Error("Expected saleOne");
        const idOne = saleOne.data.saleId;

        const saleTwo = await createSale([{ productID: productId, quantity: 2 }], "UNPAID", "MESA_5", -1);
        if (!saleTwo.success) throw new Error("Expected saleTwo");
        const idTwo = saleTwo.data.saleId;

        const res = await closeAccountAction("MESA_5", "CASH", [idOne], 5000);
        expect(res).toMatchObject({ success: true, data: { count: 1 } });

        const rowOne = await prisma.sales.findUniqueOrThrow({ where: { id: idOne } });
        expect(rowOne.status).toBe("PAID");
        expect(rowOne.payment_method).toBe("CASH");

        const rowTwo = await prisma.sales.findUniqueOrThrow({ where: { id: idTwo } });
        expect(rowTwo.status).toBe("UNPAID");
        expect(rowTwo.payment_method).toBeNull();

        // Paying a subset of sales on a walk-in ticket rewrites only paid sales to VENTA_LIBRE
        const ticket = await nextFreeSaleTicket();
        if (!ticket.success) throw new Error("Expected an available ticket");
        const tSaleOne = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", ticket.data.sourceType, -1, "CASH", ticket.data.reservationToken);
        if (!tSaleOne.success) throw new Error("Expected tSaleOne");
        const tIdOne = tSaleOne.data.saleId;
        const tSaleTwo = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", ticket.data.sourceType, -1, "CASH", undefined, [tIdOne]);
        if (!tSaleTwo.success) throw new Error("Expected tSaleTwo");
        const tIdTwo = tSaleTwo.data.saleId;

        const tRes = await closeAccountAction("VL-1", "CASH", [tIdOne], 5000);
        expect(tRes).toMatchObject({ success: true, data: { count: 1 } });

        const tRowOne = await prisma.sales.findUniqueOrThrow({ where: { id: tIdOne } });
        expect(tRowOne.status).toBe("PAID");
        expect(tRowOne.source_type).toBe("VENTA_LIBRE");

        const tRowTwo = await prisma.sales.findUniqueOrThrow({ where: { id: tIdTwo } });
        expect(tRowTwo.status).toBe("UNPAID");
        expect(tRowTwo.source_type).toBe("VL-1");

        // Closing the remaining sale frees the ticket completely
        expect(await closeAccountAction("VL-1", "CASH", [tIdTwo], 5000)).toMatchObject({ success: true, data: { count: 1 } });
        const tRowTwoAfter = await prisma.sales.findUniqueOrThrow({ where: { id: tIdTwo } });
        expect(tRowTwoAfter.status).toBe("PAID");
        expect(tRowTwoAfter.source_type).toBe("VENTA_LIBRE");
    });

    it("closeAccountAction leaves orphan unpaid sales of past jornadas untouched", async () => {
        loginAs("ADMIN", adminId);

        // An unpaid sale stranded in an already-closed jornada for the same table.
        const closedJornada = await prisma.jornada.create({
            data: { openedBy: adminId, openingAmountCents: 10000, status: "CLOSED", closedAt: new Date(), closedBy: adminId },
        });
        const orphan = await prisma.sales.create({
            data: { totalCents: 9900, status: "UNPAID", source_type: "MESA_7", placedBy: adminId, jornadaId: closedJornada.id },
        });
        // Today's account on the same table, in the open jornada.
        const current = await prisma.sales.create({
            data: { totalCents: 4000, status: "UNPAID", source_type: "MESA_7", placedBy: adminId, jornadaId },
        });

        const res = await closeAccountAction("MESA_7", "CASH", [current.id], 4000);
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
            data: { openedBy: adminId, openingAmountCents: 10000, status: "CLOSED", closedAt: new Date(), closedBy: adminId },
        });
        const orphan = await prisma.sales.create({
            data: { totalCents: 7500, status: "UNPAID", source_type: "MESA_9", placedBy: adminId, jornadaId: closedJornada.id },
        });

        // Current open jornada has NO sales for MESA_9
        const res = await closeAccountAction("MESA_9", "CASH", [orphan.id], 7500);
        expect(res).toMatchObject({ success: false, error: "DIFFERENT_JORNADA" });

        // Ensure the orphan sale remains UNPAID
        const orphanAfter = await prisma.sales.findUniqueOrThrow({ where: { id: orphan.id } });
        expect(orphanAfter.status).toBe("UNPAID");
        expect(orphanAfter.payment_method).toBeNull();
    });

    it("keeps several walk-in tickets open at once and charges them one by one", async () => {
        loginAs("ADMIN", adminId);

        const first = await nextFreeSaleTicket();
        expect(first).toMatchObject({ success: true, data: { sourceType: "VL-1" } });
        if (!first.success) return;

        const saleOne = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "VL-1", -1, "CASH", first.data.reservationToken);
        if (!saleOne.success) return;
        const idOne = saleOne.data.saleId;

        // A second walk-in customer arrives before the first one has paid:
        // they get their own ticket instead of joining the open one.
        const second = await nextFreeSaleTicket();
        expect(second).toMatchObject({ success: true, data: { sourceType: "VL-2" } });
        if (!second.success) return;

        const saleTwo = await createSale([{ productID: productId, quantity: 2 }], "UNPAID", "VL-2", -1, "CASH", second.data.reservationToken);
        if (!saleTwo.success) return;
        const idTwo = saleTwo.data.saleId;

        expect(await nextFreeSaleTicket()).toMatchObject({ success: true, data: { sourceType: "VL-3" } });

        // Charging one ticket settles only its own sales...
        const close = await closeAccountAction("VL-2", "TRANSFER", [idTwo], 10000);
        expect(close).toMatchObject({ success: true, data: { count: 1 } });

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
        expect(await nextFreeSaleTicket()).toMatchObject({ success: true, data: { sourceType: "VL-2" } });

        expect(await closeAccountAction("VL-1", "CASH", [idOne], 5000)).toMatchObject({ success: true, data: { count: 1 } });
    });

    it("closeAccountAction fails with NO_OPEN_JORNADA when none is open", async () => {
        loginAs("ADMIN", adminId);
        await prisma.jornada.updateMany({ where: { status: "OPEN" }, data: { status: "CLOSED" } });

        const res = await closeAccountAction("MESA_7", "CASH");
        expect(res).toMatchObject({ success: false, error: "NO_OPEN_JORNADA" });
        expect(await closeAccountAction("MESA_7", "CASH", [])).toMatchObject({ success: false, error: "NO_OPEN_JORNADA" });

        await prisma.jornada.update({ where: { id: jornadaId }, data: { status: "OPEN" } });
    });

    it("fails with NO_OPEN_JORNADA when the jornada is closed", async () => {
        loginAs("ADMIN", adminId);
        await prisma.jornada.update({ where: { id: jornadaId }, data: { status: "CLOSED" } });

        const res = await createSale([{ productID: productId, quantity: 1 }], "PAID", "VENTA_LIBRE", -1);
        expect(res.success).toBe(false);

        // Walk-in ticket numbers are scoped to the open jornada too.
        expect(await nextFreeSaleTicket()).toMatchObject({ success: false, error: "NO_OPEN_JORNADA" });

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
        expect(await closeAccountAction("MESA_1", "CHEQUE" as never)).toMatchObject({ success: false, error: "INVALID_INPUT" });
        expect(await closeAccountAction("MESA_1", "CASH", [-1])).toMatchObject({ success: false, error: "INVALID_INPUT" });
        expect(await closeAccountAction("MESA_1", "CASH", [1.5])).toMatchObject({ success: false, error: "INVALID_INPUT" });
        expect(await cancelSaleAction(1.5)).toMatchObject({ success: false, error: "INVALID_INPUT" });
        expect(await updateSaleQuantity(1, 1.5, productId)).toMatchObject({ success: false, error: "INVALID_INPUT" });
        expect(await prisma.sales.count()).toBe(before);
    });

    it("isolates customer accounts by customer ID when two customers share the same name", async () => {
        loginAs("ADMIN", adminId);

        // 1. Create two customers with the same customerName and different aliases
        const c1 = await prisma.customer.create({
            data: { customerName: "Juan Duplicado", alias: "Taller", currentBalanceCents: 0 }
        });
        const c2 = await prisma.customer.create({
            data: { customerName: "Juan Duplicado", alias: "Oficina", currentBalanceCents: 0 }
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
        if (!res1.success) return;
        const sale1Id = res1.data.saleId;

        // 3. Create an UNPAID sale for Customer 2
        const res2 = await createSale([{ productID: productId, quantity: 2 }], "UNPAID", source2, c2.id);
        expect(res2.success).toBe(true);
        if (!res2.success) return;
        const sale2Id = res2.data.saleId;

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
        const closeRes = await closeAccountAction(source1, "CASH", [sale1Id], 5000);
        expect(closeRes).toMatchObject({ success: true, data: { count: 1 } });

        // Customer 1's sale is now PAID
        const sale1Updated = await prisma.sales.findUniqueOrThrow({ where: { id: sale1Id } });
        expect(sale1Updated.status).toBe("PAID");

        // Customer 2's sale remains UNPAID
        const sale2Updated = await prisma.sales.findUniqueOrThrow({ where: { id: sale2Id } });
        expect(sale2Updated.status).toBe("UNPAID");

        // Clean up Customer 2's open sale so later closeJornada tests see a clean jornada
        expect(await closeAccountAction(source2, "CASH", [sale2Id], 10000)).toMatchObject({ success: true, data: { count: 1 } });
    });

    describe("getTodaySalesHistory", () => {
        it("returns empty array when unauthenticated", async () => {
            logout();
            expect(await getTodaySalesHistory()).toEqual([]);
        });

        it("includes sales from today's business day regardless of server UTC midnight", async () => {
            loginAs("ADMIN", adminId);
            const today = businessDate();
            const todayStart = businessMidnight(today);

            // A sale created at 10:00 AM local time today in Mexico City
            const morningSaleTime = new Date(todayStart.getTime() + 10 * 3600 * 1000);
            const sale = await prisma.sales.create({
                data: {
                    placedBy: adminId,
                    totalCents: 5000,
                    source_type: "VENTA_LIBRE",
                    status: "PAID",
                    payment_method: "CASH",
                    jornadaId,
                    createdAt: morningSaleTime,
                    sale_items: {
                        create: {
                            productID: productId,
                            quantity: 1,
                            unitPriceCents: 5000,
                            subtotalCents: 5000,
                        },
                    },
                },
            });

            const history = await getTodaySalesHistory();
            const found = history.find((s) => s.id === sale.id);
            expect(found).toBeDefined();
            expect(found?.total).toBe(5000);
        });

        it("preserves open UNPAID table accounts belonging to the active jornada across midnight", async () => {
            loginAs("ADMIN", adminId);
            const today = businessDate();
            const yesterdayDate = shiftCalendarDate(today, -1);
            const yesterdayMidnight = businessMidnight(yesterdayDate);

            // An open table opened yesterday before midnight during the active jornada
            const nightAccount = await prisma.sales.create({
                data: {
                    placedBy: adminId,
                    totalCents: 8000,
                    source_type: "MESA_99",
                    status: "UNPAID",
                    jornadaId,
                    createdAt: new Date(yesterdayMidnight.getTime() + 23 * 3600 * 1000), // 23:00 yesterday
                    sale_items: {
                        create: {
                            productID: productId,
                            quantity: 2,
                            unitPriceCents: 4000,
                            subtotalCents: 8000,
                        },
                    },
                },
            });

            const history = await getTodaySalesHistory();
            const found = history.find((s) => s.id === nightAccount.id);
            expect(found).toBeDefined();
            expect(found?.source_type).toBe("MESA_99");
            expect(found?.status).toBe("UNPAID");

            // Clean up test table
            await prisma.sale_items.deleteMany({ where: { saleID: nightAccount.id } });
            await prisma.sales.delete({ where: { id: nightAccount.id } });
        });

        it("excludes cancelled sales from today's history", async () => {
            loginAs("ADMIN", adminId);
            const today = businessDate();
            const todayStart = businessMidnight(today);

            const cancelledSale = await prisma.sales.create({
                data: {
                    placedBy: adminId,
                    totalCents: 4000,
                    source_type: "VENTA_LIBRE",
                    status: "CANCELLED",
                    jornadaId,
                    createdAt: new Date(todayStart.getTime() + 12 * 3600 * 1000),
                },
            });

            const history = await getTodaySalesHistory();
            expect(history.find((s) => s.id === cancelledSale.id)).toBeUndefined();

            await prisma.sales.delete({ where: { id: cancelledSale.id } });
        });
    });

    describe("sale cancellation and quantity edit restrictions", () => {
        it("rejects cancelling PAID sales for STAFF and ADMIN without changing the sale or stock", async () => {
            loginAs("ADMIN", adminId);
            const saleRes = await createSale([{ productID: productId, quantity: 1 }], "PAID", "VENTA_LIBRE", -1, "CASH");
            if (!saleRes.success) throw new Error("Expected sale creation");
            const saleId = saleRes.data.saleId;
            const beforeSale = await prisma.sales.findUniqueOrThrow({ where: { id: saleId } });
            const beforeItems = await prisma.sale_items.findMany({ where: { saleID: saleId } });
            const beforeStock = (await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits;

            loginAs("STAFF", staffId);
            const staffAttempt = await cancelSaleAction(saleId);
            expect(staffAttempt).toMatchObject({ success: false, error: "CANNOT_CANCEL_PAID_SALE" });

            loginAs("ADMIN", adminId);
            const adminAttempt = await cancelSaleAction(saleId);
            expect(adminAttempt).toMatchObject({ success: false, error: "CANNOT_CANCEL_PAID_SALE" });
            expect(await prisma.sales.findUniqueOrThrow({ where: { id: saleId } })).toEqual(beforeSale);
            expect(await prisma.sale_items.findMany({ where: { saleID: saleId } })).toEqual(beforeItems);
            expect((await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits).toBe(beforeStock);
        });

        it("rejects cancelling legacy PAID transfer sales without a jornada", async () => {
            loginAs("ADMIN", adminId);
            const legacySale = await prisma.sales.create({
                data: { placedBy: adminId, totalCents: 5000, source_type: "VENTA_LIBRE", status: "PAID", payment_method: "TRANSFER" },
            });
            expect(await cancelSaleAction(legacySale.id)).toMatchObject({ success: false, error: "CANNOT_CANCEL_PAID_SALE" });
            expect((await prisma.sales.findUniqueOrThrow({ where: { id: legacySale.id } })).status).toBe("PAID");
        });

        it("restricts cancelling DEBT sales to ADMIN", async () => {
            loginAs("ADMIN", adminId);
            const saleRes = await createSale([{ productID: productId, quantity: 1 }], "DEBT", "CL- Cliente Venta", customerId);
            if (!saleRes.success) throw new Error("Expected sale creation");
            const saleId = saleRes.data.saleId;

            loginAs("STAFF", staffId);
            const staffAttempt = await cancelSaleAction(saleId);
            expect(staffAttempt).toMatchObject({ success: false, error: "UNAUTHORIZED" });

            loginAs("ADMIN", adminId);
            const adminAttempt = await cancelSaleAction(saleId);
            expect(adminAttempt).toMatchObject({ success: true });
        });

        it("allows STAFF to cancel UNPAID sales in an open jornada", async () => {
            loginAs("STAFF", staffId);
            const saleRes = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_5", -1);
            if (!saleRes.success) throw new Error("Expected sale creation");
            const saleId = saleRes.data.saleId;

            const res = await cancelSaleAction(saleId);
            expect(res).toMatchObject({ success: true });

            const cancelled = await prisma.sales.findUniqueOrThrow({ where: { id: saleId } });
            expect(cancelled.status).toBe("CANCELLED");
        });

        it("rejects cancelSaleAction when the sale's jornada is closed", async () => {
            loginAs("ADMIN", adminId);
            const closedJornada = await prisma.jornada.create({
                data: { openedBy: adminId, openingAmountCents: 10000, status: "CLOSED", closedAt: new Date() },
            });
            const oldSale = await prisma.sales.create({
                data: {
                    placedBy: adminId,
                    totalCents: 5000,
                    source_type: "VENTA_LIBRE",
                    status: "UNPAID",
                    jornadaId: closedJornada.id,
                },
            });

            const res = await cancelSaleAction(oldSale.id);
            expect(res).toMatchObject({ success: false, error: "JORNADA_CLOSED" });
        });

        it("rejects updateSaleQuantity on CANCELLED sales without modifying stock", async () => {
            loginAs("ADMIN", adminId);
            const saleRes = await createSale([{ productID: productId, quantity: 2 }], "UNPAID", "MESA_6", -1);
            if (!saleRes.success) throw new Error("Expected sale creation");
            const saleId = saleRes.data.saleId;
            await cancelSaleAction(saleId);

            const stockBefore = Number(
                (await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits
            );

            const res = await updateSaleQuantity(saleId, 5, productId);
            expect(res).toMatchObject({ success: false, error: "CANNOT_MODIFY_CANCELLED_SALE" });

            const stockAfter = Number(
                (await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits
            );
            expect(stockAfter).toBe(stockBefore);
        });

        it("rejects updateSaleQuantity on sales in a closed jornada", async () => {
            loginAs("ADMIN", adminId);
            const closedJornada = await prisma.jornada.create({
                data: { openedBy: adminId, openingAmountCents: 10000, status: "CLOSED", closedAt: new Date() },
            });
            const oldSale = await prisma.sales.create({
                data: {
                    placedBy: adminId,
                    totalCents: 5000,
                    source_type: "VENTA_LIBRE",
                    status: "UNPAID",
                    jornadaId: closedJornada.id,
                    sale_items: {
                        create: { productID: productId, quantity: 1, unitPriceCents: 5000, subtotalCents: 5000 },
                    },
                },
            });

            const res = await updateSaleQuantity(oldSale.id, 2, productId);
            expect(res).toMatchObject({ success: false, error: "JORNADA_CLOSED" });
        });

        it("rejects updateSaleQuantity on PAID sales for STAFF and ADMIN without changing sale items or stock", async () => {
            loginAs("ADMIN", adminId);
            const saleRes = await createSale([{ productID: productId, quantity: 2 }], "PAID", "VENTA_LIBRE", -1, "CASH");
            if (!saleRes.success) throw new Error("Expected sale creation");
            const saleId = saleRes.data.saleId;
            const beforeSale = await prisma.sales.findUniqueOrThrow({ where: { id: saleId } });
            const beforeItems = await prisma.sale_items.findMany({ where: { saleID: saleId } });
            const beforeStock = (await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits;

            loginAs("STAFF", staffId);
            for (const quantity of [1, 2, 3]) {
                const staffAttempt = await updateSaleQuantity(saleId, quantity, productId);
                expect(staffAttempt).toMatchObject({ success: false, error: "CANNOT_MODIFY_PAID_SALE" });
            }

            loginAs("ADMIN", adminId);
            for (const quantity of [1, 2, 3]) {
                const adminAttempt = await updateSaleQuantity(saleId, quantity, productId);
                expect(adminAttempt).toMatchObject({ success: false, error: "CANNOT_MODIFY_PAID_SALE" });
            }
            expect(await prisma.sales.findUniqueOrThrow({ where: { id: saleId } })).toEqual(beforeSale);
            expect(await prisma.sale_items.findMany({ where: { saleID: saleId } })).toEqual(beforeItems);
            expect((await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits).toBe(beforeStock);
        });

        it("rejects quantity edits to legacy PAID transfer sales without a jornada", async () => {
            loginAs("ADMIN", adminId);
            const legacySale = await prisma.sales.create({
                data: {
                    placedBy: adminId, totalCents: 5000, source_type: "VENTA_LIBRE", status: "PAID", payment_method: "TRANSFER",
                    sale_items: { create: { productID: productId, quantity: 1, unitPriceCents: 5000, subtotalCents: 5000 } },
                },
            });
            expect(await updateSaleQuantity(legacySale.id, 2, productId)).toMatchObject({ success: false, error: "CANNOT_MODIFY_PAID_SALE" });
            expect((await prisma.sales.findUniqueOrThrow({ where: { id: legacySale.id } })).totalCents).toBe(BigInt(5000));
            expect((await prisma.sale_items.findFirstOrThrow({ where: { saleID: legacySale.id } })).quantity).toBe(1);
        });

        it("synchronizes debtor amounts and customer balance when editing DEBT sale quantity", async () => {
            loginAs("ADMIN", adminId);
            const customer = await prisma.customer.create({
                data: { customerName: "Cliente Sync Debt", currentBalanceCents: 0 },
            });

            const saleRes = await createSale([{ productID: productId, quantity: 1 }], "DEBT", `CL- ${customer.id}`, customer.id);
            if (!saleRes.success) throw new Error("Expected sale creation");
            const saleId = saleRes.data.saleId;

            // Product price is 50. Increase quantity to 3 -> total should be 150
            const updateRes = await updateSaleQuantity(saleId, 3, productId);
            expect(updateRes).toMatchObject({ success: true });

            const debtor = await prisma.debtors.findUniqueOrThrow({ where: { saleID: saleId } });
            expect(Number(debtor.amountCents)).toBe(15000);

            const customerAfter = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
            expect(Number(customerAfter.currentBalanceCents)).toBe(15000);
        });

        it("rejects updateSaleQuantity when a debt has already been paid", async () => {
            loginAs("ADMIN", adminId);
            const customer = await prisma.customer.create({
                data: { customerName: "Cliente Paid Debt", currentBalanceCents: 0 },
            });

            const saleRes = await createSale([{ productID: productId, quantity: 1 }], "DEBT", `CL- ${customer.id}`, customer.id);
            if (!saleRes.success) throw new Error("Expected sale creation");
            const saleId = saleRes.data.saleId;

            await payAccount(customer.id, [{ id: saleId } as never], "CASH");

            const updateRes = await updateSaleQuantity(saleId, 2, productId);
            expect(updateRes).toMatchObject({ success: false, error: "CANNOT_MODIFY_PAID_SALE" });
        });
    });

    it("Issue #29: atomically reserves distinct ticket numbers across concurrent terminals in PostgreSQL", async () => {
        loginAs("ADMIN", adminId);

        // True concurrent calls before any product is added
        const results = await Promise.all([
            nextFreeSaleTicket(),
            nextFreeSaleTicket(),
            nextFreeSaleTicket(),
            nextFreeSaleTicket(),
        ]);

        for (const r of results) {
            expect(r.success).toBe(true);
            if (r.success) {
                expect(r.data.reservationToken).toBeTruthy();
            }
        }

        const sourceTypes = results
            .filter((r): r is Extract<typeof r, { success: true }> => r.success)
            .map((r) => r.data.sourceType)
            .sort();

        expect(sourceTypes).toEqual(["VL-1", "VL-2", "VL-3", "VL-4"]);

        // Persisted in PostgreSQL `setting` table (survives restarts/multi-instance)
        const storedRows = await prisma.setting.findMany({
            where: { key: { startsWith: TICKET_RESERVATION_PREFIX } },
        });
        expect(storedRows.length).toBe(4);
    });

    it("Issue #29: validates releaseTicketReservationAction inputs, ownership token, and UNPAID sales guard", async () => {
        // Unauthenticated rejected
        logout();
        expect(await releaseTicketReservationAction("VL-1", "tok")).toMatchObject({
            success: false,
            error: "UNAUTHORIZED",
        });

        loginAs("ADMIN", adminId);

        // Malformed / non-string inputs rejected cleanly without throwing
        for (const badSource of [null, undefined, 123, "", "MESA_1", "VL-0", "VL-01", "VL- 1", "VL-abc"]) {
            expect(
                await releaseTicketReservationAction(badSource as never, "valid-token")
            ).toMatchObject({ success: false, error: "INVALID_INPUT" });
        }
        expect(await releaseTicketReservationAction("VL-1", "")).toMatchObject({
            success: false,
            error: "INVALID_INPUT",
        });

        // Reserve VL-1
        const t1 = await nextFreeSaleTicket();
        expect(t1.success).toBe(true);
        if (!t1.success) return;

        // Wrong token cannot sabotage Terminal 1's reservation
        expect(await releaseTicketReservationAction("VL-1", "wrong-token")).toMatchObject({
            success: false,
            error: "RESERVATION_MISMATCH",
        });
        const t2 = await nextFreeSaleTicket();
        expect(t2).toMatchObject({ success: true, data: { sourceType: "VL-2" } });

        // Matching token releases VL-1 immediately before any sale is placed
        expect(await releaseTicketReservationAction("VL-1", t1.data.reservationToken)).toMatchObject({
            success: true,
        });
        const reused = await nextFreeSaleTicket();
        expect(reused).toMatchObject({ success: true, data: { sourceType: "VL-1" } });
        if (!reused.success) return;

        // Place a sale on VL-1 -> consumes reservation atomically; release then fails with TICKET_HAS_SALES
        const sale1 = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "VL-1",
            -1,
            "CASH",
            reused.data.reservationToken
        );
        expect(sale1).toMatchObject({ success: true });
        if (!sale1.success) return;

        // Reservation row in DB was atomically consumed by createSale
        const resRow = await prisma.setting.findUnique({ where: { key: reservationKey(jornadaId, 1) } });
        expect(resRow).toBeNull();

        expect(await releaseTicketReservationAction("VL-1", reused.data.reservationToken)).toMatchObject({
            success: false,
            error: "TICKET_HAS_SALES",
        });

        const saleId = sale1.data.saleId;
        expect(await closeAccountAction("VL-1", "CASH", [saleId], 5000)).toMatchObject({ success: true, data: { count: 1 } });
    });

    it("Issue #29: prevents closeAccountAction(count=0) sabotage and protects reservations on expiry/collision", async () => {
        loginAs("ADMIN", adminId);

        const t1 = await nextFreeSaleTicket();
        expect(t1).toMatchObject({ success: true, data: { sourceType: "VL-1" } });
        if (!t1.success) return;

        // Duplicate/stale closeAccountAction with count=0 MUST NOT wipe Terminal 1's reservation
        expect(await closeAccountAction("VL-1", "CASH")).toMatchObject({ success: false, error: "NO_SALES_TO_CLOSE" });
        const t2 = await nextFreeSaleTicket();
        expect(t2).toMatchObject({ success: true, data: { sourceType: "VL-2" } });

        // Different user calling createSale without token on Terminal 1's empty reservation is rejected
        loginAs("STAFF", staffId);
        const hijackAttempt = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "VL-1", -1);
        expect(hijackAttempt).toMatchObject({ success: false, error: "TICKET_TAKEN" });

        // Advance time past 15-minute TTL -> reservation expires and can be reclaimed
        const futureNow = Date.now() + TICKET_RESERVATION_TTL_MS + 1_000;
        vi.spyOn(Date, "now").mockReturnValue(futureNow);

        // Also inject an expired reservation from a past jornada to verify global pruning
        await prisma.setting.upsert({
            where: { key: reservationKey(999999, 7) },
            update: { value: JSON.stringify({ token: "old", userId: adminId, expiresAt: futureNow - 5_000 }) },
            create: { key: reservationKey(999999, 7), value: JSON.stringify({ token: "old", userId: adminId, expiresAt: futureNow - 5_000 }) },
        });

        const t3 = await nextFreeSaleTicket();
        expect(t3).toMatchObject({ success: true, data: { sourceType: "VL-1" } });
        if (!t3.success) return;

        // Past-jornada expired entry was pruned automatically
        const prunedOld = await prisma.setting.findUnique({ where: { key: reservationKey(999999, 7) } });
        expect(prunedOld).toBeNull();

        // Terminal 1 attempting to use its stale token after Terminal 3 reclaimed VL-1 is rejected
        loginAs("ADMIN", adminId);
        const staleWrite = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "VL-1",
            -1,
            "CASH",
            t1.data.reservationToken
        );
        expect(staleWrite).toMatchObject({ success: false, error: "TICKET_TAKEN" });

        // Terminal 3 places a sale with its valid token -> succeeds
        loginAs("STAFF", staffId);
        const validWrite = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "VL-1",
            -1,
            "CASH",
            t3.data.reservationToken
        );
        expect(validWrite).toMatchObject({ success: true });
        if (!validWrite.success) return;

        // Even after Terminal 3 consumed its token, Terminal 1's stale token is STILL rejected (no merge!)
        loginAs("ADMIN", adminId);
        const postConsumeStale = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "VL-1",
            -1,
            "CASH",
            t1.data.reservationToken
        );
        expect(postConsumeStale).toMatchObject({ success: false, error: "TICKET_TAKEN" });

        // Cleanup
        await closeAccountAction("VL-1", "CASH", [validWrite.data.saleId], 5000);
    });

    it("Issue #29: handles cancelSaleAction, toDebt, direct PAID sales, and closeJornada cleanly", async () => {
        loginAs("ADMIN", adminId);

        // 1. Direct PAID sale on reserved ticket consumes & frees the reservation immediately
        const directTicket = await nextFreeSaleTicket();
        expect(directTicket).toMatchObject({ success: true, data: { sourceType: "VL-1" } });
        if (!directTicket.success) return;
        const paidSale = await createSale(
            [{ productID: productId, quantity: 1 }],
            "PAID",
            "VL-1",
            -1,
            "CASH",
            directTicket.data.reservationToken
        );
        expect(paidSale).toMatchObject({ success: true });
        const afterPaid = await nextFreeSaleTicket();
        expect(afterPaid).toMatchObject({ success: true, data: { sourceType: "VL-1" } });
        if (!afterPaid.success) return;

        // 2. Cancelling 1 of 2 UNPAID sales keeps VL-1 taken; cancelling the last frees it
        const s1 = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "VL-1", -1, "CASH", afterPaid.data.reservationToken);
        expect(s1).toMatchObject({ success: true });
        if (!s1.success) return;
        const id1 = s1.data.saleId;
        const s2 = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "VL-1", -1, "CASH", undefined, [id1]);
        expect(s2).toMatchObject({ success: true });
        if (!s2.success) return;
        const id2 = s2.data.saleId;

        await cancelSaleAction(id1);
        const whileOneRemains = await nextFreeSaleTicket();
        expect(whileOneRemains).toMatchObject({ success: true, data: { sourceType: "VL-2" } });

        await cancelSaleAction(id2);
        const afterLastCancelled = await nextFreeSaleTicket();
        expect(afterLastCancelled).toMatchObject({ success: true, data: { sourceType: "VL-1" } });
        if (!afterLastCancelled.success) return;

        // 3. Converting VL-1 to DEBT frees VL-1 immediately, and later cancelling that DEBT sale
        //    MUST NOT destroy a new terminal's live reservation on VL-1
        const debtCandidate = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "VL-1",
            -1,
            "CASH",
            afterLastCancelled.data.reservationToken
        );
        expect(debtCandidate).toMatchObject({ success: true });
        if (!debtCandidate.success) return;
        const debtSaleId = debtCandidate.data.saleId;

        const debtRes = await toDebt(customerId, [{ id: debtSaleId } as never]);
        expect(debtRes).toMatchObject({ success: true });

        const freshAfterDebt = await nextFreeSaleTicket();
        expect(freshAfterDebt).toMatchObject({ success: true, data: { sourceType: "VL-1" } });

        // Cancelling the earlier DEBT sale on VL-1 must leave the fresh empty reservation intact
        expect(await cancelSaleAction(debtSaleId)).toMatchObject({ success: true });
        const nextAfterDebtCancel = await nextFreeSaleTicket();
        expect(nextAfterDebtCancel).toMatchObject({ success: true, data: { sourceType: "VL-3" } });

        // 4. closeJornada preserves reservations when failing (OPEN_ACCOUNTS), clears them on success
        await prisma.sales.updateMany({ where: { jornadaId, status: "UNPAID" }, data: { status: "CANCELLED" } });
        const openSale = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_1", -1);
        expect(openSale).toMatchObject({ success: true });
        if (!openSale.success) return;
        const failedClose = await closeJornada(jornadaId, 50000);
        expect(failedClose).toMatchObject({ success: false, error: "OPEN_ACCOUNTS" });
        const remainingBeforeClose = await prisma.setting.findMany({
            where: { key: { startsWith: `${TICKET_RESERVATION_PREFIX}${jornadaId}:` } },
        });
        expect(remainingBeforeClose.length).toBeGreaterThan(0);

        await closeAccountAction("MESA_1", "CASH", [openSale.data.saleId], 5000);
        const okClose = await closeJornada(jornadaId, 50000);
        expect(okClose).toMatchObject({ success: true });

        const remainingAfterClose = await prisma.setting.findMany({
            where: { key: { startsWith: `${TICKET_RESERVATION_PREFIX}${jornadaId}:` } },
        });
        expect(remainingAfterClose.length).toBe(0);

        // Re-open jornada for any subsequent tests
        await prisma.jornada.update({ where: { id: jornadaId }, data: { status: "OPEN", closedAt: null, closedBy: null } });
    });

    it("rejects additions from a terminal that selected a previous use of the same ticket number", async () => {
        loginAs("ADMIN", adminId);
        const line = [{ productID: productId, quantity: 1 }];
        const first = await nextFreeSaleTicket();
        if (!first.success) throw new Error("Expected an available ticket");
        const sale = await createSale(line, "UNPAID", first.data.sourceType, -1, "CASH", first.data.reservationToken);
        expect(sale.success).toBe(true);
        if (!sale.success) return;
        const saleId = sale.data.saleId;
        expect(await closeAccountAction(first.data.sourceType, "CASH", [saleId], 5000)).toMatchObject({ success: true });

        const next = await nextFreeSaleTicket();
        if (!next.success) throw new Error("Expected a reusable ticket");
        expect(next.data.sourceType).toBe(first.data.sourceType);
        const nextSale = await createSale(line, "UNPAID", next.data.sourceType, -1, "CASH", next.data.reservationToken);
        expect(nextSale.success).toBe(true);
        if (!nextSale.success) return;
        const nextSaleId = nextSale.data.saleId;
        expect(await createSale(line, "UNPAID", next.data.sourceType, -1, "CASH", undefined, [saleId]))
            .toMatchObject({ success: false, error: "TICKET_TAKEN" });
        expect(await closeAccountAction(next.data.sourceType, "CASH", [nextSaleId], 5000)).toMatchObject({ success: true });
    });

    it("keeps a selected guest ticket after another terminal replaces its first line", async () => {
        loginAs("ADMIN", adminId);
        const ticket = await nextFreeSaleTicket();
        if (!ticket.success) throw new Error("Expected an available ticket");

        const line = [{ productID: productId, quantity: 1 }];
        const first = await createSale(line, "UNPAID", ticket.data.sourceType, -1, "CASH", ticket.data.reservationToken);
        if (!first.success || !first.data.ticketAccountId) throw new Error("Expected a guest ticket sale");
        const next = await createSale(line, "UNPAID", ticket.data.sourceType, -1, "CASH", undefined, [first.data.saleId]);
        if (!next.success) throw new Error("Expected a second line");
        expect(await cancelSaleAction(first.data.saleId)).toMatchObject({ success: true });

        const active = (await getTodaySalesHistory()).find((sale) => sale.id === next.data.saleId);
        expect(active?.ticketAccountId).toBe(first.data.ticketAccountId);
        const added = await createSale(line, "UNPAID", ticket.data.sourceType, -1, "CASH", undefined, undefined, first.data.ticketAccountId);
        if (!added.success) throw new Error("Expected an addition to the selected account");
        expect(await closeAccountAction(ticket.data.sourceType, "CASH", [next.data.saleId, added.data.saleId], 10000)).toMatchObject({ success: true, data: { count: 2 } });
    });
});
