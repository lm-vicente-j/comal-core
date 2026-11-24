import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return {
        auth: authMock,
        signIn: vi.fn(),
        signOut: vi.fn(),
    };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, resetDb, seedBase } from "./helpers";
import { createSale } from "@/lib/actions/sales";
import { saveExpense, getExpenses } from "@/lib/actions/expenses";
import { saveSalaryPayment } from "@/lib/actions/payrolls";
import { closeJornada, getActiveJornadaWithStats } from "@/lib/actions/jornada";
import { BillSchema, ProductSchema, SalarySchema, SupplySchema } from "@/lib/actions/schemas";
import { analyticsPeriod, formatReportCell, reportCsv, type ReportData } from "@/lib/analytics";
import { calculateCashChange } from "@/lib/cash-change";
import { formatCurrencyCents } from "@/lib/scaled-values";
import { salesOptimisticReducer } from "@/app/(dashboard)/pos/optimistic-sale";

const ROOT = process.cwd();

describe("Adversarial Round 14 — Round 4 Pro Audit Reproduction Tests", () => {
    let adminId: number;
    let jornadaId: number;
    let customerId: number;
    let productId: number;

    beforeEach(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;

        const customer = await prisma.customer.create({
            data: {
                customerName: "Cliente Ronda 14",
                alias: "R14",
                currentBalanceCents: 0,
            },
        });
        customerId = customer.id;

        const product = await prisma.products.create({
            data: {
                name: "Producto R14",
                priceCents: 2500,
            },
        });
        productId = product.id;

        loginAs("ADMIN", adminId);
    });

    // -------------------------------------------------------------------------
    // Q1 (Alta): saveExpense y saveSalaryPayment omiten validación de acumulados safe-integer
    // -------------------------------------------------------------------------
    it("Q1: saveExpense and saveSalaryPayment must prevent jornada cashBills/cashSalaries/expectedCash from overflowing safe integer bounds", async () => {
        await prisma.jornada.update({ where: { id: jornadaId }, data: { openingAmountCents: 0 } });

        // Seed 4.9e15 in existing CASH bills and 4.1e15 in existing CASH salaries (expectedCash = -9.0e15, safe)
        await prisma.bill.create({
            data: {
                description: "Gasto acumulado",
                amountCents: BigInt("4900000000000000"),
                date: new Date(),
                registered_by: adminId,
                payment_method: "CASH",
                jornadaId,
            },
        });
        await prisma.salary.create({
            data: {
                userID: adminId,
                amountCents: BigInt("4100000000000000"),
                payDate: new Date(),
                period: "SUELDO: Acumulado",
                payment_method: "CASH",
                jornadaId,
            },
        });

        // Adding one more valid 1e14 CASH expense pushes expectedCash to -9.1e15 < MIN_SAFE_INTEGER
        const expRes = await saveExpense({
            amount: 100_000_000_000_000,
            category: "Otros",
            description: "Desborde caja",
            date: new Date(),
            payment_method: "CASH",
        });

        // Also test saveSalaryPayment pushing expectedCash below MIN_SAFE_INTEGER if expense was rejected
        if (expRes.success) {
            await expect(getActiveJornadaWithStats()).resolves.toBeDefined();
            const closeRes = await closeJornada(jornadaId, 0);
            expect(closeRes.error).not.toBe("INTERNAL ERROR");
            const expenses = await getExpenses();
            expect(expenses.success && expenses.data.items.length).toBeGreaterThan(0);
        } else {
            const salRes = await saveSalaryPayment({
                userID: adminId,
                amount: 100_000_000_000_000,
                period: "SUELDO: Desborde",
                payment_method: "CASH",
            });
            expect(salRes.success).toBe(false);
        }
    });

    // -------------------------------------------------------------------------
    // Q2 (Alta): Crash RangeError en render optimista de MobilePosManager al subir cantidad cerca de MAX_SAFE_INTEGER
    // -------------------------------------------------------------------------
    it("Q2: optimistic quantity increment near MAX_SAFE_INTEGER must not produce unsafe subtotal that crashes formatCurrencyCents", () => {
        const sale = {
            id: 1,
            customerID: null,
            jornadaId,
            placedBy: adminId,
            status: "UNPAID" as const,
            source_type: "MESA_1",
            total: 9_000_000_000_000_000,
            sale_items: [
                {
                    productID: productId,
                    quantity: 90,
                    unitPrice: 100_000_000_000_000,
                    subtotal: 9_000_000_000_000_000,
                    products: { id: productId, name: "Producto Alto", price: 100_000_000_000_000 },
                },
            ],
        };

        const nextSales = salesOptimisticReducer([sale], {
            type: "setQuantity",
            saleId: 1,
            productId,
            quantity: 91,
        });

        // MobilePosManager renders formatCurrencyCents(Number(item.subtotal || 0))
        expect(() => formatCurrencyCents(nextSales[0].sale_items[0].subtotal)).not.toThrow();
    });

    // -------------------------------------------------------------------------
    // Q3 (Media): createSale acepta customerID > 0 en MESA_<n> y MESA_<n> fuera de rango INT4
    // -------------------------------------------------------------------------
    it("Q3: createSale must reject customerID > 0 on MESA_<n> accounts and out-of-range table numbers", async () => {
        const resTableWithCustomer = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "MESA_1",
            customerId,
        );
        expect(resTableWithCustomer.success).toBe(false);

        const resHugeTable = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            "MESA_9999999999999999999999999",
            -1,
        );
        expect(resHugeTable.success).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Q4 (Media): SalesInputClient rechaza efectivo recibido > MAX_SAFE_INTEGER cuando receiptTotal <= MAX_SAFE_INTEGER
    // -------------------------------------------------------------------------
    it("Q4: SalesInputClient cash change calculation must handle cashReceived > MAX_SAFE_INTEGER consistently with mobile/debtors", () => {
        const source = fs.readFileSync(path.join(ROOT, "components/Sales-input-client.tsx"), "utf8");
        // Confirm calculateCashChange currently rejects "100000000000000" (1e16 cents) as invalid
        expect(calculateCashChange("100000000000000", 8_000_000_000_000_000).status).toBe("invalid");

        // SalesInputClient must not delegate solely to Number-based calculateCashChange when cashReceived can exceed MAX_SAFE_INTEGER
        expect(source).not.toMatch(/if \(Number\.isSafeInteger\(asNumber\)\) \{\s*return calculateCashChange\(cashReceived, asNumber\);\s*\}/);
    });

    // -------------------------------------------------------------------------
    // Q5 (Media): Mensajes Zod en inglés o "es requerido" para NaN/Infinity/floats en BillSchema, SalarySchema, SupplySchema y ProductSchema
    // -------------------------------------------------------------------------
    it("Q5: schemas must return Spanish invalid-value messages (not English 'Invalid input' or 'es requerido') for NaN/float/id inputs", () => {
        const billNaN = BillSchema.shape.amount.safeParse(Number.NaN);
        expect(billNaN.success).toBe(false);
        if (!billNaN.success) {
            expect(billNaN.error.issues[0].message).not.toMatch(/Invalid input/i);
        }

        const salNaN = SalarySchema.shape.amount.safeParse(Number.NaN);
        expect(salNaN.success).toBe(false);
        if (!salNaN.success) {
            expect(salNaN.error.issues[0].message).not.toBe("El monto es requerido");
        }

        const supFloatId = SupplySchema.shape.id.safeParse(1.5);
        expect(supFloatId.success).toBe(false);
        if (!supFloatId.success) {
            expect(supFloatId.error.issues[0].message).not.toMatch(/Invalid input|expected int/i);
        }

        const prodZeroId = ProductSchema.shape.id.safeParse(0);
        expect(prodZeroId.success).toBe(false);
        if (!prodZeroId.success) {
            expect(prodZeroId.error.issues[0].message).not.toMatch(/Too small|Invalid input/i);
        }
    });

    // -------------------------------------------------------------------------
    // Q6 (Media): formatReportCell ("NaN" en integer, "-0.0%" en percent, RangeError en fecha inválida) y csvCell (strings money inválidos)
    // -------------------------------------------------------------------------
    it("Q6: formatReportCell and reportCsv must safely handle invalid integers, -0.0%, invalid dates, and non-integer money strings", () => {
        expect(formatReportCell(Number.NaN, "integer")).toBe("Sin especificar");
        expect(formatReportCell(-0.01, "percent")).toBe("0.0%");
        expect(() => formatReportCell("invalid-date", "datetime")).not.toThrow();

        const report: ReportData = {
            type: "expenses",
            period: analyticsPeriod({ from: "2026-09-30", to: "2026-09-30" }),
            generatedAt: new Date().toISOString(),
            notices: [],
            columns: [{ key: "amount", label: "Monto", kind: "money" }],
            rows: [{ amount: "12.50" }, { amount: "abc" }],
            totals: { amount: 0 },
            totalRows: 2,
        };
        const csv = reportCsv(report);
        expect(csv).not.toContain('"12.50"');
        expect(csv).not.toContain('"abc"');
    });

    // -------------------------------------------------------------------------
    // Q7 (Media): MobilePosManager debtConfirm mantiene snapshot obsoleto al editar/eliminar líneas
    // -------------------------------------------------------------------------
    it("Q7: MobilePosManager must disable line edits or close debtConfirm when account lines are modified", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/pos/MobilePosManager.tsx"),
            "utf8",
        );
        // Line +/-/delete buttons must be disabled when debtConfirm is open (or debtConfirm closed on line mutation)
        expect(source).toMatch(/disabled=\{line\.optimistic \|\| settling \|\| sendingToDebt \|\| debtConfirm/);
    });

    // -------------------------------------------------------------------------
    // Q8 (Media): DebtPaymentDialog no limpia error/accounts al cargar y muestra $0.00 en fallo de getCustomerDebtAccounts
    // -------------------------------------------------------------------------
    it("Q8: DebtPaymentDialog must clear stale error/accounts on load and not show $0.00 when loading accounts fails", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/debtors/debt-payment-dialog.tsx"),
            "utf8",
        );
        expect(source).toMatch(/setLoadingAccounts\(true\);\s*setError\(""\);\s*setAccounts\(\[\]\);/);
    });

    // -------------------------------------------------------------------------
    // Q10 (Baja): menu-manager y MobileMenuManager colapsan cantidades de receta inválidas a 0 en totalBaseCost
    // -------------------------------------------------------------------------
    it("Q10: menu-manager must detect invalid recipe quantities instead of silently collapsing them to 0 in totalBaseCost", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/admin/menu/menu-manager.tsx"),
            "utf8",
        );
        expect(source).not.toMatch(/quantityUsed: parseMilliunits\(String\(item\.quantityUsed\)\) \?\? 0,/);
    });

    // -------------------------------------------------------------------------
    // Q11 (Baja): jornada-manager omite if (loading) return en handleOpen/handleClose y persisten ${formatCents(...)}
    // -------------------------------------------------------------------------
    it("Q11: jornada-manager must guard handleOpen/handleClose with if (loading) return and avoid ${formatCents(...)}", () => {
        const jornadaSource = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/admin/jornada/jornada-manager.tsx"),
            "utf8",
        );
        expect(jornadaSource).toMatch(/const handleOpen = async \(\) => \{\s*if \(loading\) return;/);
        expect(jornadaSource).toMatch(/const handleClose = async \(\) => \{\s*if \(loading\) return;/);
        expect(jornadaSource).not.toContain("${formatCents(");
    });

    // -------------------------------------------------------------------------
    // Q12 (Baja): CRMManager / MobileCRMManager reemplazan saldo > MAX_SAFE_INTEGER por $0.00 en verde
    // -------------------------------------------------------------------------
    it("Q12: CRMManager and MobileCRMManager must not silently fall back to 0 ($0.00) when currentBalance exceeds MAX_SAFE_INTEGER", () => {
        const crmSource = fs.readFileSync(path.join(ROOT, "app/(dashboard)/admin/crm/crm-manager.tsx"), "utf8");
        const mobileCrmSource = fs.readFileSync(path.join(ROOT, "app/(dashboard)/admin/crm/MobileCRMManager.tsx"), "utf8");

        expect(crmSource).not.toMatch(/const balance = Number\.isSafeInteger\(raw\) \? raw : 0;/);
        expect(mobileCrmSource).not.toMatch(/const balance = Number\.isSafeInteger\(rawBalance\) \? rawBalance : 0;/);
    });

    // -------------------------------------------------------------------------
    // Q13 (Baja): /admin/roster permite atravesar dos modales de confirmación con amount > MAX_MONETARY_AMOUNT
    // -------------------------------------------------------------------------
    it("Q13: roster page must validate MAX_MONETARY_AMOUNT (1e14) before opening confirmation dialogs", () => {
        const rosterSource = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/admin/roster/page.tsx"),
            "utf8",
        );
        expect(rosterSource).toMatch(/100_000_000_000_000|MAX_MONETARY_AMOUNT/);
    });
});
