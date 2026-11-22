"use server"
import prisma from "../prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { recipeCostCents } from "../monetary";
import { toSafeInteger } from "../scaled-values";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { actionFail, actionOk, type ActionResult } from "../action-result";
import { ProductSchema, SaleItemsSchema, type Product } from "./schemas";
import z from "zod";
import { AdminListQuerySchema, escapeListSearch } from "@/components/pagination/schema";

export async function saveProduct(data: Product): Promise<ActionResult> {
    // Check role
    const session = await auth();
    const role = session?.user?.role || "NONE";

    if (role != "ADMIN") return actionFail("PERMISSION DENIED");

    if (!data || typeof data !== "object") {
        return actionFail("Datos inválidos");
    }

    const rawPrice: unknown = (data as Record<string, unknown>).price;
    const normalizedPrice =
        typeof rawPrice === "number"
            ? rawPrice
            : typeof rawPrice === "string" && /^-?\d+$/.test(rawPrice.trim())
                ? Number(rawPrice.trim())
                : rawPrice;

    const parsedData = {
        ...data,
        price: normalizedPrice
    };

    const result = ProductSchema.safeParse(parsedData);
    if (!result.success) {
        return actionFail("Datos inválidos", {
            fieldErrors: z.flattenError(result.error).fieldErrors,
        });
    }

    const { id, name, price, recipes } = result.data;
    const isUpdate = id !== undefined;

    try {
        const saved = await prisma.$transaction(async (tx): Promise<ActionResult> => {
            if (isUpdate) {
                await tx.$executeRaw`SELECT id FROM products WHERE id = ${id} FOR UPDATE`;
                const existing = await tx.products.findUnique({
                    where: { id },
                    select: { id: true },
                });
                if (!existing) {
                    return actionFail("Producto no encontrado");
                }
            }

            // Reject duplicate product names cleanly with fieldErrors
            const duplicateName = await tx.products.findFirst({
                where: { name, ...(isUpdate ? { id: { not: id } } : {}) },
                select: { id: true },
            });
            if (duplicateName) {
                return actionFail("Datos inválidos", {
                    fieldErrors: { name: ["Ya existe un producto con ese nombre"] },
                });
            }

            // Merge duplicate supplyIDs if provided and verify every referenced supply exists
            let normalizedRecipes = recipes;
            if (recipes !== undefined) {
                const merged = new Map<number, number>();
                for (const r of recipes) {
                    const nextQty = (merged.get(r.supplyID) ?? 0) + r.quantityUsed;
                    if (!ProductSchema.shape.recipes.unwrap().element.shape.quantityUsed.safeParse(nextQty).success) {
                        return actionFail("Datos inválidos", {
                            fieldErrors: { recipes: ["La cantidad utilizada del insumo es inválida."] },
                        });
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
                    select: { supplyID: true, quantityUsedMilliunits: true }
                })).map(({ supplyID, quantityUsedMilliunits }) => ({ supplyID, quantityUsed: quantityUsedMilliunits }))
                : []);

            // The sale price must be strictly greater than the recipe's base cost.
            if (recipeForCost.length > 0) {
                const supplyRows = await tx.supplies.findMany({
                    where: {
                        id: { in: recipeForCost.map(r => r.supplyID) },
                        ...(normalizedRecipes !== undefined ? { active: true } : {}),
                    },
                    select: { id: true, unitCostCents: true }
                });
                if (normalizedRecipes !== undefined && supplyRows.length !== normalizedRecipes.length) {
                    return actionFail("Datos inválidos", {
                        fieldErrors: { recipes: ["Uno o más insumos no existen"] },
                    });
                }
                const costById = new Map(supplyRows.map(s => [s.id, s.unitCostCents]));
                const baseCost = recipeCostCents(recipeForCost.map(({ supplyID, quantityUsed }) => ({
                    unitCost: costById.get(supplyID),
                    quantityUsed,
                })));

                if (BigInt(price) <= baseCost) {
                    return actionFail("Datos inválidos", {
                        fieldErrors: { price: ["El precio debe ser mayor al costo base"] },
                    });
                }
            }

            if (isUpdate) {
                await tx.products.update({
                    where: { id },
                    data: {
                        name,
                        priceCents: price,
                        // Leave the stored recipe untouched when the caller omits it.
                        ...(normalizedRecipes !== undefined && {
                            recipes: {
                                deleteMany: {},
                                create: normalizedRecipes.map(r => ({
                                    supplyID: r.supplyID,
                                    quantityUsedMilliunits: r.quantityUsed
                                }))
                            }
                        })
                    },
                });
            } else {
                await tx.products.create({
                    data: {
                        name,
                        priceCents: price,
                        recipes: {
                            create: normalizedRecipes?.map(r => ({
                                supplyID: r.supplyID,
                                quantityUsedMilliunits: r.quantityUsed
                            }))
                        }
                    },
                });
            }
            return actionOk();
        });
        if (!saved.success) return saved;

        revalidatePath("/pos");
        revalidatePath("/admin/inventory");
        revalidatePath("/admin/menu");
        return saved;
    } catch {
        return actionFail("ERROR IN UPSERT OPERATION");
    }

}

export async function deleteProduct(id: number): Promise<ActionResult> {
    // Check role
    const session = await auth();
    const role = session?.user?.role || "NONE";

    if (role != "ADMIN") {
        return actionFail("PERMISSION DENIED");
    }

    if (!SaleItemsSchema.shape.productID.safeParse(id).success) return actionFail("INVALID_INPUT");

    try {
        await prisma.products.delete({ where: { id } })
        revalidatePath("/pos")
        revalidatePath("/admin/inventory")
        revalidatePath("/admin/menu")
        return actionOk();
    } catch {
        return actionFail("ERROR, ASSOCIATED RECIPE    ");
    }

}

export async function getProductPage(query: unknown = {}) {
    const session = await auth();
    const input = AdminListQuerySchema.safeParse(query);
    if (session?.user?.role !== "ADMIN" || !input.success) return { rows: [], total: 0, page: 1 };

    const { pageSize, search, sort, desc } = input.data;
    const field = sort === "price" ? "priceCents" : "name";
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
        rows: rows.map(serializeProduct),
        total,
        page,
    };
}

export async function getProductsData() {

    const session = await auth();
    if (!session?.user) return [];

    try {
        const products = await prisma.products.findMany({
            include: {
                recipes: {
                    include: { supplies: session.user.role === "ADMIN" ? true : { select: { id: true, name: true, measureUnit: true, currentStockMilliunits: true, active: true } } }
                }
            },
            orderBy: { name: 'asc' }
        });
        return products.map(serializeProduct);


    } catch {
        return []
    }


}

function serializeProduct(product: Prisma.productsGetPayload<{ include: { recipes: { include: { supplies: true } } } }>) {
    const { priceCents, recipes, ...fields } = product;
    return {
        ...fields,
        price: toSafeInteger(priceCents),
        recipes: recipes.map(({ quantityUsedMilliunits, supplies, ...recipe }) => {
            const { unitCostCents, currentStockMilliunits, ...supply } = supplies;
            return {
                ...recipe,
                quantityUsed: quantityUsedMilliunits === null ? null : toSafeInteger(quantityUsedMilliunits),
                supplies: {
                    ...supply,
                    currentStock: toSafeInteger(currentStockMilliunits),
                    ...(unitCostCents === undefined ? {} : { unitCost: toSafeInteger(unitCostCents) }),
                },
            };
        }),
    };
}
