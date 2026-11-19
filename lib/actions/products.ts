"use server"
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { ProductSchema, SaleItemsSchema, type Product } from "./schemas";
import z from "zod";

export async function saveProduct(data: Product) {
    // Check role
    const session = await auth();
    const role = session?.user?.role || "NONE";

    if (role != "ADMIN") return { success: false, error: "PERMISSION DENIED" };

    const parsedData = {
        ...data,
        price: Number(data.price)
    };

    const result = ProductSchema.safeParse(parsedData);
    if (!result.success) {
        return {
            success: false,
            error: "Datos inválidos",
            fieldErrors: z.flattenError(result.error).fieldErrors
        };
    }

    let { id, name, price, recipes } = result.data;
    id = id == undefined ? -1 : id;

    const recipeForCost = recipes ?? (id !== -1
        ? (await prisma.recipes.findMany({
            where: { productID: id },
            select: { supplyID: true, quantityUsed: true }
        })).map(r => ({ ...r, quantityUsed: Number(r.quantityUsed) }))
        : []);

    // The sale price must be strictly greater than the recipe's base cost.
    if (recipeForCost.length > 0) {
        const supplyRows = await prisma.supplies.findMany({
            where: { id: { in: recipeForCost.map(r => r.supplyID) } },
            select: { id: true, unitCost: true }
        });
        const costById = new Map(supplyRows.map(s => [s.id, Number(s.unitCost)]));
        const rawBaseCost = recipeForCost.reduce((acc, r) => acc + (costById.get(r.supplyID) ?? 0) * r.quantityUsed, 0);
        // Round to 2 decimal places to prevent IEEE-754 precision issues (e.g. 0.7 + 0.1)
        const baseCost = Math.round((rawBaseCost + Number.EPSILON) * 100) / 100;

        if (price <= baseCost) {
            return {
                success: false,
                error: "Datos inválidos",
                fieldErrors: { price: ["El precio debe ser mayor al costo base"] }
            };
        }
    }

    try {
        await prisma.products.upsert({
            where: { id: id },
            update: {
                name,
                price,
                // Leave the stored recipe untouched when the caller omits it.
                ...(recipes !== undefined && {
                    recipes: {
                        deleteMany: {},
                        create: recipes.map(r => ({
                            supplyID: r.supplyID,
                            quantityUsed: r.quantityUsed
                        }))
                    }
                })
            },
            create: {
                name,
                price,
                recipes: {
                    create: recipes?.map(r => ({
                        supplyID: r.supplyID,
                        quantityUsed: r.quantityUsed
                    }))
                }
            },
        });


        revalidatePath("/pos")
        revalidatePath("/admin/inventory")
        revalidatePath("/admin/menu")
        return { success: true }
    } catch (e) {

        return { success: false, error: "ERROR IN UPSERT OPERATION" }
    }

}

export async function deleteProduct(id: number) {
    // Check role
    const session = await auth();
    const role = session?.user?.role || "NONE";

    if (role != "ADMIN") {
        return {
            error: "PERMISSION DENIED"
        }
    }

    if (!SaleItemsSchema.shape.productID.safeParse(id).success) return { error: "INVALID_INPUT" };

    try {
        await prisma.products.delete({ where: { id } })
        revalidatePath("/pos")
        revalidatePath("/admin/inventory")
        revalidatePath("/admin/menu")
        return { success: true }
    } catch (e) {
        return { success: false, error: "ERROR, ASSOCIATED RECIPE    " }
    }

}

export async function getProductsData() {

    const session = await auth();
    if (!session?.user) return [];

    try {
        return await prisma.products.findMany({
            include: {
                recipes: {
                    include: { supplies: session.user.role === "ADMIN" ? true : { select: { id: true, name: true, measureUnit: true, currentStock: true, active: true } } }
                }
            },
            orderBy: { name: 'asc' }
        });


    } catch (e) {
        return []
    }


}
