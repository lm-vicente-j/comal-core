"use client"
import * as React from "react"
import {
    flexRender,
    getCoreRowModel,
    useReactTable,
    type ColumnDef,
    type ColumnFiltersState,
    type SortingState,
} from "@tanstack/react-table"
import { ButtonGroup } from "@/components/ui/button-group"
import { ArrowUpDown, ChevronsUpDown, HamIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { saveSupply } from "@/lib/actions/inventory"
import { getProductPage, saveProduct } from "@/lib/actions/products"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Supply } from "@/lib/actions/schemas"

import {
    CommandInput,
    CommandSeparator,
    CommandShortcut,
} from "@/components/ui/command"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    DialogClose,
    DialogFooter
} from "@/components/ui/dialog"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { TablePagination } from "@/components/pagination";
import { useAdminList } from "@/components/pagination/use-admin-list";
import {
    Command,
    CommandGroup,
    CommandItem,
    CommandList,
    CommandEmpty
} from "@/components/ui/command"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"

import { PlusIcon, MinusIcon } from "lucide-react"

import {
    PopoverAnchor,
} from "@/components/ui/popover"

import { useState, useRef, useEffect } from "react"

import clsx from "clsx"


type RecipeItem = {
    supply: Supply;
    quantityUsed: number | string;
};

export const columns: ColumnDef<any>[] = [
    {
        id: "select",
        header: () => <div className="pl-1 text-xs font-bold text-muted-foreground">Sel.</div>,
        cell: ({ row, table }) => (
            <div onClick={(e) => e.stopPropagation()}>
                <Checkbox
                    checked={row.getIsSelected()}
                    disabled={(table.options.meta as any)?.isSaving}
                    onCheckedChange={(value) => {
                        const meta = table.options.meta as any;
                        if (meta?.isSaving) return;
                        const isChecked = !!value;
                        table.setRowSelection(isChecked ? { [row.id]: true } : {});
                        meta?.onSelectRow?.(isChecked ? row.original : null);
                    }}
                    aria-label="Select row"
                    className="rounded-full"
                />
            </div>
        ),
        enableSorting: false,
        enableHiding: false,
    },
    {
        accessorKey: "name",
        header: "Producto",
        cell: ({ row }) => <div className="font-medium">{row.original.name}</div>,
    },
    {
        accessorKey: "stock",
        header: "Stock",
        cell: ({ row }) => <div className="font-medium text-center">0</div>,
    },
    {
        accessorKey: "baseCost",
        header: "Costo base",
        cell: ({ row }) => {
            const recipes = row.original.recipes || [];
            const cost = recipes.reduce((acc: number, r: any) => {
                const unitCost = Number(r.supplies?.unitCost) || 0;
                const qty = Number(r.quantityUsed) || 0;
                return acc + (unitCost * qty);
            }, 0);

            return <div className="text-right font-mono">${cost.toFixed(2)}</div>;
        },
    },
    {
        accessorKey: "finalPrice",
        header: "Precio venta",
        cell: ({ row }) => {
            const price = Number(row.original.price) || 0;
            return <div className="text-right font-mono">${price.toFixed(2)}</div>;
        },
    },
    {
        accessorKey: "profit",
        header: "Utilidad",
        cell: ({ row }) => {
            const price = Number(row.original.price) || 0;
            const recipes = row.original.recipes || [];
            const baseCost = recipes.reduce((acc: number, r: any) => {
                const unitCost = Number(r.supplies?.unitCost) || 0;
                const qty = Number(r.quantityUsed) || 0;
                return acc + (unitCost * qty);
            }, 0);
            const profit = price - baseCost;
            return <div className="text-right font-mono">${profit.toFixed(2)}</div>;
        },
    },
]

interface MenuProps {
    products: Awaited<ReturnType<typeof getProductPage>>;
    supplies: Supply[];
}


export function InputSupply({
    supplyList,
    recipeItems,
    setRecipeItems
}: {
    supplyList: Supply[],
    recipeItems: RecipeItem[],
    setRecipeItems: React.Dispatch<React.SetStateAction<RecipeItem[]>>
}) {
    const [visible, setVisible] = useState(false);
    const [value, setValue] = useState("");
    const [selectedFromList, setSelectedFromList] = useState<Supply | null>(null);

    const handleAddSupply = () => {
        if (!selectedFromList) return;

        const exists = recipeItems.find(r => r.supply.id === selectedFromList.id);
        if (!exists) {
            setRecipeItems([...recipeItems, { supply: selectedFromList, quantityUsed: 1 }]);
        }

        setValue("");
        setSelectedFromList(null);
        setVisible(false);
    };

    const handleRemoveSupply = (id: number) => {
        setRecipeItems(recipeItems.filter(r => r.supply.id !== id));
    };

    const handleUpdateQuantity = (id: number, qty: string) => {
        // Store the raw value so the input can be emptied; coerced to a number on save.
        setRecipeItems(recipeItems.map(r =>
            r.supply.id === id ? { ...r, quantityUsed: qty } : r
        ));
    };

    return (
        <>
            <div className="flex row gap-2 justify-center align-middle">
                <Command className="max-w-sm rounded-lg border">
                    <CommandInput
                        customIcon={<HamIcon />}
                        placeholder="Escriba un insumo..."
                        value={value}
                        onValueChange={(val) => {
                            setValue(val);
                            setSelectedFromList(null);
                            setVisible(true);
                            if (val == "") setVisible(false);
                        }}
                    />
                    <CommandList className={clsx(!visible && "hidden")}>
                        <CommandEmpty>Insumo no encontrado...</CommandEmpty>
                        <CommandGroup>
                            {supplyList.map((s) => (
                                <CommandItem
                                    key={s.id}
                                    value={`${s.id}-${s.name ?? ""}`}
                                    onSelect={() => {
                                        setValue(s.name ?? "");
                                        setSelectedFromList(s);
                                        setVisible(false);
                                    }}
                                >
                                    <span>{s.name}</span>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>

                <Button
                    type="button"
                    size="icon-sm"
                    aria-label="Submit"
                    className="cursor-pointer"
                    onClick={handleAddSupply}
                    disabled={!selectedFromList}
                >
                    <PlusIcon />
                </Button>
            </div>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Insumo</TableHead>
                        <TableHead>Cantidad</TableHead>
                        <TableHead>Unidad</TableHead>
                        <TableHead className="text-right">Acción</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {recipeItems.length === 0 ? (
                        <TableRow>
                            <TableCell colSpan={4} className="text-center text-muted-foreground py-4">
                                No hay insumos seleccionados
                            </TableCell>
                        </TableRow>
                    ) : (
                        recipeItems.map((item) => (
                            <TableRow key={item.supply.id}>
                                <TableCell className="font-medium">{item.supply.name}</TableCell>
                                <TableCell>
                                    <Input
                                        type="number"
                                        min={0}
                                        className="h-8 w-20"
                                        value={item.quantityUsed}
                                        onChange={(e) => {
                                            const raw = e.target.value;
                                            if (raw !== "" && Number(raw) < 0) return;
                                            handleUpdateQuantity(item.supply.id ?? -1, raw);
                                        }}

                                    />
                                </TableCell>
                                <TableCell className="text-center">
                                    <Badge variant="secondary">{item.supply.measureUnit || "U"}</Badge>
                                </TableCell>
                                <TableCell className="text-right">
                                    <Button
                                        type="button"
                                        size="xs"
                                        variant="outline"
                                        className="cursor-pointer text-destructive hover:bg-destructive/10"
                                        onClick={() => handleRemoveSupply(item.supply.id ?? -1)}
                                    >
                                        <MinusIcon className="h-3 w-3" />
                                    </Button>
                                </TableCell>
                            </TableRow>
                        ))
                    )}
                </TableBody>
            </Table>
        </>
    );
}

export function MenuManager({ products, supplies }: MenuProps) {
    const [sorting, setSorting] = React.useState<SortingState>([]);
    const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
    const [rowSelection, setRowSelection] = React.useState({});
    const [currentItem, setCurrentItem] = React.useState<any | null>(null);

    const [recipeItems, setRecipeItems] = useState<RecipeItem[]>([]);
    const [alert, setAlert] = React.useState<{ message: string, type: 'success' | 'error' } | null>(null);
    const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});
    const [saving, setSaving] = React.useState(false);

    const [formData, setFormData] = React.useState({
        name: "",
        price: "",
        unitCost: "",
        currentStock: "",
        measureUnit: ""
    });

    const productPage = useAdminList(
        products, getProductPage, String(columnFilters[0]?.value ?? ""),
        sorting[0]?.id === "finalPrice" ? "price" : sorting[0]?.id,
        sorting[0]?.desc,
    );
    const table = useReactTable({
        data: productPage.rows,
        columns,
        getRowId: (row) => String(row.id),
        meta: { onSelectRow: setCurrentItem, isSaving: saving } as any,
        onSortingChange: setSorting,
        onColumnFiltersChange: setColumnFilters,
        getCoreRowModel: getCoreRowModel(),
        manualPagination: true,
        manualSorting: true,
        manualFiltering: true,
        rowCount: productPage.total,
        onPaginationChange: productPage.onPaginationChange,
        onRowSelectionChange: setRowSelection,
        enableMultiRowSelection: false,
        state: { sorting, columnFilters, rowSelection, pagination: productPage.pagination },
    });

    // Calculate base cost based on selected supplies rounded to 2 decimal places to prevent IEEE-754 precision issues
    const rawBaseCost = recipeItems.reduce((acc, item) => {
        return acc + (Number(item.supply?.unitCost || 0) * Math.max(0, Number(item.quantityUsed) || 0));
    }, 0);
    const totalBaseCost = Math.round((rawBaseCost + Number.EPSILON) * 100) / 100;

    const hasRecipe = recipeItems.length > 0;
    const editSalePrice = parseFloat(formData.price) || 0;
    const runningProfit = editSalePrice - totalBaseCost;
    const isEditPriceInvalid = hasRecipe && editSalePrice <= totalBaseCost;

    React.useEffect(() => {
        setErrors({});
        setAlert((previous) => currentItem || previous?.type === 'error' ? null : previous);
        if (currentItem) {
            setFormData({
                name: currentItem.name || "",
                price: currentItem.price?.toString() ?? "",
                unitCost: currentItem.unitCost?.toString() ?? "",
                currentStock: "",
                measureUnit: ""
            });
            const existingRecipes = currentItem.recipes?.map((r: any) => ({
                supply: r.supplies,
                quantityUsed: Number(r.quantityUsed)
            })) || [];
            setRecipeItems(existingRecipes);
        } else {
            setFormData({
                name: "",
                price: "",
                unitCost: "",
                currentStock: "",
                measureUnit: ""
            });
            setRecipeItems([]);
        }
    }, [currentItem]);



    const resetForm = (clearAlert = true) => {
        setCurrentItem(null);
        setRowSelection({});
        setFormData({ name: "", price: "", unitCost: "", currentStock: "", measureUnit: "" });
        setRecipeItems([]);
        if (clearAlert) setAlert(null);
        setErrors({});
    };


    const handleInputBlur = (e: React.FocusEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        // Leave the field empty if the user cleared it; don't force it back to a number.
        if (value === "") return;
        if (name === "price" && Number.isFinite(parseFloat(value))) {
            setFormData(prev => ({
                ...prev,
                [name]: parseFloat(value).toString()
            }));
        }
    }

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;


        setFormData(prev => ({
            ...prev,
            [name]: value
        }));
    };

    const handleSave = async () => {
        if (saving) return;
        setAlert(null);
        setErrors({});

        const sanitizedRecipes = recipeItems.map(item => ({
            supplyID: item.supply.id!,
            quantityUsed: Math.max(0, Number(item.quantityUsed) || 0),
        }));
        const savedRecipes = currentItem?.recipes ?? [];
        const recipesChanged = sanitizedRecipes.length !== savedRecipes.length ||
            sanitizedRecipes.some((recipe, index) =>
                recipe.supplyID !== savedRecipes[index].supplyID ||
                recipe.quantityUsed !== Number(savedRecipes[index].quantityUsed)
            );

        const canPrecheckBaseCost =
            hasRecipe &&
            formData.name.trim().length >= 3 &&
            Number(formData.price) > 0 &&
            sanitizedRecipes.every((r) => r.quantityUsed > 0);

        if (currentItem) {
            // Never allow a sale price at or below the recipe's base cost.
            if (canPrecheckBaseCost && editSalePrice <= totalBaseCost) {
                setAlert({ message: "El precio debe ser mayor al costo base.", type: 'error' });
                setErrors({ price: ["El precio debe ser mayor al costo base"] });
                return;
            }

            setSaving(true);
            try {
                const response = await saveProduct({
                    id: currentItem.id,
                    price: Number(formData.price),
                    name: formData.name,
                    recipes: recipesChanged ? sanitizedRecipes : undefined
                });
                if (response.success) {
                    productPage.invalidate();
                    resetForm(false);
                    setAlert({ message: "Producto actualizado exitosamente.", type: 'success' });
                    setTimeout(() => setAlert(null), 4000);
                } else {
                    setAlert({ message: response.error || "Ocurrió un error.", type: 'error' });
                    if (response.fieldErrors) {
                        setErrors(response.fieldErrors);
                    }
                }
            } catch {
                setAlert({ message: "Error de conexión al guardar el producto.", type: 'error' });
            } finally {
                setSaving(false);
            }
        } else {
            // Never allow a sale price at or below the recipe's base cost.
            if (canPrecheckBaseCost && Number(formData.price) <= totalBaseCost) {
                setAlert({ message: "El precio debe ser mayor al costo base.", type: 'error' });
                setErrors({ price: ["El precio debe ser mayor al costo base"] });
                return;
            }

            setSaving(true);
            try {
                const response = await saveProduct({
                    name: formData.name,
                    price: Number(formData.price),
                    recipes: sanitizedRecipes
                });
                if (response.success) {
                    productPage.invalidate();
                    resetForm(false);
                    setAlert({ message: "Producto agregado exitosamente.", type: 'success' });
                    setTimeout(() => setAlert(null), 4000);
                } else {
                    setAlert({ message: response.error || "Ocurrió un error.", type: 'error' });
                    if (response.fieldErrors) {
                        setErrors(response.fieldErrors);
                    }
                }
            } catch {
                setAlert({ message: "Error de conexión al guardar el producto.", type: 'error' });
            } finally {
                setSaving(false);
            }
        }
    };

    const isRowSelected = currentItem !== null;
    const [open, setOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    return (
        <div className="flex flex-row items-center justify-around w-full h-full gap-4 p-4">
            <div className="bg-white flex flex-col w-[70%] h-[90%] border rounded-md p-5 shadow-sm">
                <div className="flex w-full items-center py-4">
                    <Input
                        placeholder="Buscar producto..."
                        value={(table.getColumn("name")?.getFilterValue() as string) ?? ""}
                        onChange={(event) => table.getColumn("name")?.setFilterValue(event.target.value)}
                        className="max-w-sm"
                    />

                </div>
                <div className="rounded-md border flex flex-col overflow-hidden flex-1 min-h-0">
                    <ScrollArea className="flex-1 min-h-0">
                        <Table>
                            <TableHeader className="sticky top-0 bg-white z-10 shadow-sm">
                                {table.getHeaderGroups().map(hg => (
                                    <TableRow key={hg.id}>
                                        {hg.headers.map(header => (
                                            <TableHead key={header.id}>
                                                {flexRender(header.column.columnDef.header, header.getContext())}
                                            </TableHead>
                                        ))}
                                    </TableRow>
                                ))}
                            </TableHeader>
                            <TableBody>
                                {productPage.loading && (
                                    <TableRow><TableCell colSpan={table.getVisibleLeafColumns().length} role="status">Cargando…</TableCell></TableRow>
                                )}
                                {table.getRowModel().rows.map(row => (
                                    <TableRow
                                        key={row.id}
                                        className="cursor-pointer"
                                        onClick={() => {
                                            if (saving) return;
                                            const isSelected = row.getIsSelected();
                                            setRowSelection(!isSelected ? { [row.id]: true } : {});
                                            setCurrentItem(!isSelected ? row.original : null);
                                        }}
                                        data-state={row.getIsSelected() && "selected"}
                                    >
                                        {row.getVisibleCells().map(cell => (
                                            <TableCell key={cell.id}>
                                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </ScrollArea>
                    <TablePagination table={table} />
                </div>
            </div>

            <div className="bg-white flex flex-col w-[30%] h-[90%] border rounded-md p-6 shadow-sm">
                {alert && (
                    <div className={`p-3 rounded mb-4 text-sm font-semibold ${alert.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {alert.message}
                    </div>
                )}
                <form onSubmit={(e) => e.preventDefault()} hidden={!isRowSelected} className="h-full w-full flex-col flex flex-1 justify-between">
                    <div className="flex flex-col gap-2">
                        <div className="flex flex-row items-center justify-between">
                            <h2 className="text-xl font-bold">Editar Producto</h2>
                            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => resetForm()} className="text-orange-600 font-bold">+ Nuevo</Button>
                        </div>
                        <p className="text-xs text-muted-foreground">Revise los datos antes de actualizar.</p>
                    </div>
                    <div className="space-y-4 mt-6 flex-1">
                        <div>
                            <label className="text-xs font-semibold uppercase">Nombre</label>
                            <Input name="name" value={formData.name} onChange={handleInputChange} />
                            {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name[0]}</p>}

                        </div>
                        <div className="flex flex-col gap-2">
                            <label className="text-xs font-semibold uppercase">Insumos</label>
                            <Dialog>
                                <DialogTrigger asChild>
                                    <Button type="button" variant="outline" disabled={saving} className="w-full justify-start font-normal">
                                        Editar insumos
                                    </Button>
                                </DialogTrigger>
                                <DialogContent className="max-w-2xl">
                                    <DialogHeader>
                                        <DialogTitle>Editar lista de insumos</DialogTitle>
                                    </DialogHeader>
                                    <ScrollArea className="max-h-[60vh]">
                                        <Popover open={open} onOpenChange={setOpen}>
                                            <PopoverAnchor asChild>
                                                <InputSupply
                                                    supplyList={supplies}
                                                    recipeItems={recipeItems}
                                                    setRecipeItems={setRecipeItems}
                                                />
                                            </PopoverAnchor>
                                        </Popover>
                                    </ScrollArea>
                                    <DialogFooter>
                                        <DialogClose asChild>
                                            <Button type="button" className="cursor-pointer">Cerrar</Button>
                                        </DialogClose>
                                    </DialogFooter>
                                </DialogContent>
                            </Dialog>
                            {errors.recipes && <p className="text-red-500 text-xs mt-1">{errors.recipes[0]}</p>}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <label className="text-xs font-semibold uppercase">Precio de venta</label>
                                
                                <Input
                                    name="price"
                                    type="number"
                                    onBlur={handleInputBlur}
                                    value={formData.price}
                                    onChange={handleInputChange}
                                    className={isEditPriceInvalid ? "border-red-500 focus-visible:ring-red-500 text-red-600" : ""}
                                />
                                {isEditPriceInvalid && (
                                    <p className="text-red-500 text-xs mt-1">El precio debe ser mayor al costo base</p>
                                )}
                                {errors.price && <p className="text-red-500 text-xs mt-1">{errors.price[0]}</p>}

                            </div>
                            <div>
                                <label className="text-xs font-semibold uppercase">Stock</label>
                                <Input name="currentStock" type="number" disabled value={formData.currentStock} />
                            </div>
                        </div>
                        {hasRecipe && (
                            <div className="flex flex-row items-center justify-between border-y py-2">
                                <label className="text-xs font-semibold uppercase">Costo base: </label>
                                <p className="font-mono font-bold">${totalBaseCost.toFixed(2)}</p>
                            </div>
                        )}
                        <div className="flex flex-row items-center justify-between border-b pb-2">
                            <label className="text-xs font-semibold uppercase">Utilidad: </label>
                            <p className={`font-mono font-bold ${isEditPriceInvalid ? "text-red-500" : ""}`}>
                                ${runningProfit.toFixed(2)}
                            </p>
                        </div>
                    </div>
                    <ButtonGroup className="mt-6 flex gap-2 w-full">
                        <Button type="button" variant="outline" disabled={saving} onClick={() => resetForm()} className="flex-1 cursor-pointer">Cancelar</Button>
                        <Button
                            type="button"
                            onClick={handleSave}
                            disabled={saving || isEditPriceInvalid}
                            className="rounderd-sm cursor-pointer"
                        >
                            Actualizar
                        </Button>
                    </ButtonGroup>
                </form>

                <form onSubmit={(e) => e.preventDefault()} hidden={isRowSelected} className="h-full w-full flex-col flex flex-1 justify-between">
                    <div className="mb-6">
                        <h2 className="text-xl font-bold">Agregar producto al menú</h2>
                        <p className="text-xs text-muted-foreground">Ingrese los datos del nuevo producto.</p>
                    </div>
                    <div className="space-y-4 flex-1">
                        <div>
                            <label className="text-xs font-semibold uppercase">Nombre</label>
                            <Input name="name" value={formData.name} onChange={handleInputChange} placeholder="Nombre del producto..." />
                            {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name[0]}</p>}

                        </div>
                        <div className="flex flex-col gap-2">
                            <label className="text-xs font-semibold uppercase">Insumos</label>
                            <Dialog>
                                <DialogTrigger asChild>
                                    <Button type="button" variant="outline" disabled={saving} className="w-full justify-start font-normal">
                                        {recipeItems.length > 0
                                            ? `${recipeItems.length} insumos seleccionados`
                                            : "Editar lista insumos"}
                                    </Button>
                                </DialogTrigger>
                                <DialogContent className="max-w-2xl">
                                    <DialogHeader>
                                        <DialogTitle>Editar lista de insumos</DialogTitle>
                                    </DialogHeader>
                                    <ScrollArea className="max-h-[60vh]">
                                        <Popover open={open} onOpenChange={setOpen}>
                                            <PopoverAnchor asChild>
                                                <InputSupply
                                                    supplyList={supplies}
                                                    recipeItems={recipeItems}
                                                    setRecipeItems={setRecipeItems}
                                                />
                                            </PopoverAnchor>
                                        </Popover>
                                    </ScrollArea>
                                    <DialogFooter>
                                        <DialogClose asChild>
                                            <Button type="button" className="cursor-pointer">Cerrar</Button>
                                        </DialogClose>
                                    </DialogFooter>
                                </DialogContent>
                            </Dialog>
                            {errors.recipes && <p className="text-red-500 text-xs mt-1">{errors.recipes[0]}</p>}
                        </div>
                        <div className="flex flex-row items-center justify-between border-y py-2">
                            <label className="text-xs font-semibold uppercase">Costo base: </label>
                            <p className="font-mono font-bold">${totalBaseCost.toFixed(2)}</p>
                        </div>
                        <div>
                            <label className="text-xs font-semibold uppercase">Precio de Venta</label>
                            <Input name="price" type="number" value={formData.price} onChange={handleInputChange} placeholder="0.00" />
                                {errors.price && <p className="text-red-500 text-xs mt-1">{errors.price[0]}</p>}
                        
                        </div>
                    </div>
                    <ButtonGroup className="mt-6 flex gap-2 w-full">
                        <Button type="button" variant="outline" disabled={saving} onClick={() => resetForm()} className="cursor-pointer flex-1 rounderd-sm">Limpiar</Button>

                        <Button type="button" onClick={handleSave} disabled={saving} className="rounderd-sm cursor-pointer" >
                            AGREGAR
                        </Button>
                    </ButtonGroup>
                </form>
            </div>
        </div>
    );
}
