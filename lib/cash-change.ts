export type CashChangeStatus = "empty" | "invalid" | "insufficient" | "exact" | "change";

export interface CashChangeResult {
    status: CashChangeStatus;
    receivedCents: number | null;
    changeCents: number | null;
    /** Formatted positive MXN-style dollar string (change to return, or missing amount when insufficient). */
    formattedAmount: string | null;
}

/**
 * Parses a cashier-entered decimal string (dot or comma, up to 2 decimal places)
 * into exact integer cents. Returns `null` for blank input and `NaN` for invalid input.
 */
export function parseCashInputToCents(raw: string): number | null {
    const value = raw.trim().replace(",", ".");
    if (value === "") return null;
    if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value)) return NaN;
    const [whole, decimals = ""] = value.split(".");
    const cents = Number(whole || "0") * 100 + Number(decimals.padEnd(2, "0"));
    return Number.isSafeInteger(cents) ? cents : NaN;
}

/**
 * Sums monetary totals in integer cents so floating-point sums cannot drift.
 */
export function sumSaleTotalsCents(totals: ReadonlyArray<number | string | null | undefined>): number {
    return totals.reduce<number>((sum, value) => sum + Math.round(Number(value ?? 0) * 100), 0);
}

/**
 * Computes informational change for a cash checkout from the raw input string
 * and the account total in integer cents.
 */
export function calculateCashChange(rawReceived: string, totalCents: number): CashChangeResult {
    const receivedCents = parseCashInputToCents(rawReceived);
    if (receivedCents === null) {
        return { status: "empty", receivedCents: null, changeCents: null, formattedAmount: null };
    }
    if (Number.isNaN(receivedCents) || !Number.isSafeInteger(totalCents) || totalCents < 0) {
        return { status: "invalid", receivedCents: Number.isNaN(receivedCents) ? null : receivedCents, changeCents: null, formattedAmount: null };
    }

    const changeCents = receivedCents - totalCents;
    if (!Number.isSafeInteger(changeCents)) {
        return { status: "invalid", receivedCents: null, changeCents: null, formattedAmount: null };
    }

    if (changeCents < 0) {
        return {
            status: "insufficient",
            receivedCents,
            changeCents,
            formattedAmount: `$${(-changeCents / 100).toFixed(2)}`,
        };
    }

    if (changeCents === 0) {
        return {
            status: "exact",
            receivedCents,
            changeCents: 0,
            formattedAmount: "$0.00",
        };
    }

    return {
        status: "change",
        receivedCents,
        changeCents,
        formattedAmount: `$${(changeCents / 100).toFixed(2)}`,
    };
}
