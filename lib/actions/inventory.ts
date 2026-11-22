"use server"
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { RecipesSchema, SupplySchema, type Supply } from "./schemas";
import { actionFail, actionOk, type ActionResult } from "../action-result";
import z from "zod";

export async function saveSupply(data: Supply): Promise<ActionResult> {

    const session = await auth();
    if (session?.user?.role !== "ADMIN") return actionFail("PERMISSION DENIED");


    const parsedData = {
        ...data,
        unitCost: Number(data.unitCost),
        currentStock: Number(data.currentStock)
    };

    const result = SupplySchema.safeParse(parsedData);
    
   if (!result.success) {
        return actionFail("Datos inválidos", {
            fieldErrors: z.flattenError(result.error).fieldErrors,
        });
    }
        
    

    const { id, name, measureUnit, currentStock, unitCost } = result.data;

    try {
        await prisma.supplies.upsert({
            where: { id: id ?? -1 },
            update: { name, measureUnit, currentStock, unitCost },
            create: { name, measureUnit, currentStock, unitCost },
        });
        revalidatePath("/admin/inventory");
        return actionOk();
    } catch (e) {

        return actionFail("INTERNAL ERROR");
    }
}

export async function getSuppliesData() {
    const session = await auth();
    if (!session?.user) return [];

    try {
        return await prisma.supplies.findMany({
             ...(session.user.role !== "ADMIN" && { select: { id: true, name: true, measureUnit: true, currentStock: true, active: true } }),
             orderBy: { name: 'asc' },
             where:{ 
                active: true
             }
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
