/** Converts stored integers to numbers at the application boundary. */
export function toSafeInteger(value: bigint | number | string): number {
    if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") {
        throw new RangeError("Value is outside the safe integer range");
    }
    if (typeof value === "string" && !/^-?\d+$/.test(value)) {
        throw new RangeError("Value is outside the safe integer range");
    }
    const integer = Number(value);
    if (!Number.isSafeInteger(integer)) {
        throw new RangeError("Value is outside the safe integer range");
    }
    return integer === 0 ? 0 : integer;
}

function parseScaledValue(raw: string, digits: number): number | null {
    const value = raw.trim().replace(",", ".");
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;

    const [whole, fraction = ""] = value.split(".");
    if (fraction.length > digits) return null;

    const integer = Number(`${whole}${fraction.padEnd(digits, "0")}`);
    if (!Number.isSafeInteger(integer)) return null;
    return integer === 0 ? 0 : integer;
}

export function parseCents(raw: string): number | null {
    return parseScaledValue(raw, 2);
}

export function parseMilliunits(raw: string): number | null {
    return parseScaledValue(raw, 3);
}

function formatScaledValue(value: number | bigint, digits: number): string {
    const integer = typeof value === "bigint" ? value : toSafeInteger(value);
    const [sign, magnitude] = integer < 0 ? ["-", -integer] : ["", integer];
    const text = magnitude.toString().padStart(digits + 1, "0");
    return `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

export function formatCents(cents: number | bigint): string {
    return formatScaledValue(cents, 2);
}

export function formatCurrencyCents(cents: number | bigint): string {
    const formatted = formatCents(cents);
    return formatted.startsWith("-") ? `-$${formatted.slice(1)}` : `$${formatted}`;
}

export function formatMilliunits(milliunits: number): string {
    return formatScaledValue(milliunits, 3).replace(/\.?0+$/, "");
}

