"use server";

import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { SalarySchema } from "./schemas";
import { auth } from "../auth";
import z from "zod";

export async function saveSalaryPayment(data: {
  userID: number;
  amount: number;
  period: string;
  // No default: the caller must say whether the money left the drawer.
  payment_method: "CASH" | "TRANSFER";
}) {

  const session = await auth();
  if (session?.user?.role !== "ADMIN") {
    return { success: false, error: "UNAUTHORIZED" };
  }

  // The payment belongs to the open jornada so the cash cut can deduct it.
  const activeJornada = await prisma.jornada.findFirst({
    where: { status: "OPEN" },
    select: { id: true }
  });

  if (!activeJornada) {
    return { success: false, error: "NO_OPEN_JORNADA" };
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
    await prisma.salary.create({
      data: {
        userID: data.userID,
        amount: data.amount,
        period: data.period,
        payDate: new Date(),
        jornadaId: activeJornada.id,
        payment_method: data.payment_method,
      },
    });
    revalidatePath("/admin/roster");
    return { success: true };
  } catch (error) {
    console.error(error);
    return { success: false };
  }
}

// Paginated: returns one page of payments and whether more remain.
export async function getSalaryHistory(userID: number, offset = 0, limit = 30) {
  const session = await auth();
  if (!session?.user) return { items: [], hasMore: false };
  if (!SalarySchema.shape.userID.safeParse(userID).success) return { items: [], hasMore: false };

  try {
    const history = await prisma.salary.findMany({
      where: { userID },
      // payDate is day-precision; id breaks same-day ties for stable pages.
      orderBy: [{ payDate: "desc" }, { id: "desc" }],
      skip: offset,
      // One extra row just to know whether another page exists.
      take: limit + 1,
    });
    const SalaryReadSchema = SalarySchema.extend({
      payDate: SalarySchema.shape.payDate.nullable(),
      period: SalarySchema.shape.period.nullable(),
    });
    return {
      items: history.slice(0, limit).map((row) => SalaryReadSchema.parse(row)),
      hasMore: history.length > limit,
    };
  } catch (error) {
    console.error(error);
    return { items: [], hasMore: false };
  }
}

export async function getUserPayrollInfo(userID: number) {
  const session = await auth();
  if (!session?.user) return null;
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
