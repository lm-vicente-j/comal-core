"use server";
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { BillSchema } from "./schemas";
import { actionFail, actionOk, type ActionResult } from "../action-result";
import { auth } from "../auth";
import { toBusinessCalendarDate } from "../analytics";
import { lockOpenJornada } from "../ticket-reservations";
import { Decimal } from "@prisma/client/runtime/client";
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
    const saved = await prisma.$transaction(async (tx) => {
      const activeJornada = await lockOpenJornada(tx);
      if (!activeJornada) return false;

      await tx.bill.create({
        data: {
          amount: parsed.data.amount,
          category: parsed.data.category,
          description: parsed.data.description,
          date: toBusinessCalendarDate(parsed.data.date),
          registered_by: registeredBy,
          jornadaId: activeJornada.id,
          payment_method: parsed.data.payment_method
        },
      });
      return true;
    });
    if (!saved) return actionFail("NO_OPEN_JORNADA");
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
      prisma.bill.aggregate({ _sum: { amount: true } }),
    ]);

    const BillReadSchema = BillSchema.extend({
      amount: z.union([z.number(), z.instanceof(Decimal)]).transform((val) => Number(val)),
      description: z.string().nullable(),
      category: z.string().nullable(),
      date: z.date().nullable(),
      receiptUrl: z.string().nullable(),
    });

    return {
      items: rows.slice(0, safeLimit).map((row) => BillReadSchema.parse(row)),
      total: Number(totals._sum.amount ?? 0),
      hasMore: rows.length > safeLimit,
    };
  } catch (error) {
    console.error(error);
    return { items: [], total: 0, hasMore: false };
  }
}
