import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});

import prisma from "@/lib/prisma";
import { getCurrentAuthorization } from "@/lib/server-permissions";
import { getRecipeSupplyPage, getSupplyPage, saveSupply } from "@/lib/actions/inventory";
import { saveCustomer } from "@/lib/actions/customers";
import { saveProduct } from "@/lib/actions/products";
import { getExpenses, saveExpense } from "@/lib/actions/expenses";
import { openJornada, closeJornada, getActiveJornadaWithStats } from "@/lib/actions/jornada";
import { DEFAULT_ROLE_PERMISSIONS, isConfigurable } from "@/lib/permissions";
import { getReportExport } from "@/lib/actions/analytics";
import { getPoolBalance } from "@/lib/actions/savings";
import { cancelSaleAction, updateSaleQuantity } from "@/lib/actions/sales";
import { getRolePermissions, saveRolePermissions } from "@/lib/actions/security";
import { loginAs, resetDb, seedBase } from "./helpers";

describe("central role permissions", () => {
    beforeAll(async () => {
        await prisma.$connect();
    });
    beforeEach(async () => {
        await resetDb();
    });
    afterEach(() => vi.restoreAllMocks());

    it("starts from the plan defaults and keeps owner-only controls fixed", () => {
        expect(DEFAULT_ROLE_PERMISSIONS.SUPERVISOR["sales.create"]).toBe(true);
        expect(DEFAULT_ROLE_PERMISSIONS.SUPERVISOR["reports.operational"]).toBe(true);
        expect(DEFAULT_ROLE_PERMISSIONS.STAFF["jornada.open"]).toBe(false);
        expect(DEFAULT_ROLE_PERMISSIONS.STAFF["jornada.reconcile"]).toBe(true);
        expect(isConfigurable("SUPERVISOR", "inventory.manage")).toBe(true);
        expect(isConfigurable("STAFF", "jornada.open")).toBe(true);
        expect(isConfigurable("STAFF", "reports.operational")).toBe(false);
        expect(isConfigurable("SUPERVISOR", "sales.manageDebt")).toBe(false);
        expect(isConfigurable("SUPERVISOR", "savings.manage")).toBe(false);
    });

    it("applies a role permission change on the next server request", async () => {
        loginAs("SUPERVISOR", 41);
        expect((await getCurrentAuthorization())?.permissions["inventory.manage"]).toBe(false);

        await prisma.rolePermission.create({ data: { role: "SUPERVISOR", capability: "inventory.manage", enabled: true } });
        expect((await getCurrentAuthorization())?.permissions["inventory.manage"]).toBe(true);

        // A persisted row cannot grant a capability outside the role's policy.
        await prisma.rolePermission.create({ data: { role: "SUPERVISOR", capability: "sales.manageDebt", enabled: true } });
        expect((await getCurrentAuthorization())?.permissions["sales.manageDebt"]).toBe(false);
    });

    it.each(["SUPERVISOR", "STAFF"] as const)("keeps baseline sales access fixed for %s even with a stale permission override", async (role) => {
        const { admin } = await seedBase();
        const operator = await prisma.users.create({ data: { name: "Baseline Operator", role, active: true } });
        loginAs("ADMIN", admin.id);
        expect(isConfigurable(role, "sales.create")).toBe(false);
        expect(await saveRolePermissions(role, { "sales.create": false })).toMatchObject({ success: false });
        expect(await prisma.rolePermission.count()).toBe(0);
        await prisma.rolePermission.create({ data: { role, capability: "sales.create", enabled: false } });
        expect(await getRolePermissions(role)).toMatchObject({ success: true, data: { "sales.create": true } });
        loginAs(role, operator.id);
        expect((await getCurrentAuthorization())?.permissions["sales.create"]).toBe(true);
    });

    it("blocks STAFF operational reports and keeps private savings totals out of their response", async () => {
        const staff = await prisma.users.create({ data: { name: "Staff test", role: "STAFF", active: true } });
        loginAs("STAFF", staff.id);
        const report = await getReportExport({ type: "sales", from: "2026-11-01", to: "2026-11-01" });
        expect(report.success).toBe(false);

        await prisma.savings_movement.create({ data: { amountCents: BigInt(2000), type: "DEPOSIT", registered_by: staff.id } });
        expect(await getPoolBalance()).toEqual({ balance: 0, deposited: 0, withdrawn: 0 });
    });
    it("keeps catalog, inventory and customer grants independent and revokes writes immediately", async () => {
        await seedBase();
        const staff = await prisma.users.create({ data: { name: "Supervisor Person", role: "SUPERVISOR", active: true } });
        loginAs("SUPERVISOR", staff.id);
        const supply = { name: "Recipe Flour", measureUnit: "kg", currentStock: 1000, unitCost: 500 };
        const product = { name: "New Product", price: 1000, recipes: [] };
        expect(await saveSupply(supply)).toMatchObject({ success: false });
        expect(await saveProduct(product)).toMatchObject({ success: false });
        expect(await saveCustomer({ customerName: "New Customer" })).toMatchObject({ success: false });
        expect(await prisma.supplies.count()).toBe(0);
        expect(await prisma.products.count()).toBe(0);
        expect(await prisma.customer.count()).toBe(0);
        await prisma.rolePermission.create({ data: { role: "SUPERVISOR", capability: "catalog.manage", enabled: true } });
        expect(await saveProduct(product)).toMatchObject({ success: true });
        expect(await getRecipeSupplyPage()).toMatchObject({ success: true });
        expect(await getSupplyPage()).toMatchObject({ success: false });
        expect(await saveSupply(supply)).toMatchObject({ success: false });
        await prisma.rolePermission.create({ data: { role: "SUPERVISOR", capability: "inventory.manage", enabled: true } });
        expect(await saveSupply(supply)).toMatchObject({ success: true });
        expect(await saveCustomer({ customerName: "New Customer" })).toMatchObject({ success: false });
        await prisma.rolePermission.create({ data: { role: "SUPERVISOR", capability: "customers.manage", enabled: true } });
        expect(await saveCustomer({ customerName: "New Customer" })).toMatchObject({ success: true });
        await prisma.rolePermission.updateMany({ where: { role: "SUPERVISOR" }, data: { enabled: false } });
        expect(await saveProduct({ ...product, name: "Denied Product" })).toMatchObject({ success: false });
        expect(await saveSupply({ ...supply, name: "Denied Supply" })).toMatchObject({ success: false });
        expect(await saveCustomer({ customerName: "Denied Customer" })).toMatchObject({ success: false });
        expect(await prisma.products.count()).toBe(1);
        expect(await prisma.supplies.count()).toBe(1);
        expect(await prisma.customer.count()).toBe(1);
    });

    it("delegates shift opening and closing independently without revealing expected cash to STAFF", async () => {
        const { jornada } = await seedBase();
        const staff = await prisma.users.create({ data: { name: "Service Person", role: "STAFF", active: true } });
        loginAs("STAFF", staff.id);
        expect(await closeJornada(jornada.id, 0)).toMatchObject({ success: false });
        await prisma.rolePermission.create({ data: { role: "STAFF", capability: "jornada.close", enabled: true } });
        expect(await getActiveJornadaWithStats()).toBeNull();
        expect(await closeJornada(jornada.id, 0)).toMatchObject({ success: true });
        expect(await openJornada(0)).toMatchObject({ success: false });
        await prisma.rolePermission.create({ data: { role: "STAFF", capability: "jornada.open", enabled: true } });
        expect(await openJornada(0)).toMatchObject({ success: true });
        expect(await getActiveJornadaWithStats()).toBeNull();
    });

    it("lets STAFF record and review their expenses without exposing other operators' expenses", async () => {
        const { admin, jornada } = await seedBase();
        await prisma.bill.create({ data: { amountCents: 1000, category: "Private", registered_by: admin.id, jornadaId: jornada.id, payment_method: "CASH" } });
        const staff = await prisma.users.create({ data: { name: "Expense Person", role: "STAFF", active: true } });
        loginAs("STAFF", staff.id);
        expect(await saveExpense({ amount: 100, category: "Own", description: "Own expense", date: new Date(), payment_method: "CASH" })).toMatchObject({ success: true });
        const result = await getExpenses();
        expect(result).toMatchObject({ success: true, data: { total: 1, summary: { totalAmount: 100 } } });
        if (result.success) expect(result.data.items.every(item => item.registered_by === staff.id)).toBe(true);
    });

    it.each(["SUPERVISOR", "STAFF"] as const)("prevents %s from changing existing debt sales without changing balances or items", async (role) => {
        const { admin, jornada } = await seedBase();
        const operator = await prisma.users.create({ data: { name: "Debt Operator", role, active: true } });
        const customer = await prisma.customer.create({ data: { customerName: "Debt Customer", currentBalanceCents: 1000 } });
        const product = await prisma.products.create({ data: { name: "Debt Product", priceCents: 1000 } });
        const sale = await prisma.sales.create({ data: {
            placedBy: admin.id, jornadaId: jornada.id, customerID: customer.id, status: "DEBT", totalCents: 1000,
            sale_items: { create: { productID: product.id, quantity: 1, unitPriceCents: 1000, subtotalCents: 1000 } },
            debtors: { create: { customerID: customer.id, amountCents: 1000, status: "DEBT", createdJornadaId: jornada.id } },
        } });
        const before = await prisma.sales.findUnique({ where: { id: sale.id }, include: { sale_items: true, debtors: true } });
        loginAs(role, operator.id);
        expect(await cancelSaleAction(sale.id)).toMatchObject({ success: false, error: "UNAUTHORIZED" });
        expect(await updateSaleQuantity(sale.id, 2, product.id)).toMatchObject({ success: false, error: "UNAUTHORIZED" });
        expect(await prisma.sales.findUnique({ where: { id: sale.id }, include: { sale_items: true, debtors: true } })).toEqual(before);
        expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).currentBalanceCents).toBe(BigInt(1000));
    });

    it.each(["ADMIN", "SUPERVISOR", "STAFF"] as const)("keeps paid sales immutable for %s", async (role) => {
        const { admin, jornada } = await seedBase();
        const operator = role === "ADMIN" ? admin : await prisma.users.create({ data: { name: "Paid Operator", role, active: true } });
        const product = await prisma.products.create({ data: { name: "Paid Product", priceCents: 1000 } });
        const sale = await prisma.sales.create({ data: {
            placedBy: admin.id, jornadaId: jornada.id, status: "PAID", payment_method: "CASH", totalCents: 1000,
            sale_items: { create: { productID: product.id, quantity: 1, unitPriceCents: 1000, subtotalCents: 1000 } },
        } });
        const before = await prisma.sales.findUnique({ where: { id: sale.id }, include: { sale_items: true } });
        loginAs(role, operator.id);
        expect(await cancelSaleAction(sale.id)).toMatchObject({ success: false, error: "CANNOT_CANCEL_PAID_SALE" });
        expect(await updateSaleQuantity(sale.id, 2, product.id)).toMatchObject({ success: false, error: "CANNOT_MODIFY_PAID_SALE" });
        expect(await prisma.sales.findUnique({ where: { id: sale.id }, include: { sale_items: true } })).toEqual(before);
    });

});

// These tests call server actions directly; navigation visibility cannot satisfy them.
