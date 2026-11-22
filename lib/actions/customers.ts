"use server";

import { success, z } from "zod";
import prisma from "../prisma"
import { revalidatePath } from "next/cache";
import { Customer, CustomerSchema } from "./schemas";
import { actionFail, actionOk, type ActionResult } from "../action-result";
import { auth } from "../auth";
import { isAdmin } from "../permissions";
import { toBusinessCalendarDate } from "../analytics";
import { AdminListQuerySchema, escapeListSearch } from "@/components/pagination/schema";
import { toSafeInteger } from "@/lib/scaled-values";
import { Prisma } from "@/app/generated/prisma/client";


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
        return customers.map((c) => {
            const { currentBalanceCents, ...rest } = c;
            return { ...rest, currentBalance: currentBalanceCents === undefined ? undefined : toSafeInteger(currentBalanceCents) };
        });
    } catch (e) {
        console.error(e);
        return [];
    }

}

// Debounced, server-side customer search for the POS picker. Mirrors
// searchUsers (Roster): filtering happens in the database so the picker
// scales past a client-side list, and only the fields the picker needs are
// returned.
export async function getCustomerPage(query: unknown = {}) {
    const session = await auth();
    const input = AdminListQuerySchema.safeParse(query);
    if (!isAdmin(session?.user?.role) || !input.success) return { rows: [], total: 0, page: 1 };

    const { pageSize, search, sort, desc } = input.data;
    const field = sort === "customerName" || sort === "alias" || sort === "phone" || sort === "currentBalance" ? sort : "registeredDate";
    const direction = (desc ?? field === "registeredDate") ? "desc" : "asc";
    const term = escapeListSearch(search);
    const where = term
        ? {
            OR: [
                { customerName: { contains: term, mode: "insensitive" as const } },
                { alias: { contains: term, mode: "insensitive" as const } },
            ],
        }
        : undefined;

    const total = await prisma.customer.count({ where });
    const page = Math.min(input.data.page, Math.max(1, Math.ceil(total / pageSize)));
    const offset = (page - 1) * pageSize;
    const nameDirection = direction === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    // Preserve the CRM's Spanish primary-strength sort before applying pagination.
    const rows = field === "customerName"
        ? await prisma.$queryRaw<Prisma.customerGetPayload<{}>[]>(Prisma.sql`
            SELECT c.* FROM "customer" c
            ${term ? Prisma.sql`WHERE (c."customerName" ILIKE ${`%${term}%`} OR c."alias" ILIKE ${`%${term}%`})` : Prisma.empty}
            ORDER BY coalesce(c."customerName", '') COLLATE "comal_customer_name_es" ${nameDirection}, c."id" ${nameDirection}
            LIMIT ${pageSize} OFFSET ${offset}
        `)
        : await prisma.customer.findMany({
            where,
            orderBy: [
                field === "currentBalance" ? { currentBalanceCents: direction } : { [field]: { sort: direction, nulls: "last" } },
                { id: direction },
            ],
            take: pageSize,
            skip: offset,
        });
    return { rows: rows.map(({ currentBalanceCents, ...customer }) => ({ ...customer, currentBalance: toSafeInteger(currentBalanceCents) })), total, page };
}

export async function searchCustomers(query: string, limit = 20) {
    const session = await auth();
    if (!session?.user) return [];

    if (typeof query !== "string") return [];

    const safeLimit = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 20));
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
            take: safeLimit,
        });
    } catch (e) {
        console.error(e);
        return [];
    }
}

export async function saveCustomer(data: Partial<Customer>): Promise<ActionResult> {

    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) return actionFail("UNAUTHORIZED");

    const parsed = CustomerSchema.pick({ id: true, customerName: true, phone: true, alias: true }).partial({ id: true }).safeParse(data);

    if (!parsed.success) {
        return actionFail("Datos inválidos", {
            fieldErrors: parsed.error.flatten().fieldErrors,
        });
    }

    try{
        const { id, customerName, alias } = parsed.data;
        // Only update phone if explicitly provided in input; preserve existing phone if omitted
        const phone = parsed.data.phone !== undefined
            ? (parsed.data.phone?.trim() ? parsed.data.phone.trim() : null)
            : undefined;

        if (id !== undefined) {
            const existing = await prisma.customer.findUnique({
                where: { id },
                select: { id: true },
            });
            if (!existing) {
                return actionFail("Cliente no encontrado");
            }

            await prisma.customer.update({
                where: { id },
                data: {
                    customerName,
                    ...(alias !== undefined && { alias: alias || null }),
                    ...(phone !== undefined && { phone }),
                },
            });
        } else {
            await prisma.customer.create({
                data: {
                    customerName,
                    alias: alias || null,
                    phone: phone ?? null,
                    currentBalanceCents: BigInt(0),
                    registeredDate: toBusinessCalendarDate(),
                },
            });
        }

        revalidatePath("/admin/crm");
        revalidatePath("/pos");
        return actionOk();

    }catch(e){
      return actionFail("Error on save client");
    }
}
