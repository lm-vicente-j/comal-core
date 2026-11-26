import fc from "fast-check";
import { mkdirSync, writeFileSync } from "node:fs";
import { CASH_DENOMINATIONS } from "@/lib/cash-count";

export const cents = fc.integer({ min: 0, max: 1_000_000 });
export const positiveCents = fc.integer({ min: 1, max: 10_000 });
export const milliunits = fc.integer({ min: 0, max: 1_000_000 });
export const paymentMethod = fc.constantFrom("CASH" as const, "TRANSFER" as const);
export const recipe = fc.array(fc.record({ unitCost: cents, quantityUsed: milliunits }), { maxLength: 12 });
export const denominations = fc.uniqueArray(fc.record({
    denomination: fc.constantFrom(...CASH_DENOMINATIONS),
    quantity: fc.integer({ min: 0, max: 1000 }),
}), { selector: row => `${row.denomination.kind}:${row.denomination.valueCents}`, maxLength: CASH_DENOMINATIONS.length })
    .map(rows => rows.map(({ denomination, quantity }) => ({ ...denomination, quantity })));

// Include values that JSON-only generators cannot express.
export const invalidNumber = fc.oneof(
    fc.constantFrom<unknown>(undefined, null, false, true, "", "1e3", "1.001", [], {}, NaN, Infinity, -Infinity,
        Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER, -1, 0, 0.5, 100_000_000_000_001),
    fc.integer({ min: -1_000_000, max: -1 }),
);
export const invalidId = fc.oneof(
    fc.constantFrom<unknown>(undefined, null, false, true, "1", [], {}, NaN, Infinity, -Infinity, 0, -1, 0.5, 2_147_483_648, Number.MAX_SAFE_INTEGER),
    fc.integer({ min: -1_000_000, max: 0 }),
);

function integerOption(name: string, fallback: number, allowNegative = false) {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(value) || (!allowNegative && value < 1)) {
        throw new Error(`${name} must be ${allowNegative ? "a safe" : "a positive safe"} integer`);
    }
    return value;
}

/** Keep shrinking failures reproducible and preserve artifacts even outside CI. */
export async function checkGenerated<T>(name: string, property: fc.IProperty<T> | fc.IAsyncProperty<T>, database = false) {
    const stress = process.env.FC_PROFILE === "stress";
    const options: fc.Parameters<T> = {
        seed: integerOption("FC_SEED", 60, true),
        numRuns: integerOption("FC_NUM_RUNS", database ? (stress ? 200 : 30) : (stress ? 2000 : 200)),
        ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}),
    };
    const result = await fc.check(property, options);
    if (!result.failed) return;
    const details = {
        name, seed: result.seed, path: result.counterexamplePath,
        numRuns: result.numRuns, numShrinks: result.numShrinks,
        counterexample: result.counterexample, error: String(result.errorInstance),
    };
    const json = JSON.stringify(details, (_key, value) => {
        if (typeof value === "bigint") return `${value}n`;
        if (typeof value === "number" && !Number.isFinite(value)) return String(value);
        if (value === undefined) return "[undefined]";
        return value;
    }, 2);
    mkdirSync("ci_results/counterexamples", { recursive: true });
    writeFileSync(`ci_results/counterexamples/${name}.json`, json + "\n");
    throw new Error(`${json}\nReplay: FC_SEED=${result.seed} FC_PATH='${result.counterexamplePath}' npm test -- -t '${name}'`, { cause: result.errorInstance });
}
