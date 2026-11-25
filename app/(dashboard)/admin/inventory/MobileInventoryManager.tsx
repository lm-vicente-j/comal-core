"use client"
import { parseCents, parseMilliunits, formatCents, formatMilliunits } from "@/lib/scaled-values";
import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { saveSupply, getSupplyPage, setSupplyActive } from "@/lib/actions/inventory"
import { DataPagination, PaginationErrorState, usePaginationState } from "@/components/pagination"
import { usePaginatedTable } from "@/components/pagination"

import { StatusChange, StatusFilter } from "../status-controls"
import { PlusIcon, Edit2Icon } from "lucide-react"

type SupplyRow = Extract<Awaited<ReturnType<typeof getSupplyPage>>, { success: true }>["data"]["items"][number];

const measureUnits = [
    { value: "kg", label: "KILOG" },
    { value: "g", label: "GRAMOS" },
    { value: "Lt", label: "LITRO" },
    { value: "piece", label: "PAQU./PIEZA" },
]

export function MobileInventoryManager() {
    const searchRef = React.useRef<HTMLInputElement>(null);
    const [isDialogOpen, setIsDialogOpen] = React.useState(false);
    const state = usePaginationState({ filterKeys: ["stock", "status"] });
    const search = state.query.search ?? "";
    const setSearch = state.setSearch;
    const stockFilter = String(state.query.filters?.stock ?? "all");
    const [currentItem, setCurrentItem] = React.useState<SupplyRow | null>(null);
    const [errors, setErrors] = React.useState<Record<string, string[]>>({});
    const [alert, setAlert] = React.useState<{ message: string, type: 'success' | 'error' } | null>(null);
    const [saving, setSaving] = React.useState(false);
    const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearCloseTimer = () => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
    };

    const [formData, setFormData] = React.useState({
        name: "", unitCost: "", currentStock: "", measureUnit: ""
    });

    const openEdit = (item: SupplyRow) => {
        clearCloseTimer();
        setCurrentItem(item);
        setFormData({
            name: item.name || "",
            unitCost: item.unitCost == null ? "" : formatCents(Number(item.unitCost)),
            currentStock: item.currentStock == null ? "" : formatMilliunits(Number(item.currentStock)),
            measureUnit: item.measureUnit || ""
        });
        setErrors({});
        setAlert(null);
        setIsDialogOpen(true);
    };

    const openNew = () => {
        clearCloseTimer();
        setCurrentItem(null);
        setFormData({ name: "", unitCost: "", currentStock: "", measureUnit: "" });
        setErrors({});
        setAlert(null);
        setIsDialogOpen(true);
    };

    // Store raw string values so numeric fields can be cleared.
    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: value
        }));
    };

    const handleSave = async () => {
        if (saving) return;
        setErrors({});
        setAlert(null);
        const unitCost = parseCents(formData.unitCost);
        const currentStock = parseMilliunits(formData.currentStock);
        if (unitCost === null || currentStock === null) {
            setAlert({ message: "Ingresa un costo y una cantidad válidos.", type: 'error' });
            return;
        }
        setSaving(true);
        try {
            const response = await saveSupply({ ...formData, unitCost, currentStock, id: currentItem?.id });

            if (response.success) {
                page.refresh();
                setAlert({ message: "Guardado exitosamente.", type: 'success' });
                clearCloseTimer();
                closeTimerRef.current = setTimeout(() => { setAlert(null); setIsDialogOpen(false); }, 1500);
            } else {
                setAlert({ message: response.error || "Ocurrió un error.", type: 'error' });
                if (response.fieldErrors) setErrors(response.fieldErrors);
            }
        } catch {
            setAlert({ message: "Error de conexión al guardar.", type: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const page = usePaginatedTable(state, getSupplyPage);
    const filtered = page.items;

    return (
        <div className="flex min-h-0 flex-1 flex-col w-full p-4 gap-4 bg-gray-50 overflow-hidden">
            <div className="flex shrink-0 justify-between items-center">
                <h1 className="text-xl font-bold">Inventario</h1>
                <Button onClick={openNew} size="sm"><PlusIcon className="w-4 h-4 mr-1" /> Nuevo</Button>
            </div>

            <div className="flex shrink-0 flex-col gap-2">
                <Input
                    ref={searchRef}
                        aria-label="Buscar insumo"
                    placeholder="Buscar insumo..."
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                />
                <Select value={stockFilter} onValueChange={(value) => { state.setFilters({ stock: value === "all" ? undefined : value }); }}>
                    <SelectTrigger aria-label="Filtrar por existencias" className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">Todos</SelectItem>
                        <SelectItem value="in-stock">Con stock</SelectItem>
                        <SelectItem value="out-of-stock">Sin stock</SelectItem>
                    </SelectContent>
                </Select>
                <StatusFilter value={String(state.query.filters?.status ?? "active")} onChange={status => state.setFilters({ status })} />
            </div>

            {page.error && <PaginationErrorState error={page.error} onRetry={page.refresh} />}

            {/* Mobile List View */}
            <div className="min-h-0 flex-1 overflow-y-auto space-y-3">
                {filtered.map(item => (
                    <div key={item.id} className="bg-white p-4 rounded-xl shadow-sm border flex justify-between items-center">
                        <div>
                            <p className="font-bold text-gray-800">{item.name} {!item.active && <Badge variant="secondary">Inactivo</Badge>}</p>
                            {!item.active && <p className="text-xs text-muted-foreground">Reactiva este insumo para editarlo.</p>}
                            <div className="text-xs text-gray-500 mt-1 flex gap-2">
                                <Badge variant="secondary">{formatMilliunits(Number(item.currentStock))} {item.measureUnit}</Badge>
                                <span>${formatCents(Number(item.unitCost))}</span>
                            </div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                        <StatusChange name={item.name ?? ""} active={item.active} kind="insumo" focusTarget={searchRef} action={active => setSupplyActive(item.id, active)} onSuccess={page.refresh} />
                        <Button aria-label={`Editar ${item.name}`} disabled={!item.active} variant="ghost" size="icon" onClick={() => openEdit(item)}>
                            <Edit2Icon className="w-4 h-4 text-gray-500" />
                        </Button>
                        </div>
                    </div>
                ))}
                {!page.error && filtered.length === 0 && (
                    <p role="status" className="py-8 text-center text-sm text-muted-foreground">{page.loading ? "Cargando…" : "No hay insumos que coincidan."}</p>
                )}
            </div>

            <DataPagination {...page} onPageChange={page.setPage} onPageSizeChange={page.setPageSize} isPending={page.loading} totalLabel="insumos" />

            {/* Form Dialog */}
            <Dialog
                open={isDialogOpen}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen && saving) return;
                    clearCloseTimer();
                    setIsDialogOpen(nextOpen);
                    if (!nextOpen) {
                        setErrors({});
                        setAlert(null);
                    }
                }}
            >
                <DialogContent className="w-[95%] rounded-lg sm:max-w-[425px]">
                    <DialogHeader>
                        <DialogTitle>{currentItem ? "Editar Insumo" : "Agregar Insumo"}</DialogTitle>
                    </DialogHeader>
                    
                    {alert && (
                        <div className={`p-2 text-xs rounded font-semibold ${alert.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {alert.message}
                        </div>
                    )}

                    <div className="space-y-4">
                        <div>
                            <label className="text-xs font-semibold uppercase">Nombre</label>
                            <Input name="name" value={formData.name} onChange={handleInputChange} />
                            {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name[0]}</p>}
                        </div>
                        <div className="flex gap-3">
                            <div className="flex-1">
                                <label className="text-xs font-semibold uppercase">Stock</label>
                                <Input type="number" min="0" step="0.001" name="currentStock" value={formData.currentStock} onChange={handleInputChange} />
                                {errors.currentStock && <p className="text-red-500 text-xs mt-1">{errors.currentStock[0]}</p>}
                            </div>
                            <div className="flex-1">
                                <label className="text-xs font-semibold uppercase">Costo ($)</label>
                                <Input type="number" min="0" step="0.01" name="unitCost" value={formData.unitCost} onChange={handleInputChange} />
                                {errors.unitCost && <p className="text-red-500 text-xs mt-1">{errors.unitCost[0]}</p>}
                            </div>
                        </div>
                        <div>
                            <label className="text-xs font-semibold uppercase">Unidad</label>
                            <select 
                                name="measureUnit" 
                                value={formData.measureUnit} 
                                onChange={handleInputChange}
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
                            >
                                <option value="" disabled>Seleccionar...</option>
                                {measureUnits.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                            </select>
                            {errors.measureUnit && <p className="text-red-500 text-xs mt-1">{errors.measureUnit[0]}</p>}
                        </div>
                        <Button className="w-full mt-4" onClick={handleSave} disabled={saving || alert?.type === "success"}>Guardar Insumo</Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
