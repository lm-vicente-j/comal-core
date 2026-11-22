import { describe, it, expect } from "vitest";
import { calculateCashChange, parseCashInputToCents, sumSaleTotalsCents } from "@/lib/cash-change";

describe("cash-change calculator", () => {
    describe("parseCashInputToCents", () => {
        it("returns null for empty or whitespace-only input", () => {
            expect(parseCashInputToCents("")).toBeNull();
            expect(parseCashInputToCents("   \t\n  ")).toBeNull();
        });

        it("parses whole numbers, dots, commas, and 1-2 decimals into exact integer cents", () => {
            expect(parseCashInputToCents("0")).toBe(0);
            expect(parseCashInputToCents("0.00")).toBe(0);
            expect(parseCashInputToCents("25")).toBe(2500);
            expect(parseCashInputToCents(" 100.5 ")).toBe(10050);
            expect(parseCashInputToCents("25.05")).toBe(2505);
            expect(parseCashInputToCents("25,05")).toBe(2505);
            expect(parseCashInputToCents("25,1")).toBe(2510);
            expect(parseCashInputToCents(".50")).toBe(50);
            expect(parseCashInputToCents(",5")).toBe(50);
            expect(parseCashInputToCents("25.")).toBe(2500);
            expect(parseCashInputToCents("25,")).toBe(2500);
            expect(parseCashInputToCents("0050.25")).toBe(5025);
        });

        it("rejects malformed, negative, >2 decimal, scientific, or overflowing inputs as NaN", () => {
            for (const invalid of [
                "abc",
                "-1",
                "-0.01",
                "+25",
                "25.001",
                "25,001",
                "25.1.2",
                "25,0.1",
                ".",
                ",",
                "1e3",
                "Infinity",
                "NaN",
                "$50",
                "90071992547409.92",
            ]) {
                expect(Number.isNaN(parseCashInputToCents(invalid)), `expected NaN for "${invalid}"`).toBe(true);
            }
        });
    });

    describe("sumSaleTotalsCents", () => {
        it("sums cent amounts and handles missing totals", () => {
            expect(sumSaleTotalsCents([10, 20])).toBe(30);
            expect(sumSaleTotalsCents([1999, 1001, null, undefined])).toBe(3000);
            expect(sumSaleTotalsCents([])).toBe(0);
        });
    });

    describe("calculateCashChange", () => {
        it("handles minimal cases: empty, exact, change due, and insufficient", () => {
            expect(calculateCashChange("", 2500)).toEqual({
                status: "empty",
                receivedCents: null,
                changeCents: null,
                formattedAmount: null,
            });

            expect(calculateCashChange("25", 2500)).toEqual({
                status: "exact",
                receivedCents: 2500,
                changeCents: 0,
                formattedAmount: "$0.00",
            });

            expect(calculateCashChange("100", 3750)).toEqual({
                status: "change",
                receivedCents: 10000,
                changeCents: 6250,
                formattedAmount: "$62.50",
            });

            expect(calculateCashChange("20", 2500)).toEqual({
                status: "insufficient",
                receivedCents: 2000,
                changeCents: -500,
                formattedAmount: "$5.00",
            });
        });

        it("handles edge cases: penny differences, comma decimals, zero total, invalid inputs", () => {
            expect(calculateCashChange("25,01", 2500)).toEqual({
                status: "change",
                receivedCents: 2501,
                changeCents: 1,
                formattedAmount: "$0.01",
            });

            expect(calculateCashChange("24.99", 2500)).toEqual({
                status: "insufficient",
                receivedCents: 2499,
                changeCents: -1,
                formattedAmount: "$0.01",
            });

            expect(calculateCashChange("0", 0)).toEqual({
                status: "exact",
                receivedCents: 0,
                changeCents: 0,
                formattedAmount: "$0.00",
            });

            expect(calculateCashChange("0", 2500)).toEqual({
                status: "insufficient",
                receivedCents: 0,
                changeCents: -2500,
                formattedAmount: "$25.00",
            });

            expect(calculateCashChange("abc", 2500)).toMatchObject({
                status: "invalid",
                changeCents: null,
                formattedAmount: null,
            });

            expect(calculateCashChange("50", -100)).toMatchObject({
                status: "invalid",
                changeCents: null,
                formattedAmount: null,
            });
        });
    });
});
