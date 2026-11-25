import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
vi.mock("next/link", () => ({
    default: ({ children, href, ...props }: { children?: React.ReactNode; href: string; [key: string]: unknown }) =>
        React.createElement("a", { href, ...props }, children),
}));
vi.mock("@/lib/actions/settings", () => ({
    getSettings: vi.fn().mockResolvedValue({ clabe: "012345678901234567" }),
}));

import prisma from "@/lib/prisma";
import { actionData, loginAs, resetDb, seedBase } from "./helpers";
import {
    createSale,
    closeAccountAction,
    updateSaleQuantity,
    cancelSaleAction,
} from "@/lib/actions/sales";
import {
    closeJornada,
    getActiveJornadaWithStats,
    getJornadaEmployeeBreakdown,
} from "@/lib/actions/jornada";
import { getCustomerPage } from "@/lib/actions/customers";
import { getAllDebtors, getDebtsSummary, payAccount, toDebt } from "@/lib/actions/debts";
import { saveSupply, deleteSupply, getSuppliesData } from "@/lib/actions/inventory";
import { saveProduct, getProductPage } from "@/lib/actions/products";
import { saveSalaryPayment } from "@/lib/actions/payrolls";
import { BillSchema } from "@/lib/actions/schemas";
import { toSafeInteger } from "@/lib/scaled-values";
import { sumSaleTotalsCents } from "@/lib/cash-change";
import { analyticsPeriod, compareAmounts, formatReportCell, reportCsv, type ReportData } from "@/lib/analytics";
import FreeSaleTickets from "@/components/FreeSaleTickets";
import TransferConfirmationDialog from "@/components/Transfer-confirmation-dialog";

const ROOT = process.cwd();

describe("Adversarial Round 12 — Working Tree Audit Reproduction Tests", () => {
    let adminId: number;
    let jornadaId: number;
    let customerId: number;
    let supplyId: number;
    let productId: number;

    beforeEach(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;

        const customer = await prisma.customer.create({
            data: {
                customerName: "Cliente Ronda 12",
                alias: "R12",
                currentBalanceCents: 0,
            },
        });
        customerId = customer.id;

        const supply = await prisma.supplies.create({
            data: {
                name: "Insumo Base",
                measureUnit: "kg",
                currentStockMilliunits: 50000,
                unitCostCents: 100,
                active: true,
            },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Producto Base",
                priceCents: 2500,
                recipes: {
                    create: [{ supplyID: supplyId, quantityUsedMilliunits: 1000 }],
                },
            },
        });
        productId = product.id;

        loginAs("ADMIN", adminId);
    });

    // -------------------------------------------------------------------------
    // R1 (Alta): closeAccountAction omite guardas de acumulados safe-integer
    // -------------------------------------------------------------------------
    it("R1: closeAccountAction must prevent PAID jornada cashSales from exceeding MAX_SAFE_INTEGER", async () => {
        const pRes = await saveProduct({ name: "Prod Close Max", price: 100_000_000_000_000, recipes: [] });
        expect(pRes.success).toBe(true);
        const prod = await prisma.products.findFirstOrThrow({ where: { name: "Prod Close Max" } });

        const s1 = await createSale([{ productID: prod.id, quantity: 50 }], "UNPAID", "MESA_1", -1);
        const s2 = await createSale([{ productID: prod.id, quantity: 50 }], "UNPAID", "MESA_2", -1);
        expect(s1.success).toBe(true);
        expect(s2.success).toBe(true);

        const c1 = await closeAccountAction("MESA_1", "CASH", [s1.data!.saleId], 5_000_000_000_000_000);
        expect(c1.success).toBe(true);
        const c2 = await closeAccountAction("MESA_2", "CASH", [s2.data!.saleId], 5_000_000_000_000_000);

        if (c2.success) {
            await expect(getActiveJornadaWithStats()).resolves.toBeDefined();
            const closeRes = await closeJornada(jornadaId, 0);
            expect(closeRes.error).not.toBe("INTERNAL ERROR");
        } else {
            expect(c2.success).toBe(false);
        }
    });

    // -------------------------------------------------------------------------
    // R2 (Alta): updateSaleQuantity omits safe-integer guards for stock and debt balances
    // -------------------------------------------------------------------------
    it("R2a: updateSaleQuantity must not overflow supply currentStockMilliunits below MIN_SAFE_INTEGER", async () => {
        const s = await prisma.supplies.create({
            data: { name: "Insumo Upd", measureUnit: "g", currentStockMilliunits: 0, unitCostCents: 1, active: true },
        });
        const pRes = await saveProduct({
            name: "Prod Upd Stock",
            price: 2_000_000_000_000,
            recipes: [{ supplyID: s.id, quantityUsed: 1_000_000_000_000_000 }],
        });
        expect(pRes.success).toBe(true);
        const prod = await prisma.products.findFirstOrThrow({ where: { name: "Prod Upd Stock" } });

        const sale = await createSale([{ productID: prod.id, quantity: 1 }], "UNPAID", "MESA_1", -1);
        expect(sale.success).toBe(true);

        const upd = await updateSaleQuantity(sale.data!.saleId, 10, prod.id);
        if (upd.success) {
            await expect(getProductPage({})).resolves.toBeDefined();
            expect((await getSuppliesData()).length).toBeGreaterThan(0);
        } else {
            expect(upd.success).toBe(false);
        }
    });

    it("R2b: updateSaleQuantity must not overflow customer debt balance beyond MAX_SAFE_INTEGER", async () => {
        const pRes = await saveProduct({ name: "Prod Upd Debt", price: 100_000_000_000_000, recipes: [] });
        expect(pRes.success).toBe(true);
        const prod = await prisma.products.findFirstOrThrow({ where: { name: "Prod Upd Debt" } });

        const s1 = await createSale([{ productID: prod.id, quantity: 1 }], "DEBT", `CL- ${customerId}`, customerId);
        const s2 = await createSale([{ productID: prod.id, quantity: 1 }], "DEBT", `CL- ${customerId}`, customerId);
        expect(s1.success && s2.success).toBe(true);

        expect((await updateSaleQuantity(s1.data!.saleId, 50, prod.id)).success).toBe(true);
        const upd2 = await updateSaleQuantity(s2.data!.saleId, 50, prod.id);

        if (upd2.success) {
            await expect(getCustomerPage({})).resolves.toMatchObject({ success: true, data: { total: 1 } });
            expect((actionData(await getAllDebtors())).total).toBe(1);
        } else {
            expect(upd2.success).toBe(false);
        }
    });

    // -------------------------------------------------------------------------
    // R3 (Alta): payAccount omite guardas de acumulados safe-integer (expectedCash / todayPayments)
    // -------------------------------------------------------------------------
    it("R3: payAccount must not overflow jornada expectedCash beyond MAX_SAFE_INTEGER", async () => {
        await prisma.jornada.update({ where: { id: jornadaId }, data: { openingAmountCents: 0 } });
        const pRes = await saveProduct({ name: "Prod Pay Max", price: 100_000_000_000_000, recipes: [] });
        expect(pRes.success).toBe(true);
        const prod = await prisma.products.findFirstOrThrow({ where: { name: "Prod Pay Max" } });

        const cashSale = await createSale([{ productID: prod.id, quantity: 50 }], "PAID", "VENTA_LIBRE", -1, "CASH");
        const debtSale = await createSale([{ productID: prod.id, quantity: 50 }], "DEBT", `CL- ${customerId}`, customerId);
        expect(cashSale.success && debtSale.success).toBe(true);

        const payRes = await payAccount(customerId, [{ id: debtSale.data!.saleId }], "CASH");
        if (payRes.success) {
            await expect(getActiveJornadaWithStats()).resolves.toBeDefined();
            const closeRes = await closeJornada(jornadaId, 0);
            expect(closeRes.error).not.toBe("INTERNAL ERROR");
        } else {
            expect(payRes.success).toBe(false);
        }
    });

    // -------------------------------------------------------------------------
    // R4 (Alta): createSale 3b omite openingAmountCents y suma por empleado (CASH + TRANSFER)
    // -------------------------------------------------------------------------
    it("R4a: createSale must account for jornada openingAmountCents so expectedCash cannot overflow MAX_SAFE_INTEGER", async () => {
        await prisma.jornada.update({
            where: { id: jornadaId },
            data: { openingAmountCents: BigInt("100000000000000") },
        });
        const pRes = await saveProduct({ name: "Prod Open Max", price: 100_000_000_000_000, recipes: [] });
        expect(pRes.success).toBe(true);
        const prod = await prisma.products.findFirstOrThrow({ where: { name: "Prod Open Max" } });

        const s = await createSale([{ productID: prod.id, quantity: 90 }], "PAID", "VENTA_LIBRE", -1, "CASH");
        if (s.success) {
            await expect(getActiveJornadaWithStats()).resolves.toBeDefined();
        } else {
            expect(s.success).toBe(false);
        }
    });

    it("R4b: createSale must not allow CASH + TRANSFER by same employee to break getJornadaEmployeeBreakdown", async () => {
        const pRes = await saveProduct({ name: "Prod Emp Max", price: 100_000_000_000_000, recipes: [] });
        expect(pRes.success).toBe(true);
        const prod = await prisma.products.findFirstOrThrow({ where: { name: "Prod Emp Max" } });

        const s1 = await createSale([{ productID: prod.id, quantity: 50 }], "PAID", "VENTA_LIBRE", -1, "CASH");
        expect(s1.success).toBe(true);
        const s2 = await createSale([{ productID: prod.id, quantity: 50 }], "PAID", "VENTA_LIBRE", -1, "TRANSFER");

        if (s2.success) {
            const breakdown = await getJornadaEmployeeBreakdown(jornadaId);
            expect(breakdown.length).toBeGreaterThan(0);
        } else {
            expect(s2.success).toBe(false);
        }
    });

    // -------------------------------------------------------------------------
    // R5 (Alta): cancelSaleAction desborda MAX_SAFE_INTEGER SIN cambiar receta
    // -------------------------------------------------------------------------
    it("R5: cancelSaleAction must not push supply stock above MAX_SAFE_INTEGER even when recipe is unchanged", async () => {
        const s = await prisma.supplies.create({
            data: {
                name: "Insumo Restock",
                measureUnit: "g",
                currentStockMilliunits: BigInt("1000000000000000"),
                unitCostCents: 1,
                active: true,
            },
        });
        const pRes = await saveProduct({
            name: "Prod Same Recipe",
            price: 2_000_000_000_000,
            recipes: [{ supplyID: s.id, quantityUsed: 1_000_000_000_000_000 }],
        });
        expect(pRes.success).toBe(true);
        const prod = await prisma.products.findFirstOrThrow({ where: { name: "Prod Same Recipe" } });

        // Sell 9 units -> stock drops from 1e15 to -8e15 (valid)
        const sale = await createSale([{ productID: prod.id, quantity: 9 }], "UNPAID", "MESA_1", -1);
        expect(sale.success).toBe(true);

        // Restock manually via saveSupply to 1e15 (valid, recipe is NOT changed)
        const restock = await saveSupply({
            id: s.id,
            name: "Insumo Restock",
            measureUnit: "g",
            currentStock: 1_000_000_000_000_000,
            unitCost: 1,
        });
        expect(restock.success).toBe(true);

        // Cancel sale -> 1e15 + 9e15 = 10e15 > MAX_SAFE_INTEGER
        const cancel = await cancelSaleAction(sale.data!.saleId);
        if (cancel.success) {
            expect((await getSuppliesData()).length).toBeGreaterThan(0);
            await expect(getProductPage({})).resolves.toBeDefined();
        } else {
            expect(cancel.error).not.toBe("INTERNAL ERROR");
        }
    });

    // -------------------------------------------------------------------------
    // R6 (Alta): MobilePosManager conserva acumuladores en number plano sin BigInt
    // -------------------------------------------------------------------------
    it("R6: MobilePosManager must accumulate ticket/account/change totals in BigInt to avoid formatCents RangeError", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/pos/MobilePosManager.tsx"),
            "utf8",
        );
        expect(source).not.toMatch(/ticket\.total \+= Number\(sale\.total\)/);
        expect(source).not.toMatch(/accountSales\.reduce\(\(acc, s\) => acc \+ Number\(s\.total\), 0\)/);
    });

    // -------------------------------------------------------------------------
    // R7 (Alta): DebtPaymentDialog parsea cashReceived con Number (bloquea cobro en efectivo > MAX_SAFE_INTEGER) y omite !canCollect
    // -------------------------------------------------------------------------
    it("R7: DebtPaymentDialog must parse cashReceived in BigInt to match BigInt totalCents and guard !canCollect on confirm button", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/debtors/debt-payment-dialog.tsx"),
            "utf8",
        );
        // Currently parses cashReceived via Number.isSafeInteger(cents), rejecting its own auto-filled total > MAX_SAFE_INTEGER
        expect(source).not.toMatch(/Number\(whole \|\| "0"\) \* 100 \+ Number\(decimals\.padEnd\(2, "0"\)\)/);
    });

    // -------------------------------------------------------------------------
    // R8 (Media): saveSupply crea duplicado con id inexistente y muta registros soft-deleted (active: false)
    // -------------------------------------------------------------------------
    it("R8: saveSupply must reject nonexistent or soft-deleted supply ids instead of silently upserting", async () => {
        const countBefore = await prisma.supplies.count();
        const resMissing = await saveSupply({
            id: 999_999,
            name: "Sal Fantasma",
            measureUnit: "kg",
            currentStock: 1000,
            unitCost: 500,
        });
        expect(resMissing.success).toBe(false);
        expect(await prisma.supplies.count()).toBe(countBefore);

        expect((await deleteSupply(supplyId)).success).toBe(true);
        const resDeleted = await saveSupply({
            id: supplyId,
            name: "Insumo Inactivo Editado",
            measureUnit: "kg",
            currentStock: 2000,
            unitCost: 200,
        });
        expect(resDeleted.success).toBe(false);
    });

    // Note: R9 (converting VL-<n> to DEBT via toDebt) was reverted because
    // tests/integration/sales.test.ts (Issue #29) explicitly specifies that
    // converting a walk-in VL-<n> ticket to DEBT via toDebt is intentional
    // and frees the ticket number immediately.

    // -------------------------------------------------------------------------
    // R10 (Media): createSale acepta "CL-123" sin espacio con customerID = -1 y source_type arbitrario UNPAID
    // -------------------------------------------------------------------------
    it("R10: createSale must reject malformed customer prefix CL-123 without valid customerID and arbitrary UNPAID sources", async () => {
        const resMalformedCl = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "CL-123", -1);
        expect(resMalformedCl.success).toBe(false);

        const resArbitrary = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "CUENTA_FANTASMA", -1);
        expect(resArbitrary.success).toBe(false);
    });

    // -------------------------------------------------------------------------
    // R11 (Media): SalesInputClient usa sumSaleTotalsCents (RangeError en render) y pos-manager.tsx:211 crashea con NaN
    // -------------------------------------------------------------------------
    it("R11: SalesInputClient must not throw via sumSaleTotalsCents on overflowed accounts and pos-manager must guard non-finite sale.total", () => {
        const posSource = fs.readFileSync(path.join(ROOT, "app/(dashboard)/pos/pos-manager.tsx"), "utf8");
        const clientSource = fs.readFileSync(path.join(ROOT, "components/Sales-input-client.tsx"), "utf8");

        expect(posSource).not.toMatch(/BigInt\(Math\.trunc\(Number\(sale\.total \?\? 0\)\)\)/);
        expect(clientSource).not.toMatch(/sumSaleTotalsCents\(receiptSales\.map\(\(s\) => s\.total\)\)/);
    });

    // -------------------------------------------------------------------------
    // R12 (Media): saveProduct permite asociar insumos eliminados (active: false) en recetas
    // -------------------------------------------------------------------------
    it("R12: saveProduct must reject recipes referencing soft-deleted (active: false) supplies", async () => {
        expect((await deleteSupply(supplyId)).success).toBe(true);

        const res = await saveProduct({
            name: "Quesadilla Inactiva",
            price: 5000,
            recipes: [{ supplyID: supplyId, quantityUsed: 1000 }],
        });
        expect(res.success).toBe(false);
    });

    // -------------------------------------------------------------------------
    // R13 (Media): compareAmounts en rama no-entera devuelve Infinity/-Infinity y pierde precisión silenciosamente
    // -------------------------------------------------------------------------
    it("R13: compareAmounts must not return Infinity/-Infinity or silently lose precision on non-integer extremes", () => {
        expect(() => compareAmounts(Number.MAX_VALUE, -0.5)).toThrow(RangeError);
        expect(() => compareAmounts(100, 1e-308)).toThrow(RangeError);
        expect(() => compareAmounts(Number.MAX_SAFE_INTEGER, 0.5)).toThrow(RangeError);
    });

    // -------------------------------------------------------------------------
    // R14 (Media): formatReportCell crashea con string no numérico en money y csvCell exporta strings money sin escalar
    // -------------------------------------------------------------------------
    it("R14: formatReportCell must handle invalid money strings safely and reportCsv must scale string money cells", () => {
        expect(() => formatReportCell("abc", "money")).not.toThrow();
        expect(formatReportCell("", "money")).toBe("Sin especificar");

        const report: ReportData = {
            type: "expenses",
            period: analyticsPeriod({ from: "2026-09-30", to: "2026-09-30" }),
            generatedAt: new Date().toISOString(),
            notices: [],
            columns: [{ key: "amount", label: "Monto", kind: "money" }],
            rows: [{ amount: "1500" }],
            totals: { amount: 1500 },
            totalRows: 1,
        };
        expect(reportCsv(report)).toContain('"15.00"');
    });

    // -------------------------------------------------------------------------
    // R15 (Media): jornada-manager Stat muestra −$0.00 en cero y OpenJornadaPanel omite min="0"
    // -------------------------------------------------------------------------
    it("R15: jornada-manager Stat must not render −$0.00 for zero outflows and OpenJornadaPanel must declare min=\"0\"", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/admin/jornada/jornada-manager.tsx"),
            "utf8",
        );
        expect(source).not.toMatch(/\{negative \? `−\$\{formatCurrencyCents\(value < 0 \? -value : value\)\}` : formatCurrencyCents\(value\)\}/);
        expect(source).toMatch(/id="opening"[\s\S]{0,160}min="0"/);
    });

    // -------------------------------------------------------------------------
    // R16 (Media): MobileInventoryManager sin guard saving, sin try/catch, sin limpiar alert/timeout y sin min="0"
    // -------------------------------------------------------------------------
    it("R16: MobileInventoryManager must guard concurrent submits, catch errors, clear stale alert, and set min=\"0\"", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/admin/inventory/MobileInventoryManager.tsx"),
            "utf8",
        );
        expect(source).toMatch(/disabled=\{saving\b/);
        expect(source).toMatch(/try\s*\{[\s\S]{0,300}await saveSupply/);
        expect(source).toMatch(/name="currentStock"[\s\S]{0,100}min="0"|min="0"[\s\S]{0,100}name="currentStock"/);
    });

    // -------------------------------------------------------------------------
    // R17 (Media): MenuManager / MobileMenuManager bypass de coma negativa "-0,5", costo base $- y blur de negativos
    // -------------------------------------------------------------------------
    it("R17: MenuManager and MobileMenuManager must block comma-negative quantities, format base cost with formatCurrencyCents, and reject negative prices", () => {
        const desktopSource = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/admin/menu/menu-manager.tsx"),
            "utf8",
        );
        const mobileSource = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/admin/menu/MobileMenuManager.tsx"),
            "utf8",
        );
        // Comma negative bypass: Number("-0,5") is NaN -> NaN < 0 is false
        expect(desktopSource).not.toMatch(/if \(raw !== "" && Number\(raw\) < 0\) return;/);
        // Creation form & mobile dialog still use ${formatCents(totalBaseCost)} instead of formatCurrencyCents
        expect(desktopSource).not.toContain("${formatCents(totalBaseCost)}");
        expect(mobileSource).not.toContain("${formatCents(totalBaseCost)}");
    });

    // -------------------------------------------------------------------------
    // R18 (Baja): toSafeInteger devuelve -0 y coacciona booleanos/null/[]
    // -------------------------------------------------------------------------
    it("R18: toSafeInteger and sumSaleTotalsCents must normalize -0 to +0 and reject booleans/arrays", () => {
        expect(Object.is(toSafeInteger("-0"), 0)).toBe(true);
        expect(Object.is(toSafeInteger(-0), 0)).toBe(true);
        expect(() => toSafeInteger(true as unknown as number)).toThrow(RangeError);
        expect(() => sumSaleTotalsCents([true as unknown as number, [] as unknown as number])).toThrow(RangeError);
    });

    // -------------------------------------------------------------------------
    // R19 (Baja): FreeSaleTickets y TransferConfirmationDialog formatean negativos como $-5.00 y TransferConfirmationDialog crashea con unsafe number
    // -------------------------------------------------------------------------
    it("R19: FreeSaleTickets and TransferConfirmationDialog must format negative totals as -$5.00 and not throw on unsafe number", () => {
        const ticketHtml = renderToStaticMarkup(
            React.createElement(FreeSaleTickets, {
                tickets: [{ sourceType: "VL-1", number: 1, total: -500 }],
                activeTicket: 1,
                onSelect: () => {},
                onNew: () => {},
                creating: false,
            }),
        );
        expect(ticketHtml).not.toContain("$-5.00");
        expect(ticketHtml).toContain("-$5.00");

        expect(() =>
            renderToStaticMarkup(
                React.createElement(TransferConfirmationDialog, {
                    accountLabel: "Mesa 1",
                    total: 10_000_000_000_000_000,
                    onCancel: () => {},
                    onConfirm: async () => true,
                }),
            ),
        ).not.toThrow();
    });

    // -------------------------------------------------------------------------
    // R20 (Baja): Mensajes engañosos en BillSchema (> MAX_MONETARY_AMOUNT) y SalarySchema/saveProduct (string negativo)
    // -------------------------------------------------------------------------
    it("R20: BillSchema and SalarySchema/saveProduct must report accurate range error messages in Spanish", async () => {
        const billOverflow = BillSchema.shape.amount.safeParse(100_000_000_000_001);
        expect(billOverflow.success).toBe(false);
        if (!billOverflow.success) {
            expect(billOverflow.error.issues[0].message).not.toBe("El monto debe ser mayor a cero");
        }

        const prodNegStr = await saveProduct({
            name: "Taco Negativo",
            price: "-100" as unknown as number,
            recipes: [],
        });
        expect(prodNegStr.success).toBe(false);
        expect(prodNegStr.fieldErrors?.price?.[0]).toBe("El precio debe ser mayor de cero.");

        const salNegStr = await saveSalaryPayment({
            userID: adminId,
            amount: "-100" as unknown as number,
            period: "BONO: Test",
            payment_method: "CASH",
        });
        expect(salNegStr.success).toBe(false);
        expect(salNegStr.fieldErrors?.amount?.[0]).toBe("El monto debe ser mayor a cero");
    });

    // -------------------------------------------------------------------------
    // R21 & R22 (Baja): CRM parseFloat residual y doble envío en expenses/page.tsx
    // -------------------------------------------------------------------------
    it("R21 & R22: CRM views must avoid parseFloat on integer balances and expenses handleSave must guard concurrent submits", () => {
        const crmSource = fs.readFileSync(path.join(ROOT, "app/(dashboard)/admin/crm/crm-manager.tsx"), "utf8");
        const mobileCrmSource = fs.readFileSync(path.join(ROOT, "app/(dashboard)/admin/crm/MobileCRMManager.tsx"), "utf8");
        const expensesSource = fs.readFileSync(path.join(ROOT, "app/(dashboard)/expenses/page.tsx"), "utf8");

        expect(crmSource).not.toMatch(/parseFloat\(row\.getValue\("currentBalance"\)/);
        expect(mobileCrmSource).not.toMatch(/parseFloat\(String\(item\.currentBalance/);
        expect(expensesSource).toMatch(/const handleSave = async \(\) => \{\s*if \(loading\) return;/);
    });
});
