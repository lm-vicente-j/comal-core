"use server";
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { BillSchema } from "./schemas";
import { auth } from "../auth";
import z from "zod";

export async function saveExpense(data: {
  amount: number;
  category: string;
  description: string;
  date: Date;
  // No default: the caller must say whether the money left the drawer.
  payment_method: "CASH" | "TRANSFER";
}) {

  const session = await auth();
  if (!session?.user) return { success: false, error: "UNAUTHORIZED" };

  // Attribution comes from the authenticated session, never from the client.
  const registeredBy = Number(session.user.id);
  if (!Number.isInteger(registeredBy)) return { success: false, error: "UNAUTHORIZED" };

  const activeJornada = await prisma.jornada.findFirst({
    where: { status: "OPEN" }
  });

  if (!activeJornada) {
    return { success: false, error: "NO_OPEN_JORNADA" };
  }

  const parsed = BillSchema.omit({ id: true, receiptUrl: true }).safeParse({
    ...data,
    registered_by: registeredBy,
  });


  if (!parsed.success) {
    return {
      success: false,
      error: "Datos inválidos",
      fieldErrors: z.flattenError(parsed.error).fieldErrors
    };
  }

  try {
    await prisma.bill.create({
      data: {
        amount: data.amount,
        category: data.category,
        description: data.description,
        date: data.date,
        registered_by: registeredBy,
        jornadaId: activeJornada.id,
        payment_method: data.payment_method
      },
    });
    revalidatePath("/expenses");
    return { success: true };
  } catch (error) {
    console.error(error);
    return { success: false, error: "INTERNAL ERROR" };
  }
}

// Paginated: fetches one page of bills plus the all-time total so the
// summary card stays accurate while the list loads incrementally.
export async function getExpenses(offset = 0, limit = 30) {
  const session = await auth();
  if (!session?.user) return { items: [], total: 0, hasMore: false };

  const safeOffset = Math.max(0, Number.isInteger(offset) ? offset : 0);
  const safeLimit = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 30));

  const [rows, totals] = await Promise.all([
    prisma.bill.findMany({
      // date is day-precision; id breaks same-day ties so new expenses
      // always surface at the top and pagination stays stable.
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      skip: safeOffset,
      // One extra row just to know whether another page exists.
      take: safeLimit + 1,
    }),
    prisma.bill.aggregate({ _sum: { amount: true } }),
  ]);

  const BillReadSchema = BillSchema.extend({
    description: z.string().nullable(),
    category: BillSchema.shape.category.nullable(),
    date: BillSchema.shape.date.nullable(),
  });

  return {
    items: rows.slice(0, safeLimit).map((row) => BillReadSchema.parse(row)),
    total: Number(totals._sum.amount ?? 0),
    hasMore: rows.length > safeLimit,
  };
}
