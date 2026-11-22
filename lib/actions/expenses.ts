"use server";
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { BillSchema } from "./schemas";
import { actionFail, actionOk, type ActionResult } from "../action-result";
import { auth } from "../auth";
import { toBusinessCalendarDate } from "../analytics";
import { lockOpenJornada } from "../ticket-reservations";
import { toSafeInteger } from "@/lib/scaled-values";
import z from "zod";

export async function saveExpense(data: {
  amount: number;
  category: string;
  description: string;
  date: Date;
  // No default: the caller must say whether the money left the drawer.
  payment_method: "CASH" | "TRANSFER";
}): Promise<ActionResult> {

  const session = await auth();
  if (!session?.user) return actionFail("UNAUTHORIZED");

  // Attribution comes from the authenticated session, never from the client.
  const registeredBy = Number(session.user.id);
  if (!Number.isInteger(registeredBy) || registeredBy <= 0 || registeredBy > 2_147_483_647) return actionFail("UNAUTHORIZED");

  const parsed = BillSchema.omit({ id: true, receiptUrl: true })
    .extend({
      category: z
        .string({ message: "La categoría es requerida" })
        .trim()
        .min(1, "La categoría es requerida")
        .max(50, "La categoría no puede superar 50 caracteres"),
    })
    .safeParse({
      ...data,
      registered_by: registeredBy,
    });


  if (!parsed.success) {
    return actionFail("Datos inválidos", {
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  try {
    const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
    const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
    const isSafeBigInt = (v: bigint) => v >= MIN_SAFE_BIGINT && v <= MAX_SAFE_BIGINT;
    const amountBig = BigInt(parsed.data.amount);
    const method = parsed.data.payment_method;

    const txResult = await prisma.$transaction(async (tx): Promise<ActionResult> => {
      const activeJornada = await lockOpenJornada(tx);
      if (!activeJornada) return actionFail("NO_OPEN_JORNADA");

      const [
        jornadaRow,
        allBillsAgg,
        methodSalesAgg,
        methodDebtAgg,
        methodBillsAgg,
        methodSalariesAgg,
        depositsAgg,
      ] = await Promise.all([
        tx.jornada.findUnique({ where: { id: activeJornada.id }, select: { openingAmountCents: true } }),
        tx.bill.aggregate({ _sum: { amountCents: true } }),
        tx.sales.aggregate({
          where: { jornadaId: activeJornada.id, status: "PAID", debtors: { is: null }, payment_method: method },
          _sum: { totalCents: true },
        }),
        tx.debtors.aggregate({
          where: { paidJornadaId: activeJornada.id, status: "PAID", sales: { status: "PAID", payment_method: method } },
          _sum: { amountCents: true },
        }),
        tx.bill.aggregate({ where: { jornadaId: activeJornada.id, payment_method: method }, _sum: { amountCents: true } }),
        tx.salary.aggregate({ where: { jornadaId: activeJornada.id, payment_method: method }, _sum: { amountCents: true } }),
        method === "CASH"
          ? tx.savings_movement.aggregate({ where: { jornadaId: activeJornada.id, type: "DEPOSIT" }, _sum: { amountCents: true } })
          : Promise.resolve({ _sum: { amountCents: null } }),
      ]);

      const nextAllBills = (allBillsAgg._sum.amountCents ?? BigInt(0)) + amountBig;
      const nextMethodBills = (methodBillsAgg._sum.amountCents ?? BigInt(0)) + amountBig;
      const nextExpected = (method === "CASH" ? (jornadaRow?.openingAmountCents ?? BigInt(0)) : BigInt(0))
        + (methodSalesAgg._sum.totalCents ?? BigInt(0))
        + (methodDebtAgg._sum.amountCents ?? BigInt(0))
        - nextMethodBills
        - (methodSalariesAgg._sum.amountCents ?? BigInt(0))
        - (depositsAgg._sum.amountCents ?? BigInt(0));

      if (!isSafeBigInt(nextAllBills) || !isSafeBigInt(nextMethodBills) || !isSafeBigInt(nextExpected)) {
        return actionFail("INVALID_INPUT");
      }

      await tx.bill.create({
        data: {
          amountCents: amountBig,
          category: parsed.data.category,
          description: parsed.data.description,
          date: toBusinessCalendarDate(parsed.data.date),
          registered_by: registeredBy,
          jornadaId: activeJornada.id,
          payment_method: method
        },
      });
      return actionOk();
    });
    if (!txResult.success) return txResult;
    revalidatePath("/expenses");
    return actionOk();
  } catch (error) {
    console.error(error);
    return actionFail("INTERNAL ERROR");
  }
}

// Paginated: fetches one page of bills plus the all-time total so the
// summary card stays accurate while the list loads incrementally.
export async function getExpenses(offset = 0, limit = 30) {
  const session = await auth();
  if (!session?.user) return { items: [], total: 0, hasMore: false };

  const safeOffset = Math.min(2_147_483_647, Math.max(0, Number.isInteger(offset) ? offset : 0));
  const safeLimit = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 30));

  try {
    const [rows, totals] = await Promise.all([
      prisma.bill.findMany({
        // date is day-precision; id breaks same-day ties so new expenses
        // always surface at the top and pagination stays stable.
        orderBy: [{ date: { sort: "desc", nulls: "last" } }, { id: "desc" }],
        skip: safeOffset,
        // One extra row just to know whether another page exists.
        take: safeLimit + 1,
      }),
      prisma.bill.aggregate({ _sum: { amountCents: true } }),
    ]);

    const BillReadSchema = BillSchema.extend({
      amount: z.number().int().safe(),
      description: z.string().nullable(),
      category: z.string().nullable(),
      date: z.date().nullable(),
      receiptUrl: z.string().nullable(),
    });

    return {
      items: rows.slice(0, safeLimit).map((row) => BillReadSchema.parse({ ...row, amount: toSafeInteger(row.amountCents) })),
      total: toSafeInteger(totals._sum.amountCents ?? 0),
      hasMore: rows.length > safeLimit,
    };
  } catch (error) {
    console.error(error);
    return { items: [], total: 0, hasMore: false };
  }
}
