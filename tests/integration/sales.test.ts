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

    it("closeAccountAction closes only the nominated sale IDs when provided", async () => {
        loginAs("ADMIN", adminId);

        const saleOne = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_5", -1);
        const idOne = (saleOne as { saleId: number }).saleId;

        const saleTwo = await createSale([{ productID: productId, quantity: 2 }], "UNPAID", "MESA_5", -1);
        const idTwo = (saleTwo as { saleId: number }).saleId;

        const res = await closeAccountAction("MESA_5", "CASH", [idOne]);
        expect(res).toMatchObject({ success: true, count: 1 });

        const rowOne = await prisma.sales.findUniqueOrThrow({ where: { id: idOne } });
        expect(rowOne.status).toBe("PAID");
        expect(rowOne.payment_method).toBe("CASH");

        const rowTwo = await prisma.sales.findUniqueOrThrow({ where: { id: idTwo } });
        expect(rowTwo.status).toBe("UNPAID");
        expect(rowTwo.payment_method).toBeNull();

        // Paying a subset of sales on a walk-in ticket rewrites only paid sales to VENTA_LIBRE
        const tSaleOne = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "VL-1", -1);
        const tIdOne = (tSaleOne as { saleId: number }).saleId;
        const tSaleTwo = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "VL-1", -1);
        const tIdTwo = (tSaleTwo as { saleId: number }).saleId;

        const tRes = await closeAccountAction("VL-1", "CASH", [tIdOne]);
        expect(tRes).toMatchObject({ success: true, count: 1 });

        const tRowOne = await prisma.sales.findUniqueOrThrow({ where: { id: tIdOne } });
        expect(tRowOne.status).toBe("PAID");
        expect(tRowOne.source_type).toBe("VENTA_LIBRE");

        const tRowTwo = await prisma.sales.findUniqueOrThrow({ where: { id: tIdTwo } });
        expect(tRowTwo.status).toBe("UNPAID");
        expect(tRowTwo.source_type).toBe("VL-1");

        // Closing the remaining sale frees the ticket completely
        expect(await closeAccountAction("VL-1", "CASH", [tIdTwo])).toMatchObject({ success: true, count: 1 });
        const tRowTwoAfter = await prisma.sales.findUniqueOrThrow({ where: { id: tIdTwo } });
        expect(tRowTwoAfter.status).toBe("PAID");
        expect(tRowTwoAfter.source_type).toBe("VENTA_LIBRE");
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
        expect(await closeAccountAction("MESA_7", "CASH", [])).toMatchObject({ success: false, message: "NO_OPEN_JORNADA" });

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
        expect(await closeAccountAction("MESA_1", "CASH", [-1])).toMatchObject({ success: false, message: "INVALID_INPUT" });
        expect(await closeAccountAction("MESA_1", "CASH", [1.5])).toMatchObject({ success: false, message: "INVALID_INPUT" });
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

        // Clean up Customer 2's open sale so later closeJornada tests see a clean jornada
        expect(await closeAccountAction(source2, "CASH")).toMatchObject({ success: true, count: 1 });
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
                    total: 50,
                    source_type: "VENTA_LIBRE",
                    status: "PAID",
                    payment_method: "CASH",
                    jornadaId,
                    createdAt: morningSaleTime,
                    sale_items: {
                        create: {
                            productID: productId,
                            quantity: 1,
                            unitPrice: 50,
                            subtotal: 50,
                        },
                    },
                },
            });

            const history = await getTodaySalesHistory();
            const found = history.find((s) => s.id === sale.id);
            expect(found).toBeDefined();
            expect(found?.total).toBe(50);
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
                    total: 80,
                    source_type: "MESA_99",
                    status: "UNPAID",
                    jornadaId,
                    createdAt: new Date(yesterdayMidnight.getTime() + 23 * 3600 * 1000), // 23:00 yesterday
                    sale_items: {
                        create: {
                            productID: productId,
                            quantity: 2,
                            unitPrice: 40,
                            subtotal: 80,
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
                    total: 40,
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
        it("restricts cancelling PAID sales to ADMIN", async () => {
            loginAs("ADMIN", adminId);
            const saleRes = await createSale([{ productID: productId, quantity: 1 }], "PAID", "VENTA_LIBRE", -1);
            const saleId = (saleRes as { saleId: number }).saleId;

            loginAs("STAFF", staffId);
            const staffAttempt = await cancelSaleAction(saleId);
            expect(staffAttempt).toMatchObject({ success: false, error: "UNAUTHORIZED" });

            loginAs("ADMIN", adminId);
            const adminAttempt = await cancelSaleAction(saleId);
            expect(adminAttempt).toMatchObject({ success: true });
        });

        it("restricts cancelling DEBT sales to ADMIN", async () => {
            loginAs("ADMIN", adminId);
            const saleRes = await createSale([{ productID: productId, quantity: 1 }], "DEBT", "CL- Cliente Venta", customerId);
            const saleId = (saleRes as { saleId: number }).saleId;

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
            const saleId = (saleRes as { saleId: number }).saleId;

            const res = await cancelSaleAction(saleId);
            expect(res).toMatchObject({ success: true });

            const cancelled = await prisma.sales.findUniqueOrThrow({ where: { id: saleId } });
            expect(cancelled.status).toBe("CANCELLED");
        });

        it("rejects cancelSaleAction when the sale's jornada is closed", async () => {
            loginAs("ADMIN", adminId);
            const closedJornada = await prisma.jornada.create({
                data: { openedBy: adminId, openingAmount: 100, status: "CLOSED", closedAt: new Date() },
            });
            const oldSale = await prisma.sales.create({
                data: {
                    placedBy: adminId,
                    total: 50,
                    source_type: "VENTA_LIBRE",
                    status: "PAID",
                    payment_method: "CASH",
                    jornadaId: closedJornada.id,
                },
            });

            const res = await cancelSaleAction(oldSale.id);
            expect(res).toMatchObject({ success: false, error: "JORNADA_CLOSED" });
        });

        it("rejects updateSaleQuantity on CANCELLED sales without modifying stock", async () => {
            loginAs("ADMIN", adminId);
            const saleRes = await createSale([{ productID: productId, quantity: 2 }], "UNPAID", "MESA_6", -1);
            const saleId = (saleRes as { saleId: number }).saleId;
            await cancelSaleAction(saleId);

            const stockBefore = Number(
                (await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStock
            );

            const res = await updateSaleQuantity(saleId, 5, productId);
            expect(res).toMatchObject({ success: false, message: "CANNOT_MODIFY_CANCELLED_SALE" });

            const stockAfter = Number(
                (await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStock
            );
            expect(stockAfter).toBe(stockBefore);
        });

        it("rejects updateSaleQuantity on sales in a closed jornada", async () => {
            loginAs("ADMIN", adminId);
            const closedJornada = await prisma.jornada.create({
                data: { openedBy: adminId, openingAmount: 100, status: "CLOSED", closedAt: new Date() },
            });
            const oldSale = await prisma.sales.create({
                data: {
                    placedBy: adminId,
                    total: 50,
                    source_type: "VENTA_LIBRE",
                    status: "PAID",
                    payment_method: "CASH",
                    jornadaId: closedJornada.id,
                    sale_items: {
                        create: { productID: productId, quantity: 1, unitPrice: 50, subtotal: 50 },
                    },
                },
            });

            const res = await updateSaleQuantity(oldSale.id, 2, productId);
            expect(res).toMatchObject({ success: false, message: "JORNADA_CLOSED" });
        });

        it("restricts updateSaleQuantity on PAID and DEBT sales to ADMIN", async () => {
            loginAs("ADMIN", adminId);
            const saleRes = await createSale([{ productID: productId, quantity: 1 }], "PAID", "VENTA_LIBRE", -1);
            const saleId = (saleRes as { saleId: number }).saleId;

            loginAs("STAFF", staffId);
            const res = await updateSaleQuantity(saleId, 2, productId);
            expect(res).toMatchObject({ success: false, message: "UNAUTHORIZED" });

            loginAs("ADMIN", adminId);
            const adminRes = await updateSaleQuantity(saleId, 2, productId);
            expect(adminRes).toMatchObject({ success: true });
        });

        it("synchronizes debtor amounts and customer balance when editing DEBT sale quantity", async () => {
            loginAs("ADMIN", adminId);
            const customer = await prisma.customer.create({
                data: { customerName: "Cliente Sync Debt", currentBalance: 0 },
            });

            const saleRes = await createSale([{ productID: productId, quantity: 1 }], "DEBT", `CL- ${customer.id}`, customer.id);
            const saleId = (saleRes as { saleId: number }).saleId;

            // Product price is 50. Increase quantity to 3 -> total should be 150
            const updateRes = await updateSaleQuantity(saleId, 3, productId);
            expect(updateRes).toMatchObject({ success: true });

            const debtor = await prisma.debtors.findUniqueOrThrow({ where: { saleID: saleId } });
            expect(Number(debtor.amount)).toBe(150);

            const customerAfter = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
            expect(Number(customerAfter.currentBalance)).toBe(150);
        });

        it("rejects updateSaleQuantity when a debt has already been paid", async () => {
            loginAs("ADMIN", adminId);
            const customer = await prisma.customer.create({
                data: { customerName: "Cliente Paid Debt", currentBalance: 0 },
            });

            const saleRes = await createSale([{ productID: productId, quantity: 1 }], "DEBT", `CL- ${customer.id}`, customer.id);
            const saleId = (saleRes as { saleId: number }).saleId;

            await payAccount(customer.id, [{ id: saleId } as never], "CASH");

            const updateRes = await updateSaleQuantity(saleId, 2, productId);
            expect(updateRes).toMatchObject({ success: false, message: "CANNOT_MODIFY_PAID_DEBT" });
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
                expect(r.reservationToken).toBeTruthy();
            }
        }

        const sourceTypes = results
            .filter((r): r is { success: true; sourceType: string; reservationToken: string } => r.success)
            .map((r) => r.sourceType)
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
            message: "UNAUTHORIZED",
        });

        loginAs("ADMIN", adminId);

        // Malformed / non-string inputs rejected cleanly without throwing
        for (const badSource of [null, undefined, 123, "", "MESA_1", "VL-0", "VL-01", "VL- 1", "VL-abc"]) {
            expect(
                await releaseTicketReservationAction(badSource as never, "valid-token")
            ).toMatchObject({ success: false, message: "INVALID_INPUT" });
        }
        expect(await releaseTicketReservationAction("VL-1", "")).toMatchObject({
            success: false,
            message: "INVALID_INPUT",
        });

        // Reserve VL-1
        const t1 = await nextFreeSaleTicket();
        expect(t1.success).toBe(true);
        if (!t1.success) return;

        // Wrong token cannot sabotage Terminal 1's reservation
        expect(await releaseTicketReservationAction("VL-1", "wrong-token")).toMatchObject({
            success: false,
            message: "RESERVATION_MISMATCH",
        });
        const t2 = await nextFreeSaleTicket();
        expect(t2).toMatchObject({ success: true, sourceType: "VL-2" });

        // Matching token releases VL-1 immediately before any sale is placed
        expect(await releaseTicketReservationAction("VL-1", t1.reservationToken)).toMatchObject({
            success: true,
        });
        const reused = await nextFreeSaleTicket();
        expect(reused).toMatchObject({ success: true, sourceType: "VL-1" });
        if (!reused.success) return;

        // Place a sale on VL-1 -> consumes reservation atomically; release then fails with TICKET_HAS_SALES
        const sale1 = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "VL-1",
            -1,
            "CASH",
            reused.reservationToken
        );
        expect(sale1).toMatchObject({ success: true });

        // Reservation row in DB was atomically consumed by createSale
        const resRow = await prisma.setting.findUnique({ where: { key: reservationKey(jornadaId, 1) } });
        expect(resRow).toBeNull();

        expect(await releaseTicketReservationAction("VL-1", reused.reservationToken)).toMatchObject({
            success: false,
            message: "TICKET_HAS_SALES",
        });

        // Cleanup open UNPAID sale
        expect(await closeAccountAction("VL-1", "CASH")).toMatchObject({ success: true, count: 1 });
    });

    it("Issue #29: prevents closeAccountAction(count=0) sabotage and protects reservations on expiry/collision", async () => {
        loginAs("ADMIN", adminId);

        const t1 = await nextFreeSaleTicket();
        expect(t1).toMatchObject({ success: true, sourceType: "VL-1" });
        if (!t1.success) return;

        // Duplicate/stale closeAccountAction with count=0 MUST NOT wipe Terminal 1's reservation
        expect(await closeAccountAction("VL-1", "CASH")).toMatchObject({ success: true, count: 0 });
        const t2 = await nextFreeSaleTicket();
        expect(t2).toMatchObject({ success: true, sourceType: "VL-2" });

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
        expect(t3).toMatchObject({ success: true, sourceType: "VL-1" });
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
            t1.reservationToken
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
            t3.reservationToken
        );
        expect(validWrite).toMatchObject({ success: true });

        // Even after Terminal 3 consumed its token, Terminal 1's stale token is STILL rejected (no merge!)
        loginAs("ADMIN", adminId);
        const postConsumeStale = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "VL-1",
            -1,
            "CASH",
            t1.reservationToken
        );
        expect(postConsumeStale).toMatchObject({ success: false, error: "TICKET_TAKEN" });

        // Cleanup
        await closeAccountAction("VL-1", "CASH");
    });

    it("Issue #29: handles cancelSaleAction, toDebt, direct PAID sales, and closeJornada cleanly", async () => {
        loginAs("ADMIN", adminId);

        // 1. Direct PAID sale on reserved ticket consumes & frees the reservation immediately
        const directTicket = await nextFreeSaleTicket();
        expect(directTicket).toMatchObject({ success: true, sourceType: "VL-1" });
        if (!directTicket.success) return;
        const paidSale = await createSale(
            [{ productID: productId, quantity: 1 }],
            "PAID",
            "VL-1",
            -1,
            "CASH",
            directTicket.reservationToken
        );
        expect(paidSale).toMatchObject({ success: true });
        const afterPaid = await nextFreeSaleTicket();
        expect(afterPaid).toMatchObject({ success: true, sourceType: "VL-1" });
        if (!afterPaid.success) return;

        // 2. Cancelling 1 of 2 UNPAID sales keeps VL-1 taken; cancelling the last frees it
        const s1 = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "VL-1", -1, "CASH", afterPaid.reservationToken);
        const s2 = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "VL-1", -1);
        expect(s1).toMatchObject({ success: true });
        expect(s2).toMatchObject({ success: true });
        const id1 = (s1 as { saleId: number }).saleId;
        const id2 = (s2 as { saleId: number }).saleId;

        await cancelSaleAction(id1);
        const whileOneRemains = await nextFreeSaleTicket();
        expect(whileOneRemains).toMatchObject({ success: true, sourceType: "VL-2" });

        await cancelSaleAction(id2);
        const afterLastCancelled = await nextFreeSaleTicket();
        expect(afterLastCancelled).toMatchObject({ success: true, sourceType: "VL-1" });
        if (!afterLastCancelled.success) return;

        // 3. Converting VL-1 to DEBT frees VL-1 immediately, and later cancelling that DEBT sale
        //    MUST NOT destroy a new terminal's live reservation on VL-1
        const debtCandidate = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "VL-1",
            -1,
            "CASH",
            afterLastCancelled.reservationToken
        );
        expect(debtCandidate).toMatchObject({ success: true });
        const debtSaleId = (debtCandidate as { saleId: number }).saleId;

        const debtRes = await toDebt(customerId, [{ id: debtSaleId } as never]);
        expect(debtRes).toMatchObject({ msg: "SUCCESS" });

        const freshAfterDebt = await nextFreeSaleTicket();
        expect(freshAfterDebt).toMatchObject({ success: true, sourceType: "VL-1" });

        // Cancelling the earlier DEBT sale on VL-1 must leave the fresh empty reservation intact
        expect(await cancelSaleAction(debtSaleId)).toMatchObject({ success: true });
        const nextAfterDebtCancel = await nextFreeSaleTicket();
        expect(nextAfterDebtCancel).toMatchObject({ success: true, sourceType: "VL-3" });

        // 4. closeJornada preserves reservations when failing (OPEN_ACCOUNTS), clears them on success
        await prisma.sales.updateMany({ where: { jornadaId, status: "UNPAID" }, data: { status: "CANCELLED" } });
        const openSale = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_1", -1);
        expect(openSale).toMatchObject({ success: true });
        const failedClose = await closeJornada(jornadaId, 500);
        expect(failedClose).toMatchObject({ success: false, error: "OPEN_ACCOUNTS" });
        const remainingBeforeClose = await prisma.setting.findMany({
            where: { key: { startsWith: `${TICKET_RESERVATION_PREFIX}${jornadaId}:` } },
        });
        expect(remainingBeforeClose.length).toBeGreaterThan(0);

        await closeAccountAction("MESA_1", "CASH");
        const okClose = await closeJornada(jornadaId, 500);
        expect(okClose).toMatchObject({ success: true });

        const remainingAfterClose = await prisma.setting.findMany({
            where: { key: { startsWith: `${TICKET_RESERVATION_PREFIX}${jornadaId}:` } },
        });
        expect(remainingAfterClose.length).toBe(0);

        // Re-open jornada for any subsequent tests
        await prisma.jornada.update({ where: { id: jornadaId }, data: { status: "OPEN", closedAt: null, closedBy: null } });
    });
});
