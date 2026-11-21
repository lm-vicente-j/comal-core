"use server"
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { ProductSchema, SaleItemsSchema, type Product } from "./schemas";
import z from "zod";
import { AdminListQuerySchema, escapeListSearch } from "@/components/pagination/schema";

export async function saveProduct(data: Product) {
    // Check role
    const session = await auth();
    const role = session?.user?.role || "NONE";

    if (role != "ADMIN") return { success: false, error: "PERMISSION DENIED" };

    if (!data || typeof data !== "object") {
        return { success: false, error: "Datos inválidos" };
    }

    const rawPrice: unknown = (data as Record<string, unknown>).price;
    const normalizedPrice =
        typeof rawPrice === "number"
            ? rawPrice
            : typeof rawPrice === "string" && rawPrice.trim() !== ""
                ? Number(rawPrice)
                : rawPrice;

    const parsedData = {
        ...data,
        price: normalizedPrice
    };

    const result = ProductSchema.safeParse(parsedData);
    if (!result.success) {
        return {
            success: false,
            error: "Datos inválidos",
            fieldErrors: z.flattenError(result.error).fieldErrors
        };
    }

    const { id, name, price, recipes } = result.data;
    const isUpdate = id !== undefined;

    try {
        const saved = await prisma.$transaction(async (tx) => {
            if (isUpdate) {
                await tx.$executeRaw`SELECT id FROM products WHERE id = ${id} FOR UPDATE`;
                const existing = await tx.products.findUnique({
                    where: { id },
                    select: { id: true },
                });
                if (!existing) {
                    return { success: false, error: "Producto no encontrado" };
                }
            }

            // Reject duplicate product names cleanly with fieldErrors
            const duplicateName = await tx.products.findFirst({
                where: { name, ...(isUpdate ? { id: { not: id } } : {}) },
                select: { id: true },
            });
            if (duplicateName) {
                return {
                    success: false,
                    error: "Datos inválidos",
                    fieldErrors: { name: ["Ya existe un producto con ese nombre"] },
                };
            }

            // Merge duplicate supplyIDs if provided and verify every referenced supply exists
            let normalizedRecipes = recipes;
            if (recipes !== undefined) {
                const merged = new Map<number, number>();
                for (const r of recipes) {
                    const nextQty = (merged.get(r.supplyID) ?? 0) + r.quantityUsed;
                    if (!ProductSchema.shape.recipes.unwrap().element.shape.quantityUsed.safeParse(nextQty).success) {
                        return {
                            success: false,
                            error: "Datos inválidos",
                            fieldErrors: { recipes: ["La cantidad utilizada del insumo es inválida."] },
                        };
                    }
                    merged.set(r.supplyID, nextQty);
                }
                normalizedRecipes = Array.from(merged.entries()).map(([supplyID, quantityUsed]) => ({
                    supplyID,
                    quantityUsed,
                }));
            }

            const recipeForCost = normalizedRecipes ?? (isUpdate
                ? (await tx.recipes.findMany({
                    where: { productID: id },
                    select: { supplyID: true, quantityUsed: true }
                })).map(r => ({ ...r, quantityUsed: Number(r.quantityUsed) }))
                : []);

            // The sale price must be strictly greater than the recipe's base cost.
            if (recipeForCost.length > 0) {
                const supplyRows = await tx.supplies.findMany({
                    where: { id: { in: recipeForCost.map(r => r.supplyID) } },
                    select: { id: true, unitCost: true }
                });
                if (normalizedRecipes !== undefined && supplyRows.length !== normalizedRecipes.length) {
                    return {
                        success: false,
                        error: "Datos inválidos",
                        fieldErrors: { recipes: ["Uno o más insumos no existen"] },
                    };
                }
                const costById = new Map(supplyRows.map(s => [s.id, Number(s.unitCost)]));
                const rawBaseCost = recipeForCost.reduce((acc, r) => acc + (costById.get(r.supplyID) ?? 0) * r.quantityUsed, 0);
                // Round to 2 decimal places to prevent IEEE-754 precision issues (e.g. 0.7 + 0.1)
                const baseCost = Math.round((rawBaseCost + Number.EPSILON) * 100) / 100;

                if (!Number.isFinite(rawBaseCost) || !Number.isFinite(baseCost)) {
                    return {
                        success: false,
                        error: "Datos inválidos",
                        fieldErrors: { recipes: ["La cantidad utilizada del insumo es inválida."] },
                    };
                }

                if (price <= baseCost) {
                    return {
                        success: false,
                        error: "Datos inválidos",
                        fieldErrors: { price: ["El precio debe ser mayor al costo base"] }
                    };
                }
            }

            if (isUpdate) {
                await tx.products.update({
                    where: { id },
                    data: {
                        name,
                        price,
                        // Leave the stored recipe untouched when the caller omits it.
                        ...(normalizedRecipes !== undefined && {
                            recipes: {
                                deleteMany: {},
                                create: normalizedRecipes.map(r => ({
                                    supplyID: r.supplyID,
                                    quantityUsed: r.quantityUsed
                                }))
                            }
                        })
                    },
                });
            } else {
                await tx.products.create({
                    data: {
                        name,
                        price,
                        recipes: {
                            create: normalizedRecipes?.map(r => ({
                                supplyID: r.supplyID,
                                quantityUsed: r.quantityUsed
                            }))
                        }
                    },
                });
            }
            return { success: true };
        });
        if (!saved.success) return saved;

        revalidatePath("/pos");
        revalidatePath("/admin/inventory");
        revalidatePath("/admin/menu");
        return saved;
    } catch (e) {
        return { success: false, error: "ERROR IN UPSERT OPERATION" };
    }

}

export async function deleteProduct(id: number) {
    // Check role
    const session = await auth();
    const role = session?.user?.role || "NONE";

    if (role != "ADMIN") {
        return {
            success: false,
            error: "PERMISSION DENIED"
        }
    }

    if (!SaleItemsSchema.shape.productID.safeParse(id).success) return { success: false, error: "INVALID_INPUT" };

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

export async function getProductPage(query: unknown = {}) {
    const session = await auth();
    const input = AdminListQuerySchema.safeParse(query);
    if (session?.user?.role !== "ADMIN" || !input.success) return { rows: [], total: 0, page: 1 };

    const { pageSize, search, sort, desc } = input.data;
    const field = sort === "price" ? "price" : "name";
    const direction = desc ? "desc" : "asc";
    const where = search ? { name: { contains: escapeListSearch(search), mode: "insensitive" as const } } : undefined;
    const total = await prisma.products.count({ where });
    const page = Math.min(input.data.page, Math.max(1, Math.ceil(total / pageSize)));
    const rows = await prisma.products.findMany({
        include: { recipes: { include: { supplies: true } } },
        where,
        orderBy: [{ [field]: direction }, { id: direction }],
        take: pageSize,
        skip: (page - 1) * pageSize,
    });
    return {
        rows: rows.map((product) => ({
            ...product,
            price: Number(product.price),
            recipes: product.recipes.map((recipe) => ({
                ...recipe,
                quantityUsed: recipe.quantityUsed === null ? null : Number(recipe.quantityUsed),
                supplies: { ...recipe.supplies, unitCost: Number(recipe.supplies.unitCost), currentStock: Number(recipe.supplies.currentStock) },
            })),
        })),
        total,
        page,
    };
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
