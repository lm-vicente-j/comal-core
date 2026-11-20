import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb } from "./helpers";
import { closeJornada, getActiveJornadaWithStats, getJornadaEmployeeBreakdown, openJornada } from "@/lib/actions/jornada";

describe("jornada actions", () => {
    let adminId: number;
    let staffId: number;

    beforeAll(async () => {
        await resetDb();
        const admin = await prisma.users.create({
            data: { name: "Admin Caja", email: "caja@test.local", role: "ADMIN", active: true },
        });
        adminId = admin.id;

        const staff = await prisma.users.create({
            data: { name: "Staff Caja", username: "staffcaja", role: "STAFF", active: true },
        });
        staffId = staff.id;
    });

    it("rejects openJornada for non-admin sessions and invalid amounts", async () => {
        logout();
        expect(await openJornada(500)).toMatchObject({ success: false, error: "PERMISSION DENIED" });

        loginAs("STAFF", staffId);
        expect(await openJornada(500)).toMatchObject({ success: false, error: "PERMISSION DENIED" });

        loginAs("ADMIN", adminId);
        expect(await openJornada(-5)).toMatchObject({ success: false });
        expect(await prisma.jornada.count()).toBe(0);
    });

    it("rejects closeJornada for non-admin sessions", async () => {
        logout();
        expect(await closeJornada(1, 500)).toMatchObject({ success: false, error: "PERMISSION DENIED" });

        loginAs("STAFF", staffId);
        expect(await closeJornada(1, 500)).toMatchObject({ success: false, error: "PERMISSION DENIED" });
    });

    it("opens a jornada and blocks a second one", async () => {
        loginAs("ADMIN", adminId);
        expect(await openJornada(500)).toMatchObject({ success: true });

        const row = await prisma.jornada.findFirstOrThrow();
        expect(row.status).toBe("OPEN");
        expect(row.openedBy).toBe(adminId);
        expect(Number(row.openingAmount)).toBe(500);

        const again = await openJornada(300);
        expect(again).toMatchObject({ success: false, error: "PENDING_JORNADA", pendingJornadaId: row.id });
        expect(await prisma.jornada.count()).toBe(1);
    });

    it("reports the active jornada with stats for ADMIN and blocks non-admins", async () => {
        loginAs("ADMIN", adminId);
        const state = await getActiveJornadaWithStats();
        expect(state?.state).toBe("OWN_OPEN");
        expect(state?.stats).toBeDefined();

        if (state?.state !== "OWN_OPEN") throw new Error("Expected OWN_OPEN");
        const jornadaId = state.jornada.id;

        const breakdown = await getJornadaEmployeeBreakdown(jornadaId);
        expect(Array.isArray(breakdown)).toBe(true);

        // STAFF must be blocked from cash summary and employee breakdown
        loginAs("STAFF", staffId);
        expect(await getActiveJornadaWithStats()).toBeNull();
        expect(await getJornadaEmployeeBreakdown(jornadaId)).toEqual([]);

        // Logged out must also be blocked
        logout();
        expect(await getActiveJornadaWithStats()).toBeNull();
        expect(await getJornadaEmployeeBreakdown(jornadaId)).toEqual([]);
    });

    it("refuses to close while table/client accounts are still open", async () => {
        loginAs("ADMIN", adminId);
        const jornada = await prisma.jornada.findFirstOrThrow({ where: { status: "OPEN" } });

        const openSale = await prisma.sales.create({
            data: { total: 80, status: "UNPAID", source_type: "MESA_1", placedBy: adminId, jornadaId: jornada.id },
        });

        const res = await closeJornada(jornada.id, 500);
        expect(res).toMatchObject({
            success: false,
            error: "OPEN_ACCOUNTS",
            openAccounts: [{ sourceType: "MESA_1", count: 1, total: 80 }],
        });

        const stillOpen = await prisma.jornada.findUniqueOrThrow({ where: { id: jornada.id } });
        expect(stillOpen.status).toBe("OPEN");

        // Resolving the account in the POS (here: cancelling it) unblocks the close.
        await prisma.sales.update({ where: { id: openSale.id }, data: { status: "CANCELLED" } });
    });

    it("refuses to close while a walk-in ticket is still open", async () => {
        loginAs("ADMIN", adminId);
        const jornada = await prisma.jornada.findFirstOrThrow({ where: { status: "OPEN" } });

        // A walk-in ticket nobody charged is as blocking as an open table:
        // closing over it would strand the sales as UNPAID forever.
        const ticketSale = await prisma.sales.create({
            data: { total: 45, status: "UNPAID", source_type: "VL-2", placedBy: adminId, jornadaId: jornada.id },
        });

        const res = await closeJornada(jornada.id, 500);
        expect(res).toMatchObject({
            success: false,
            error: "OPEN_ACCOUNTS",
            openAccounts: [{ sourceType: "VL-2", count: 1, total: 45 }],
        });

        await prisma.sales.update({ where: { id: ticketSale.id }, data: { status: "CANCELLED" } });
    });

    it("closes the jornada computing the expected amount", async () => {
        loginAs("ADMIN", adminId);
        const jornada = await prisma.jornada.findFirstOrThrow({ where: { status: "OPEN" } });

        // opening 500 + cash sales 200 - cash bills 50 - savings deposit 30 = 620 (withdrawals reduce pool only)
        await prisma.sales.create({
            data: { total: 200, status: "PAID", payment_method: "CASH", source_type: "VENTA_LIBRE", placedBy: adminId, jornadaId: jornada.id },
        });
        // Neither of these ever put cash in the register, so the expected
        // amount must ignore them even though their payment_method is CASH:
        // a cancelled sale keeps its original payment_method...
        await prisma.sales.create({
            data: { total: 500, status: "CANCELLED", payment_method: "CASH", source_type: "VENTA_LIBRE", placedBy: adminId, jornadaId: jornada.id },
        });
        // ...and a sale converted to debt is collected on a later day.
        await prisma.sales.create({
            data: { total: 300, status: "DEBT", payment_method: "CASH", source_type: "CL- Deudor", placedBy: adminId, jornadaId: jornada.id },
        });
        await prisma.bill.create({
            data: { amount: 50, category: "Otros", description: "Gasto jornada", date: new Date(), registered_by: adminId, jornadaId: jornada.id, payment_method: "CASH" },
        });
        await prisma.savings_movement.create({
            data: { amount: 30, type: "DEPOSIT", registered_by: adminId, jornadaId: jornada.id },
        });
        await prisma.savings_movement.create({
            data: { amount: 10, type: "WITHDRAW", registered_by: adminId, jornadaId: jornada.id },
        });

        const res = await closeJornada(jornada.id, 640);
        expect(res).toMatchObject({ success: true });

        const closed = await prisma.jornada.findUniqueOrThrow({ where: { id: jornada.id } });
        expect(closed.status).toBe("CLOSED");
        expect(closed.closedBy).toBe(adminId);
        expect(closed.closedAt).not.toBeNull();
        expect(Number(closed.expectedClosingAmount)).toBe(620);
        expect(Number(closed.expectedTransferAmount)).toBe(0);
        expect(Number(closed.actualClosingAmount)).toBe(640);
    });

    it("refuses to close a jornada twice or with invalid data", async () => {
        loginAs("ADMIN", adminId);
        const closed = await prisma.jornada.findFirstOrThrow({ where: { status: "CLOSED" } });

        expect(await closeJornada(closed.id, 100)).toMatchObject({ success: false, error: "La jornada ya está cerrada" });
        expect(await closeJornada(99999, 100)).toMatchObject({ success: false, error: "Jornada no encontrada" });
        expect(await closeJornada(closed.id, -1)).toMatchObject({ success: false, error: "Monto físico inválido" });
    });
});
