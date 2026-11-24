"use server"
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { RecipesSchema, SupplySchema, type Supply } from "./schemas";
import { actionFail, actionOk, type ActionResult } from "../action-result";
import z from "zod";
import { toSafeInteger } from "@/lib/scaled-values";
import { createPaginationSchema, escapeListSearch, getPaginationMeta, getPaginationOffset } from "@/lib/pagination";

export async function saveSupply(data: Supply): Promise<ActionResult> {

    const session = await auth();
    if (session?.user?.role !== "ADMIN") return actionFail("PERMISSION DENIED");


    if (!data || typeof data !== "object") {
        return actionFail("Datos inválidos");
    }

    const rawUnitCost: unknown = (data as Record<string, unknown>).unitCost;
    const rawCurrentStock: unknown = (data as Record<string, unknown>).currentStock;
    const parseStrictInt = (val: unknown) =>
        typeof val === "number"
            ? val
            : typeof val === "string" && /^-?\d+$/.test(val.trim())
                ? Number(val.trim())
                : val;

    const parsedData = {
        ...data,
        unitCost: parseStrictInt(rawUnitCost),
        currentStock: parseStrictInt(rawCurrentStock)
    };

    const result = SupplySchema.safeParse(parsedData);
    
   if (!result.success) {
        return actionFail("Datos inválidos", {
            fieldErrors: z.flattenError(result.error).fieldErrors,
        });
    }
        
    

    const { id, name, measureUnit, currentStock, unitCost } = result.data;

    try {
        if (id !== undefined) {
            const { count } = await prisma.supplies.updateMany({
                where: { id, active: true },
                data: { name, measureUnit, currentStockMilliunits: BigInt(currentStock), unitCostCents: BigInt(unitCost) },
            });
            if (count === 0) {
                return actionFail("Insumo no encontrado");
            }
        } else {
            await prisma.supplies.create({
                data: { name, measureUnit, currentStockMilliunits: BigInt(currentStock), unitCostCents: BigInt(unitCost) },
            });
        }
        revalidatePath("/admin/inventory");
        revalidatePath("/admin/menu");
        return actionOk();
    } catch (e) {

        return actionFail("INTERNAL ERROR");
    }
}

export async function getSuppliesData() {
    const session = await auth();
    if (!session?.user) return [];

    try {
        const supplies = await prisma.supplies.findMany({
             ...(session.user.role !== "ADMIN" && { select: { id: true, name: true, measureUnit: true, currentStockMilliunits: true, active: true } }),
             orderBy: { name: 'asc' },
             where:{ 
                active: true
             }
        });
        return supplies.map(({ currentStockMilliunits, ...supply }) => {
            const { unitCostCents, ...rest } = supply as typeof supply & { unitCostCents?: bigint };
            return { ...rest, currentStock: toSafeInteger(currentStockMilliunits), ...(unitCostCents !== undefined && { unitCost: toSafeInteger(unitCostCents) }) };
        });
    } catch (e) {
        return [];
    }
}

export async function getSupplyPage(query: unknown = {}) {
    const session = await auth();
    if (!session?.user) return actionFail("UNAUTHENTICATED");
    if (session.user.role !== "ADMIN") return actionFail("FORBIDDEN");
    const input = createPaginationSchema({ filters: z.object({ stock: z.enum(["in-stock", "out-of-stock"]).optional() }).strict().optional(), sortFields: ["name", "measureUnit", "currentStock", "unitCost"], defaultSort: "name", defaultOrder: "asc" }).safeParse(query);
    if (!input.success) return actionFail("INVALID_INPUT");
    const { search, sort, order = "asc", filters } = input.data;
    const field = sort === "currentStock" ? "currentStockMilliunits" : sort === "unitCost" ? "unitCostCents" : sort === "measureUnit" ? "measureUnit" : "name";
    const where = { active: true, ...(search ? { name: { contains: escapeListSearch(search), mode: "insensitive" as const } } : {}),
        ...(filters?.stock === "in-stock" ? { currentStockMilliunits: { gt: BigInt(0) } } : filters?.stock === "out-of-stock" ? { currentStockMilliunits: { lte: BigInt(0) } } : {}) };
    try {
        return await prisma.$transaction(async (tx) => {
            const total = await tx.supplies.count({ where });
            const meta = getPaginationMeta(total, input.data);
            const rows = await tx.supplies.findMany({ where, orderBy: [{ [field]: order }, { id: order }], take: meta.pageSize, skip: getPaginationOffset(meta) });
            return actionOk({ ...meta, items: rows.map(({ currentStockMilliunits, unitCostCents, ...supply }) => ({ ...supply, currentStock: toSafeInteger(currentStockMilliunits), unitCost: toSafeInteger(unitCostCents) })) });
        }, { isolationLevel: "RepeatableRead" });
    } catch (error) { console.error(error); return actionFail("QUERY_FAILED"); }
}

// Soft delete: Mark as inactive
export async function deleteSupply(id: number): Promise<ActionResult> {
    
    const session = await auth();
    if (session?.user?.role !== "ADMIN") return actionFail("PERMISSION DENIED");

    if (!RecipesSchema.shape.supplyID.safeParse(id).success) return actionFail("INVALID_INPUT");

    try {
        await prisma.supplies.update({
            where: { id: id ?? -1 },
            data: { active:false },
        });
        revalidatePath("/admin/inventory");
        return actionOk();
    } catch (e) {

        return actionFail("INTERNAL ERROR");
    }
}
