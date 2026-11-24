"use server";

import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { SalarySchema } from "./schemas";
import { auth } from "../auth";
import { isAdmin } from "../permissions";
import { toBusinessCalendarDate } from "../analytics";
import { lockOpenJornada } from "../ticket-reservations";
import { actionFail, actionOk, type ActionResult } from "../action-result";
import { toSafeInteger } from "@/lib/scaled-values";
import z from "zod";
import { createPaginationSchema, getPaginationMeta, getPaginationOffset, escapeListSearch, type PaginationOptions } from "@/lib/pagination";

export async function saveSalaryPayment(data: {
  userID: number;
  amount: number;
  period: string;
  // No default: the caller must say whether the money left the drawer.
  payment_method: "CASH" | "TRANSFER";
}): Promise<ActionResult> {

  const session = await auth();
  if (!session?.user || !isAdmin(session.user.role)) {
    return actionFail("UNAUTHORIZED");
  }

  const parsed = SalarySchema.omit({ id: true, payDate: true }).safeParse(data);
  
  if (!parsed.success) {
    return actionFail("Datos inválidos", {
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  try {
    const userExists = await prisma.users.findUnique({
      where: { id: parsed.data.userID },
      select: { id: true },
    });
    if (!userExists) {
      return actionFail("Empleado no encontrado");
    }

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
        userSalaryAgg,
        methodSalesAgg,
        methodDebtAgg,
        methodBillsAgg,
        methodSalariesAgg,
        depositsAgg,
      ] = await Promise.all([
        tx.jornada.findUnique({ where: { id: activeJornada.id }, select: { openingAmountCents: true } }),
        tx.salary.aggregate({ where: { userID: parsed.data.userID }, _sum: { amountCents: true } }),
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

      const nextUserSalary = (userSalaryAgg._sum.amountCents ?? BigInt(0)) + amountBig;
      const nextMethodSalaries = (methodSalariesAgg._sum.amountCents ?? BigInt(0)) + amountBig;
      const nextExpected = (method === "CASH" ? (jornadaRow?.openingAmountCents ?? BigInt(0)) : BigInt(0))
        + (methodSalesAgg._sum.totalCents ?? BigInt(0))
        + (methodDebtAgg._sum.amountCents ?? BigInt(0))
        - (methodBillsAgg._sum.amountCents ?? BigInt(0))
        - nextMethodSalaries
        - (depositsAgg._sum.amountCents ?? BigInt(0));

      if (!isSafeBigInt(nextUserSalary) || !isSafeBigInt(nextMethodSalaries) || !isSafeBigInt(nextExpected)) {
        return actionFail("INVALID_INPUT");
      }

      await tx.salary.create({
        data: {
          userID: parsed.data.userID,
          amountCents: amountBig,
          period: parsed.data.period,
          payDate: toBusinessCalendarDate(),
          jornadaId: activeJornada.id,
          payment_method: method,
        },
      });
      return actionOk();
    });
    if (!txResult.success) return txResult;
    revalidatePath("/admin/roster");
    return actionOk();
  } catch (error) {
    console.error(error);
    return actionFail("Error al guardar el pago");
  }
}

export async function getSalaryHistory(options: PaginationOptions<{ userId?: string | number }> = {}) {
  const session = await auth();
  if (!session?.user) return actionFail("UNAUTHENTICATED" as const);
  if (!isAdmin(session.user.role)) return actionFail("FORBIDDEN" as const);
  const parsed = createPaginationSchema({ filters: z.object({ userId: z.union([z.number(), z.string().regex(/^[1-9]\d*$/).transform(Number)]).pipe(z.number().int().positive().max(2_147_483_647)) }).strict(), sortFields: [] }).safeParse(options);
  if (!parsed.success) return actionFail("INVALID_INPUT" as const);
  try {
    return await prisma.$transaction(async tx => {
      const where = { userID: parsed.data.filters.userId, ...(parsed.data.search ? { period: { contains: escapeListSearch(parsed.data.search), mode: "insensitive" as const } } : {}) };
      const total = await tx.salary.count({ where });
      const meta = getPaginationMeta(total, parsed.data);
      const rows = await tx.salary.findMany({ where, orderBy: [{ payDate: { sort: "desc", nulls: "last" } }, { id: "desc" }], skip: getPaginationOffset(meta), take: meta.pageSize });
      const schema = SalarySchema.extend({ amount: z.number().int().safe(), payDate: z.date().nullable(), period: z.string().nullable() });
      return actionOk({ ...meta, items: rows.map(row => schema.parse({ ...row, amount: toSafeInteger(row.amountCents) })) });
    }, { isolationLevel: "RepeatableRead" });
  } catch (error) { console.error(error); return actionFail("QUERY_FAILED" as const); }
}

export async function getPayrollUsersPage(options: PaginationOptions = {}) {
  const session = await auth();
  if (!session?.user) return actionFail("UNAUTHENTICATED" as const);
  if (!isAdmin(session.user.role)) return actionFail("FORBIDDEN" as const);
  const parsed = createPaginationSchema({ filters: z.object({}).strict(), sortFields: [] }).safeParse(options);
  if (!parsed.success) return actionFail("INVALID_INPUT" as const);
  const search = escapeListSearch(parsed.data.search);
  const where = search ? { OR: [{ name: { contains: search, mode: "insensitive" as const } }, { username: { contains: search, mode: "insensitive" as const } }] } : {};
  try {
    return await prisma.$transaction(async tx => {
      const total = await tx.users.count({ where });
      const meta = getPaginationMeta(total, parsed.data);
      const items = await tx.users.findMany({ where, select: { id: true, name: true, username: true, registeredAt: true }, orderBy: [{ name: { sort: "asc", nulls: "last" } }, { id: "asc" }], skip: getPaginationOffset(meta), take: meta.pageSize });
      return actionOk({ ...meta, items });
    }, { isolationLevel: "RepeatableRead" });
  } catch (error) { console.error(error); return actionFail("QUERY_FAILED" as const); }
}

export async function getUserPayrollInfo(userID: number) {
  const session = await auth();
  if (!session?.user || !isAdmin(session.user.role)) return null;
  if (!SalarySchema.shape.userID.safeParse(userID).success) return null;

  try {
    const user = await prisma.users.findUnique({
      where: { id: userID },
      select: { id: true, name: true, username: true, registeredAt: true }
    });
    return user;
  } catch (error) {
    return null;
  }
}
