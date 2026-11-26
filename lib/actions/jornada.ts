"use server";
import { toSafeInteger } from "@/lib/scaled-values";
import { cache } from "react";
import { Prisma } from "@/app/generated/prisma/client";
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { getJornadaCashSummary } from "../jornada-cash";
import { canCurrentUser } from "@/lib/server-permissions";
import {
  acquireJornadaTicketLock,
  clearJornadaReservations,
} from "../ticket-reservations";
import {
  actionFail,
  actionOk,
  type ActionResult,
  type FieldErrors,
} from "../action-result";
import { createHash } from "node:crypto";
import {
  parseCashCountInput,
  type CashCountInput,
  type CashCountView,
  type JornadaCashSummary,
  type ParsedCashCount,
} from "../cash-count";
import { getPaginationMeta, getPaginationOffset } from "@/lib/pagination";

// React.cache memoizes per server request: the dashboard layout (banner)
// and the /pos page ask for the same jornada data in a single render, so
// the query work runs once per render instead of once per caller.
const hasOpenJornadaCached = cache(async () => {
  const session = await auth();
  if (!session?.user) return null;

  const jornada = await prisma.jornada.findFirst({
    where: { status: "OPEN" },
    select: { id: true },
  });
  return jornada?.id ?? null;
});

// Lightweight check used by the UI to disable controls that need an open jornada.
export async function hasOpenJornada() {
  return (await hasOpenJornadaCached()) !== null;
}

export async function getOpenJornadaId() {
  return hasOpenJornadaCached();
}

const INT4_MAX = 2_147_483_647;

function isValidInt4Id(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= INT4_MAX
  );
}

function revalidateShiftPaths(): void {
  revalidatePath("/admin/jornada");
  revalidatePath("/(dashboard)", "layout");
  revalidatePath("/pos");
  revalidatePath("/debtors");
  revalidatePath("/admin/savings");
  revalidatePath("/expenses");
  revalidatePath("/admin/payrolls");
  revalidatePath("/analytics");
}

type CashFilter = {
  page?: number;
  pageSize?: number;
  jornadaId?: number;
  operatorId?: number;
  type?: "OPENING" | "INTERIM" | "CLOSING";
};
type OpenAccountSummary = { sourceType: string; count: number; total: number };
const MAX_COUNT = 100_000_000_000_000;
const MAX_ID = 2_147_483_647;

function payloadHash(
  operation: string,
  jornadaId: number | null,
  actorId: number,
  normalized: string,
) {
  return createHash("sha256")
    .update(JSON.stringify({ operation, jornadaId, actorId, normalized }))
    .digest("hex");
}
function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (
    /^[\s\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]*[=+@\-]/.test(
      text,
    )
  )
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function formatCents(value: number | undefined): string {
  if (value === undefined) return "";
  return (value / 100).toFixed(2);
}
async function readCashTolerance(
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<number> {
  const row = await db.setting.findUnique({
    where: { key: "CASH_COUNT_TOLERANCE_CENTS" },
    select: { value: true },
  });
  if (!row) return 0;
  if (row.value == null || row.value === "")
    throw new Error("INVALID_CASH_TOLERANCE");
  if (!/^\d+$/.test(row.value)) throw new Error("INVALID_CASH_TOLERANCE");
  const amount = Number(row.value);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_COUNT)
    throw new Error("INVALID_CASH_TOLERANCE");
  return amount;
}
type CashCountRow = Prisma.cash_countGetPayload<{
  include: { operator: { select: { name: true } } };
}>;
function countView(
  row: CashCountRow,
  privileged: boolean,
  admin = false,
): CashCountView {
  const result =
    toSafeInteger(row.differenceCents) === 0 ||
    Math.abs(toSafeInteger(row.differenceCents)) <=
      toSafeInteger(row.toleranceCents)
      ? "BALANCED"
      : "DISCREPANCY";
  const base: CashCountView = {
    id: row.id,
    jornadaId: row.jornadaId,
    type: row.type,
    operatorId: row.operatorId,
    operatorName: row.operator?.name ?? "",
    cutoffAt: row.cutoffAt.toISOString(),
    denominations: row.denominations as CashCountView["denominations"],
    note: row.note,
    recountOfId: row.recountOfId,
    countedAmount: toSafeInteger(row.countedAmountCents),
  };
  if (privileged) {
    const summary = row.cashSummary as JornadaCashSummary;
    const safeSummary = admin
      ? summary
      : { ...summary, cashSalaries: 0, transferSalaries: 0, savingsOut: 0 };
    Object.assign(base, {
      expectedAmount: toSafeInteger(row.expectedAmountCents),
      difference: toSafeInteger(row.differenceCents),
      tolerance: toSafeInteger(row.toleranceCents),
      result,
      cashSummary: safeSummary,
    });
  }
  return base;
}
async function saveCount(
  tx: Prisma.TransactionClient,
  args: {
    jornadaId: number;
    type: "OPENING" | "INTERIM" | "CLOSING";
    operatorId: number;
    cutoffAt: Date;
    input: ParsedCashCount;
    expected: number;
    tolerance: number;
    cash: JornadaCashSummary;
    hash: string;
  },
) {
  const differenceBig = BigInt(args.input.total) - BigInt(args.expected);
  if (
    differenceBig > BigInt(Number.MAX_SAFE_INTEGER) ||
    differenceBig < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new Error("AMOUNT_OVERFLOW");
  const difference = Number(differenceBig);
  if (Math.abs(difference) > args.tolerance && !args.input.data.note)
    return null;
  return tx.cash_count.create({
    data: {
      jornadaId: args.jornadaId,
      type: args.type,
      operatorId: args.operatorId,
      cutoffAt: args.cutoffAt,
      denominations: args.input.data.denominations,
      note: args.input.data.note ?? null,
      recountOfId: args.input.data.recountOfId ?? null,
      requestId: args.input.data.requestId,
      payloadHash: args.hash,
      countedAmountCents: BigInt(args.input.total),
      expectedAmountCents: BigInt(args.expected),
      differenceCents: BigInt(difference),
      toleranceCents: BigInt(args.tolerance),
      cashSummary: args.cash,
    },
  });
}
export async function openJornada(
  input: CashCountInput,
): Promise<
  ActionResult<CashCountView, string, FieldErrors, { pendingJornadaId: number }>
> {
  const session = await auth();
  if (!session?.user || !(await canCurrentUser("jornada.open")))
    return actionFail("PERMISSION DENIED");
  const userId = Number(session.user.id);
  const parsed = parseCashCountInput(input);
  if (!Number.isInteger(userId) || userId < 1 || userId > MAX_ID || !parsed.ok)
    return actionFail(parsed.ok ? "PERMISSION DENIED" : parsed.error);
  const privileged = await canCurrentUser("jornada.viewCash");
  try {
    const result = await prisma.$transaction(async (tx) => {
      await acquireJornadaTicketLock(tx, 0);
      const old = await tx.cash_count.findUnique({
        where: { requestId: parsed.data.requestId },
        include: { operator: { select: { name: true } } },
      });
      if (old)
        return old.payloadHash ===
          payloadHash("OPENING", null, userId, parsed.normalized) &&
          old.operatorId === userId
          ? actionOk(countView(old, privileged, session.user.role === "ADMIN"))
          : actionFail("IDEMPOTENCY_CONFLICT");
      const pending = await tx.jornada.findFirst({
        where: { status: "OPEN" },
        select: { id: true },
      });
      if (pending)
        return actionFail("PENDING_JORNADA", {
          data: { pendingJornadaId: pending.id },
        });
      if (parsed.data.recountOfId !== undefined)
        return actionFail("INVALID_RECOUNT");
      const tolerance = await readCashTolerance(tx);
      const jornada = await tx.jornada.create({
        data: {
          openedBy: userId,
          openingAmountCents: BigInt(parsed.total),
          status: "OPEN",
        },
      });
      const cash = await getJornadaCashSummary(jornada.id, parsed.total, tx);
      const row = await saveCount(tx, {
        jornadaId: jornada.id,
        type: "OPENING",
        operatorId: userId,
        cutoffAt: jornada.openedAt,
        input: parsed,
        expected: parsed.total,
        tolerance,
        cash,
        hash: payloadHash("OPENING", null, userId, parsed.normalized),
      });
      if (!row) throw new Error("UNEXPECTED_OPENING_DISCREPANCY");
      return actionOk(
        countView(
          { ...row, operator: { name: session.user.name ?? null } },
          privileged,
          session.user.role === "ADMIN",
        ),
      );
    });
    if (result.success) revalidateShiftPaths();
    return result;
  } catch {
    return actionFail("INTERNAL ERROR");
  }
}

export async function recordCashCount(
  jornadaId: number,
  input: CashCountInput,
): Promise<ActionResult<CashCountView>> {
  return writeJornadaCashCount(jornadaId, input, "INTERIM");
}
async function writeJornadaCashCount(
  jornadaId: number,
  input: CashCountInput,
  type: "INTERIM" | "CLOSING",
): Promise<ActionResult<CashCountView>> {
  const session = await auth();
  if (!session?.user) return actionFail("PERMISSION DENIED");
  const cap = type === "CLOSING" ? "jornada.close" : "jornada.reconcile";
  if (!(await canCurrentUser(cap))) return actionFail("PERMISSION DENIED");
  const actorId = Number(session.user.id),
    parsed = parseCashCountInput(input);
  if (!isValidInt4Id(jornadaId) || !isValidInt4Id(actorId) || !parsed.ok)
    return actionFail(parsed.ok ? "INVALID_INPUT" : parsed.error);
  const privileged = await canCurrentUser("jornada.viewCash");
  try {
    const result = await prisma.$transaction(async (tx) => {
      await acquireJornadaTicketLock(tx, jornadaId);
      const old = await tx.cash_count.findUnique({
        where: { requestId: parsed.data.requestId },
        include: { operator: { select: { name: true } } },
      });
      const hash = payloadHash(type, jornadaId, actorId, parsed.normalized);
      if (old)
        return old.payloadHash === hash &&
          old.operatorId === actorId &&
          old.jornadaId === jornadaId
          ? actionOk(countView(old, privileged, session.user.role === "ADMIN"))
          : actionFail("IDEMPOTENCY_CONFLICT");
      const jornada = await tx.jornada.findUnique({
        where: { id: jornadaId },
        select: { status: true, openingAmountCents: true },
      });
      if (!jornada) return actionFail("Jornada no encontrada");
      if (jornada.status !== "OPEN")
        return actionFail("La jornada ya está cerrada");
      if (parsed.data.recountOfId !== undefined) {
        const prior = await tx.cash_count.findUnique({
          where: { id: parsed.data.recountOfId },
          select: { id: true, jornadaId: true, type: true },
        });
        if (
          type !== "INTERIM" ||
          !prior ||
          prior.jornadaId !== jornadaId ||
          !parsed.data.note
        )
          return actionFail("INVALID_RECOUNT");
      }
      const cash = await getJornadaCashSummary(
        jornadaId,
        toSafeInteger(jornada.openingAmountCents),
        tx,
      );
      const tolerance = await readCashTolerance(tx),
        cutoffAt = new Date();
      const row = await saveCount(tx, {
        jornadaId,
        type,
        operatorId: actorId,
        cutoffAt,
        input: parsed,
        expected: cash.expectedCash,
        tolerance,
        cash,
        hash,
      });
      if (!row) return actionFail("NOTE_REQUIRED");
      return actionOk(
        countView(
          { ...row, operator: { name: session.user.name ?? null } },
          privileged,
          session.user.role === "ADMIN",
        ),
      );
    });
    if (result.success) revalidateShiftPaths();
    return result;
  } catch {
    return actionFail("INTERNAL ERROR");
  }
}

export async function closeJornada(
  jornadaId: number,
  input: CashCountInput,
): Promise<
  ActionResult<
    CashCountView,
    string,
    FieldErrors,
    { openAccounts: OpenAccountSummary[] }
  >
> {
  const session = await auth();
  if (!session?.user || !(await canCurrentUser("jornada.close")))
    return actionFail("PERMISSION DENIED");
  const actorId = Number(session.user.id),
    parsed = parseCashCountInput(input),
    privileged = await canCurrentUser("jornada.viewCash");
  if (!isValidInt4Id(jornadaId) || !isValidInt4Id(actorId) || !parsed.ok)
    return actionFail(parsed.ok ? "INVALID_INPUT" : parsed.error);
  try {
    const result = await prisma.$transaction(async (tx) => {
      await acquireJornadaTicketLock(tx, jornadaId);
      const old = await tx.cash_count.findUnique({
          where: { requestId: parsed.data.requestId },
          include: { operator: { select: { name: true } } },
        }),
        hash = payloadHash("CLOSING", jornadaId, actorId, parsed.normalized);
      if (old)
        return old.payloadHash === hash && old.operatorId === actorId
          ? actionOk(countView(old, privileged, session.user.role === "ADMIN"))
          : actionFail("IDEMPOTENCY_CONFLICT");
      const jornada = await tx.jornada.findUnique({
        where: { id: jornadaId },
        select: { status: true, openingAmountCents: true },
      });
      if (!jornada) return actionFail("Jornada no encontrada");
      if (jornada.status !== "OPEN")
        return actionFail("La jornada ya está cerrada");
      const open = await tx.sales.groupBy({
        by: ["source_type"],
        where: { jornadaId, status: "UNPAID" },
        _count: { id: true },
        _sum: { totalCents: true },
      });
      if (open.length)
        return privileged
          ? actionFail("OPEN_ACCOUNTS", {
              data: {
                openAccounts: open.map((a) => ({
                  sourceType: a.source_type ?? "SIN ORIGEN",
                  count: a._count.id,
                  total: toSafeInteger(a._sum.totalCents ?? 0),
                })),
              },
            })
          : actionFail("OPEN_ACCOUNTS");
      if (parsed.data.recountOfId !== undefined)
        return actionFail("INVALID_RECOUNT");
      const cash = await getJornadaCashSummary(
          jornadaId,
          toSafeInteger(jornada.openingAmountCents),
          tx,
        ),
        tolerance = await readCashTolerance(tx),
        cutoffAt = new Date();
      const row = await saveCount(tx, {
        jornadaId,
        type: "CLOSING",
        operatorId: actorId,
        cutoffAt,
        input: parsed,
        expected: cash.expectedCash,
        tolerance,
        cash,
        hash,
      });
      if (!row) return actionFail("NOTE_REQUIRED");
      await tx.jornada.update({
        where: { id: jornadaId },
        data: {
          status: "CLOSED",
          closedAt: cutoffAt,
          closedBy: actorId,
          expectedClosingAmountCents: BigInt(cash.expectedCash),
          expectedTransferAmountCents: BigInt(cash.expectedTransfer),
          actualClosingAmountCents: BigInt(parsed.total),
        },
      });
      await clearJornadaReservations(tx, jornadaId);
      return actionOk(
        countView(
          { ...row, operator: { name: session.user.name ?? null } },
          privileged,
          session.user.role === "ADMIN",
        ),
      );
    });
    if (result.success) revalidateShiftPaths();
    return result;
  } catch {
    return actionFail("INTERNAL ERROR");
  }
}

function parseCashFilters(
  raw: unknown,
  pagination: boolean,
): CashFilter | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  const allowed = new Set([
    "jornadaId",
    "operatorId",
    "type",
    ...(pagination ? ["page", "pageSize"] : []),
  ]);
  if (Object.keys(f).some((k) => !allowed.has(k))) return null;
  for (const key of ["jornadaId", "operatorId"] as const) {
    if (
      f[key] !== undefined &&
      (!Number.isSafeInteger(f[key]) ||
        (f[key] as number) < 1 ||
        (f[key] as number) > MAX_ID)
    )
      return null;
  }
  if (
    f.type !== undefined &&
    !["OPENING", "INTERIM", "CLOSING"].includes(String(f.type))
  )
    return null;
  if (
    pagination &&
    ((f.page !== undefined &&
      (!Number.isSafeInteger(f.page) || (f.page as number) < 1)) ||
      (f.pageSize !== undefined &&
        (!Number.isSafeInteger(f.pageSize) ||
          (f.pageSize as number) < 1 ||
          (f.pageSize as number) > 50)))
  )
    return null;
  return f as CashFilter;
}

export async function getCashCountHistory(
  options: unknown = {},
): Promise<
  ActionResult<{
    items: CashCountView[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasMore: boolean;
  }>
> {
  const session = await auth();
  if (!session?.user) return actionFail("PERMISSION DENIED");
  const privileged = await canCurrentUser("jornada.viewCash"),
    actorId = Number(session.user.id);
  const filters = parseCashFilters(options, true);
  if (!filters || !isValidInt4Id(actorId)) return actionFail("INVALID_INPUT");
  if (
    !privileged &&
    filters.operatorId !== undefined &&
    filters.operatorId !== actorId
  )
    return actionFail("PERMISSION DENIED");
  const requestedPage = filters.page ?? 1,
    requestedPageSize = filters.pageSize ?? 20;
  const where = {
    ...(filters.jornadaId ? { jornadaId: filters.jornadaId } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(privileged
      ? filters.operatorId
        ? { operatorId: filters.operatorId }
        : {}
      : { operatorId: actorId }),
  };
  try {
    return await prisma.$transaction(
      async (tx) => {
        const total = await tx.cash_count.count({ where });
        const meta = getPaginationMeta(total, {
          page: requestedPage,
          pageSize: requestedPageSize,
        });
        const rows = await tx.cash_count.findMany({
          where,
          include: { operator: { select: { name: true } } },
          orderBy: [{ cutoffAt: "desc" }, { id: "desc" }],
          skip: getPaginationOffset(meta),
          take: meta.pageSize,
        });
        return actionOk({
          items: rows.map((row) =>
            countView(row, privileged, session.user.role === "ADMIN"),
          ),
          ...meta,
        });
      },
      { isolationLevel: "RepeatableRead" },
    );
  } catch {
    return actionFail("QUERY_FAILED");
  }
}

export async function exportCashCountHistory(
  options: unknown = {},
): Promise<ActionResult<string>> {
  const session = await auth();
  if (!session?.user) return actionFail("PERMISSION DENIED");
  const privileged = await canCurrentUser("jornada.viewCash"),
    actorId = Number(session.user.id);
  const filters = parseCashFilters(options, false);
  if (!filters || !isValidInt4Id(actorId)) return actionFail("INVALID_INPUT");
  if (
    !privileged &&
    filters.operatorId !== undefined &&
    filters.operatorId !== actorId
  )
    return actionFail("PERMISSION DENIED");
  const where = {
    ...(filters.jornadaId ? { jornadaId: filters.jornadaId } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(privileged
      ? filters.operatorId
        ? { operatorId: filters.operatorId }
        : {}
      : { operatorId: actorId }),
  };
  try {
    const rows = await prisma.cash_count.findMany({
      where,
      include: { operator: { select: { name: true } } },
      orderBy: [{ cutoffAt: "asc" }, { id: "asc" }],
    });
    const headers = [
      "Folio",
      "Jornada",
      "Tipo",
      "Operador ID",
      "Operador",
      "Corte",
      "Contado MXN",
      "Nota",
      "Recuento de folio",
      "Denominaciones",
      ...(privileged
        ? [
            "Esperado MXN",
            "Diferencia MXN",
            "Tolerancia MXN",
            "Resultado",
            "Resumen de efectivo",
          ]
        : []),
    ];
    const lines = [
      headers.map(csvCell).join(","),
      ...rows.map((row) => {
        const view = countView(row, privileged, session.user.role === "ADMIN");
        return [
          view.id,
          view.jornadaId,
          view.type,
          view.operatorId,
          view.operatorName,
          view.cutoffAt,
          formatCents(view.countedAmount),
          view.note,
          view.recountOfId,
          JSON.stringify(view.denominations),
          ...(privileged
            ? [
                formatCents(view.expectedAmount),
                formatCents(view.difference),
                formatCents(view.tolerance),
                view.result,
                JSON.stringify(view.cashSummary),
              ]
            : []),
        ]
          .map(csvCell)
          .join(",");
      }),
    ];
    return actionOk(lines.join("\r\n"));
  } catch {
    return actionFail("QUERY_FAILED");
  }
}

export async function getJornadaCollectionsByEmployee(jornadaId: number) {
  if (!(await canCurrentUser("jornada.viewCash")) || !isValidInt4Id(jornadaId))
    return [];
  try {
    const [sales, debts] = await Promise.all([
      prisma.sales.groupBy({
        by: ["collectedBy", "payment_method"],
        where: {
          OR: [
            { paidJornadaId: jornadaId },
            { paidJornadaId: null, jornadaId },
          ],
          status: "PAID",
          debtors: { is: null },
        },
        _count: { id: true },
        _sum: { totalCents: true },
      }),
      prisma.debtors.findMany({
        where: {
          paidJornadaId: jornadaId,
          status: "PAID",
          sales: { status: "PAID" },
        },
        select: {
          collectedBy: true,
          amountCents: true,
          sales: { select: { payment_method: true } },
        },
      }),
    ]);
    const users = await prisma.users.findMany({
      where: {
        id: {
          in: [
            ...sales
              .map((x) => x.collectedBy)
              .filter((x): x is number => x !== null),
            ...debts
              .map((x) => x.collectedBy)
              .filter((x): x is number => x !== null),
          ],
        },
      },
      select: { id: true, name: true },
    });
    const output = new Map<
      number | null,
      {
        userId: number | null;
        userName: string;
        collectionsCount: number;
        totalCollected: bigint;
        cashCollected: bigint;
        transferCollected: bigint;
      }
    >();
    const ensure = (id: number | null) => {
      let x = output.get(id);
      if (!x) {
        x = {
          userId: id,
          userName:
            id === null
              ? "Sin registro"
              : (users.find((u) => u.id === id)?.name ?? "Usuario"),
          collectionsCount: 0,
          totalCollected: BigInt(0),
          cashCollected: BigInt(0),
          transferCollected: BigInt(0),
        };
        output.set(id, x);
      }
      return x;
    };
    for (const row of sales) {
      const x = ensure(row.collectedBy),
        amount = row._sum.totalCents ?? BigInt(0);
      x.collectionsCount += row._count.id;
      x.totalCollected += amount;
      if (row.payment_method === "CASH") x.cashCollected += amount;
      else if (row.payment_method === "TRANSFER") x.transferCollected += amount;
    }
    // Debts retain their receiving employee attribution on debtors.
    for (const row of debts) {
      const x = ensure(row.collectedBy),
        amount = row.amountCents;
      x.collectionsCount += 1;
      x.totalCollected += amount;
      if (row.sales.payment_method === "CASH") x.cashCollected += amount;
      else if (row.sales.payment_method === "TRANSFER")
        x.transferCollected += amount;
    }
    return [...output.values()].map((row) => ({
      ...row,
      totalCollected: toSafeInteger(row.totalCollected),
      cashCollected: toSafeInteger(row.cashCollected),
      transferCollected: toSafeInteger(row.transferCollected),
    }));
  } catch {
    return [];
  }
}

export async function getJornadaClosingSummary(
  jornadaId: number,
): Promise<
  ActionResult<{
    jornada: {
      id: number;
      status: string;
      openedAt: string;
      closedAt: string | null;
      openingAmount: number;
      expectedClosingAmount?: number | null;
      actualClosingAmount: number | null;
      expectedTransferAmount?: number | null;
    };
    counts: CashCountView[];
    collections: Awaited<ReturnType<typeof getJornadaCollectionsByEmployee>>;
  }>
> {
  const session = await auth();
  if (!session?.user) return actionFail("PERMISSION DENIED");
  if (!isValidInt4Id(jornadaId)) return actionFail("INVALID_INPUT");
  const privileged = await canCurrentUser("jornada.viewCash"),
    actorId = Number(session.user.id);
  try {
    const j = await prisma.jornada.findUnique({
      where: { id: jornadaId },
      select: {
        id: true,
        status: true,
        openedAt: true,
        closedAt: true,
        openingAmountCents: true,
        expectedClosingAmountCents: true,
        actualClosingAmountCents: true,
        expectedTransferAmountCents: true,
      },
    });
    if (!j) return actionFail("Jornada no encontrada");
    const rows = await prisma.cash_count.findMany({
      where: { jornadaId, ...(privileged ? {} : { operatorId: actorId }) },
      include: { operator: { select: { name: true } } },
      orderBy: { cutoffAt: "asc" },
    });
    if (!privileged && rows.length === 0)
      return actionFail("PERMISSION DENIED");
    const collections = privileged
      ? await getJornadaCollectionsByEmployee(jornadaId)
      : [];
    const ownsOpening = rows.some((row) => row.type === "OPENING");
    const ownsClosing = rows.some((row) => row.type === "CLOSING");
    return actionOk({
      jornada: {
        id: j.id,
        status: j.status,
        openedAt: j.openedAt.toISOString(),
        closedAt: j.closedAt?.toISOString() ?? null,
        openingAmount:
          privileged || ownsOpening ? toSafeInteger(j.openingAmountCents) : 0,
        ...(privileged
          ? {
              expectedClosingAmount:
                j.expectedClosingAmountCents === null
                  ? null
                  : toSafeInteger(j.expectedClosingAmountCents),
              expectedTransferAmount:
                j.expectedTransferAmountCents === null
                  ? null
                  : toSafeInteger(j.expectedTransferAmountCents),
            }
          : {}),
        actualClosingAmount:
          privileged || ownsClosing
            ? j.actualClosingAmountCents === null
              ? null
              : toSafeInteger(j.actualClosingAmountCents)
            : null,
      },
      counts: rows.map((r) =>
        countView(r, privileged, session.user.role === "ADMIN"),
      ),
      collections,
    });
  } catch {
    return actionFail("QUERY_FAILED");
  }
}

// Wrapped in React.cache for the same reason as hasOpenJornada: JornadaBanner
// and the /pos page both need these stats in the same render, and the
// aggregate queries are the heaviest part of a POS reload.
const getActiveJornadaWithStatsCached = cache(async () => {
  const session = await auth();
  if (!session?.user || !(await canCurrentUser("jornada.viewCash")))
    return null;

  const jornada = await prisma.jornada.findFirst({
    where: { status: "OPEN" },
    include: {
      openedByUser: { select: { id: true, name: true } },
    },
  });

  if (!jornada) {
    return {
      state: "NO_JORNADA" as const,
      currentUserId: Number(session.user.id),
    };
  }

  const cash = await getJornadaCashSummary(
    jornada.id,
    toSafeInteger(jornada.openingAmountCents),
  );
  const safeCash =
    session.user.role === "ADMIN"
      ? cash
      : { ...cash, cashSalaries: 0, transferSalaries: 0, savingsOut: 0 };

  const currentUserId = Number(session.user.id);
  const isMine = jornada.openedBy === currentUserId;

  const serializedJornada = {
    id: jornada.id,
    openedAt: jornada.openedAt,
    closedAt: jornada.closedAt,
    openedBy: jornada.openedBy,
    closedBy: jornada.closedBy,
    status: jornada.status,
    openingAmount: toSafeInteger(jornada.openingAmountCents),
    expectedClosingAmount:
      jornada.expectedClosingAmountCents !== null
        ? toSafeInteger(jornada.expectedClosingAmountCents)
        : null,
    actualClosingAmount:
      jornada.actualClosingAmountCents !== null
        ? toSafeInteger(jornada.actualClosingAmountCents)
        : null,
    openedByUser: jornada.openedByUser
      ? { id: jornada.openedByUser.id, name: jornada.openedByUser.name }
      : null,
  };

  return {
    state: isMine ? ("OWN_OPEN" as const) : ("OTHER_OPEN" as const),
    jornada: serializedJornada,
    stats: safeCash,
    currentUserId,
  };
});

export async function getActiveJornadaWithStats() {
  return getActiveJornadaWithStatsCached();
}

export async function getJornadaEmployeeBreakdown(jornadaId: number) {
  const session = await auth();
  if (!session?.user || !(await canCurrentUser("jornada.viewCash"))) return [];
  if (!isValidInt4Id(jornadaId)) return [];

  try {
    const grouped = await prisma.sales.groupBy({
      by: ["placedBy"],
      where: { jornadaId, status: "PAID" },
      _sum: { totalCents: true },
      _count: { id: true },
    });

    if (grouped.length === 0) return [];

    const userIds = grouped
      .map((g) => g.placedBy)
      .filter((id): id is number => id !== null);
    const users = await prisma.users.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });

    const usersMap = new Map(users.map((u) => [u.id, u.name ?? "Sin nombre"]));

    return grouped
      .map((g) => ({
        userId: g.placedBy,
        userName: g.placedBy
          ? (usersMap.get(g.placedBy) ?? "Desconocido")
          : "Desconocido",
        salesCount: g._count.id,
        totalSold: toSafeInteger(g._sum.totalCents ?? 0),
      }))
      .sort((a, b) => b.totalSold - a.totalSold);
  } catch {
    return [];
  }
}
