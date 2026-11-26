import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => ({ auth: (await import("../helpers/database")).authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { createSale, closeAccountAction, updateSaleQuantity, cancelSaleAction, nextFreeSaleTicket } from "@/lib/actions/sales";
import { toDebt, payAccount } from "@/lib/actions/debts";
import { closeJornada } from "@/lib/actions/jornada";
import { loginAs, resetDb, seedBase, makeCashCountInput } from "../helpers/database";
import { orderedJornadaActions } from "../helpers/concurrency";
import { getJornadaCashSummary } from "@/lib/jornada-cash";
import { reservationKey } from "@/lib/ticket-reservations";

let jornada: number;
let product: number;
let customer: number;
let sale: number;

beforeEach(async () => {
    await resetDb();
    const base = await seedBase();
    jornada = base.jornada.id;
    loginAs("ADMIN", base.admin.id);
    customer = (await prisma.customer.create({ data: { customerName: "Concurrency customer", currentBalanceCents: 0 } })).id;
    product = (await prisma.products.create({ data: { name: "Concurrency product", priceCents: 2500 } })).id;
    const created = await createSale([{ productID: product, quantity: 1 }], "UNPAID", "MESA_1", -1);
    if (!created.success) throw new Error(created.error);
    sale = created.data.saleId;
});

it("double-checkout-commits-one-settlement", async () => {
    const results = await orderedJornadaActions(jornada, [
        () => closeAccountAction("MESA_1", "CASH", [sale], 2500),
        () => closeAccountAction("MESA_1", "TRANSFER", [sale], 2500),
    ]);
    expect(results).toMatchObject([{ success: true }, { success: false }]);
    expect((await prisma.sales.findUniqueOrThrow({ where: { id: sale } }))).toMatchObject({ status: "PAID", payment_method: "CASH" });
    expect((await getJornadaCashSummary(jornada, 50000)).expectedCash).toBe(52500);
});

it("double-debt-collection-decrements-once", async () => {
    expect(await toDebt(customer, [{ id: sale }], 2500)).toMatchObject({ success: true });
    const results = await orderedJornadaActions(jornada, [
        () => payAccount(customer, [{ id: sale }], "CASH"),
        () => payAccount(customer, [{ id: sale }], "TRANSFER"),
    ]);
    expect(results).toMatchObject([{ success: true }, { success: false }]);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer } })).currentBalanceCents).toBe(BigInt(0));
    expect((await getJornadaCashSummary(jornada, 50000)).debtCollectedCash).toBe(2500);
});

for (const mutation of ["edit", "cancel", "debt"] as const) {
    for (const first of ["checkout", "mutation"] as const) {
        it(`${mutation}-versus-checkout-${first}-first`, async () => {
            const change = () => mutation === "edit" ? updateSaleQuantity(sale, 2, product)
                : mutation === "cancel" ? cancelSaleAction(sale) : toDebt(customer, [{ id: sale }], 2500);
            const checkout = () => closeAccountAction("MESA_1", "CASH", [sale], 2500);
            const results = await orderedJornadaActions(jornada, first === "checkout" ? [checkout, change] : [change, checkout]);
            expect(results).toMatchObject([{ success: true }, { success: false }]);
            const row = await prisma.sales.findUniqueOrThrow({ where: { id: sale } });
            expect(row.status).toBe(first === "checkout" ? "PAID" : mutation === "cancel" ? "CANCELLED" : mutation === "debt" ? "DEBT" : "UNPAID");
            expect(row.totalCents).toBe(first === "mutation" && mutation === "edit" ? BigInt(5000) : BigInt(2500));
            expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer } })).currentBalanceCents)
                .toBe(first === "mutation" && mutation === "debt" ? BigInt(2500) : BigInt(0));
        });
    }
}

for (const first of ["close", "collect"] as const) {
    it(`closure-versus-collection-${first}-first`, async () => {
        expect(await toDebt(customer, [{ id: sale }], 2500)).toMatchObject({ success: true });
        const collect = () => payAccount(customer, [{ id: sale }], "CASH");
        const close = () => closeJornada(jornada, makeCashCountInput(first === "close" ? 50000 : 52500));
        const results = await orderedJornadaActions(jornada, first === "close" ? [close, collect] : [collect, close]);
        expect(results).toMatchObject(first === "close" ? [{ success: true }, { success: false }] : [{ success: true }, { success: true }]);
        const count = await prisma.cash_count.findFirstOrThrow({ where: { jornadaId: jornada, type: "CLOSING" } });
        expect(count.expectedAmountCents).toBe(first === "close" ? BigInt(50000) : BigInt(52500));
        expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer } })).currentBalanceCents).toBe(first === "close" ? BigInt(2500) : BigInt(0));
    });
}

it("expired-reservation-cannot-consume-a-reused-ticket", async () => {
    const reserved = await Promise.all([nextFreeSaleTicket(), nextFreeSaleTicket()]);
    expect(reserved.every(result => result.success)).toBe(true);
    if (!reserved[0].success || !reserved[1].success) throw new Error("Reservation setup failed");
    expect(reserved[0].data.sourceType).not.toBe(reserved[1].data.sourceType);
    const old = reserved[0].data;
    const number = Number(old.sourceType.slice(3));
    const key = reservationKey(jornada, number);
    const row = await prisma.setting.findUniqueOrThrow({ where: { key } });
    await prisma.setting.update({ where: { key }, data: { value: JSON.stringify({ ...JSON.parse(row.value!), expiresAt: Date.now() - 1 }) } });
    const fresh = await nextFreeSaleTicket();
    expect(fresh.success).toBe(true);
    if (!fresh.success) throw new Error(fresh.error);
    expect(fresh.data.sourceType).toBe(old.sourceType);
    expect(fresh.data.reservationToken).not.toBe(old.reservationToken);
    expect(await createSale([{ productID: product, quantity: 1 }], "UNPAID", old.sourceType, -1, "CASH", old.reservationToken)).toMatchObject({ success: false });
    expect(await createSale([{ productID: product, quantity: 1 }], "UNPAID", fresh.data.sourceType, -1, "CASH", fresh.data.reservationToken)).toMatchObject({ success: true });
    expect(await prisma.sales.count({ where: { source_type: old.sourceType } })).toBe(1);
});
