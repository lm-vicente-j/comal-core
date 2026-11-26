import { expect, it } from "vitest";
import fc from "fast-check";
import { parseCashCountInput, CASH_DENOMINATIONS, MAX_CASH_COUNT_CENTS } from "@/lib/cash-count";
import { parseCashInputToCents } from "@/lib/cash-change";
import { checkGenerated } from "../helpers/generators";

it("cash-count-unknown-input", async () => {
    await checkGenerated("cash-count-unknown-input", fc.property(fc.anything({ withBigInt: true }), raw => {
        const result = parseCashCountInput(raw);
        expect(typeof result.ok).toBe("boolean");
        if (result.ok) {
            expect(Number.isSafeInteger(result.total)).toBe(true);
            expect(result.total).toBeGreaterThanOrEqual(0);
            expect(result.total).toBeLessThanOrEqual(MAX_CASH_COUNT_CENTS);
            for (const row of result.data.denominations) {
                expect(CASH_DENOMINATIONS).toContainEqual({ kind: row.kind, valueCents: row.valueCents });
            }
        } else expect(["INVALID_INPUT", "CONFIRM_EMPTY_REQUIRED"]).toContain(result.error);
    }));
});

it("cash-text-boundaries", async () => {
    await checkGenerated("cash-text-boundaries", fc.property(fc.string({ maxLength: 1000 }), raw => {
        const result = parseCashInputToCents(raw);
        if (result === null || Number.isNaN(result)) return;
        expect(Number.isSafeInteger(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(0);
        // Decimal parsing oracle uses integers, independently of the implementation's Number arithmetic.
        const [whole = "0", fraction = ""] = raw.trim().replace(",", ".").split(".");
        expect(BigInt(result)).toBe(BigInt(whole || "0") * BigInt(100) + BigInt(fraction.padEnd(2, "0")));
    }));
});

it("cash-count-rejects-removed-denominations", async () => {
    await checkGenerated("cash-count-rejects-removed-denominations", fc.property(fc.constantFrom(5, 10, 20, 51, Number.MAX_SAFE_INTEGER), fc.nat(), (valueCents, quantity) => {
        expect(parseCashCountInput({ requestId: "00000000-0000-4000-8000-000000000060", denominations: [{ kind: "COIN", valueCents, quantity }], confirmEmpty: true })).toEqual({ ok: false, error: "INVALID_INPUT" });
    }));
});


it("cash-count-overflow-and-structured-mutations", async () => {
    const requestId = "00000000-0000-4000-8000-000000000060";
    const invalidRow = fc.oneof(
        fc.integer({ min: 1_000_000_001, max: 2_000_000_000 }).map(quantity => ({ kind: "BILL", valueCents: 100000, quantity })),
        fc.constantFrom(NaN, Infinity, -1, 0.5, "1", null, undefined).map(quantity => ({ kind: "COIN", valueCents: 50, quantity })),
    );
    await checkGenerated("cash-count-overflow-and-structured-mutations", fc.property(invalidRow, row => {
        expect(parseCashCountInput({ requestId, denominations: [row], confirmEmpty: true })).toEqual({ ok: false, error: "INVALID_INPUT" });
    }));
    const row = { kind: "COIN", valueCents: 50, quantity: 1 };
    for (const patch of [
        { denominations: [row, row] }, { requestId: "bad-uuid" }, { requestId: null },
        { note: "X".repeat(1001) }, { note: 1 }, { recountOfId: 2_147_483_648 },
        { confirmEmpty: "true" }, { extra: true },
    ]) expect(parseCashCountInput({ requestId, denominations: [row], ...patch })).toEqual({ ok: false, error: "INVALID_INPUT" });
});
