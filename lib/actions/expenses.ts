"use server";
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@/app/generated/prisma/client";
import { BillSchema } from "./schemas";
import { actionFail, actionOk, type ActionResult } from "../action-result";
import { auth } from "../auth";
import { toBusinessCalendarDate } from "../analytics";
import { lockOpenJornada } from "../ticket-reservations";
import { toSafeInteger } from "@/lib/scaled-values";
import z from "zod";
import { createPaginationSchema, getPaginationMeta, getPaginationOffset, escapeListSearch, type PaginationOptions } from "@/lib/pagination";
import { getCurrentAuthorization } from "@/lib/server-permissions";

export async function saveExpense(data: {
  amount: number;
  category: string;
  description: string;
  date: Date;
  // No default: the caller must say whether the money left the drawer.
  payment_method: "CASH" | "TRANSFER";
}): Promise<ActionResult> {

  const authorization = await getCurrentAuthorization();
  if (!authorization) return actionFail("UNAUTHORIZED");
  if (!authorization.permissions["expenses.create"]) return actionFail("FORBIDDEN");

  // Attribution comes from the authenticated session, never from the client.
  const registeredBy = authorization.userId;
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

export async function getExpenses(options: PaginationOptions = {}) {
  const session = await auth();
  if (!session?.user) return actionFail("UNAUTHENTICATED" as const);
  const authorization = await getCurrentAuthorization();
  if (!authorization || (!authorization.permissions["reports.operational"] && !authorization.permissions["expenses.create"])) return actionFail("FORBIDDEN" as const);
  const parsed = createPaginationSchema({ filters: z.object({}).strict(), sortFields: [] }).safeParse(options);
  if (!parsed.success) return actionFail("INVALID_INPUT" as const);
  try {
    return await prisma.$transaction(async tx => {
      const ownScope: Prisma.billWhereInput = authorization.permissions["reports.operational"] ? {} : { registered_by: authorization.userId };
      const where: Prisma.billWhereInput = { ...ownScope, ...(parsed.data.search ? { OR: [{ category: { contains: escapeListSearch(parsed.data.search), mode: "insensitive" } }, { description: { contains: escapeListSearch(parsed.data.search), mode: "insensitive" } }] } : {}) };
      const total = await tx.bill.count({ where });
      const meta = getPaginationMeta(total, parsed.data);
      const [rows, totals, latest] = await Promise.all([
        tx.bill.findMany({ where, orderBy: [{ date: { sort: "desc", nulls: "last" } }, { id: "desc" }], skip: getPaginationOffset(meta), take: meta.pageSize }),
        tx.bill.aggregate({ where: ownScope, _sum: { amountCents: true } }),
        tx.bill.findFirst({ where: ownScope, orderBy: [{ date: { sort: "desc", nulls: "last" } }, { id: "desc" }], select: { category: true } }),
      ]);
      const schema = BillSchema.extend({ amount: z.number().int().safe(), description: z.string().nullable(), category: z.string().nullable(), date: z.date().nullable(), receiptUrl: z.string().nullable() });
      return actionOk({ ...meta, items: rows.map(row => schema.parse({ ...row, amount: toSafeInteger(row.amountCents) })), summary: { totalAmount: toSafeInteger(totals._sum.amountCents ?? 0), latestCategory: latest?.category ?? null } });
    }, { isolationLevel: "RepeatableRead" });
  } catch (error) { console.error(error); return actionFail("QUERY_FAILED" as const); }
}
