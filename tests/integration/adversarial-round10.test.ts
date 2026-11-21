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
vi.mock("next-auth", () => ({
    AuthError: class AuthError extends Error {
        type = "CredentialsSignin";
    },
}));

import bcrypt from "bcryptjs";
import prisma from "@/lib/prisma";
import { loginAs, resetDb, seedBase } from "./helpers";
import {
    createSale,
    cancelSaleAction,
    updateSaleQuantity,
    closeAccountAction,
    nextFreeSaleTicket,
    getTodaySalesHistory,
} from "@/lib/actions/sales";
import {
    openJornada,
    closeJornada,
    getJornadaEmployeeBreakdown,
} from "@/lib/actions/jornada";
import {
    saveSalaryPayment,
    getSalaryHistory,
    getUserPayrollInfo,
} from "@/lib/actions/payrolls";
import {
    getPoolBalance,
    getRecentMovements,
    saveMovement,
    getGoalsWithProgress,
    saveGoal,
    cancelGoal,
    addContribution,
} from "@/lib/actions/savings";
import { saveCustomer } from "@/lib/actions/customers";
import { saveExpense, getExpenses } from "@/lib/actions/expenses";
import { saveUser } from "@/lib/actions/users";
import { saveProduct, deleteProduct } from "@/lib/actions/products";
import { login } from "@/lib/actions/auth_action";
import {
    payAccount,
    toDebt,
    getCustomerDebtAccounts,
    getSaleOrderItems,
    getDebtorHistory,
} from "@/lib/actions/debts";
import { authorizeCredentials } from "@/lib/auth-credentials";
import {
    resetAllLockouts,
    recordFailedAttempt,
    isLockedOut,
    getFailedAttempts,
    MAX_TRACKED_IDENTIFIERS,
} from "@/lib/auth-lockout";

describe("Adversarial Round 10 — Reproduction Tests (15 commits, Hydrogen audit)", () => {
    let adminId: number;
    let staffId: number;
    let jornadaId: number;
    let customerId: number;
    let supplyId: number;
    let productId: number;

    beforeEach(async () => {
        vi.useRealTimers();
        resetAllLockouts();
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;

        const staff = await prisma.users.create({
            data: {
                name: "Staff Prueba",
                username: "STAFF01",
                pin: await bcrypt.hash("1234", 10),
                role: "STAFF",
                active: true,
            },
        });
        staffId = staff.id;

        const customer = await prisma.customer.create({
            data: {
                customerName: "Cliente Base",
                alias: "Base",
                currentBalance: 0,
            },
        });
        customerId = customer.id;

        const supply = await prisma.supplies.create({
            data: {
                name: "Tortilla",
                measureUnit: "pz",
                currentStock: 100,
                unitCost: 2,
                active: true,
            },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Taco Pastor",
                price: 25,
                recipes: {
                    create: [{ supplyID: supplyId, quantityUsed: 2 }],
                },
            },
        });
        productId = product.id;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // F1: cancelSaleAction allows cancelling a sale whose debt was already PAID (commit 00a9caf / #13 gap)
    it("F1: cancelSaleAction must reject cancelling a sale with an already-PAID debt", async () => {
        loginAs("ADMIN", adminId);

        const created = await createSale(
            [{ productID: productId, quantity: 2 }],
            "DEBT",
            `CL- ${customerId}`,
            customerId,
            "CASH"
        );
        expect(created.success).toBe(true);
        const saleId = (created as { saleId: number }).saleId;

        const sale = await prisma.sales.findUniqueOrThrow({
            where: { id: saleId },
            include: { sale_items: true },
        });
        const payRes = await payAccount(
            customerId,
            [{
                id: sale.id,
                customerID: sale.customerID,
                placedBy: sale.placedBy,
                status: sale.status,
                source_type: sale.source_type ?? "",
                total: Number(sale.total),
                sale_items: sale.sale_items.map((i) => ({
                    productID: i.productID,
                    quantity: i.quantity,
                    unitPrice: Number(i.unitPrice),
                    subtotal: Number(i.subtotal),
                })),
            }],
            "CASH"
        );
        expect(payRes.msg).toBe("SUCCESS");

        const cancelRes = await cancelSaleAction(saleId);
        // MUST FAIL: cancelSaleAction omits `sale.debtors?.status === "PAID"` check
        expect(cancelRes.success).toBe(false);
    });

    // F2: Tracked in remote issue #28 (Prevent concurrent sale edits from corrupting stock)
    it("F2 (Issue #28): concurrent cancelSaleAction must not double-replenish stock or double-decrement customer balance", async () => {
        loginAs("ADMIN", adminId);

        const created = await createSale(
            [{ productID: productId, quantity: 3 }],
            "DEBT",
            `CL- ${customerId}`,
            customerId,
            "CASH"
        );
        expect(created.success).toBe(true);
        const saleId = (created as { saleId: number }).saleId;

        // Warm up 2 pool connections so both transactions actually execute concurrently
        await Promise.all([
            prisma.$queryRaw`SELECT 1`,
            prisma.$queryRaw`SELECT 1`,
        ]);

        const results = await Promise.all([
            cancelSaleAction(saleId),
            cancelSaleAction(saleId),
        ]);

        const supply = await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } });
        const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });

        // MUST FAIL under concurrent Read Committed cancellation
        expect(results.filter((r) => r.success).length).toBe(1);
        expect(Number(supply.currentStock)).toBe(100);
        expect(Number(customer.currentBalance)).toBe(0);
    });

    // F3: createSale with duplicate productID breaks inventory sync in updateSaleQuantity
    it("F3: updateSaleQuantity must keep inventory synchronized when createSale received duplicate productID lines", async () => {
        loginAs("ADMIN", adminId);

        // 2 + 3 = 5 products => 5 * 2 = 10 tortillas consumed => stock = 90
        const created = await createSale(
            [
                { productID: productId, quantity: 2 },
                { productID: productId, quantity: 3 },
            ],
            "UNPAID",
            "MESA_1",
            -1,
            "CASH"
        );
        expect(created.success).toBe(true);
        const saleId = (created as { saleId: number }).saleId;

        const upd = await updateSaleQuantity(saleId, 1, productId);
        expect(upd.success).toBe(true);

        const items = await prisma.sale_items.findMany({ where: { saleID: saleId } });
        const totalQty = items.reduce((acc, i) => acc + i.quantity, 0);
        const expectedStock = 100 - totalQty * 2;

        const supply = await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } });
        // MUST FAIL: updateMany sets both rows to qty=1 (total=2 => expectedStock=96), but stock only restored +2 (92)
        expect(Number(supply.currentStock)).toBe(expectedStock);
    });

    // F4: Tracked in remote issue #28 (Prevent concurrent sale edits from corrupting stock)
    it("F4 (Issue #28): concurrent updateSaleQuantity must leave inventory consistent with persisted item quantity", async () => {
        loginAs("ADMIN", adminId);

        const created = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "MESA_2",
            -1,
            "CASH"
        );
        expect(created.success).toBe(true);
        const saleId = (created as { saleId: number }).saleId;

        await Promise.all([
            updateSaleQuantity(saleId, 5, productId),
            updateSaleQuantity(saleId, 3, productId),
        ]);

        const item = await prisma.sale_items.findFirstOrThrow({
            where: { saleID: saleId, productID: productId },
        });
        const supply = await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } });
        // MUST FAIL: both read oldQuantity=1 and both decrement stock
        expect(Number(supply.currentStock)).toBe(100 - item.quantity * 2);
    });

    // F5: Tracked in remote issues #20 and #35 (Shift closing TOCTOU / cash counts)
    it("F5 (Issue #20/#35): closeJornada must persist expectedClosingAmount consistent with concurrent PAID cash sales", async () => {
        loginAs("ADMIN", adminId);

        // Run closeJornada concurrently with multiple PAID cash sales (which do NOT acquire ticket lock)
        const [closeRes] = await Promise.all([
            closeJornada(jornadaId, 500),
            createSale([{ productID: productId, quantity: 1 }], "PAID", "VENTA_LIBRE", -1, "CASH"),
            createSale([{ productID: productId, quantity: 2 }], "PAID", "VENTA_LIBRE", -1, "CASH"),
            createSale([{ productID: productId, quantity: 3 }], "PAID", "VENTA_LIBRE", -1, "CASH"),
        ]);

        expect(closeRes.success).toBe(true);

        const closedJornada = await prisma.jornada.findUniqueOrThrow({ where: { id: jornadaId } });
        const paidCashSales = await prisma.sales.aggregate({
            where: { jornadaId, status: "PAID", payment_method: "CASH" },
            _sum: { total: true },
        });

        const trueExpectedCash = Number(closedJornada.openingAmount) + Number(paidCashSales._sum.total ?? 0);
        // MUST FAIL when any PAID sale commits after getJornadaCashSummary() on line 116
        expect(Number(closedJornada.expectedClosingAmount)).toBe(trueExpectedCash);
    });

    // F6: Tracked in remote issue #20 (Prevent races in shift opening, savings withdrawals, and closing)
    it("F6 (Issue #20): concurrent openJornada calls must allow at most one OPEN jornada", async () => {
        loginAs("ADMIN", adminId);
        await prisma.jornada.update({
            where: { id: jornadaId },
            data: { status: "CLOSED", closedAt: new Date(), closedBy: adminId },
        });

        await Promise.all([
            openJornada(500),
            openJornada(300),
        ]);

        const openCount = await prisma.jornada.count({ where: { status: "OPEN" } });
        // MUST FAIL: both read pending === null and insert OPEN rows
        expect(openCount).toBe(1);
    });

    // F7: Missing ADMIN role checks in payrolls.ts & savings.ts read actions (rel. Issue #16 / #44)
    it("F7: STAFF must not be able to read admin payroll history, payroll info, or savings data", async () => {
        loginAs("ADMIN", adminId);
        await saveSalaryPayment({
            userID: adminId,
            amount: 1500,
            period: "SUELDO: Quincena",
            payment_method: "CASH",
        });
        await saveMovement(800, "DEPOSIT", "Fondo caja");
        await saveGoal({ name: "Horno nuevo", targetAmount: 5000 });

        loginAs("STAFF", staffId);

        const salaryHistory = await getSalaryHistory(adminId, 0, 30);
        const payrollInfo = await getUserPayrollInfo(adminId);
        const pool = await getPoolBalance();
        const movements = await getRecentMovements(20, 0);
        const goals = await getGoalsWithProgress();

        // MUST FAIL: none of these 5 actions check isAdmin(session.user.role)
        expect(salaryHistory.items).toHaveLength(0);
        expect(payrollInfo).toBeNull();
        expect(pool.balance).toBe(0);
        expect(movements.items).toHaveLength(0);
        expect(goals).toHaveLength(0);
    });

    // F8a: Tracked in remote issue #20 (make savings withdrawals atomic)
    it("F8a (Issue #20): concurrent saveMovement WITHDRAW must never leave pool balance negative", async () => {
        loginAs("ADMIN", adminId);
        await saveMovement(500, "DEPOSIT", "Saldo inicial");

        await Promise.all([
            saveMovement(400, "WITHDRAW", "Retiro 1"),
            saveMovement(400, "WITHDRAW", "Retiro 2"),
        ]);

        const pool = await getPoolBalance();
        // MUST FAIL: both withdrawals read balance=500 and leave balance=-300
        expect(pool.balance).toBeGreaterThanOrEqual(0);
    });

    it("F8b: saveMovement must validate movement type and reject invalid enum with validation message", async () => {
        loginAs("ADMIN", adminId);
        const res = await saveMovement(100, "INVALID_TYPE" as never, "Test");
        expect(res.success).toBe(false);
        if (!res.success) {
            // MUST FAIL: reaches Prisma unhandled and returns "INTERNAL ERROR"
            expect(res.message).not.toBe("INTERNAL ERROR");
        }
    });

    // F9: addContribution, cancelGoal, saveGoal missing state & validation guards
    it("F9a: addContribution must reject contributions to CANCELLED or COMPLETED goals", async () => {
        loginAs("ADMIN", adminId);
        const goal = await prisma.savings_goal.create({
            data: { name: "Meta Cancelada", targetAmount: 500, status: "CANCELLED" },
        });

        const res = await addContribution(goal.id, 100, "Abono indebido");
        // MUST FAIL: addContribution inserts contribution without checking goal.status === "ACTIVE"
        expect(res.success).toBe(false);
    });

    it("F9b: cancelGoal must reject cancelling an already COMPLETED goal", async () => {
        loginAs("ADMIN", adminId);
        const goal = await prisma.savings_goal.create({
            data: { name: "Meta Completada", targetAmount: 500, status: "COMPLETED" },
        });

        const res = await cancelGoal(goal.id);
        // MUST FAIL: overwrites COMPLETED -> CANCELLED
        expect(res.success).toBe(false);
    });

    it("F9c: saveGoal must not create a new goal when given a nonexistent id and must validate name <= 80", async () => {
        loginAs("ADMIN", adminId);

        const resMissing = await saveGoal({ id: 999999, name: "Meta Fantasma", targetAmount: 100 });
        // MUST FAIL: upsert silently creates a new goal
        expect(resMissing.success).toBe(false);

        const resLong = await saveGoal({ name: "M".repeat(81), targetAmount: 100 });
        expect(resLong.success).toBe(false);
        if (!resLong.success) {
            // MUST FAIL: Prisma VarChar(80) throws -> "INTERNAL ERROR"
            expect(resLong.message).not.toBe("INTERNAL ERROR");
        }
    });

    // F10: closeAccountAction false success on empty/already-settled sales & partial mixed-jornada close
    it("F10a: closeAccountAction must not report success: true when saleIds is empty or sales were already paid", async () => {
        loginAs("ADMIN", adminId);

        const emptyRes = await closeAccountAction("MESA_1", "CASH", []);
        // MUST FAIL: returns { success: true, count: 0 }
        expect(emptyRes.success).toBe(false);

        const created = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_1", -1, "CASH");
        const createdId = (created as { saleId: number }).saleId;
        const total = Number((await prisma.sales.findUniqueOrThrow({ where: { id: createdId } })).total);
        const firstClose = await closeAccountAction("MESA_1", "CASH", [createdId], total);
        expect(firstClose.success).toBe(true);

        const secondClose = await closeAccountAction("MESA_1", "TRANSFER", [createdId]);
        // MUST FAIL: returns { success: true, count: 0 } making second terminal believe TRANSFER succeeded
        expect(secondClose.success).toBe(false);
    });

    it("F10b: closeAccountAction must not report success when saleIds mixes a closed jornada and the open jornada", async () => {
        loginAs("ADMIN", adminId);
        const closedJornada = await prisma.jornada.create({
            data: {
                openedBy: adminId,
                closedBy: adminId,
                openingAmount: 100,
                status: "CLOSED",
                closedAt: new Date(),
            },
        });
        const oldSale = await prisma.sales.create({
            data: {
                total: 25,
                status: "UNPAID",
                source_type: "MESA_3",
                placedBy: adminId,
                jornadaId: closedJornada.id,
            },
        });
        const currentSale = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_3", -1, "CASH");

        const res = await closeAccountAction("MESA_3", "CASH", [oldSale.id, (currentSale as { saleId: number }).saleId]);
        // MUST FAIL: silently closes only currentSale (count=1) and returns success: true, leaving oldSale UNPAID
        expect(res.success).toBe(false);
    });

    // F11: createSale walk-in ticket VL-<n> reservation bypass & PAID status violation
    it("F11a: createSale without reservationToken must not steal an active VL-<n> reservation even for the same user", async () => {
        loginAs("ADMIN", adminId);
        const ticket = await nextFreeSaleTicket();
        expect(ticket.success).toBe(true);
        if (!ticket.success) return;

        // Second tab of the SAME user calls createSale without reservationToken
        const hijack = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            ticket.sourceType,
            -1,
            "CASH"
        );
        // MUST FAIL: line 144 only rejects if existingRes.userId !== placedBy
        expect(hijack.success).toBe(false);
    });

    it("F11b: createSale must reject VL-<n> tickets with PAID status (VL-<n> is UNPAID-only)", async () => {
        loginAs("ADMIN", adminId);
        const res = await createSale(
            [{ productID: productId, quantity: 1 }],
            "PAID",
            "VL-1",
            -1,
            "CASH"
        );
        // MUST FAIL: creates PAID sale with source_type="VL-1"
        expect(res.success).toBe(false);
    });

    // F12: Timezone bugs in payrolls.ts:48, customers.ts:100, sales.ts:231 (@db.Date stored in UTC instead of business date)
    it("F12: saveSalaryPayment, saveCustomer, and createSale must store @db.Date in America/Mexico_City date after 00:00 UTC", async () => {
        loginAs("ADMIN", adminId);
        // 2026-11-21 01:30 UTC === 2026-11-20 19:30 America/Mexico_City
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-21T01:30:00.000Z"));

        const payRes = await saveSalaryPayment({
            userID: staffId,
            amount: 300,
            period: "SUELDO: Nocturno",
            payment_method: "CASH",
        });
        expect(payRes.success).toBe(true);
        const salary = await prisma.salary.findFirstOrThrow({ where: { userID: staffId } });

        const custRes = await saveCustomer({ customerName: "Cliente Nocturno" });
        expect(custRes.success).toBe(true);
        const nightCust = await prisma.customer.findFirstOrThrow({ where: { customerName: "Cliente Nocturno" } });

        const saleRes = await createSale(
            [{ productID: productId, quantity: 1 }],
            "PAID",
            `CL- ${nightCust.id}`,
            nightCust.id,
            "CASH"
        );
        expect(saleRes.success).toBe(true);
        const updatedCust = await prisma.customer.findUniqueOrThrow({ where: { id: nightCust.id } });

        // MUST FAIL: all three persist 2026-11-21 (UTC tomorrow) instead of 2026-11-20 (Mexico City today)
        expect(salary.payDate?.toISOString().slice(0, 10)).toBe("2026-11-20");
        expect(nightCust.registeredDate?.toISOString().slice(0, 10)).toBe("2026-11-20");
        expect(updatedCust.lastConsumption?.toISOString().slice(0, 10)).toBe("2026-11-20");
    });

    // F13: closeJornada and getJornadaEmployeeBreakdown throw unhandled Prisma exceptions on invalid jornadaId
    it("F13: closeJornada and getJornadaEmployeeBreakdown must handle invalid jornadaId without throwing", async () => {
        loginAs("ADMIN", adminId);

        // MUST FAIL: both throw PrismaClientValidationError outside try/catch
        await expect(closeJornada(Number.NaN, 100)).resolves.toMatchObject({ success: false });
        await expect(getJornadaEmployeeBreakdown(Number.NaN)).resolves.toEqual([]);
    });

    // F14: getTodaySalesHistory leaks old UNPAID sales from CLOSED jornadas when no jornada is open
    it("F14: getTodaySalesHistory must not return old UNPAID sales from closed jornadas when no jornada is open", async () => {
        loginAs("ADMIN", adminId);
        const oldDate = new Date("2026-10-01T18:00:00.000Z");
        await prisma.jornada.update({
            where: { id: jornadaId },
            data: { status: "CLOSED", closedAt: oldDate, closedBy: adminId },
        });
        await prisma.sales.create({
            data: {
                total: 50,
                status: "UNPAID",
                source_type: "MESA_9",
                placedBy: adminId,
                jornadaId,
                createdAt: oldDate,
            },
        });

        const todaySales = await getTodaySalesHistory();
        // MUST FAIL: when activeJornada is null, OR includes `{ status: "UNPAID" }` without date/jornada filter
        expect(todaySales).toHaveLength(0);
    });

    // F15: authorizeCredentials case-sensitivity mismatch vs auth-lockout
    it("F15: authorizeCredentials must match email and username case-insensitively like auth-lockout", async () => {
        await prisma.users.create({
            data: {
                name: "Admin Mayus",
                email: "Admin@Comal.mx",
                password: await bcrypt.hash("secret123", 10),
                role: "ADMIN",
                active: true,
            },
        });

        const adminLogin = await authorizeCredentials({
            role: "ADMIN",
            email: "admin@comal.mx",
            password: "secret123",
        });
        const staffLogin = await authorizeCredentials({
            role: "STAFF",
            username: "staff01",
            pin: "1234",
        });

        // MUST FAIL: Prisma queries are case-sensitive while lockout normalizes with .toLowerCase()
        expect(adminLogin).not.toBeNull();
        expect(staffLogin).not.toBeNull();
    });

    // F16: GenerateUsername deterministic collision on vowel-less surnames
    it("F16: saveUser must not collide deterministically when creating two users with vowel-less penultimate surnames", async () => {
        loginAs("ADMIN", adminId);

        const first = await saveUser({
            name: "Juan Ng Cruz",
            role: "STAFF",
            pin: "1111",
            active: true,
        });
        expect(first.success).toBe(true);

        const second = await saveUser({
            name: "José Ng Castro",
            role: "STAFF",
            pin: "2222",
            active: true,
        });
        // MUST FAIL: both generate "NC01" and hit @unique constraint
        expect(second.success).toBe(true);
    });

    // F17: saveCustomer phantom creation on nonexistent id and whitespace-only customerName
    it("F17: saveCustomer must reject nonexistent/negative ids and whitespace-only customerName", async () => {
        loginAs("ADMIN", adminId);

        const resGhost = await saveCustomer({ id: 999999, customerName: "Cliente Fantasma" });
        // MUST FAIL: upsert silently creates a new customer
        expect(resGhost.success).toBe(false);

        const resSpaces = await saveCustomer({ customerName: "   " });
        // MUST FAIL: CustomerSchema lacks .trim()
        expect(resSpaces.success).toBe(false);
    });

    // F18: saveExpense validation gaps & getExpenses unhandled crashes
    it("F18a: saveExpense must reject whitespace-only description and category > 50 chars with fieldErrors", async () => {
        loginAs("ADMIN", adminId);

        const resSpaces = await saveExpense({
            amount: 50,
            category: "Otros",
            description: "   ",
            date: new Date(),
            payment_method: "CASH",
        });
        // MUST FAIL: BillSchema.description lacks .trim()
        expect(resSpaces.success).toBe(false);

        const resLongCat = await saveExpense({
            amount: 50,
            category: "C".repeat(51),
            description: "Compra válida",
            date: new Date(),
            payment_method: "CASH",
        });
        expect(resLongCat.success).toBe(false);
        // MUST FAIL: reaches PostgreSQL VarChar(50) and returns INTERNAL ERROR without fieldErrors
        expect(resLongCat.fieldErrors?.category).toBeDefined();
    });

    it("F18b: getExpenses must not throw ZodError on a legacy bill with empty receiptUrl", async () => {
        loginAs("ADMIN", adminId);

        await prisma.bill.create({
            data: {
                amount: 25,
                category: "Otros",
                description: "Legado",
                date: new Date(),
                registered_by: adminId,
                jornadaId,
                payment_method: "CASH",
                receiptUrl: "",
            },
        });
        // MUST FAIL: BillReadSchema.parse rejects receiptUrl: "" with unhandled ZodError
        await expect(getExpenses(0, 10)).resolves.toMatchObject({ total: 25 });
    });

    // F19: saveSalaryPayment coerces boolean amount: true -> 1 and accepts whitespace period
    it("F19: saveSalaryPayment must reject boolean amount and whitespace-only period", async () => {
        loginAs("ADMIN", adminId);

        const res = await saveSalaryPayment({
            userID: staffId,
            amount: true as unknown as number,
            period: "   ",
            payment_method: "CASH",
        });
        // MUST FAIL: z.coerce.number() turns true into 1 and period lacks .trim()
        expect(res.success).toBe(false);
    });

    // F20: login throws unhandled TypeError on non-FormData input
    it("F20: login action must handle non-FormData input gracefully instead of throwing TypeError", async () => {
        // MUST FAIL: throws TypeError: formData.get is not a function
        await expect(login(null, {} as unknown as FormData)).resolves.toMatchObject({ success: false });
    });

    // F21: INT4 overflow in createSale
    it("F21: createSale must reject INT4-overflow quantity with INVALID_INPUT instead of crashing in Prisma", async () => {
        loginAs("ADMIN", adminId);

        const saleRes = await createSale(
            [{ productID: productId, quantity: 2147483648 }],
            "PAID",
            "VENTA_LIBRE",
            -1,
            "CASH"
        );
        expect(saleRes.success).toBe(false);
        // MUST FAIL: passes Zod int().positive() and crashes in Prisma INT4 -> "INTERNAL ERROR"
        expect(saleRes.error).toBe("INVALID_INPUT");
    });

    // F22: saveProduct phantom creation on nonexistent id and whitespace-only name
    it("F22: saveProduct must reject nonexistent id and whitespace-only name", async () => {
        loginAs("ADMIN", adminId);

        const resGhost = await saveProduct({ id: 999999, name: "Taco Fantasma", price: 30 });
        // MUST FAIL: upsert silently creates a new product
        expect(resGhost.success).toBe(false);

        const resSpaces = await saveProduct({ name: "   ", price: 30 });
        // MUST FAIL: ProductSchema.name lacks .trim()
        expect(resSpaces.success).toBe(false);
    });

    // --- Round 2 Regression Tests ---

    it("R2-1: saveGoal persists ISO string deadlines, rejects editing inactive goals, and auto-completes on target reduction", async () => {
        loginAs("ADMIN", adminId);

        const resStrDate = await saveGoal({
            name: "Meta Fecha ISO",
            targetAmount: 1000,
            deadline: "2026-12-31" as unknown as Date,
        });
        expect(resStrDate.success).toBe(true);
        const created = await prisma.savings_goal.findFirstOrThrow({ where: { name: "Meta Fecha ISO" } });
        expect(created.deadline).toBeInstanceOf(Date);

        // Reject boolean deadline
        expect(await saveGoal({ name: "Meta Bool", targetAmount: 100, deadline: false as unknown as Date }))
            .toMatchObject({ success: false });

        // Lowering targetAmount below existing contributions auto-completes ACTIVE goal
        await addContribution(created.id, 600);
        expect(await saveGoal({ id: created.id, name: "Meta Fecha ISO", targetAmount: 500 })).toMatchObject({ success: true });
        const afterLower = await prisma.savings_goal.findUniqueOrThrow({ where: { id: created.id } });
        expect(afterLower.status).toBe("COMPLETED");

        // Editing a COMPLETED goal is rejected
        expect(await saveGoal({ id: created.id, name: "Editada", targetAmount: 2000 })).toMatchObject({ success: false });
    });

    it("R2-2: savings pool balance and goal auto-completion handle IEEE-754 decimals cleanly", async () => {
        loginAs("ADMIN", adminId);
        await saveMovement(0.3, "DEPOSIT");
        await saveMovement(0.1, "WITHDRAW");
        expect(await saveMovement(0.2, "WITHDRAW")).toMatchObject({ success: true });
        expect((await getPoolBalance()).balance).toBe(0);

        await saveGoal({ name: "Meta Decimal", targetAmount: 0.8 });
        const g = await prisma.savings_goal.findFirstOrThrow({ where: { name: "Meta Decimal" } });
        await addContribution(g.id, 0.7);
        await addContribution(g.id, 0.1);
        const updated = await prisma.savings_goal.findUniqueOrThrow({ where: { id: g.id } });
        expect(updated.status).toBe("COMPLETED");
    });

    it("R2-3: saveProduct handles null, boolean price, duplicate/missing supplyID, zero quantityUsed, duplicate name, and deleteProduct shape", async () => {
        loginAs("ADMIN", adminId);

        expect(await saveProduct(null as never)).toMatchObject({ success: false });
        expect(await saveProduct({ name: "Agua Bool", price: true as unknown as number })).toMatchObject({ success: false });
        expect(await saveProduct({ name: "Taco Cero", price: 10, recipes: [{ supplyID: supplyId, quantityUsed: 0 }] }))
            .toMatchObject({ success: false });
        expect(await saveProduct({ name: "Taco Insumo Inexistente", price: 50, recipes: [{ supplyID: 999999, quantityUsed: 1 }] }))
            .toMatchObject({ success: false, fieldErrors: { recipes: expect.any(Array) } });

        // Duplicate supplyIDs are merged cleanly
        expect(await saveProduct({
            name: "Taco Merge",
            price: 50,
            recipes: [
                { supplyID: supplyId, quantityUsed: 1 },
                { supplyID: supplyId, quantityUsed: 2 },
            ],
        })).toMatchObject({ success: true });
        const merged = await prisma.products.findFirstOrThrow({ where: { name: "Taco Merge" }, include: { recipes: true } });
        expect(merged.recipes).toHaveLength(1);
        expect(Number(merged.recipes[0].quantityUsed)).toBe(3);

        // Duplicate product name returns fieldErrors.name
        expect(await saveProduct({ name: "Taco Merge", price: 60 }))
            .toMatchObject({ success: false, fieldErrors: { name: expect.any(Array) } });

        // deleteProduct consistently includes success: false on errors
        expect(await deleteProduct(-1)).toMatchObject({ success: false, error: "INVALID_INPUT" });
        loginAs("STAFF", staffId);
        expect(await deleteProduct(merged.id)).toMatchObject({ success: false, error: "PERMISSION DENIED" });
    });

    it("R2-4: saveCustomer requires ADMIN role and trims phone before max-length check", async () => {
        loginAs("STAFF", staffId);
        expect(await saveCustomer({ customerName: "Cliente Staff" })).toMatchObject({ success: false, error: "UNAUTHORIZED" });

        loginAs("ADMIN", adminId);
        expect(await saveCustomer({ customerName: "Cliente Con Espacios Tel", phone: " 12345678901234567890 " }))
            .toMatchObject({ success: true });
    });

    it("R2-5: saveUser enforces INT4 max on id and case-insensitive email uniqueness", async () => {
        loginAs("ADMIN", adminId);

        const int4Res = await saveUser({ id: 2147483648, name: "Juan Perez", role: "STAFF" });
        expect(int4Res.success).toBe(false);
        expect((int4Res.fieldErrors as Record<string, string[] | undefined>)?.id).toBeDefined();

        expect(await saveUser({ name: "Admin Uno", role: "ADMIN", email: "AdminCase@Comal.mx", password: "password123" }))
            .toMatchObject({ success: true });
        const dupCase = await saveUser({ name: "Admin Dos", role: "ADMIN", email: "admincase@comal.mx", password: "password123" });
        expect(dupCase.success).toBe(false);
        expect(dupCase.fieldErrors?.email).toBeDefined();
    });

    it("R2-6: debts actions reject INT4-overflow IDs and toDebt rejects UNPAID sales from CLOSED jornadas", async () => {
        loginAs("ADMIN", adminId);
        expect(await getCustomerDebtAccounts(2147483648)).toMatchObject({ success: false, error: "INVALID_INPUT" });
        expect(await getSaleOrderItems(2147483648)).toMatchObject({ success: false, error: "INVALID_INPUT" });
        expect(await getDebtorHistory(2147483648)).toMatchObject({ success: false, error: "INVALID_INPUT" });
        expect(await toDebt(2147483648, [{ id: 1 }] as never)).toMatchObject({ msg: "INVALID_INPUT" });
        expect(await payAccount(2147483648, [{ id: 1 }] as never, "CASH")).toMatchObject({ msg: "INVALID_INPUT" });

        const closedJornada = await prisma.jornada.create({
            data: { openedBy: adminId, closedBy: adminId, openingAmount: 100, status: "CLOSED", closedAt: new Date() },
        });
        const oldSale = await prisma.sales.create({
            data: { total: 50, status: "UNPAID", source_type: "MESA_7", placedBy: adminId, jornadaId: closedJornada.id },
        });
        expect(await toDebt(customerId, [{ id: oldSale.id }] as never)).toMatchObject({ msg: "JORNADA_CLOSED" });
    });

    it("R2-7: createSale rejects malformed VL-* prefixes and saveExpense rejects whitespace-only category", async () => {
        loginAs("ADMIN", adminId);
        expect(await createSale([{ productID: productId, quantity: 1 }], "PAID", "VL-01", -1, "CASH"))
            .toMatchObject({ success: false, error: "INVALID_INPUT" });
        expect(await createSale([{ productID: productId, quantity: 1 }], "DEBT", "vl-1", customerId, "CASH"))
            .toMatchObject({ success: false, error: "INVALID_INPUT" });

        expect(await saveExpense({
            amount: 50,
            category: "   ",
            description: "Hielo",
            date: new Date(),
            payment_method: "CASH",
        })).toMatchObject({ success: false, fieldErrors: { category: expect.any(Array) } });
    });

    it("R2-8: auth-lockout ignores whitespace identifiers and protects active lockouts from 10k-probe flood eviction", () => {
        resetAllLockouts();
        recordFailedAttempt("   ");
        expect(getFailedAttempts("   ")).toBe(0);

        for (let i = 0; i < 5; i++) {
            recordFailedAttempt("victim@comal.mx");
        }
        expect(isLockedOut("victim@comal.mx")).toBe(true);

        // Flood with MAX_TRACKED_IDENTIFIERS + 50 random non-locked identifiers
        for (let i = 0; i < MAX_TRACKED_IDENTIFIERS + 50; i++) {
            recordFailedAttempt(`probe-${i}@attacker.test`);
        }
        // Victim's active lockout MUST remain intact
        expect(isLockedOut("victim@comal.mx")).toBe(true);
    });

    // --- Round 3 Regression Tests ---

    it("R3-1: savings rejects sub-cent amounts (<0.01), normalizes deadline to business date, and rounds goal progress", async () => {
        loginAs("ADMIN", adminId);

        expect(await saveMovement(0.004, "DEPOSIT")).toMatchObject({ success: false });
        expect(await saveGoal({ name: "Subcent", targetAmount: 0.004 })).toMatchObject({ success: false });

        // Non-midnight business evening deadline normalizes to 2026-11-25 UTC midnight (not Nov 26)
        const eveningMexico = new Date("2026-11-26T02:00:00.000Z"); // 20:00 Nov 25 Mexico City
        expect(await saveGoal({ name: "Meta Fecha TZ", targetAmount: 100, deadline: eveningMexico }))
            .toMatchObject({ success: true });
        const goal = await prisma.savings_goal.findFirstOrThrow({ where: { name: "Meta Fecha TZ" } });
        expect(goal.deadline?.toISOString().slice(0, 10)).toBe("2026-11-25");

        // Sub-cent contribution rejected; editing targetAmount to 0.004 rejected
        expect(await addContribution(goal.id, 0.004)).toMatchObject({ success: false });
        expect(await saveGoal({ id: goal.id, name: "Meta Fecha TZ", targetAmount: 0.004 })).toMatchObject({ success: false });

        // Goal progress rounds IEEE-754 sums cleanly
        await addContribution(goal.id, 0.1);
        await addContribution(goal.id, 0.2);
        const progress = (await getGoalsWithProgress()).find((g) => g.id === goal.id)!;
        expect(progress.currentAmount).toBe(0.3);
    });

    it("R3-2: saveExpense rejects omitted category and login rejects empty password/pin with fieldErrors", async () => {
        loginAs("ADMIN", adminId);
        expect(await saveExpense({
            amount: 100,
            description: "Sin categoria",
            date: new Date(),
            payment_method: "CASH",
        } as unknown as Parameters<typeof saveExpense>[0])).toMatchObject({
            success: false,
            fieldErrors: { category: expect.any(Array) },
        });

        const fdAdmin = new FormData();
        fdAdmin.set("email", "admin@test.local");
        fdAdmin.set("password", "");
        expect(await login(null, fdAdmin)).toMatchObject({
            success: false,
            fieldErrors: { password: expect.any(Array) },
        });

        const fdStaff = new FormData();
        fdStaff.set("username", "STAFF01");
        fdStaff.set("pin", "");
        expect(await login(null, fdStaff)).toMatchObject({
            success: false,
            fieldErrors: { pin: expect.any(Array) },
        });
    });

    it("R3-3: auth-lockout still locks a new real account even if all 10k slots were filled with locked fakes", () => {
        resetAllLockouts();
        for (let i = 0; i < MAX_TRACKED_IDENTIFIERS; i++) {
            recordFailedAttempt(`fake-${i}@flood.test`, 1);
        }
        // Now attempt brute force on a brand-new real account
        for (let i = 0; i < 5; i++) {
            recordFailedAttempt("new-target@comal.mx");
        }
        expect(isLockedOut("new-target@comal.mx")).toBe(true);
    });

    it("R4-1: saveMovement and addContribution reject 1e308 overflow with Monto inválido instead of INTERNAL ERROR", async () => {
        loginAs("ADMIN", adminId);
        const movRes = await saveMovement(1e308, "DEPOSIT", "overflow");
        expect(movRes).toEqual({ success: false, message: "Monto inválido" });

        await saveGoal({ name: "Meta R4", targetAmount: 1000 });
        const goal = await prisma.savings_goal.findFirstOrThrow({ where: { name: "Meta R4" } });
        const contribRes = await addContribution(goal.id, 1e308, "overflow");
        expect(contribRes).toEqual({ success: false, message: "Monto inválido" });
    });

    it("R4-2: createSale rejects UNPAID sales with VENTA_LIBRE source_type when jornada is open", async () => {
        loginAs("ADMIN", adminId);
        const res = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "VENTA_LIBRE",
            -1
        );
        expect(res).toMatchObject({ success: false, error: "INVALID_INPUT" });
    });

    it("R5-1: login ignores residual whitespace or values in unused fields of the opposite role", async () => {
        // STAFF login with invalid password (< 4 chars), but still missing valid credentials -> should not fail on password
        const fdStaff = new FormData();
        fdStaff.set("username", "STAFF01");
        fdStaff.set("pin", "");
        fdStaff.set("password", "ab");
        const staffRes = await login(null, fdStaff);
        expect(staffRes).toMatchObject({
            success: false,
            fieldErrors: { pin: expect.any(Array) },
        });
        expect((staffRes as any).fieldErrors?.password).toBeUndefined();

        // ADMIN login with whitespace username and invalid pin, but missing password -> should only fail on password
        const fdAdmin = new FormData();
        fdAdmin.set("email", "admin@comal.mx");
        fdAdmin.set("password", "");
        fdAdmin.set("username", "   ");
        fdAdmin.set("pin", "12");
        const adminRes = await login(null, fdAdmin);
        expect(adminRes).toMatchObject({
            success: false,
            fieldErrors: { password: expect.any(Array) },
        });
        expect((adminRes as any).fieldErrors?.username).toBeUndefined();
        expect((adminRes as any).fieldErrors?.pin).toBeUndefined();
    });

    it("R5-2: saveProduct rejects duplicate supplyID quantityUsed overflow to Infinity with fieldErrors", async () => {
        loginAs("ADMIN", adminId);
        const res = await saveProduct({
            name: "Overflow Recipe Product",
            price: 50,
            recipes: [
                { supplyID: supplyId, quantityUsed: 1e308 },
                { supplyID: supplyId, quantityUsed: 1e308 },
            ],
        });
        expect(res).toMatchObject({
            success: false,
            fieldErrors: { recipes: expect.any(Array) },
        });
    });

    it("R6-1: saveMovement, saveGoal, and addContribution reject extreme monetary amounts and invalid calendar deadlines", async () => {
        loginAs("ADMIN", adminId);
        expect(await saveMovement(1e306, "DEPOSIT")).toEqual({
            success: false,
            message: "Monto inválido",
        });
        expect(await saveGoal({ name: "Extreme Target", targetAmount: 1e306 })).toEqual({
            success: false,
            message: "Datos inválidos",
        });
        expect(
            await saveGoal({
                name: "Feb 31 Goal",
                targetAmount: 1000,
                deadline: "2026-02-31" as unknown as Date,
            })
        ).toEqual({
            success: false,
            message: "Fecha límite inválida",
        });
        expect(
            await saveGoal({
                name: "Year 10000 Goal",
                targetAmount: 1000,
                deadline: new Date("10000-01-01T00:00:00.000Z"),
            })
        ).toEqual({
            success: false,
            message: "Fecha límite inválida",
        });
    });

    it("R6-2: login returns combined format and missing-field errors for the active role", async () => {
        const fdAdmin = new FormData();
        fdAdmin.set("email", "correo-invalido");
        fdAdmin.set("password", "");
        const adminRes = await login(null, fdAdmin);
        expect(adminRes).toMatchObject({
            success: false,
            fieldErrors: {
                email: expect.any(Array),
                password: expect.any(Array),
            },
        });

        const fdStaff = new FormData();
        fdStaff.set("username", "");
        fdStaff.set("pin", "12");
        const staffRes = await login(null, fdStaff);
        expect(staffRes).toMatchObject({
            success: false,
            fieldErrors: {
                username: expect.any(Array),
                pin: expect.any(Array),
            },
        });
    });

    it("R6-3: saveProduct rejects single-recipe baseCost overflow on recipes field and saveSalaryPayment rejects empty reason after colon", async () => {
        loginAs("ADMIN", adminId);
        const prodRes = await saveProduct({
            name: "Single Recipe BaseCost Overflow",
            price: 50,
            recipes: [{ supplyID: supplyId, quantityUsed: 1e308 }],
        });
        expect(prodRes).toMatchObject({
            success: false,
            fieldErrors: { recipes: expect.any(Array) },
        });

        const salRes = await saveSalaryPayment({
            userID: staffId,
            amount: 100,
            period: "ADELANTO:   ",
            payment_method: "CASH",
        });
        expect(salRes.success).toBe(false);
    });

    it("R7-1: saveExpense rejects dates that convert to year < 1900 in America/Mexico_City and extreme amounts > 1e12", async () => {
        loginAs("ADMIN", adminId);
        const borderDateRes = await saveExpense({
            amount: 100,
            category: "Insumos",
            description: "Borde 1900",
            date: new Date("1900-01-01T02:00:00.000Z"),
            payment_method: "CASH",
        });
        expect(borderDateRes.success).toBe(false);

        const extremeAmountRes = await saveExpense({
            amount: 1e307,
            category: "Insumos",
            description: "Extremo",
            date: new Date("2026-05-01T00:00:00.000Z"),
            payment_method: "CASH",
        });
        expect(extremeAmountRes.success).toBe(false);

        const list = await getExpenses(0, 30);
        expect(Array.isArray(list.items)).toBe(true);
    });

    it("R7-2: saveGoal rejects non-canonical invalid calendar date strings like 2026/02/30 and 2026-2-31", async () => {
        loginAs("ADMIN", adminId);
        for (const bad of ["2026/02/30", "2026-2-31", "02/31/2026"]) {
            expect(
                await saveGoal({
                    name: "Bad Date Format Goal",
                    targetAmount: 500,
                    deadline: bad as unknown as Date,
                })
            ).toEqual({
                success: false,
                message: "Fecha límite inválida",
            });
        }
    });

    it("R7-3: auth-lockout protects partial failed attempts (2..4) against 1-attempt dummy floods", () => {
        resetAllLockouts();
        for (let i = 0; i < 4; i++) {
            recordFailedAttempt("almost-locked@comal.mx");
        }
        for (let i = 0; i < MAX_TRACKED_IDENTIFIERS; i++) {
            recordFailedAttempt(`dummy-1attempt-${i}@flood.test`);
        }
        // 5th attempt on almost-locked@comal.mx must lock it out
        const fifth = recordFailedAttempt("almost-locked@comal.mx");
        expect(fifth.locked).toBe(true);
        expect(isLockedOut("almost-locked@comal.mx")).toBe(true);
    });

    it("R7-4: saveUser accepts whitespace-only email on STAFF and returns combined fieldErrors on invalid ADMIN create", async () => {
        loginAs("ADMIN", adminId);
        const staffSpaceEmail = await saveUser({
            name: "Mario Blanco Gomez",
            role: "STAFF",
            pin: "1234",
            email: "   ",
        });
        expect(staffSpaceEmail).toMatchObject({ success: true });

        const invalidAdmin = await saveUser({
            name: "Admin Invalido Perez",
            role: "ADMIN",
            email: "correo-invalido",
            password: "",
        });
        expect(invalidAdmin).toMatchObject({
            success: false,
            fieldErrors: {
                email: expect.any(Array),
                password: expect.any(Array),
            },
        });
    });
});
