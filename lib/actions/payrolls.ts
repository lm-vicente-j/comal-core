"use server";

import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { SalarySchema } from "./schemas";
import { auth } from "../auth";
import { isAdmin } from "../permissions";
import { toBusinessCalendarDate } from "../analytics";
import { lockOpenJornada } from "../ticket-reservations";
import { Decimal } from "@prisma/client/runtime/client";
import z from "zod";

export async function saveSalaryPayment(data: {
  userID: number;
  amount: number;
  period: string;
  // No default: the caller must say whether the money left the drawer.
  payment_method: "CASH" | "TRANSFER";
}) {

  const session = await auth();
  if (!session?.user || !isAdmin(session.user.role)) {
    return { success: false, error: "UNAUTHORIZED" };
  }

  const parsed = SalarySchema.omit({ id: true, payDate: true }).safeParse(data);
  
  if (!parsed.success) {
    return {
      success: false,
      error: "Datos inválidos",
      fieldErrors: z.flattenError(parsed.error).fieldErrors
    };
  }

  try {
    const userExists = await prisma.users.findUnique({
      where: { id: parsed.data.userID },
      select: { id: true },
    });
    if (!userExists) {
      return { success: false, error: "Empleado no encontrado" };
    }

    const saved = await prisma.$transaction(async (tx) => {
      const activeJornada = await lockOpenJornada(tx);
      if (!activeJornada) return false;

      await tx.salary.create({
        data: {
          userID: parsed.data.userID,
          amount: parsed.data.amount,
          period: parsed.data.period,
          payDate: toBusinessCalendarDate(),
          jornadaId: activeJornada.id,
          payment_method: parsed.data.payment_method,
        },
      });
      return true;
    });
    if (!saved) return { success: false, error: "NO_OPEN_JORNADA" };
    revalidatePath("/admin/roster");
    return { success: true };
  } catch (error) {
    console.error(error);
    return { success: false, error: "Error al guardar el pago" };
  }
}

// Paginated: returns one page of payments and whether more remain.
export async function getSalaryHistory(userID: number, offset = 0, limit = 30) {
  const session = await auth();
  if (!session?.user || !isAdmin(session.user.role)) return { items: [], hasMore: false };
  if (!SalarySchema.shape.userID.safeParse(userID).success) return { items: [], hasMore: false };

  const safeOffset = Math.min(2_147_483_647, Math.max(0, Number.isInteger(offset) ? offset : 0));
  const safeLimit = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 30));

  try {
    const history = await prisma.salary.findMany({
      where: { userID },
      // payDate is day-precision; id breaks same-day ties for stable pages.
      orderBy: [{ payDate: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      skip: safeOffset,
      // One extra row just to know whether another page exists.
      take: safeLimit + 1,
    });
    const SalaryReadSchema = SalarySchema.extend({
      amount: z.union([z.number(), z.instanceof(Decimal)]).transform((v) => Number(v)),
      payDate: z.date().nullable(),
      period: z.string().nullable(),
    });
    return {
      items: history.slice(0, safeLimit).map((row) => SalaryReadSchema.parse(row)),
      hasMore: history.length > safeLimit,
    };
  } catch (error) {
    console.error(error);
    return { items: [], hasMore: false };
  }
}

export async function getUserPayrollInfo(userID: number) {
  const session = await auth();
  if (!session?.user || !isAdmin(session.user.role)) return null;
  if (!SalarySchema.shape.userID.safeParse(userID).success) return null;

  try {
    const user = await prisma.users.findUnique({
      where: { id: userID },
      select: { name: true, registeredAt: true }
    });
    return user;
  } catch (error) {
    return null;
  }
}
