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

import prisma from "@/lib/prisma";
import { actionData, loginAs, resetDb, seedBase } from "./helpers";
import { createSale } from "@/lib/actions/sales";
import { closeJornada, getActiveJornadaWithStats } from "@/lib/actions/jornada";
import { getCustomerPage } from "@/lib/actions/customers";
import { getAllDebtors, getDebtsSummary, toDebt } from "@/lib/actions/debts";
import { saveSupply, getSuppliesData } from "@/lib/actions/inventory";
import { saveProduct, getProductPage, getProductsData } from "@/lib/actions/products";
import { saveSalaryPayment } from "@/lib/actions/payrolls";
import { parseCents, parseMilliunits, formatCents } from "@/lib/scaled-values";
import { sumSaleTotalsCents } from "@/lib/cash-change";
import { compareAmounts } from "@/lib/analytics";
import JornadaBanner from "@/components/layout/jornada-banner";
import FreeSaleTickets from "@/components/FreeSaleTickets";

const ROOT = process.cwd();

describe("Adversarial Round 11 — Commit cc105321669b829a7e7d865af9e1787882c1098c (cents & milliunits)", () => {
    let adminId: number;
    let staffId: number;
    let jornadaId: number;
    let customerId: number;
    let supplyId: number;
    let productId: number;

    beforeEach(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;

        const staff = await prisma.users.create({
            data: {
                name: "Staff Prueba",
                username: "STAFF11",
                role: "STAFF",
                active: true,
            },
        });
        staffId = staff.id;

        const customer = await prisma.customer.create({
            data: {
                customerName: "Cliente Base",
                alias: "Base",
                currentBalanceCents: 0,
            },
        });
        customerId = customer.id;

        const supply = await prisma.supplies.create({
            data: {
                name: "Masa",
                measureUnit: "kg",
                currentStockMilliunits: 50000,
                unitCostCents: 100,
                active: true,
            },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Taco Base",
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
    // C1a (Alta): Acumulados de ventas en jornada desbordan MAX_SAFE_INTEGER
    // -------------------------------------------------------------------------
    it("C1a: valid sales must not overflow jornada aggregates into RangeError / unclosable shift", async () => {
        const prodRes = await saveProduct({
            name: "Producto Alto",
            price: 100_000_000_000_000, // MAX_MONETARY_AMOUNT (valid in ProductSchema)
            recipes: [],
        });
        expect(prodRes.success).toBe(true);
        const prod = await prisma.products.findFirstOrThrow({ where: { name: "Producto Alto" } });

        const s1 = await createSale([{ productID: prod.id, quantity: 50 }], "PAID", "VENTA_LIBRE", -1, "CASH");
        expect(s1.success).toBe(true);
        const s2 = await createSale([{ productID: prod.id, quantity: 50 }], "PAID", "VENTA_LIBRE", -1, "CASH");

        // Either the second write is rejected before overflowing safe-integer aggregates,
        // or reading/closing the jornada must continue working without RangeError / INTERNAL ERROR.
        if (s2.success) {
            await expect(getActiveJornadaWithStats()).resolves.toBeDefined();
            const closeRes = await closeJornada(jornadaId, 0);
            expect(closeRes.error).not.toBe("INTERNAL ERROR");
        } else {
            expect(s2.success).toBe(false);
        }
    });

    // -------------------------------------------------------------------------
    // C1b (Alta): Acumulados de deuda (customer.currentBalanceCents) desbordan MAX_SAFE_INTEGER
    // -------------------------------------------------------------------------
    it("C1b: valid DEBT sales must not overflow customer balance and break CRM / Debtors", async () => {
        const prodRes = await saveProduct({
            name: "Producto Deuda",
            price: 100_000_000_000_000,
            recipes: [],
        });
        expect(prodRes.success).toBe(true);
        const prod = await prisma.products.findFirstOrThrow({ where: { name: "Producto Deuda" } });

        const s1 = await createSale([{ productID: prod.id, quantity: 50 }], "DEBT", `CL-${customerId}`, customerId);
        expect(s1.success).toBe(true);
        const s2 = await createSale([{ productID: prod.id, quantity: 50 }], "DEBT", `CL-${customerId}`, customerId);

        if (s2.success) {
            await expect(getCustomerPage({})).resolves.toMatchObject({ success: true, data: { total: 1 } });
            const debtors = actionData(await getAllDebtors());
            expect(debtors.total).toBe(1);
            const summary = await getDebtsSummary();
            expect(summary.activeDebtors).toBe(1);
        } else {
            expect(s2.success).toBe(false);
        }
    });

    // -------------------------------------------------------------------------
    // C1c (Alta): Acumulados de stock negativo desbordan MIN_SAFE_INTEGER
    // -------------------------------------------------------------------------
    it("C1c: valid sales with max recipe quantityUsed must not break /admin/menu, /pos, and /admin/inventory", async () => {
        const cheapSupply = await prisma.supplies.create({
            data: {
                name: "Insumo Limite",
                measureUnit: "g",
                currentStockMilliunits: 0,
                unitCostCents: 1,
                active: true,
            },
        });
        const prodRes = await saveProduct({
            name: "Producto Receta Max",
            price: 2_000_000_000_000, // > baseCost (1_000_000_000_000) and <= MAX_MONETARY_AMOUNT
            recipes: [{ supplyID: cheapSupply.id, quantityUsed: 1_000_000_000_000_000 }],
        });
        expect(prodRes.success).toBe(true);
        const prod = await prisma.products.findFirstOrThrow({ where: { name: "Producto Receta Max" } });

        const s1 = await createSale([{ productID: prod.id, quantity: 9 }], "PAID", "VENTA_LIBRE", -1, "CASH");
        expect(s1.success).toBe(true);
        const s2 = await createSale([{ productID: prod.id, quantity: 1 }], "PAID", "VENTA_LIBRE", -1, "CASH");

        if (s2.success) {
            await expect(getProductPage({})).resolves.toBeDefined();
            const supplies = await getSuppliesData();
            expect(supplies.length).toBeGreaterThan(0);
            const products = await getProductsData();
            expect(products.length).toBeGreaterThan(0);
        } else {
            expect(s2.success).toBe(false);
        }
    });

    // Note: C2a & C2b (cancelSaleAction using edited recipe to restore stock) were discarded
    // because they are already tracked by open GitHub issue #30 ("29. Restore original
    // ingredient consumption on cancellation").

    // -------------------------------------------------------------------------
    // C3a (Alta): saveSupply(null) lanza TypeError no capturado
    // -------------------------------------------------------------------------
    it("C3a: saveSupply(null) must return actionFail instead of throwing uncaught TypeError", async () => {
        const res = await saveSupply(null as never);
        expect(res.success).toBe(false);
    });

    // -------------------------------------------------------------------------
    // C3b (Alta): saveSupply coacciona "", null, false, [], true y "50.00" vía Number()
    // -------------------------------------------------------------------------
    it("C3b: saveSupply must reject empty string, null, booleans, arrays, and decimal strings instead of coercing", async () => {
        const resEmptyStock = await saveSupply({
            id: supplyId,
            name: "Masa",
            measureUnit: "kg",
            unitCost: 100,
            currentStock: "" as unknown as number,
        });
        expect(resEmptyStock.success).toBe(false);

        const persisted = await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } });
        expect(persisted.currentStockMilliunits).toBe(BigInt(50000));

        const resBoolCost = await saveSupply({
            name: "Sal Bool",
            measureUnit: "kg",
            unitCost: true as unknown as number,
            currentStock: false as unknown as number,
        });
        expect(resBoolCost.success).toBe(false);

        const resDecimalString = await saveSupply({
            name: "Sal Decimal",
            measureUnit: "kg",
            unitCost: "50.00" as unknown as number,
            currentStock: "10.000" as unknown as number,
        });
        expect(resDecimalString.success).toBe(false);
    });

    // -------------------------------------------------------------------------
    // C4a (Alta): SupplySchema carece de .max() en currentStock y unitCost
    // -------------------------------------------------------------------------
    it("C4a: saveSupply must enforce sane upper bounds on currentStock and unitCost", async () => {
        const res = await saveSupply({
            name: "Insumo Extremo",
            measureUnit: "kg",
            currentStock: Number.MAX_SAFE_INTEGER,
            unitCost: Number.MAX_SAFE_INTEGER,
        });
        expect(res.success).toBe(false);
    });

    // -------------------------------------------------------------------------
    // C4b (Alta): SupplySchema permite id <= 0 (crea nuevo), id > INT4_MAX (INTERNAL ERROR), y name/measureUnit sin trim/max
    // -------------------------------------------------------------------------
    it("C4b: saveSupply must validate positive INT4 id and trimmed VarChar(40)/VarChar(30) name/measureUnit", async () => {
        const countBefore = await prisma.supplies.count();

        const resNegId = await saveSupply({
            id: -5,
            name: "   ",
            measureUnit: "   ",
            currentStock: 0,
            unitCost: 100,
        });
        expect(resNegId.success).toBe(false);
        expect(await prisma.supplies.count()).toBe(countBefore);

        const resBigId = await saveSupply({
            id: 2_147_483_648,
            name: "Harina",
            measureUnit: "kg",
            currentStock: 0,
            unitCost: 100,
        });
        expect(resBigId.success).toBe(false);
        expect(resBigId.error).toBe("Datos inválidos");

        const resLongName = await saveSupply({
            name: "A".repeat(45),
            measureUnit: "B".repeat(35),
            currentStock: 0,
            unitCost: 100,
        });
        expect(resLongName.success).toBe(false);
        expect(resLongName.fieldErrors?.name).toBeDefined();
        expect(resLongName.fieldErrors?.measureUnit).toBeDefined();
    });

    // -------------------------------------------------------------------------
    // C5 (Alta): Crash RangeError en CloseJornadaDialog (jornada-manager.tsx:257-259, 311)
    // -------------------------------------------------------------------------
    it("C5: CloseJornadaDialog must guard negative input and compute diff with BigInt so formatCents cannot throw RangeError", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/admin/jornada/jornada-manager.tsx"),
            "utf8",
        );

        // Demonstrate the exact expression currently in CloseJornadaDialog throws RangeError:
        const expectedCash = 10000;
        const actualCents = parseCents("-90071992547409.91");
        expect(actualCents).toBe(-9007199254740991);
        const rawDiff = (actualCents ?? 0) - expectedCash;
        expect(() => formatCents(rawDiff)).toThrow(RangeError);

        // The component must NOT compute diff in plain JS number or allow negative actualCents into hasDiff:
        expect(source).not.toMatch(/const diff = \(actualCents \?\? 0\) - expectedCash;/);
        expect(source).not.toMatch(/const hasDiff = actualCents !== null;/);
    });

    // -------------------------------------------------------------------------
    // C6 (Media): JornadaBanner crashea en formatCents(cashBills + cashSalaries)
    // -------------------------------------------------------------------------
    it("C6: JornadaBanner must not throw RangeError when cashBills + cashSalaries exceeds MAX_SAFE_INTEGER", async () => {
        await prisma.jornada.update({
            where: { id: jornadaId },
            data: { openingAmountCents: 0 },
        });
        await prisma.sales.create({
            data: {
                totalCents: BigInt("6000000000000000"),
                status: "PAID",
                source_type: "VENTA_LIBRE",
                placedBy: adminId,
                payment_method: "CASH",
                jornadaId,
            },
        });
        await prisma.sales.create({
            data: {
                totalCents: BigInt("4000000000000000"),
                status: "PAID",
                source_type: `CL-${customerId}`,
                customerID: customerId,
                placedBy: adminId,
                payment_method: "CASH",
                jornadaId,
                debtors: {
                    create: {
                        customerID: customerId,
                        amountCents: BigInt("4000000000000000"),
                        status: "PAID",
                        createdJornadaId: jornadaId,
                        paidJornadaId: jornadaId,
                        paidAt: new Date(),
                        collectedBy: adminId,
                    },
                },
            },
        });
        await prisma.bill.create({
            data: {
                description: "Gasto masivo",
                amountCents: BigInt("5000000000000000"),
                date: new Date(),
                registered_by: adminId,
                payment_method: "CASH",
                jornadaId,
            },
        });
        await prisma.salary.create({
            data: {
                userID: staffId,
                amountCents: BigInt("5000000000000000"),
                payDate: new Date(),
                period: "SUELDO: Prueba",
                payment_method: "CASH",
                jornadaId,
            },
        });

        // getActiveJornadaWithStats succeeds (expectedCash === 0), so JornadaBanner must render cleanly too
        const stats = await getActiveJornadaWithStats();
        expect(stats?.state).toBe("OWN_OPEN");

        const element = await JornadaBanner();
        expect(element).not.toBeNull();
        expect(renderToStaticMarkup(element!)).toContain("100000000000000.00");
    });

    // -------------------------------------------------------------------------
    // C7 (Media): SalarySchema y saveProduct aceptan strings decimales/hex como centavos (100x menos)
    // -------------------------------------------------------------------------
    it("C7: saveSalaryPayment and saveProduct must reject decimal/hex/scientific string amounts", async () => {
        const salDecimal = await saveSalaryPayment({
            userID: staffId,
            amount: "500.00" as unknown as number,
            period: "SUELDO: Quincena",
            payment_method: "CASH",
        });
        expect(salDecimal.success).toBe(false);

        const salHex = await saveSalaryPayment({
            userID: staffId,
            amount: "0x64" as unknown as number,
            period: "SUELDO: Hex",
            payment_method: "CASH",
        });
        expect(salHex.success).toBe(false);

        const prodDecimal = await saveProduct({
            name: "Taco Decimal",
            price: "50.00" as unknown as number,
            recipes: [],
        });
        expect(prodDecimal.success).toBe(false);

        const prodSci = await saveProduct({
            name: "Taco Cientifico",
            price: "1e2" as unknown as number,
            recipes: [],
        });
        expect(prodSci.success).toBe(false);
    });

    // -------------------------------------------------------------------------
    // C8 (Media): menu-manager.tsx handleInputBlur trunca "12,50" -> "12" y pierde precisión con parseFloat
    // -------------------------------------------------------------------------
    it("C8: menu-manager handleInputBlur must not truncate comma decimals or lose precision via parseFloat", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/admin/menu/menu-manager.tsx"),
            "utf8",
        );

        // Confirm parseCents accepts both inputs while parseFloat corrupts them
        expect(parseCents("12,50")).toBe(1250);
        expect(parseFloat("12,50").toString()).toBe("12");
        expect(parseCents("90071992547409.91")).toBe(9007199254740991);
        expect(parseFloat("90071992547409.91").toString()).toBe("90071992547409.9");

        expect(source).not.toMatch(/parseFloat\(value\)\.toString\(\)/);
    });

    // -------------------------------------------------------------------------
    // C9 (Media): Formato erróneo de moneda negativa ($-50.00 en vez de -$50.00)
    // -------------------------------------------------------------------------
    it("C9: negative currency values must render as -$50.00 instead of $-50.00", async () => {
        await prisma.jornada.update({
            where: { id: jornadaId },
            data: { openingAmountCents: 0 },
        });
        await prisma.bill.create({
            data: {
                description: "Compra urgente",
                amountCents: BigInt(5000),
                date: new Date(),
                registered_by: adminId,
                payment_method: "CASH",
                jornadaId,
            },
        });

        const element = await JornadaBanner();
        const html = renderToStaticMarkup(element!);

        expect(html).not.toContain("$-50.00");
        expect(html).toContain("-$50.00");
    });

    // -------------------------------------------------------------------------
    // C10 (Media): toDebt devuelve "INTERNAL ERROR" en vez de "SALES_CHANGED" si total > MAX_SAFE_INTEGER
    // -------------------------------------------------------------------------
    it("C10: toDebt must return SALES_CHANGED rather than INTERNAL ERROR when DB unpaid sum exceeds MAX_SAFE_INTEGER", async () => {
        const s1 = await prisma.sales.create({
            data: {
                totalCents: BigInt("5000000000000000"),
                status: "UNPAID",
                source_type: `CL-${customerId}`,
                customerID: customerId,
                placedBy: adminId,
                jornadaId,
            },
        });
        const s2 = await prisma.sales.create({
            data: {
                totalCents: BigInt("5000000000000000"),
                status: "UNPAID",
                source_type: `CL-${customerId}`,
                customerID: customerId,
                placedBy: adminId,
                jornadaId,
            },
        });

        const res = await toDebt(
            customerId,
            [{ id: s1.id }, { id: s2.id }],
            5_000_000_000_000_000,
        );
        expect(res.success).toBe(false);
        expect(res.error).toBe("SALES_CHANGED");
    });

    // -------------------------------------------------------------------------
    // C11 (Media): FreeSaleTickets / clientes POS crashean al formatear totales sumados > MAX_SAFE_INTEGER
    // -------------------------------------------------------------------------
    it("C11: FreeSaleTickets must not crash with RangeError when a ticket total exceeds MAX_SAFE_INTEGER", () => {
        const overflowedTotal = 5_000_000_000_000_000 + 5_000_000_000_000_000;
        expect(() =>
            renderToStaticMarkup(
                React.createElement(FreeSaleTickets, {
                    tickets: [{ sourceType: "VL-1", number: 1, total: overflowedTotal }],
                    activeTicket: 1,
                    onSelect: () => {},
                    onNew: () => {},
                    creating: false,
                }),
            ),
        ).not.toThrow();
    });

    // -------------------------------------------------------------------------
    // C12 (Baja): menu-manager.tsx coacciona >2 decimales a 0 y muestra error engañoso de costo base
    // -------------------------------------------------------------------------
    it("C12: menu-manager must distinguish unparseable >2-decimal price from price <= baseCost", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/admin/menu/menu-manager.tsx"),
            "utf8",
        );

        // Coercing null to 0 causes "55.555" to report "El precio debe ser mayor al costo base"
        // and disables the submit button before handleSave can show the format error.
        expect(source).not.toMatch(/const editSalePrice = parseCents\(formData\.price\) \?\? 0;/);
    });

    // -------------------------------------------------------------------------
    // C13 (Baja): MobileInventoryManager nunca renderiza errors.currentStock ni errors.unitCost
    // -------------------------------------------------------------------------
    it("C13: MobileInventoryManager must render field errors for currentStock and unitCost", () => {
        const source = fs.readFileSync(
            path.join(ROOT, "app/(dashboard)/admin/inventory/MobileInventoryManager.tsx"),
            "utf8",
        );

        expect(source).toMatch(/errors\.currentStock/);
        expect(source).toMatch(/errors\.unitCost/);
    });

    // -------------------------------------------------------------------------
    // C14 (Baja): sumSaleTotalsCents y compareAmounts conservan aritmética flotante sin guarda safe integer
    // -------------------------------------------------------------------------
    it("C14: sumSaleTotalsCents must reject non-integer/unsafe inputs and compareAmounts must not lose precision", () => {
        expect(() => sumSaleTotalsCents(["10.50"])).toThrow();
        expect(() => sumSaleTotalsCents([5_000_000_000_000_000, 5_000_000_000_000_000])).toThrow();

        expect(() => compareAmounts(Number.MAX_SAFE_INTEGER, -100)).toThrow(RangeError);
    });

    // -------------------------------------------------------------------------
    // C15 (Baja): Falta step="0.01" en inputs numéricos de monto en /expenses y /admin/roster
    // -------------------------------------------------------------------------
    it("C15: monetary number inputs in expenses and roster pages must declare step=\"0.01\"", () => {
        const expensesSource = fs.readFileSync(path.join(ROOT, "app/(dashboard)/expenses/page.tsx"), "utf8");
        const rosterSource = fs.readFileSync(path.join(ROOT, "app/(dashboard)/admin/roster/page.tsx"), "utf8");

        expect(expensesSource).toMatch(/type="number"[\s\S]{0,120}step="0\.01"/);
        expect(rosterSource).toMatch(/type="number"[\s\S]{0,120}step="0\.01"/);
    });

    // -------------------------------------------------------------------------
    // C16a (Baja): parseCents("-0") / parseCents("-0.00") / parseMilliunits("-0.000") devuelven -0
    // -------------------------------------------------------------------------
    it("C16a: parseCents and parseMilliunits must normalize negative zero to +0", () => {
        expect(Object.is(parseCents("-0"), 0)).toBe(true);
        expect(Object.is(parseCents("-0.00"), 0)).toBe(true);
        expect(Object.is(parseMilliunits("-0.000"), 0)).toBe(true);
    });
});
