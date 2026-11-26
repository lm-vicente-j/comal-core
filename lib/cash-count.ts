export type CashDenomination = {
  kind: "BILL" | "COIN";
  valueCents: number;
  quantity: number;
};
export type CashCountInput = {
  requestId: string;
  denominations: CashDenomination[];
  note?: string;
  recountOfId?: number;
  confirmEmpty?: boolean;
};
export const CASH_DENOMINATIONS: {
  kind: "BILL" | "COIN";
  valueCents: number;
}[] = [
  ...[2000, 5000, 10000, 20000, 50000, 100000].map((valueCents) => ({
    kind: "BILL" as const,
    valueCents,
  })),
  ...[50, 100, 200, 500, 1000, 2000].map((valueCents) => ({
    kind: "COIN" as const,
    valueCents,
  })),
];
import type { JornadaCashSummary } from "./jornada-cash";
export type { JornadaCashSummary } from "./jornada-cash";
export type CashCountView = {
  id: number;
  jornadaId: number;
  type: "OPENING" | "INTERIM" | "CLOSING";
  operatorId: number;
  operatorName: string;
  cutoffAt: string;
  denominations: CashDenomination[];
  note: string | null;
  recountOfId: number | null;
  countedAmount: number;
  expectedAmount?: number;
  difference?: number;
  tolerance?: number;
  result?: "BALANCED" | "DISCREPANCY";
  cashSummary?: JornadaCashSummary;
};
export const MAX_CASH_COUNT_CENTS = 100_000_000_000_000;
export type ParsedCashCount = {
  ok: true;
  data: CashCountInput;
  total: number;
  normalized: string;
};
export function parseCashCountInput(
  raw: unknown,
):
  | { ok: true; data: CashCountInput; total: number; normalized: string }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "INVALID_INPUT" };
  const x = raw as Record<string, unknown>;
  if (
    Object.keys(x).some(
      (k) =>
        ![
          "requestId",
          "denominations",
          "note",
          "recountOfId",
          "confirmEmpty",
        ].includes(k),
    )
  )
    return { ok: false, error: "INVALID_INPUT" };
  if (
    typeof x.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      x.requestId,
    )
  )
    return { ok: false, error: "INVALID_INPUT" };
  if (
    !Array.isArray(x.denominations) ||
    x.denominations.length > CASH_DENOMINATIONS.length
  )
    return { ok: false, error: "INVALID_INPUT" };
  const seen = new Set<string>();
  let total = 0;
  const denominations: CashDenomination[] = [];
  for (const d of x.denominations) {
    if (!d || typeof d !== "object" || Array.isArray(d))
      return { ok: false, error: "INVALID_INPUT" };
    const v = d as Record<string, unknown>;
    if (
      Object.keys(v).some(
        (k) => !["kind", "valueCents", "quantity"].includes(k),
      ) ||
      (v.kind !== "BILL" && v.kind !== "COIN") ||
      !Number.isSafeInteger(v.valueCents) ||
      !Number.isSafeInteger(v.quantity) ||
      (v.valueCents as number) < 0 ||
      (v.quantity as number) < 0
    )
      return { ok: false, error: "INVALID_INPUT" };
    const key = `${v.kind}:${v.valueCents}`;
    if (
      seen.has(key) ||
      !CASH_DENOMINATIONS.some(
        (a) => a.kind === v.kind && a.valueCents === v.valueCents,
      )
    )
      return { ok: false, error: "INVALID_INPUT" };
    seen.add(key);
    total += (v.valueCents as number) * (v.quantity as number);
    if (!Number.isSafeInteger(total) || total > MAX_CASH_COUNT_CENTS)
      return { ok: false, error: "INVALID_INPUT" };
    denominations.push({
      kind: v.kind as "BILL" | "COIN",
      valueCents: v.valueCents as number,
      quantity: v.quantity as number,
    });
  }
  if (total === 0 && x.confirmEmpty !== true)
    return { ok: false, error: "CONFIRM_EMPTY_REQUIRED" };
  if (x.note !== undefined && typeof x.note !== "string")
    return { ok: false, error: "INVALID_INPUT" };
  const note = typeof x.note === "string" ? x.note.trim() : undefined;
  if (note && note.length > 1000) return { ok: false, error: "INVALID_INPUT" };
  if (
    x.recountOfId !== undefined &&
    (!Number.isSafeInteger(x.recountOfId) ||
      (x.recountOfId as number) <= 0 ||
      (x.recountOfId as number) > 2_147_483_647)
  )
    return { ok: false, error: "INVALID_INPUT" };
  if (x.confirmEmpty !== undefined && typeof x.confirmEmpty !== "boolean")
    return { ok: false, error: "INVALID_INPUT" };
  const data = {
    // UUIDs are case-insensitive in PostgreSQL. Canonicalize before both the
    // payload hash and unique-key lookup so casing cannot change retry identity.
    requestId: x.requestId.toLowerCase(),
    denominations,
    note,
    ...(x.recountOfId === undefined
      ? {}
      : { recountOfId: x.recountOfId as number }),
    ...(x.confirmEmpty === undefined
      ? {}
      : { confirmEmpty: x.confirmEmpty as boolean }),
  };
  return { ok: true, data, total, normalized: JSON.stringify(data) };
}
