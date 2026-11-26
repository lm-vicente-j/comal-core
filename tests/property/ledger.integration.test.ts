import { expect, it, vi } from "vitest";
import fc from "fast-check";

vi.mock("@/lib/auth", async () => ({ auth: (await import("../helpers/database")).authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { createSale } from "@/lib/actions/sales";
import { saveExpense } from "@/lib/actions/expenses";
import { saveSalaryPayment } from "@/lib/actions/payrolls";
import { saveMovement } from "@/lib/actions/savings";
import { closeJornada } from "@/lib/actions/jornada";
import { getJornadaCashSummary } from "@/lib/jornada-cash";
import { checkGenerated, paymentMethod } from "../helpers/generators";
import { loginAs, resetDb, seedBase, makeCashCountInput } from "../helpers/database";

it("jornada-ledger-conserves-cash-and-transfer", async () => {
    const movement = fc.record({
        kind: fc.constantFrom("sale", "expense", "salary", "deposit"),
        amount: fc.integer({ min: 1, max: 1000 }), method: paymentMethod,
    });
    await checkGenerated("jornada-ledger-conserves-cash-and-transfer", fc.asyncProperty(fc.array(movement, { minLength: 1, maxLength: 12 }), async movements => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        loginAs("ADMIN", admin.id);
        const model = { cash: BigInt(50000), transfer: BigInt(0), pool: BigInt(0) };
        for (const step of movements) {
            const method = step.kind === "deposit" ? "CASH" : step.method;
            const side = method === "CASH" ? "cash" : "transfer";
            if (step.kind === "sale") {
                const product = await prisma.products.create({ data: { name: `Generated ${await prisma.products.count()}`, priceCents: step.amount } });
                expect(await createSale([{ productID: product.id, quantity: 1 }], "PAID", "VENTA_LIBRE", -1, method)).toMatchObject({ success: true });
                model[side] += BigInt(step.amount);
            } else {
                const result = step.kind === "expense"
                    ? await saveExpense({ amount: step.amount, category: "Generated", description: "Property expense", date: new Date(), payment_method: method })
                    : step.kind === "salary"
                        ? await saveSalaryPayment({ userID: admin.id, amount: step.amount, period: "SUELDO: Property", payment_method: method })
                        : await saveMovement(step.amount, "DEPOSIT", "Property deposit");
                expect(result).toMatchObject({ success: true });
                model[side] -= BigInt(step.amount);
                if (step.kind === "deposit") model.pool += BigInt(step.amount);
            }
            const cash = await getJornadaCashSummary(jornada.id, 50000);
            expect(BigInt(cash.expectedCash)).toBe(model.cash);
            expect(BigInt(cash.expectedTransfer)).toBe(model.transfer);
            const pool = await prisma.savings_movement.aggregate({ _sum: { amountCents: true } });
            expect(pool._sum.amountCents ?? BigInt(0)).toBe(model.pool);
        }
        const counted = Math.floor(Number(model.cash) / 50) * 50;
        expect(await closeJornada(jornada.id, makeCashCountInput(counted, "Generated physical closing"))).toMatchObject({ success: true });
        const closing = await prisma.cash_count.findFirstOrThrow({ where: { jornadaId: jornada.id, type: "CLOSING" } });
        expect(closing.expectedAmountCents).toBe(model.cash);
        expect(closing.countedAmountCents).toBe(BigInt(counted));
        expect(closing.differenceCents).toBe(BigInt(counted) - model.cash);
    }), true);
}, 600_000);
