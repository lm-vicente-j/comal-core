import { expect, it, vi } from "vitest";
import fc from "fast-check";

vi.mock("@/lib/auth", async () => ({ auth: (await import("../helpers/database")).authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { createSale, cancelSaleAction, updateSaleQuantity, closeAccountAction } from "@/lib/actions/sales";
import { toDebt, payAccount } from "@/lib/actions/debts";
import { openJornada, recordCashCount, closeJornada } from "@/lib/actions/jornada";
import { saveSupply } from "@/lib/actions/inventory";
import { saveProduct } from "@/lib/actions/products";
import { saveCustomer } from "@/lib/actions/customers";
import { saveExpense } from "@/lib/actions/expenses";
import { saveSalaryPayment } from "@/lib/actions/payrolls";
import { saveMovement } from "@/lib/actions/savings";
import { loginAs, resetDb, seedBase, makeCashCountInput } from "../helpers/database";
import { checkGenerated, invalidId, invalidNumber } from "../helpers/generators";
import { domainSnapshot } from "../helpers/domain-snapshot";

type Fixture = { admin: number; jornada: number; product: number; sale: number; customer: number; supply: number };
// Deliberately cross the TypeScript boundary: server actions receive untrusted runtime values.
type Adapter = { name: string; values: fc.Arbitrary<unknown>; error: string; run: (value: never, f: Fixture) => Promise<{ success: boolean; error?: string }> };
const invalidCount = fc.oneof(
    invalidId.map(value => ({
        requestId: "00000000-0000-4000-8000-000000000060",
        denominations: [{ kind: "COIN", valueCents: 50, quantity: typeof value === "number" && value >= 0 ? -Math.max(1, value) : value }],
        confirmEmpty: true,
    })),
    fc.constantFrom({ requestId: "bad-uuid", denominations: [] }, { requestId: "00000000-0000-4000-8000-000000000060", denominations: [{ kind: "BILL", valueCents: 100000, quantity: 1_000_000_001 }] }),
);
const adapters: Adapter[] = [
    { name: "opening-count-payload", values: invalidCount, error: "INVALID_INPUT", run: v => openJornada(v) },
    { name: "interim-count-payload", values: invalidCount, error: "INVALID_INPUT", run: (v, f) => recordCashCount(f.jornada, v) },
    { name: "closing-count-payload", values: invalidCount, error: "INVALID_INPUT", run: (v, f) => closeJornada(f.jornada, v) },
    { name: "sale-quantity", values: invalidId, error: "INVALID_INPUT", run: (v, f) => createSale([{ productID: f.product, quantity: v }], "UNPAID", "MESA_1", -1) },
    { name: "sale-status", values: fc.constantFrom(null, undefined, "CANCELLED", "paid", "", [], {}), error: "INVALID_INPUT", run: (v, f) => createSale([{ productID: f.product, quantity: 1 }], v, "MESA_1", -1) },
    { name: "sale-source", values: fc.oneof(fc.constantFrom(null, undefined, "", [], {}), fc.string({ minLength: 31, maxLength: 100 }).map(text => `X${text}X`)), error: "INVALID_INPUT", run: (v, f) => createSale([{ productID: f.product, quantity: 1 }], "UNPAID", v, -1) },
    { name: "sale-customer", values: invalidId, error: "INVALID_INPUT", run: (v, f) => createSale([{ productID: f.product, quantity: 1 }], "UNPAID", `CL- ${f.customer}`, v) },
    { name: "sale-method", values: fc.constantFrom(null, "cash", "", [], {}, 1), error: "INVALID_INPUT", run: (v, f) => createSale([{ productID: f.product, quantity: 1 }], "UNPAID", "MESA_1", -1, v) },
    { name: "debt-sale-array", values: fc.constantFrom(null, undefined, [], {}, [{ id: -1 }], [{ id: 0.5 }]), error: "INVALID_INPUT", run: (v, f) => toDebt(f.customer, v, 2500) },
    { name: "collection-sale-array", values: fc.constantFrom(null, undefined, [], {}, [{ id: -1 }], [{ id: 0.5 }]), error: "INVALID_INPUT", run: (v, f) => payAccount(f.customer, v, "CASH") },
    { name: "collection-method", values: fc.constantFrom(null, undefined, "cash", "", [], {}), error: "INVALID_INPUT", run: (v, f) => payAccount(f.customer, [{ id: f.sale }], v) },
    { name: "sale-items", values: fc.constantFrom(null, undefined, {}, [], [{ productID: -1, quantity: 1 }], [{ productID: 1, quantity: Infinity }]), error: "INVALID_INPUT", run: (v) => createSale(v, "UNPAID", "MESA_1", -1) },
    { name: "sale-cancel-id", values: invalidId, error: "INVALID_INPUT", run: v => cancelSaleAction(v) },
    { name: "sale-edit-id", values: invalidId, error: "INVALID_INPUT", run: (v, f) => updateSaleQuantity(v, 2, f.product) },
    { name: "account-total", values: fc.constantFrom(null, "25", NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1), error: "INVALID_INPUT", run: (v, f) => closeAccountAction("MESA_1", "CASH", [f.sale], v) },
    { name: "debt-customer", values: invalidId, error: "INVALID_INPUT", run: (v, f) => toDebt(v, [{ id: f.sale }], 2500) },
    { name: "collection-customer", values: invalidId, error: "INVALID_INPUT", run: (v, f) => payAccount(v, [{ id: f.sale }], "CASH") },
    { name: "opening-input", values: fc.constantFrom(null, undefined, [], {}, { denominations: [] }), error: "INVALID_INPUT", run: v => openJornada(v) },
    { name: "count-jornada", values: invalidId, error: "INVALID_INPUT", run: v => recordCashCount(v, makeCashCountInput(50000)) },
    { name: "closing-jornada", values: invalidId, error: "INVALID_INPUT", run: v => closeJornada(v, makeCashCountInput(50000)) },
    { name: "supply-cost", values: invalidNumber, error: "Datos inválidos", run: (v, f) => saveSupply({ id: f.supply, name: "Fuzz supply", measureUnit: "kg", currentStock: 1000, unitCost: v }) },
    { name: "product-price", values: invalidNumber, error: "Datos inválidos", run: (v, f) => saveProduct({ id: f.product, name: "Fuzz product", price: v }) },
    { name: "recipe-quantity", values: invalidNumber.map(value => value === 100_000_000_000_001 ? 1_000_000_000_000_001 : value), error: "Datos inválidos", run: (v, f) => saveProduct({ id: f.product, name: "Fuzz product", price: 2500, recipes: [{ supplyID: f.supply, quantityUsed: v }] }) },
    { name: "customer-name", values: fc.oneof(fc.constantFrom(null, undefined, [], {}, 123, "", "  "), fc.string({ minLength: 101, maxLength: 200 }).map(text => `X${text}X`)), error: "Datos inválidos", run: (v, f) => saveCustomer({ id: f.customer, customerName: v }) },
    { name: "expense-amount", values: invalidNumber, error: "Datos inválidos", run: v => saveExpense({ amount: v, category: "Fuzz", description: "Fuzz", date: new Date(), payment_method: "CASH" }) },
    { name: "salary-amount", values: invalidNumber, error: "Datos inválidos", run: (v, f) => saveSalaryPayment({ userID: f.admin, amount: v, period: "SUELDO: Fuzz", payment_method: "CASH" }) },
    { name: "savings-amount", values: invalidNumber, error: "Monto inválido", run: v => saveMovement(v, "DEPOSIT", "Fuzz") },
];

for (const adapter of adapters) {
    it(`fuzz-${adapter.name}`, async () => {
        await checkGenerated(`fuzz-${adapter.name}`, fc.asyncProperty(adapter.values, async value => {
            await resetDb();
            const { admin, jornada } = await seedBase();
            loginAs("ADMIN", admin.id);
            const customer = await prisma.customer.create({ data: { customerName: "Fuzz customer", currentBalanceCents: 0 } });
            const supply = await prisma.supplies.create({ data: { name: "Fuzz supply", measureUnit: "kg", currentStockMilliunits: 1000, unitCostCents: 50 } });
            const product = await prisma.products.create({ data: { name: "Fuzz product", priceCents: 2500 } });
            const created = await createSale([{ productID: product.id, quantity: 1 }], "UNPAID", "MESA_1", -1);
            expect(created.success).toBe(true);
            if (!created.success) throw new Error(created.error);
            const before = await domainSnapshot();
            const result = await adapter.run(value as never, { admin: admin.id, jornada: jornada.id, product: product.id, sale: created.data.saleId, customer: customer.id, supply: supply.id });
            expect(result).toMatchObject({ success: false, error: adapter.error });
            expect(await domainSnapshot()).toEqual(before);
        }), true);
    }, 600_000);
}

it("fuzz-valid-controls-persist-exact-values", async () => {
    await resetDb();
    const { admin } = await seedBase();
    loginAs("ADMIN", admin.id);
    expect(await saveCustomer({ customerName: "Cliente Ñandú 测试", alias: "Unicode" })).toMatchObject({ success: true });
    expect(await saveSupply({ name: "Valid supply", measureUnit: "kg", currentStock: 1000, unitCost: 50 })).toMatchObject({ success: true });
    const supply = await prisma.supplies.findFirstOrThrow();
    expect(await saveProduct({ name: "Valid recipe", price: 2500, recipes: [{ supplyID: supply.id, quantityUsed: 125 }] })).toMatchObject({ success: true });
    expect((await prisma.recipes.findFirstOrThrow()).quantityUsedMilliunits).toBe(BigInt(125));
    expect(await saveExpense({ amount: 1, category: "Valid", description: "Valid", date: new Date(), payment_method: "CASH" })).toMatchObject({ success: true });
    expect((await prisma.bill.findFirstOrThrow()).amountCents).toBe(BigInt(1));
});
