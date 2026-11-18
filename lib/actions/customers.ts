"use server";

import { success, z } from "zod";
import prisma from "../prisma"
import { revalidatePath } from "next/cache";
import { Customer, CustomerSchema } from "./schemas";
import { auth } from "../auth";


export async function getAllCustomers() {

    const session = await auth();
    if (!session?.user) return [];

    try {
        const customers = await prisma.customer.findMany({
            ...(session.user.role !== "ADMIN" && { select: { id: true, customerName: true, alias: true, lastConsumption: true, registeredDate: true } }),
            orderBy: {
                customerName: 'desc'
            }
        });
        return customers.map((c) => ({
            ...c,
            currentBalance: (c as any).currentBalance !== undefined ? Number((c as any).currentBalance) : undefined,
        }));
    } catch (e) {
        console.error(e);
        return [];
    }

}

// Debounced, server-side customer search for the POS picker. Mirrors
// searchUsers (Roster): filtering happens in the database so the picker
// scales past a client-side list, and only the fields the picker needs are
// returned.
export async function searchCustomers(query: string, limit = 20) {
    const session = await auth();
    if (!session?.user) return [];

    if (typeof query !== "string") return [];

    const trimmed = query.trim();

    try {
        return await prisma.customer.findMany({
            where: trimmed
                ? {
                      OR: [
                          { customerName: { contains: trimmed, mode: "insensitive" } },
                          { alias: { contains: trimmed, mode: "insensitive" } },
                      ],
                  }
                : undefined,
            select: { id: true, customerName: true, alias: true },
            orderBy: { customerName: "asc" },
            take: limit,
        });
    } catch (e) {
        console.error(e);
        return [];
    }
}

export async function saveCustomer(data: Partial<Customer>){

    const session = await auth();
    if (!session?.user) return { success: false, error: "UNAUTHORIZED" };

    const parsed = CustomerSchema.pick({ id: true, customerName: true, phone: true, alias: true }).partial({ id: true }).safeParse(data);

    if (!parsed.success) {
    return { 
        success: false, 
        error: "Datos inválidos",
        fieldErrors: parsed.error.flatten().fieldErrors 
    };
}

    try{
        const { id, customerName, alias } = parsed.data;
        // Only update phone if explicitly provided in input; preserve existing phone if omitted
        const phone = parsed.data.phone !== undefined
            ? (parsed.data.phone?.trim() ? parsed.data.phone.trim() : null)
            : undefined;

        await prisma.customer.upsert({
          where: {id: id ?? -1},
          update: {
            customerName,
            ...(alias !== undefined && { alias }),
            ...(phone !== undefined && { phone }),
          },
          create: {
            customerName,
            alias: alias ?? null,
            phone: phone ?? null,
            currentBalance: 0,
            registeredDate: new Date().toISOString(),
          }
        });

        revalidatePath("/admin/crm");
        return { success: true }

    }catch(e){
      return { success: false, error: "Error on save client" };
    }
}
