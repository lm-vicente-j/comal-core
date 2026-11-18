"use server"
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { RecipesSchema, SupplySchema, type Supply } from "./schemas";
import z from "zod";

export async function saveSupply(data: Supply) {

    const session = await auth();
    if (session?.user?.role !== "ADMIN") return { success: false, error: "PERMISSION DENIED" };


    const parsedData = {
        ...data,
        unitCost: Number(data.unitCost),
        currentStock: Number(data.currentStock)
    };

    const result = SupplySchema.safeParse(parsedData);
    
   if (!result.success) {
        return {  
            success: false, 
            error: "Datos inválidos", 
            fieldErrors: z.flattenError(result.error).fieldErrors
        };
    }
        
    

    const { id, name, measureUnit, currentStock, unitCost } = result.data;

    try {
        await prisma.supplies.upsert({
            where: { id: id ?? -1 },
            update: { name, measureUnit, currentStock, unitCost },
            create: { name, measureUnit, currentStock, unitCost },
        });
        revalidatePath("/admin/inventory");
        return { success: true };
    } catch (e) {

        return {  success: false, error: "INTERNAL ERROR" };
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
export async function deleteSupply(id: number){
    
    const session = await auth();
    if (session?.user?.role !== "ADMIN") return { success: false, error: "PERMISSION DENIED" };

    if (!RecipesSchema.shape.supplyID.safeParse(id).success) return { success: false, error: "INVALID_INPUT" };

    try {
        await prisma.supplies.update({
            where: { id: id ?? -1 },
            data: { active:false },
        });
        revalidatePath("/admin/inventory");
        return { success: true };
    } catch (e) {

        return {  success: false, error: "INTERNAL ERROR" };
    }
}
