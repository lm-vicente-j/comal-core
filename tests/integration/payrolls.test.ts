import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("../helpers/database");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "../helpers/database";
import { getSalaryHistory, getUserPayrollInfo, saveSalaryPayment } from "@/lib/actions/payrolls";

describe("payrolls actions", () => {
    let staffId: number;

    beforeAll(async () => {
        await resetDb();
        await seedBase();
        const staff = await prisma.users.create({
            data: { name: "Empleado Uno", username: "EMP1", role: "STAFF", active: true },
        });
        staffId = staff.id;
    });

    it("rejects saveSalaryPayment for non-admin sessions", async () => {
        logout();
        expect(await saveSalaryPayment({ userID: staffId, amount: 50000, period: "SUELDO: semana 1", payment_method: "CASH" }))
            .toMatchObject({ success: false, error: "UNAUTHORIZED" });
        loginAs("STAFF", staffId);
        expect(await saveSalaryPayment({ userID: staffId, amount: 50000, period: "SUELDO: semana 1", payment_method: "CASH" }))
            .toMatchObject({ success: false, error: "UNAUTHORIZED" });
        expect(await prisma.salary.count()).toBe(0);
    });

    it("registers a salary payment linked to the open jornada", async () => {
        loginAs("ADMIN");
        const jornada = await prisma.jornada.findFirstOrThrow({ where: { status: "OPEN" } });
        const res = await saveSalaryPayment({ userID: staffId, amount: 50000, period: "SUELDO: semana 1", payment_method: "CASH" });
        expect(res).toMatchObject({ success: true });

        const row = await prisma.salary.findFirstOrThrow();
        expect(row.userID).toBe(staffId);
        expect(Number(row.amountCents)).toBe(50000);
        expect(row.period).toBe("SUELDO: semana 1");
        expect(row.payDate).not.toBeNull();
        expect(row.jornadaId).toBe(jornada.id);
        expect(row.payment_method).toBe("CASH");
    });

    it("fails with NO_OPEN_JORNADA when no jornada is open", async () => {
        loginAs("ADMIN");
        await prisma.jornada.updateMany({ where: { status: "OPEN" }, data: { status: "CLOSED" } });
        try {
            const res = await saveSalaryPayment({ userID: staffId, amount: 10000, period: "BONO: x", payment_method: "CASH" });
            expect(res).toMatchObject({ success: false, error: "NO_OPEN_JORNADA" });
            expect(await prisma.salary.count()).toBe(1);
        } finally {
            await prisma.jornada.updateMany({ where: { status: "CLOSED" }, data: { status: "OPEN" } });
        }
    });

    it("requires a payment method instead of defaulting to cash", async () => {
        loginAs("ADMIN");
        const res = await saveSalaryPayment({ userID: staffId, amount: 10000, period: "BONO: x", payment_method: undefined as never });
        expect(res.success).toBe(false);
        expect(res.fieldErrors?.payment_method).toBeDefined();
        expect(await prisma.salary.count()).toBe(1);
    });

    it("rejects invalid payments with field errors", async () => {
        loginAs("ADMIN");
        const res = await saveSalaryPayment({ userID: staffId, amount: 0, period: "BONO: x", payment_method: "CASH" });
        expect(res.success).toBe(false);
        expect(await prisma.salary.count()).toBe(1);
    });

    it("paginates the salary history", async () => {
        loginAs("ADMIN");
        const jornada = await prisma.jornada.findFirstOrThrow({ where: { status: "OPEN" } });
        await prisma.salary.createMany({
            data: Array.from({ length: 32 }, (_, i) => ({
                userID: staffId, amountCents: Math.round((100 + i) * 100), period: `BONO: ${i}`, payDate: new Date(),
                jornadaId: jornada.id, payment_method: "CASH" as const,
            })),
        });

        const page1 = await getSalaryHistory({ filters: { userId: staffId }, page: 1, pageSize: 30 });
        expect(page1.success && page1.data.items).toHaveLength(30);
        expect(page1.success && page1.data.hasMore).toBe(true);

        const page2 = await getSalaryHistory({ filters: { userId: staffId }, page: 2, pageSize: 30 });
        expect(page2.success && page2.data.items).toHaveLength(3);
        expect(page2.success && page2.data.hasMore).toBe(false);
    });

    it("getUserPayrollInfo returns the user info only with a session", async () => {
        loginAs("ADMIN");
        const info = await getUserPayrollInfo(staffId);
        expect(info?.name).toBe("Empleado Uno");

        logout();
        expect(await getUserPayrollInfo(staffId)).toBeNull();
        expect(await getSalaryHistory({ filters: { userId: staffId } })).toEqual({ success: false, error: "UNAUTHENTICATED" });
    });

    it("salary queries reject a malformed user id", async () => {
        loginAs("ADMIN");
        expect(await getSalaryHistory({ filters: { userId: -1 } })).toEqual({ success: false, error: "INVALID_INPUT" });
        expect(await getUserPayrollInfo(1.5)).toBeNull();
    });

    it("validates payroll reason length accounting for the payment-type prefix", async () => {
        loginAs("ADMIN");
        // Exact 50-character reason with ADELANTO prefix should succeed
        const valid50Reason = "a".repeat(50);
        const validRes = await saveSalaryPayment({
            userID: staffId,
            amount: 15000,
            period: `ADELANTO: ${valid50Reason}`,
            payment_method: "CASH",
        });
        expect(validRes).toMatchObject({ success: true });

        // 51-character reason with ADELANTO prefix should be rejected
        const invalid51Reason = "b".repeat(51);
        const invalidRes = await saveSalaryPayment({
            userID: staffId,
            amount: 15000,
            period: `ADELANTO: ${invalid51Reason}`,
            payment_method: "CASH",
        });
        expect(invalidRes.success).toBe(false);
        expect(invalidRes.fieldErrors?.period).toBeDefined();

        // Plain period without prefix exceeding 50 characters should be rejected
        const plainInvalid = "c".repeat(51);
        const plainRes = await saveSalaryPayment({
            userID: staffId,
            amount: 15000,
            period: plainInvalid,
            payment_method: "CASH",
        });
        expect(plainRes.success).toBe(false);
        expect(plainRes.fieldErrors?.period).toBeDefined();
    });

    it("handles multiline reasons with prefix and uses parsed.data in saveSalaryPayment", async () => {
        loginAs("ADMIN");
        // Multiline reason within limits
        const multilineReason = "Line 1\n" + "a".repeat(35);
        const res = await saveSalaryPayment({
            userID: staffId,
            amount: "30000" as unknown as number,
            period: `ADELANTO: ${multilineReason}`,
            payment_method: "CASH",
        });
        expect(res).toMatchObject({ success: true });

        const row = await prisma.salary.findFirstOrThrow({ where: { amountCents: 30000 } });
        expect(row.period).toBe(`ADELANTO: ${multilineReason}`);
    });
});
