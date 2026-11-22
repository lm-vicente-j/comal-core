"use server"
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { RecipesSchema, SupplySchema, type Supply } from "./schemas";
import { actionFail, actionOk, type ActionResult } from "../action-result";
import z from "zod";
import { toSafeInteger } from "@/lib/scaled-values";

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
