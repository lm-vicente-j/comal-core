import { expect, it } from "vitest";
import fc from "fast-check";
import { allocateCents, recipeCostCents, roundHalfEven } from "@/lib/monetary";
import { formatCents, parseCents, formatMilliunits, parseMilliunits, toSafeInteger } from "@/lib/scaled-values";
import { calculateCashChange } from "@/lib/cash-change";
import { parseCashCountInput } from "@/lib/cash-count";
import { checkGenerated, cents, denominations, recipe } from "../helpers/generators";

it("scaled-values-roundtrip", async () => {
    await checkGenerated("scaled-values-roundtrip", fc.property(fc.maxSafeInteger(), value => {
        expect(parseCents(formatCents(value))).toBe(value);
        expect(parseMilliunits(formatMilliunits(value))).toBe(value);
        expect(toSafeInteger(BigInt(value))).toBe(value);
    }));
});

it("allocation-conserves-cents", async () => {
    await checkGenerated("allocation-conserves-cents", fc.property(fc.maxSafeInteger(), fc.array(fc.integer({ min: 1, max: 10000 }), { minLength: 1, maxLength: 12 }), (amount, weights) => {
        const shares = allocateCents(BigInt(amount), weights.map(BigInt));
        expect(shares.reduce((sum, value) => sum + value, BigInt(0))).toBe(BigInt(amount));
        const denominator = weights.reduce((sum, value) => sum + BigInt(value), BigInt(0));
        shares.forEach((share, i) => {
            const distance = share * denominator - BigInt(amount) * BigInt(weights[i]);
            expect(distance < BigInt(0) ? -distance : distance).toBeLessThanOrEqual(denominator);
        });
    }));
});

it("recipe-cost-exact-rounding", async () => {
    await checkGenerated("recipe-cost-exact-rounding", fc.property(recipe, ingredients => {
        const numerator = ingredients.reduce((sum, row) => sum + BigInt(row.unitCost) * BigInt(row.quantityUsed), BigInt(0));
        const rounded = recipeCostCents(ingredients);
        // Independent nearest-integer oracle: enumerate the only two candidates.
        const low = numerator / BigInt(1000);
        const high = low + BigInt(1);
        const lowError = numerator - low * BigInt(1000);
        const highError = high * BigInt(1000) - numerator;
        const expected = lowError < highError ? low : lowError > highError ? high : low % BigInt(2) === BigInt(0) ? low : high;
        expect(rounded).toBe(expected);
        expect(recipeCostCents([...ingredients].reverse())).toBe(expected);
        expect(roundHalfEven(-numerator, BigInt(1000))).toBe(-expected);
    }));
});

it("cash-change-conserves-received", async () => {
    await checkGenerated("cash-change-conserves-received", fc.property(cents, cents, (received, total) => {
        const change = calculateCashChange(formatCents(received), total);
        expect(BigInt(change.changeCents!) + BigInt(total)).toBe(BigInt(received));
        expect(change.status).toBe(received < total ? "insufficient" : received === total ? "exact" : "change");
    }));
});

it("cash-denominations-total-and-retry-identity", async () => {
    await checkGenerated("cash-denominations-total-and-retry-identity", fc.property(denominations, fc.uuid(), (rows, requestId) => {
        const input = { requestId, denominations: rows, confirmEmpty: true };
        const result = parseCashCountInput(input);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(BigInt(result.total)).toBe(rows.reduce((sum, row) => sum + BigInt(row.valueCents) * BigInt(row.quantity), BigInt(0)));
        const upper = parseCashCountInput({ ...input, requestId: requestId.toUpperCase() });
        expect(upper.ok && upper.normalized).toBe(result.normalized);
    }));
});
