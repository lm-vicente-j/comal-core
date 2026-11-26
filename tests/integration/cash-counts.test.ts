import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { closeJornada, exportCashCountHistory, getCashCountHistory, getJornadaClosingSummary, getJornadaCollectionsByEmployee, openJornada, recordCashCount } from "@/lib/actions/jornada";
import { getJornadaCashSummary } from "@/lib/jornada-cash";
import { closeAccountAction } from "@/lib/actions/sales";
import { getSettings, saveSettings } from "@/lib/actions/settings";
import { makeCashCountInput, loginAs, resetDb } from "./helpers";

describe("cash count actions", () => {
    let adminId: number;
    let jornadaId: number;

    beforeEach(async () => {
        await resetDb();
        const admin = await prisma.users.create({
            data: { name: "Cash Count Admin", email: "cash-count@test.local", role: "ADMIN", active: true },
        });
        adminId = admin.id;
        loginAs("ADMIN", adminId);
    });

    async function open(amount: number) {
        const result = await openJornada(makeCashCountInput(amount));
        expect(result).toMatchObject({ success: true, data: { type: "OPENING", countedAmount: amount, expectedAmount: amount, difference: 0 } });
        if (!result.success) throw new Error(result.error);
        jornadaId = result.data.jornadaId;
        return result.data;
    }

    it("rejects malformed physical rows and requires explicit confirmation for empty cash", async () => {
        const valid = makeCashCountInput(0);
        expect(await openJornada({ ...valid, confirmEmpty: false })).toMatchObject({ success: false });
        expect(await openJornada({ ...valid, requestId: "not-a-uuid" })).toMatchObject({ success: false });
        expect(await openJornada({ ...valid, denominations: [{ kind: "BILL", valueCents: 2000, quantity: 1 }, { kind: "BILL", valueCents: 2000, quantity: 1 }] })).toMatchObject({ success: false });
        expect(await openJornada({ ...valid, denominations: [{ kind: "COIN", valueCents: 50, quantity: 1.5 }] })).toMatchObject({ success: false });
        expect(await openJornada({ ...valid, denominations: [{ kind: "COIN", valueCents: 999, quantity: 1 }] })).toMatchObject({ success: false });
        expect(await prisma.jornada.count()).toBe(0);
        expect(await prisma.cash_count.count()).toBe(0);
    });

    it("rejects coins below 50 cents at opening, interim and closing, even with zero quantity", async () => {
        for (const valueCents of [5, 10, 20]) {
            for (const quantity of [0, 1]) {
                const input = { ...makeCashCountInput(0), denominations: [{ kind: "COIN" as const, valueCents, quantity }] };
                expect(await openJornada(input)).toMatchObject({ success: false, error: "INVALID_INPUT" });
            }
        }
        expect(await prisma.jornada.count()).toBe(0);
        await open(50050);
        for (const valueCents of [5, 10, 20]) {
            for (const quantity of [0, 1]) {
                const input = { ...makeCashCountInput(50050), denominations: [{ kind: "COIN" as const, valueCents, quantity }] };
                expect(await recordCashCount(jornadaId, input)).toMatchObject({ success: false, error: "INVALID_INPUT" });
                expect(await closeJornada(jornadaId, input)).toMatchObject({ success: false, error: "INVALID_INPUT" });
            }
        }
        expect(await prisma.cash_count.count()).toBe(1);
        expect(await recordCashCount(jornadaId, makeCashCountInput(50050))).toMatchObject({ success: true, data: { countedAmount: 50050, difference: 0 } });
        expect(await closeJornada(jornadaId, makeCashCountInput(50050))).toMatchObject({ success: true, data: { countedAmount: 50050, difference: 0 } });
    });

    it("makes opening retries idempotent and rejects a changed payload for the same request", async () => {
        const input = makeCashCountInput(50000);
        const first = await openJornada(input);
        expect(first).toMatchObject({ success: true, data: { type: "OPENING", countedAmount: 50000 } });
        const retry = await openJornada(input);
        expect(retry).toMatchObject({ success: true, data: { type: "OPENING", countedAmount: 50000 } });
        expect(await prisma.jornada.count()).toBe(1);
        expect(await prisma.cash_count.count()).toBe(1);
        expect(await openJornada({ ...input, denominations: makeCashCountInput(45000).denominations })).toMatchObject({ success: false });
    });

    it("redacts opening cash from delegated STAFF and rejects recount links outside interim counts", async () => {
        const staff = await prisma.users.create({ data: { name: "Opening Staff", role: "STAFF", active: true } });
        await prisma.rolePermission.create({ data: { role: "STAFF", capability: "jornada.open", enabled: true } });
        loginAs("STAFF", staff.id);
        expect(await openJornada({ ...makeCashCountInput(0), recountOfId: 999 })).toMatchObject({ success: false });
        expect(await prisma.jornada.count()).toBe(0);
        const opened = await openJornada(makeCashCountInput(20000));
        expect(opened).toMatchObject({ success: true, data: { type: "OPENING", countedAmount: 20000 } });
        if (opened.success) {
            expect(opened.data).not.toHaveProperty("expectedAmount");
            expect(opened.data).not.toHaveProperty("difference");
            expect(opened.data).not.toHaveProperty("result");
            expect(opened.data).not.toHaveProperty("cashSummary");
        }
        await prisma.rolePermission.create({ data: { role: "STAFF", capability: "jornada.close", enabled: true } });
        expect(await closeJornada(opened.success ? opened.data.jornadaId : 1, { ...makeCashCountInput(20000, "Closing count"), recountOfId: 999 })).toMatchObject({ success: false });
    });

    it("requires a note for out of tolerance counts without persisting a failed count", async () => {
        await open(50000);
        const input = makeCashCountInput(45000);
        expect(await recordCashCount(jornadaId, input)).toMatchObject({ success: false, error: "NOTE_REQUIRED" });
        expect(await prisma.cash_count.count({ where: { jornadaId, type: "INTERIM" } })).toBe(0);
        const withNote = await recordCashCount(jornadaId, { ...input, requestId: makeCashCountInput(1_000).requestId, note: "Faltante revisado" });
        expect(withNote).toMatchObject({ success: true, data: { countedAmount: 45000, expectedAmount: 50000, difference: -5000, result: "DISCREPANCY" } });
    });

    it("captures configured tolerance at count time and exposes privileged reconciliation detail", async () => {
        await saveSettings({ cashCountToleranceCents: 500 });
        await open(25000);
        await saveSettings({ clabe: "123456789012345678" });
        const row = await recordCashCount(jornadaId, makeCashCountInput(24750));
        expect(row).toMatchObject({ success: true, data: { tolerance: 500, difference: -250, result: "BALANCED" } });
        await saveSettings({ cashCountToleranceCents: 0 });
        const stored = await prisma.cash_count.findFirstOrThrow({ where: { jornadaId, type: "INTERIM" } });
        expect(Number(stored.toleranceCents)).toBe(500);
        expect((await getSettings()).cashCountToleranceCents).toBe(0);
        expect((await getSettings()).clabe).toBe("123456789012345678");
        expect(await getJornadaCashSummary(jornadaId, 25000)).toMatchObject({ expectedCash: 25000 });
    });

    it("rejects malformed stored tolerance instead of silently treating it as zero", async () => {
        await prisma.setting.create({ data: { key: "CASH_COUNT_TOLERANCE_CENTS", value: "five pesos" } });
        const result = await openJornada(makeCashCountInput(10000));
        expect(result).toMatchObject({ success: false });
        expect(await prisma.jornada.count()).toBe(0);
        expect(await prisma.cash_count.count()).toBe(0);
    });

    it("keeps an earlier count's expected cash snapshot after later cash movement", async () => {
        await open(30000);
        const counted = await recordCashCount(jornadaId, makeCashCountInput(30000));
        if (!counted.success) throw new Error(counted.error);
        await prisma.bill.create({ data: {
            amountCents: 5000, category: "Otros", date: new Date(), registered_by: adminId,
            jornadaId, payment_method: "CASH",
        } });
        const saved = await prisma.cash_count.findUniqueOrThrow({ where: { id: counted.data.id } });
        expect(Number(saved.expectedAmountCents)).toBe(30000);
        expect(Number(saved.differenceCents)).toBe(0);
        expect(await getJornadaCashSummary(jornadaId, 30000)).toMatchObject({ expectedCash: 25000 });
    });

    it("keeps STAFF reconciliation response private and enforces capabilities", async () => {
        await open(30000);
        const staff = await prisma.users.create({ data: { name: "Cash Count Staff", role: "STAFF", active: true } });
        loginAs("STAFF", staff.id);
        const result = await recordCashCount(jornadaId, makeCashCountInput(30000));
        expect(result).toMatchObject({ success: true, data: { countedAmount: 30000 } });
        if (result.success) {
            expect(result.data).not.toHaveProperty("expectedAmount");
            expect(result.data).not.toHaveProperty("difference");
            expect(result.data).not.toHaveProperty("result");
            expect(result.data).not.toHaveProperty("cashSummary");
        }
        await prisma.rolePermission.upsert({ where: { role_capability: { role: "STAFF", capability: "jornada.reconcile" } }, create: { role: "STAFF", capability: "jornada.reconcile", enabled: false }, update: { enabled: false } });
        expect(await recordCashCount(jornadaId, makeCashCountInput(30000))).toMatchObject({ success: false, error: "PERMISSION DENIED" });
        expect(await closeJornada(jornadaId, makeCashCountInput(30000))).toMatchObject({ success: false, error: "PERMISSION DENIED" });
        expect(await saveSettings({ cashCountToleranceCents: 5 })).toMatchObject({ success: false, error: "PERMISSION DENIED" });
    });

    it("recounts only an interim count in the same open jornada and blocks closure on unpaid sales", async () => {
        await open(40000);
        const prior = await recordCashCount(jornadaId, makeCashCountInput(40000));
        if (!prior.success) throw new Error(prior.error);
        expect(await recordCashCount(jornadaId, { ...makeCashCountInput(40000), recountOfId: prior.data.id })).toMatchObject({ success: false, error: "INVALID_RECOUNT" });
        const recount = await recordCashCount(jornadaId, { ...makeCashCountInput(40000, "Second count"), recountOfId: prior.data.id });
        expect(recount).toMatchObject({ success: true, data: { recountOfId: prior.data.id } });

        await prisma.sales.create({ data: { totalCents: 2500, status: "UNPAID", source_type: "SIN_ORIGEN", placedBy: adminId, jornadaId } });
        await prisma.sales.create({ data: { totalCents: 1500, status: "UNPAID", source_type: null, placedBy: adminId, jornadaId } });
        const blocked = await closeJornada(jornadaId, makeCashCountInput(40000));
        expect(blocked).toMatchObject({ success: false, error: "OPEN_ACCOUNTS", data: { openAccounts: expect.arrayContaining([
            { sourceType: "SIN_ORIGEN", count: 1, total: 2500 },
            { sourceType: "SIN ORIGEN", count: 1, total: 1500 },
        ]) } });
        expect(await prisma.cash_count.count({ where: { jornadaId, type: "CLOSING" } })).toBe(0);
        await prisma.sales.updateMany({ where: { jornadaId, status: "UNPAID" }, data: { status: "CANCELLED" } });
        const closed = await closeJornada(jornadaId, makeCashCountInput(40000));
        expect(closed).toMatchObject({ success: true, data: { type: "CLOSING", result: "BALANCED" } });
        expect(await recordCashCount(jornadaId, makeCashCountInput(40000))).toMatchObject({ success: false });
    });

    it("rejects SQL UPDATE and DELETE against immutable counts", async () => {
        const opening = await open(50000);
        await expect(prisma.$executeRaw`UPDATE "cash_count" SET note = 'tampered' WHERE id = ${opening.id}`).rejects.toThrow(/CASH_COUNT_IMMUTABLE/);
        await expect(prisma.$executeRaw`DELETE FROM "cash_count" WHERE id = ${opening.id}`).rejects.toThrow(/CASH_COUNT_IMMUTABLE/);
        await expect(prisma.cash_count.update({ where: { id: opening.id }, data: { note: "tampered" } })).rejects.toThrow(/CASH_COUNT_IMMUTABLE/);
        await expect(prisma.cash_count.delete({ where: { id: opening.id } })).rejects.toThrow(/CASH_COUNT_IMMUTABLE/);
    });

    it("scopes paginated history, exports all matching rows, and summarizes close collections", async () => {
        await open(50000);
        await recordCashCount(jornadaId, makeCashCountInput(50000));
        const staff = await prisma.users.create({ data: { name: "Order Taker", role: "STAFF", active: true } });
        const sale = await prisma.sales.create({ data: {
            totalCents: 5000, status: "UNPAID", source_type: "MESA_1", placedBy: staff.id, jornadaId,
        } });
        expect(await closeAccountAction("MESA_1", "CASH", [sale.id], 5000)).toMatchObject({ success: true });
        const paid = await prisma.sales.findUniqueOrThrow({ where: { id: sale.id } });
        expect(paid.placedBy).toBe(staff.id);
        expect(paid.collectedBy).toBe(adminId);
        expect(paid.paidJornadaId).toBe(jornadaId);
        expect(paid.paidAt).toBeInstanceOf(Date);

        const staffRows = await getJornadaCollectionsByEmployee(jornadaId);
        expect(staffRows).toEqual(expect.arrayContaining([expect.objectContaining({ userId: adminId, collectionsCount: 1, cashCollected: 5000 })]));
        const page = await getCashCountHistory({ jornadaId, page: 1, pageSize: 1 });
        expect(page).toMatchObject({ success: true, data: { total: 2, page: 1, pageSize: 1, totalPages: 2 } });
        const csv = await exportCashCountHistory({ jornadaId });
        expect(csv).toMatchObject({ success: true });
        if (csv.success) expect(csv.data.split("\n")).toHaveLength(3);
        expect(await getJornadaClosingSummary(jornadaId)).toMatchObject({
            success: true,
            data: { jornada: { id: jornadaId, status: "OPEN" }, counts: expect.any(Array), collections: expect.any(Array) },
        });
    });

    it("limits STAFF history and CSV to their own redacted counts and neutralizes formula notes", async () => {
        await open(25000);
        const staff = await prisma.users.create({ data: { name: "Private Count Operator", role: "STAFF", active: true } });
        loginAs("STAFF", staff.id);
        const recorded = await recordCashCount(jornadaId, makeCashCountInput(25000, "=HYPERLINK(\"https://example.invalid\")"));
        expect(recorded).toMatchObject({ success: true });
        const own = await getCashCountHistory({ jornadaId });
        expect(own).toMatchObject({ success: true, data: { total: 1 } });
        if (own.success) {
            expect(own.data.items[0].operatorId).toBe(staff.id);
            expect(own.data.items[0]).not.toHaveProperty("expectedAmount");
            expect(own.data.items[0]).not.toHaveProperty("difference");
            expect(own.data.items[0]).not.toHaveProperty("cashSummary");
        }
        expect(await getCashCountHistory({ jornadaId, operatorId: adminId })).toMatchObject({ success: false, error: "PERMISSION DENIED" });
        const csv = await exportCashCountHistory({ jornadaId });
        expect(csv).toMatchObject({ success: true });
        if (csv.success) {
            expect(csv.data).toContain("'=HYPERLINK");
            expect(csv.data).not.toContain("expectedAmount");
            expect(csv.data).not.toContain("cashSummary");
        }
    });
});
