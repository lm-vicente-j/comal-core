"use client";
import type { CRMItem } from "./crm-manager";
import { formatCurrencyCents } from "@/lib/scaled-values";

import { useState, useRef, useEffect, ChangeEvent } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { usePaginatedTable } from "@/components/pagination";
import { DataPagination, PaginationErrorState, usePaginationState } from "@/components/pagination";
import { getCustomerPage } from "@/lib/actions/customers";
import { saveCustomer } from "@/lib/actions/customers";
import { PlusIcon, Edit2Icon, ListFilter } from "lucide-react";
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";


export default function MobileCRMManager() {
    const state = usePaginationState({ defaultTab: "customers" });
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [currentItem, setCurrentItem] = useState<CRMItem | null>(null);
    const customerSearch = state.query.search ?? "";
    const setCustomerSearch = state.setSearch;
    const customerOrder = state.query.sort === "customerName" ? "name" : "recent";
    const setCustomerOrder = (value: "recent" | "name") => state.setSort(value === "name" ? "customerName" : undefined, value === "name" ? "asc" : undefined);

    const [errors, setErrors] = useState<Record<string, string[] | undefined>>({});
    const [alert, setAlert] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
    const [saving, setSaving] = useState(false);
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearCloseTimer = () => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
    };

    const [formData, setFormData] = useState({ customerName: "", alias: "", phone: "" });

    const resetForm = () => {
        setCurrentItem(null);
        setFormData({ customerName: "", alias: "", phone: "" });
        setErrors({});
        setAlert(null);
    };

    useEffect(() => () => {
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    }, []);

    const openNew = () => {
        clearCloseTimer();
        resetForm();
        setIsDialogOpen(true);
    };

    const openEdit = (item: CRMItem) => {
        clearCloseTimer();
        setCurrentItem(item);
        setFormData({ customerName: item.customerName || "", alias: item.alias || "", phone: item.phone || "" });
        setErrors({});
        setAlert(null);
        setIsDialogOpen(true);
    };

    const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        const stringFields = ["customerName", "alias", "phone"];
        setFormData(prev => ({
            ...prev,
            [name]: stringFields.includes(name) ? value : parseFloat(value) || 0,
        }));
    };

    const handleSave = async () => {
        if (saving) return;
        setErrors({});
        setAlert(null);
        setSaving(true);
        try {
            const response = await saveCustomer({
                id: currentItem?.id,
                customerName: formData.customerName,
                alias: formData.alias,
                phone: formData.phone,
            });

            if (response?.success) {
                customerPage.refresh();
                setAlert({ message: "Guardado exitosamente.", type: 'success' });
                clearCloseTimer();
                closeTimerRef.current = setTimeout(() => { setAlert(null); setIsDialogOpen(false); resetForm(); }, 1500);
            } else {
                setAlert({ message: response?.error || "Error al guardar.", type: 'error' });
                if (response?.fieldErrors) setErrors(response.fieldErrors);
            }
        } catch {
            setAlert({ message: "Error de conexión al guardar.", type: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const customerPage = usePaginatedTable(state, getCustomerPage, true);

    return (
        <div className="flex min-h-0 flex-1 flex-col w-full bg-gray-50 overflow-hidden">
            <h1 className="shrink-0 px-4 pt-4 pb-2 text-xl font-bold">CRM</h1>

            <Tabs
                value="customers"
                className="w-full flex-1 min-h-0 flex flex-col"
            >
                <div className="px-4 shrink-0">
                    <TabsList className="w-full grid grid-cols-1">
                        <TabsTrigger className="cursor-pointer" value="customers">Clientes</TabsTrigger>
                    </TabsList>
                </div>

                <TabsContent value="customers" className="flex-1 min-h-0 flex flex-col mt-0 data-[state=inactive]:hidden">
                    <div className="shrink-0 flex gap-2 items-center px-4 pt-3 pb-2">
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="outline" size="icon" className="shrink-0" aria-label="Ordenar clientes">
                                    <ListFilter className="h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuRadioGroup value={customerOrder} onValueChange={(value) => setCustomerOrder(value as "recent" | "name")}>
                                    <DropdownMenuRadioItem value="recent">Más recientes</DropdownMenuRadioItem>
                                    <DropdownMenuRadioItem value="name">Nombre A–Z</DropdownMenuRadioItem>
                                </DropdownMenuRadioGroup>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Input
                            placeholder="Buscar cliente..."
                            value={customerSearch}
                            onChange={(e) => setCustomerSearch(e.target.value)}
                            className="min-w-0"
                        />
                        <Button onClick={openNew} size="sm" className="shrink-0">
                            <PlusIcon className="w-4 h-4 mr-1" /> Nuevo
                        </Button>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 pb-4 space-y-3">
                        {customerPage.items.map(item => {
                            const rawBalance = Number(item.currentBalance ?? 0);
                            const balance = Number.isFinite(rawBalance) ? BigInt(Math.trunc(rawBalance)) : BigInt(0);
                            return (
                                <div key={item.id} className="bg-white p-4 rounded-xl shadow-sm border flex justify-between items-center gap-2">
                                    <div className="min-w-0 flex-1">
                                        <p className="font-bold text-gray-800 truncate">{item.customerName}</p>
                                        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500 mt-1">
                                            {item.alias && <span className="truncate max-w-full">Alias: {item.alias}</span>}
                                            <span>Tel: {item.phone || "---"}</span>
                                            <span>
                                                Saldo: <span className={`font-mono ${balance > BigInt(0) ? "text-red-500" : "text-green-600"}`}>{formatCurrencyCents(balance)}</span>
                                            </span>
                                        </div>
                                    </div>
                                    <Button variant="ghost" size="icon" className="shrink-0" onClick={() => openEdit(item)}>
                                        <Edit2Icon className="w-4 h-4 text-gray-500" />
                                    </Button>
                                </div>
                            );
                        })}
                        {!customerPage.error && customerPage.items.length === 0 && (
                            <p className="text-sm text-center text-muted-foreground py-8">
                                {customerPage.loading
                                        ? "Cargando…"
                                        : "No hay clientes."}
                            </p>
                        )}
                    </div>

                    {customerPage.error && <PaginationErrorState error={customerPage.error} onRetry={customerPage.refresh} />}
                    <DataPagination {...customerPage} onPageChange={customerPage.setPage} onPageSizeChange={customerPage.setPageSize} isPending={customerPage.loading} totalLabel="clientes" />
                </TabsContent>

            </Tabs>

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
                        <DialogTitle>
                            {currentItem ? "Editar Cliente" : "Registrar Nuevo Cliente"}
                        </DialogTitle>
                    </DialogHeader>

                    {alert && (
                        <div className={`p-2 text-xs rounded font-semibold ${alert.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {alert.message}
                        </div>
                    )}

                        <div className="space-y-4">
                            <div>
                                <label className="text-xs font-semibold uppercase">Nombre</label>
                                <Input name="customerName" value={formData.customerName} onChange={handleInputChange} placeholder="Nombre Completo" />
                                {errors.customerName && <p className="text-red-500 text-xs mt-1">{errors.customerName[0]}</p>}
                            </div>
                            <div>
                                <label htmlFor="mobile-customer-alias" className="text-xs font-semibold uppercase">Alias (opcional)</label>
                                <Input id="mobile-customer-alias" name="alias" type="text" value={formData.alias} onChange={handleInputChange} placeholder="Ej. El Güero" />
                                {errors.alias && <p className="text-red-500 text-xs mt-1">{errors.alias[0]}</p>}
                            </div>
                            <div>
                                <label className="text-xs font-semibold uppercase">Teléfono (opcional)</label>
                                <Input name="phone" type="text" value={formData.phone} onChange={handleInputChange} placeholder="XXXX-XXXX-XX" />
                                {errors.phone && <p className="text-red-500 text-xs mt-1">{errors.phone[0]}</p>}
                            </div>
                            <Button className="w-full mt-2" onClick={handleSave} disabled={saving || alert?.type === "success"}>
                                {currentItem ? "Actualizar" : "Registrar"}
                            </Button>
                        </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
