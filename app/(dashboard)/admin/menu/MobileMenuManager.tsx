"use client"
import { parseCents, parseMilliunits, formatCents, formatCurrencyCents, formatMilliunits } from "@/lib/scaled-values";
import { recipeCostCents } from "@/lib/monetary";
import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { saveProduct } from "@/lib/actions/products"
import { Supply } from "@/lib/actions/schemas"
import { PlusIcon, Edit2Icon } from "lucide-react"
import { InputSupply } from "./menu-manager"

type RecipeItem = {
    supply: Supply;
    quantityUsed: number | string;
};

function getBaseCost(product: any): bigint {
    const recipes = product.recipes || [];
    return recipeCostCents(recipes.map((r: { supplies?: { unitCost?: number }; quantityUsed?: number | null }) => ({ unitCost: r.supplies?.unitCost, quantityUsed: r.quantityUsed })));
}

import { getProductPage } from "@/lib/actions/products";
import { useAdminList } from "@/components/pagination/use-admin-list";
import { MobilePagination } from "@/components/pagination";

export function MobileMenuManager({ products, supplies }: { products: Awaited<ReturnType<typeof getProductPage>>, supplies: Supply[] }) {
    const [isDialogOpen, setIsDialogOpen] = React.useState(false);
    const [currentItem, setCurrentItem] = React.useState<any | null>(null);
    const [search, setSearch] = React.useState("");
    const [recipeItems, setRecipeItems] = React.useState<RecipeItem[]>([]);
    const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});
    const [alert, setAlert] = React.useState<{ message: string, type: 'success' | 'error' } | null>(null);
    const [saving, setSaving] = React.useState(false);
    const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearCloseTimer = () => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
    };

    const [formData, setFormData] = React.useState({ name: "", price: "" });

    const totalBaseCost = recipeCostCents(recipeItems.map(item => ({
        unitCost: item.supply?.unitCost,
        quantityUsed: parseMilliunits(String(item.quantityUsed)) ?? 0,
    })));

    const resetForm = () => {
        setCurrentItem(null);
        setFormData({ name: "", price: "" });
        setRecipeItems([]);
        setErrors({});
        setAlert(null);
    };

    const openNew = () => {
        clearCloseTimer();
        resetForm();
        setIsDialogOpen(true);
    };

    const openEdit = (item: any) => {
        clearCloseTimer();
        setCurrentItem(item);
        setFormData({
            name: item.name || "",
            price: item.price == null ? "" : formatCents(Number(item.price)),
        });
        setRecipeItems(item.recipes?.map((r: any) => ({
            supply: r.supplies,
            quantityUsed: formatMilliunits(Number(r.quantityUsed))
        })) || []);
        setErrors({});
        setAlert(null);
        setIsDialogOpen(true);
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleSave = async () => {
        if (saving) return;
        setErrors({});
        setAlert(null);

        if (parseCents(formData.price) === null || recipeItems.some(item => parseMilliunits(String(item.quantityUsed)) === null)) {
            setAlert({ message: "Ingresa importes y cantidades válidos.", type: 'error' });
            return;
        }
        const sanitizedRecipes = recipeItems.map(item => ({
            supplyID: item.supply.id!,
            quantityUsed: parseMilliunits(String(item.quantityUsed)) ?? 0,
        }));
        const savedRecipes = currentItem?.recipes ?? [];
        const recipesChanged = sanitizedRecipes.length !== savedRecipes.length ||
            sanitizedRecipes.some((recipe, index) =>
                recipe.supplyID !== savedRecipes[index].supplyID ||
                recipe.quantityUsed !== Number(savedRecipes[index].quantityUsed)
            );

        const canPrecheckBaseCost =
            sanitizedRecipes.length > 0 &&
            formData.name.trim().length >= 3 &&
            (parseCents(formData.price) ?? 0) > 0 &&
            sanitizedRecipes.every((r) => r.quantityUsed > 0);

        // Never allow a sale price at or below the recipe's base cost.
        if (canPrecheckBaseCost && (parseCents(formData.price) ?? 0) <= totalBaseCost) {
            setAlert({ message: "El precio debe ser mayor al costo base.", type: 'error' });
            setErrors({ price: ["El precio debe ser mayor al costo base"] });
            return;
        }

        setSaving(true);
        try {
            const response = currentItem
                ? await saveProduct({
                    id: currentItem.id,
                    name: formData.name,
                    price: (parseCents(formData.price) ?? 0),
                    recipes: recipesChanged ? sanitizedRecipes : undefined,
                })
                : await saveProduct({
                    name: formData.name,
                    price: (parseCents(formData.price) ?? 0),
                    recipes: sanitizedRecipes,
                });

            if (response.success) {
                productPage.invalidate();
                setAlert({ message: "Guardado exitosamente.", type: 'success' });
                clearCloseTimer();
                closeTimerRef.current = setTimeout(() => { setAlert(null); setIsDialogOpen(false); resetForm(); }, 1500);
            } else {
                setAlert({ message: response.error || "Ocurrió un error.", type: 'error' });
                if (response.fieldErrors) setErrors(response.fieldErrors);
            }
        } catch {
            setAlert({ message: "Error de conexión al guardar el producto.", type: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const productPage = useAdminList(products, getProductPage, search);

    return (
        <div className="flex min-h-0 flex-1 flex-col w-full bg-gray-50 overflow-hidden">
            <div className="shrink-0 px-4 pt-4 pb-3 space-y-3">
                <div className="flex justify-between items-center">
                    <h1 className="text-xl font-bold">Menú</h1>
                    <Button onClick={openNew} size="sm"><PlusIcon className="w-4 h-4 mr-1" /> Agregar producto</Button>
                </div>

                <Input
                    placeholder="Buscar producto..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
            </div>

            {/* Mobile product list */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 pb-4 space-y-3">
                {productPage.rows.map(item => {
                    const baseCost = getBaseCost(item);
                    const price = Number(item.price) || 0;
                    const profit = BigInt(price) - baseCost;
                    return (
                        <div key={item.id} className="bg-white p-4 rounded-xl shadow-sm border flex justify-between items-center gap-2">
                            <div className="min-w-0 flex-1">
                                <p className="font-bold text-gray-800 truncate">{item.name}</p>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-gray-500 mt-1.5">
                                    <span>Stock: <span className="font-mono text-gray-800">0</span></span>
                                    <span>Costo base: <span className="font-mono text-gray-800">${formatCents(baseCost)}</span></span>
                                    <span>Precio: <span className="font-mono text-gray-800">${formatCents(price)}</span></span>
                                    <span>Utilidad: <span className={`font-mono ${profit >= 0 ? "text-green-600" : "text-red-600"}`}>{formatCurrencyCents(profit)}</span></span>
                                </div>
                            </div>
                            <Button variant="ghost" size="icon" className="shrink-0" onClick={() => openEdit(item)}>
                                <Edit2Icon className="w-4 h-4 text-gray-500" />
                            </Button>
                        </div>
                    );
                })}
                {productPage.rows.length === 0 && (
                    <p className="text-sm text-center text-muted-foreground py-8">
                        {productPage.retrying
                            ? "Error al cargar. Reintentando…"
                            : productPage.loading
                                ? "Cargando…"
                                : "No hay productos."}
                    </p>
                )}
            </div>

            <MobilePagination
                page={productPage.page}
                totalPages={Math.ceil(productPage.total / 10)}
                total={productPage.total}
                isPending={productPage.loading && !productPage.retrying}
                onPageChange={productPage.setPage}
                label="Paginación de menú"
                className="shrink-0"
            />

            {/* Add / edit dialog */}
            <Dialog
                open={isDialogOpen}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen && saving) return;
                    if (!nextOpen) {
                        clearCloseTimer();
                        resetForm();
                    }
                    setIsDialogOpen(nextOpen);
                }}
            >
                <DialogContent className="max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>{currentItem ? "Editar producto" : "Agregar producto al menú"}</DialogTitle>
                    </DialogHeader>

                    {alert && (
                        <div className={`p-2 text-xs rounded font-semibold ${alert.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {alert.message}
                        </div>
                    )}

                    <div className="space-y-4">
                        <div>
                            <label className="text-xs font-semibold uppercase">Nombre</label>
                            <Input name="name" value={formData.name} onChange={handleInputChange} placeholder="Nombre del producto..." />
                            {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name[0]}</p>}
                        </div>

                        <div className="flex flex-col gap-2">
                            <label className="text-xs font-semibold uppercase">Insumos</label>
                            <ScrollArea className="max-h-[40vh]">
                                <InputSupply
                                    supplyList={supplies}
                                    recipeItems={recipeItems}
                                    setRecipeItems={setRecipeItems}
                                />
                            </ScrollArea>
                            {errors.recipes && <p className="text-red-500 text-xs mt-1">{errors.recipes[0]}</p>}
                        </div>

                        <div className="flex flex-row items-center justify-between border-y py-2">
                            <label className="text-xs font-semibold uppercase">Costo base:</label>
                            <p className="font-mono font-bold">{formatCurrencyCents(totalBaseCost)}</p>
                        </div>

                        <div>
                            <label className="text-xs font-semibold uppercase">Precio de venta</label>
                            <Input name="price" type="number" min="0" step="0.01" value={formData.price} onChange={handleInputChange} placeholder="0.00" />
                            {errors.price && <p className="text-red-500 text-xs mt-1">{errors.price[0]}</p>}
                        </div>

                        <Button className="w-full mt-2" onClick={handleSave} disabled={saving || alert?.type === "success"}>
                            {currentItem ? "Actualizar" : "Agregar"}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
