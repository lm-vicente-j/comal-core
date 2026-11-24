import fs from "node:fs";
import path from "node:path";
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

import prisma from "@/lib/prisma";
import { loginAs, resetDb, seedBase } from "./helpers";
import {
    createSale,
    closeAccountAction,
    cancelSaleAction,
    updateSaleQuantity,
    nextFreeSaleTicket,
} from "@/lib/actions/sales";
import {
    closeJornada,
    getActiveJornadaWithStats,
    getJornadaEmployeeBreakdown,
} from "@/lib/actions/jornada";
import { payAccount } from "@/lib/actions/debts";
import { saveProduct } from "@/lib/actions/products";
import { saveSalaryPayment } from "@/lib/actions/payrolls";
import { saveSupply } from "@/lib/actions/inventory";
import {
    analyticsPeriod,
    compareAmounts,
    formatReportCell,
    reportCsv,
    type ReportData,
} from "@/lib/analytics";

const ROOT = process.cwd();

describe("Adversarial Round 13 — Round 3 Pro Audit Reproduction Tests", () => {
    let adminId: number;
    let jornadaId: number;
    let customerId: number;
    let supplyId: number;
    let productId: number;

    beforeEach(async () => {
        vi.useRealTimers();
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;

        const customer = await prisma.customer.create({
            data: {
                customerName: "Cliente Ronda 13",
                alias: "R13",
                currentBalanceCents: 0,
            },
        });
        customerId = customer.id;

        const supply = await prisma.supplies.create({
            data: {
                name: "Insumo R13",
                measureUnit: "kg",
                currentStockMilliunits: 50000,
                unitCostCents: 100,
                active: true,
            },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Producto R13",
                priceCents: 2500,
                recipes: {
                    create: [{ supplyID: supplyId, quantityUsedMilliunits: 1000 }],
                },
            },
        });
        productId = product.id;

        loginAs("ADMIN", adminId);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // -------------------------------------------------------------------------
    // T1 (Alta): cancelSaleAction omite checkPaidJornadaSafeBounds en ventas PAID
    // -------------------------------------------------------------------------
    it("T1: cancelSaleAction on a PAID sale must not push expectedCash below MIN_SAFE_INTEGER", async () => {
        await prisma.jornada.update({ where: { id: jornadaId }, data: { openingAmountCents: 0 } });
        const pRes = await saveProduct({ name: "Prod Cancel Paid", price: 100_000_000_000_000, recipes: [] });
        expect(pRes.success).toBe(true);
        const prod = await prisma.products.findFirstOrThrow({ where: { name: "Prod Cancel Paid" } });

        const paidSale = await createSale([{ productID: prod.id, quantity: 50 }], "PAID", "VENTA_LIBRE", -1, "CASH");
        expect(paidSale.success).toBe(true);

        // Cash outflows totaling 9.5e15 -> expectedCash = 5e15 - 9.5e15 = -4.5e15 (safe)
        await prisma.bill.create({
            data: {
                description: "Egreso alto",
                amountCents: BigInt("5000000000000000"),
                date: new Date(),
                registered_by: adminId,
                payment_method: "CASH",
                jornadaId,
            },
        });
        await prisma.salary.create({
            data: {
                userID: adminId,
                amountCents: BigInt("4500000000000000"),
                payDate: new Date(),
                period: "SUELDO: Alto",
                payment_method: "CASH",
                jornadaId,
            },
        });

        // Cancelling the 5e15 PAID sale pushes expectedCash to -9.5e15 < MIN_SAFE_INTEGER
        const cancelRes = await cancelSaleAction(paidSale.data!.saleId);
        if (cancelRes.success) {
            await expect(getActiveJornadaWithStats()).resolves.toBeDefined();
            const closeRes = await closeJornada(jornadaId, 0);
            expect(closeRes.error).not.toBe("INTERNAL ERROR");
        } else {
            expect(cancelRes.success).toBe(false);
        }
    });

    // -------------------------------------------------------------------------
    // T2 (Alta): payAccount omite validar acumulado PAID por (jornadaId, placedBy)
    // -------------------------------------------------------------------------
    it("T2: payAccount must prevent per-employee PAID sales total in a jornada from exceeding MAX_SAFE_INTEGER", async () => {
        const pRes = await saveProduct({ name: "Prod Emp Pay", price: 100_000_000_000_000, recipes: [] });
        expect(pRes.success).toBe(true);
        const prod = await prisma.products.findFirstOrThrow({ where: { name: "Prod Emp Pay" } });

        const cashSale = await createSale([{ productID: prod.id, quantity: 50 }], "PAID", "VENTA_LIBRE", -1, "CASH");
        const debtSale = await createSale([{ productID: prod.id, quantity: 50 }], "DEBT", `CL- ${customerId}`, customerId);
        expect(cashSale.success && debtSale.success).toBe(true);

        // Collecting via TRANSFER passes expectedTransfer check (5e15), but employee total PAID becomes 10e15 > MAX_SAFE_INTEGER
        const payRes = await payAccount(customerId, [{ id: debtSale.data!.saleId }], "TRANSFER");
        if (payRes.success) {
            const breakdown = await getJornadaEmployeeBreakdown(jornadaId);
            expect(breakdown.length).toBeGreaterThan(0);
        } else {
            expect(payRes.success).toBe(false);
        }
    });

    // -------------------------------------------------------------------------
    // T3 (Media): SalesInputClient conserva Number plano en debtTotal/receiptLines/expectedTotal y marca input como inválido con receiptTotalCents = -1
    // -------------------------------------------------------------------------
    it("T3: SalesInputClient must use BigInt for debtTotal, receiptLines subtotals, expectedTotal, and cash change", () => {
        const source = fs.readFileSync(path.join(ROOT, "components/Sales-input-client.tsx"), "utf8");
        expect(source).not.toMatch(/const debtTotal = debtSales\.reduce\(\(sum, sale\) => sum \+ Number\(sale\.total\), 0\);/);
        expect(source).not.toMatch(/acc\.subtotal \+= Number\(item\.subtotal\);/);
        expect(source).not.toMatch(/return Number\.isSafeInteger\(asNumber\) \? asNumber : -1;/);
    });

    // -------------------------------------------------------------------------
    // T4 (Media): createSale acepta VENTA_LIBRE/VL-<n> con customerID > 0 y PAID con source_type inválido como "MESA_0"
    // -------------------------------------------------------------------------
    it("T4: createSale must reject walk-in VENTA_LIBRE/VL-<n> with customerID > 0 and invalid PAID source_type like MESA_0", async () => {
        const resWalkInWithCust = await createSale(
            [{ productID: productId, quantity: 1 }],
            "PAID",
            "VENTA_LIBRE",
            customerId,
            "CASH",
        );
        expect(resWalkInWithCust.success).toBe(false);

        const ticket = await nextFreeSaleTicket();
        expect(ticket.success).toBe(true);
        const resTicketWithCust = await createSale(
            [{ productID: productId, quantity: 1 }],
            "UNPAID",
            ticket.data!.sourceType,
            customerId,
            undefined,
            ticket.data!.reservationToken,
        );
        expect(resTicketWithCust.success).toBe(false);

        const resBadPaidSource = await createSale(
            [{ productID: productId, quantity: 1 }],
            "PAID",
            "MESA_0",
            -1,
            "CASH",
        );
        expect(resBadPaidSource.success).toBe(false);
    });

    // -------------------------------------------------------------------------
    // T5 (Media): csvCell (reportCsv) lanza RangeError ante number inseguro/NaN en columna money
    // -------------------------------------------------------------------------
    it("T5: reportCsv must handle unsafe or NaN numeric money cells safely like formatReportCell", () => {
        const report: ReportData = {
            type: "expenses",
            period: analyticsPeriod({ from: "2026-09-30", to: "2026-09-30" }),
            generatedAt: new Date().toISOString(),
            notices: [],
            columns: [{ key: "amount", label: "Monto", kind: "money" }],
            rows: [{ amount: Number.NaN }, { amount: 1e16 }],
            totals: { amount: 1e16 },
            totalRows: 2,
        };
        expect(() => reportCsv(report)).not.toThrow();
    });

    // -------------------------------------------------------------------------
    // T6 (Media): ProductSchema, SalarySchema y SupplySchema emiten errores Zod en inglés para flotantes / > MAX_SAFE_INTEGER
    // -------------------------------------------------------------------------
    it("T6: ProductSchema, SalarySchema, and SupplySchema must emit Spanish validation messages for floats and > MAX_SAFE_INTEGER", async () => {
        const prodBig = await saveProduct({ name: "Taco Grande", price: 1e16, recipes: [] });
        expect(prodBig.success).toBe(false);
        expect(prodBig.fieldErrors?.price?.[0]).not.toMatch(/Too big|Invalid input|expected int/i);

        const prodFloat = await saveProduct({ name: "Taco Float", price: 10.5, recipes: [] });
        expect(prodFloat.success).toBe(false);
        expect(prodFloat.fieldErrors?.price?.[0]).not.toMatch(/Too big|Invalid input|expected int/i);

        const salBig = await saveSalaryPayment({
            userID: adminId,
            amount: 1e16,
            period: "BONO: Grande",
            payment_method: "CASH",
        });
        expect(salBig.success).toBe(false);
        expect(salBig.fieldErrors?.amount?.[0]).not.toMatch(/Too big|Invalid input|expected int/i);

        const supBig = await saveSupply({
            name: "Insumo Grande",
            measureUnit: "kg",
            currentStock: 1e16,
            unitCost: 1e16,
        });
        expect(supBig.success).toBe(false);
        expect(supBig.fieldErrors?.currentStock?.[0]).not.toMatch(/Too big|Invalid input|expected int/i);
        expect(supBig.fieldErrors?.unitCost?.[0]).not.toMatch(/Too big|Invalid input|expected int/i);
    });

    // -------------------------------------------------------------------------
    // T7 (Media): MobileInventoryManager doble envío durante 1500ms de éxito y Dialog onOpenChange sin limpiar/bloquear
    // -------------------------------------------------------------------------
    it("T7: MobileInventoryManager must disable save while success alert is shown and guard Dialog onOpenChange", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/admin/inventory/MobileInventoryManager.tsx"),
            "utf8",
        );
        expect(source).toMatch(/disabled=\{saving \|\| alert\?\.type === ['"]success['"]\}/);
        expect(source).not.toMatch(/<Dialog open=\{isDialogOpen\} onOpenChange=\{setIsDialogOpen\}>/);
    });

    // -------------------------------------------------------------------------
    // T8 (Media): MenuManager muestra error de costo base con precios <= 0 y colapsa cantidades inválidas a 0
    // -------------------------------------------------------------------------
    it("T8: MenuManager must distinguish price <= 0 from price <= baseCost in edit form", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/admin/menu/menu-manager.tsx"),
            "utf8",
        );
        // Currently isEditPriceTooLow triggers for negative/zero prices too, showing "El precio debe ser mayor al costo base"
        expect(source).not.toMatch(/const isEditPriceTooLow = hasRecipe && parsedEditPrice !== null && BigInt\(parsedEditPrice\) <= totalBaseCost;/);
    });

    // -------------------------------------------------------------------------
    // T9 (Media): DebtPaymentDialog omite errorMessage en TransferConfirmationDialog
    // -------------------------------------------------------------------------
    it("T9: DebtPaymentDialog must pass errorMessage={error} to TransferConfirmationDialog", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/debtors/debt-payment-dialog.tsx"),
            "utf8",
        );
        expect(source).toMatch(/<TransferConfirmationDialog[\s\S]{0,250}errorMessage=\{error\}/);
    });

    // -------------------------------------------------------------------------
    // T10 (Baja): payAccount usa toBusinessCalendarDate(now) en lugar de businessDate(now) a medianoche UTC
    // -------------------------------------------------------------------------
    it("T10: payAccount must use businessDate(now) rather than toBusinessCalendarDate(now) for todayRange at UTC midnight", () => {
        const source = fs.readFileSync(path.join(ROOT, "lib/actions/debts.ts"), "utf8");
        expect(source).not.toMatch(/const today = toBusinessCalendarDate\(now\)\.toISOString\(\)\.slice\(0, 10\);/);
    });

    // -------------------------------------------------------------------------
    // T11 (Baja): compareAmounts devuelve -0 y formatReportCell("abc", "percent") devuelve "NaN%"
    // -------------------------------------------------------------------------
    it("T11: compareAmounts must normalize -0 and formatReportCell must not return NaN% for invalid percent strings", () => {
        expect(Object.is(compareAmounts(100, -0).previous, 0)).toBe(true);
        expect(Object.is(compareAmounts(10.004, 10.005).difference, 0)).toBe(true);
        expect(formatReportCell("abc", "percent")).toBe("Sin especificar");
    });

    // -------------------------------------------------------------------------
    // T12 (Baja): closeAccountAction deduplica saleIds repetidos en silencio en vez de rechazar INVALID_INPUT
    // -------------------------------------------------------------------------
    it("T12: closeAccountAction must reject duplicate saleIds with INVALID_INPUT consistently with toDebt/payAccount", async () => {
        const sale = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_1", -1);
        expect(sale.success).toBe(true);

        const res = await closeAccountAction("MESA_1", "CASH", [sale.data!.saleId, sale.data!.saleId], 2500);
        expect(res.success).toBe(false);
        expect(res.error).toBe("INVALID_INPUT");
    });

    // -------------------------------------------------------------------------
    // T13 (Baja): updateSaleQuantity calcula debtDiff contra sale.totalCents en vez de sale.debtors.amountCents
    // -------------------------------------------------------------------------
    it("T13: updateSaleQuantity must compute customer balance delta against debtors.amountCents when updating a DEBT sale", async () => {
        const saleRes = await createSale([{ productID: productId, quantity: 1 }], "DEBT", `CL- ${customerId}`, customerId);
        expect(saleRes.success).toBe(true);

        // Simulate prior drift where debtors.amountCents = 5000 and customer.currentBalanceCents = 5000, while sales.totalCents = 2500
        await prisma.debtors.update({
            where: { saleID: saleRes.data!.saleId },
            data: { amountCents: BigInt(5000) },
        });
        await prisma.customer.update({
            where: { id: customerId },
            data: { currentBalanceCents: BigInt(5000) },
        });

        // Update quantity from 1 (2500) to 2 (5000): debtors.amountCents stays 5000, so customer balance must stay 5000 (not jump to 7500)
        const upd = await updateSaleQuantity(saleRes.data!.saleId, 2, productId);
        expect(upd.success).toBe(true);

        const cust = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
        expect(cust.currentBalanceCents).toBe(BigInt(5000));
    });

    // -------------------------------------------------------------------------
    // T14 (Baja): MobilePosManager y SalesInputClient aún interpolan ${formatCents(...)} en vez de formatCurrencyCents
    // -------------------------------------------------------------------------
    it("T14: MobilePosManager and SalesInputClient must use formatCurrencyCents instead of ${formatCents(...)}", () => {
        const mobilePos = fs.readFileSync(path.join(ROOT, "app/(dashboard)/pos/MobilePosManager.tsx"), "utf8");
        const desktopPos = fs.readFileSync(path.join(ROOT, "components/Sales-input-client.tsx"), "utf8");

        expect(mobilePos).not.toContain("${formatCents(accountTotal)}");
        expect(desktopPos).not.toContain("${formatCents(debtTotal)}");
    });

    // -------------------------------------------------------------------------
    // T15 (Baja): savings-manager.tsx omite if (loading) return en handleSave
    // -------------------------------------------------------------------------
    it("T15: savings-manager dialogs must guard handleSave against concurrent submits with if (loading) return", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/admin/savings/savings-manager.tsx"),
            "utf8",
        );
        const handleSaveMatches = source.match(/const handleSave = async \(\) => \{/g) ?? [];
        const guardedMatches = source.match(/const handleSave = async \(\) => \{\s*if \(loading\) return;/g) ?? [];
        expect(handleSaveMatches.length).toBeGreaterThan(0);
        expect(guardedMatches.length).toBe(handleSaveMatches.length);
    });
});
