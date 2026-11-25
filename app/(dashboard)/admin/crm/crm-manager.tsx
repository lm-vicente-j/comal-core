"use client";
import { formatCurrencyCents } from "@/lib/scaled-values";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useState, useEffect, useRef, useCallback, ChangeEvent } from "react";
import {
    flexRender,
    getCoreRowModel,
    useReactTable,
    type ColumnDef,
    type ColumnFiltersState,
    type SortingState,
    type Updater,
} from "@tanstack/react-table"
import { ButtonGroup } from "@/components/ui/button-group"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { DataPagination, PaginationErrorState, usePaginationState } from "@/components/pagination";
import { usePaginatedTable } from "@/components/pagination";
import { getCustomerPage, saveCustomer } from "@/lib/actions/customers";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ListFilter } from "lucide-react";
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";



type CustomerRow = Extract<Awaited<ReturnType<typeof getCustomerPage>>, { success: true }>["data"]["items"][number];

export type CRMItem = CustomerRow;
declare module "@tanstack/react-table" {
    interface TableMeta<TData extends import("@tanstack/react-table").RowData> {
        isSaving?: boolean;
        onSelectCustomer?: (item: CustomerRow | null) => void;
        onSelectRow?: (item: TData | null) => void;
    }
}

export const customerColumns: ColumnDef<CustomerRow>[] = [
    {
        id: "select",
        header: () => <div className="pl-1 text-xs font-bold text-muted-foreground">Sel.</div>,
        cell: ({ row, table }) => (
            <div onClick={(e) => e.stopPropagation()}>
                <Checkbox
                    checked={row.getIsSelected()}
                    disabled={table.options.meta?.isSaving}
                    onCheckedChange={(value) => {
                        const meta = table.options.meta;
                        if (meta?.isSaving) return;
                        if (meta?.onSelectCustomer) {
                            table.setRowSelection(value ? { [row.id]: true } : {});
                            meta.onSelectCustomer(value ? row.original : null);
                        } else {
                            row.toggleSelected(!!value);
                        }
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
        accessorKey: "customerName",
        header: "Cliente",
        cell: ({ row }) => <div className="font-medium">{row.original.customerName}</div>,
    },
    {
        accessorKey: "alias",
        header: "Alias",
        cell: ({ row }) => {
            const alias = row.original.alias;
            return alias
                ? <div className="font-medium">{alias}</div>
                : <span className="text-muted-foreground">—</span>;
        },
    },
    {
        accessorKey: "phone",
        header: "Teléfono",
        cell: ({ row }) => {
            const number = row.original.phone;
            const formatted = number?.replace(/(\d{3})(\d{3})(\d{3})(\d{1})/, "$1-$2-$3-$4");
            return <div className="font-medium">{formatted}</div>;
        },
    },
    {
        accessorKey: "currentBalance",
        header: () => <div className="text-right">Saldo</div>,
        cell: ({ row }) => {
            const raw = Number(row.getValue("currentBalance") ?? 0);
            const balance = Number.isFinite(raw) ? BigInt(Math.trunc(raw)) : BigInt(0);
            return (
                <div className={`text-right font-mono ${balance > BigInt(0) ? 'text-red-500' : 'text-green-600'}`}>
                    {formatCurrencyCents(balance)}
                </div>
            );
        },
    },
]


export default function CRMManager() {
    "use no memo"; // TanStack Table v8 uses mutable state; revisit when its API is compiler-compatible.


    const state = usePaginationState({ defaultTab: "customers" });

    const customerOrder = state.query.sort === "customerName" ? "name" : "recent";
    const setCustomerOrder = (value: "recent" | "name") => state.setSort(value === "name" ? "customerName" : undefined, value === "name" ? "asc" : undefined);
    const sorting: SortingState = state.query.sort ? [{ id: state.query.sort, desc: state.query.order === "desc" }] : [];
    const filters: ColumnFiltersState = state.query.search ? [{ id: "customerName", value: state.query.search }] : [];
    const onSortingChange = (update: Updater<SortingState>) => { const next = typeof update === "function" ? update(sorting) : update; state.setSort(next[0]?.id, next[0] ? (next[0].desc ? "desc" : "asc") : undefined); };
    const onFilterChange = (update: Updater<ColumnFiltersState>) => { const next = typeof update === "function" ? update(filters) : update; state.setSearch(String(next[0]?.value ?? "")); };
    const [rowSelection, setRowSelection] = useState({});

    const [currentItem, setCurrentItem] = useState<CRMItem | null>(null);

    const [formData, setFormData] = useState({
        name: "",
        customerName: "",
        alias: "",
        phone: "",
    });

    const customerPage = usePaginatedTable(state, getCustomerPage, true);

    const [errors, setErrors] = useState<Record<string, string[] | undefined>>({});
    const [alert, setAlert] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
    const alertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [saving, setSaving] = useState(false);

    const clearAlertTimer = useCallback(() => {
        if (alertTimerRef.current) {
            clearTimeout(alertTimerRef.current);
            alertTimerRef.current = null;
        }
    }, []);

    useEffect(() => clearAlertTimer, [clearAlertTimer]);

    // eslint-disable-next-line react-hooks/incompatible-library -- The owning component explicitly opts out of compiler memoization above.
    const customerTable = useReactTable({
        data: customerPage.items,
        getRowId: (row) => String(row.id),
        columns: customerColumns,
        meta: { onSelectCustomer: setCurrentItem, isSaving: saving },
        onSortingChange,
        onColumnFiltersChange: onFilterChange,
        getCoreRowModel: getCoreRowModel(),
        manualPagination: true,
        manualSorting: true,
        manualFiltering: true,
        rowCount: customerPage.total,
        onPaginationChange: customerPage.onPaginationChange,
        onRowSelectionChange: setRowSelection,
        enableMultiRowSelection: false,
        state: { sorting, columnFilters: filters, rowSelection, pagination: customerPage.pagination },
    });



    useEffect(() => {
        setErrors({});
        setAlert((previous) => currentItem || previous?.type === 'error' ? null : previous);

        if (currentItem) {
            // Credentials are never loaded into the form; blank means "keep the current one".
            setFormData({
                name: currentItem.customerName || "",
                customerName: currentItem.customerName || "",
                alias: currentItem.alias || "",
                phone: currentItem.phone || "",
            });
        } else {
            setFormData({ name: "", customerName: "", alias: "", phone: "" });
        }
    }, [currentItem]);

    const resetForm = useCallback(() => {
        clearAlertTimer();
        setCurrentItem(null);
        setRowSelection({});
        setFormData({ name: "", customerName: "", alias: "", phone: "" });
        setErrors({});
        setAlert(null);
    }, [clearAlertTimer]);

    const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        const stringFields = ["name", "customerName", "alias", "phone"];
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
                customerName: formData.name || formData.customerName,
                alias: formData.alias,
                phone: formData.phone,
            });
            if (response.success) {
                customerPage.refresh();
                resetForm();
                setAlert({ message: "Guardado exitosamente.", type: "success" });
                clearAlertTimer();
                alertTimerRef.current = setTimeout(() => {
                    alertTimerRef.current = null;
                    setAlert(null);
                }, 4000);
            } else {
                setAlert({ message: response.error || "Error al guardar.", type: "error" });
                if (response.fieldErrors) setErrors(response.fieldErrors);
            }
        } catch {
            setAlert({ message: "Error de conexión al guardar.", type: "error" });
        } finally {
            setSaving(false);
        }
    };

    const isRowSelected = currentItem !== null;

    return (
        <div className="flex flex-row items-center justify-around w-full h-full gap-4 p-4">
            <div className="bg-white flex flex-col w-[70%] h-[90%] border rounded-md p-5 shadow-sm">
                <Tabs
                    value="customers"
                    className="w-full h-full min-h-0"
                >
                    <TabsList>
                        <TabsTrigger className="cursor-pointer" value="customers">Clientes</TabsTrigger>
                    </TabsList>
                    <TabsContent value="customers" className="flex flex-col min-h-0">
                        <div className="flex w-full items-center gap-2 py-4">
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
                                value={(customerTable.getColumn("customerName")?.getFilterValue() as string) ?? ""}
                                onChange={(event) => customerTable.getColumn("customerName")?.setFilterValue(event.target.value)}
                                className="max-w-sm"
                            />
                        </div>
                        <div className="rounded-md border flex flex-col overflow-hidden flex-1 min-h-0">
                            <ScrollArea className="flex-1 min-h-0">
                                <Table>
                                    <TableHeader className="sticky top-0 bg-white z-10 shadow-sm">
                                        {customerTable.getHeaderGroups().map(hg => (
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
                                        {customerPage.loading && (
                                            <TableRow><TableCell colSpan={customerTable.getVisibleLeafColumns().length} role="status">Cargando…</TableCell></TableRow>
                                        )}
                                        {customerTable.getRowModel().rows.map(row => (
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
                            {customerPage.error && <PaginationErrorState error={customerPage.error} onRetry={customerPage.refresh} />}
                            <DataPagination {...customerPage} onPageChange={customerPage.setPage} onPageSizeChange={customerPage.setPageSize} isPending={customerPage.loading} totalLabel="clientes" />
                        </div>
                    </TabsContent>
                </Tabs>
            </div>

            <div className="bg-white flex flex-col w-[30%] h-[90%] border rounded-md p-6 shadow-sm">
                {alert && (
                    <div className={`p-3 rounded mb-4 text-sm font-semibold ${alert.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {alert.message}
                    </div>
                )}

                <>
                        <form onSubmit={(e) => e.preventDefault()} hidden={!isRowSelected} className="h-full w-full flex-col flex flex-1 justify-between">
                            <div className="flex flex-col gap-2">
                                <div className="flex flex-row items-center justify-between">
                                    <h2 className="text-xl font-bold">Editar Cliente</h2>
                                    <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={resetForm} className="text-orange-600 font-bold">+ Nuevo</Button>
                                </div>
                                <p className="text-xs text-muted-foreground">Revise los datos antes de actualizar.</p>
                            </div>
                            <div className="space-y-4 mt-6 flex-1">
                                <div>
                                    <label className="text-xs font-semibold uppercase">Nombre</label>
                                    <Input name="customerName" value={formData.customerName} onChange={handleInputChange} />
                                    {errors.customerName && <p className="text-red-500 text-xs mt-1">{errors.customerName[0]}</p>}
                                </div>
                                <div>
                                    <label htmlFor="edit-customer-alias" className="text-xs font-semibold uppercase">Alias (opcional)</label>
                                    <Input id="edit-customer-alias" name="alias" type="text" value={formData.alias} onChange={handleInputChange} placeholder="Ej. El Güero" />
                                    {errors.alias && <p className="text-red-500 text-xs mt-1">{errors.alias[0]}</p>}
                                </div>
                                <div>
                                    <label className="text-xs font-semibold uppercase">Teléfono (opcional)</label>
                                    <Input name="phone" type="text" value={formData.phone} onChange={handleInputChange} />
                                    {errors.phone && <p className="text-red-500 text-xs mt-1">{errors.phone[0]}</p>}
                                </div>
                            </div>
                            <ButtonGroup className="mt-6 flex gap-2 w-full">
                                <Button type="button" variant="outline" disabled={saving} onClick={resetForm} className="flex-1 cursor-pointer">Cancelar</Button>
                                <Button type="button" onClick={handleSave} disabled={saving} className="rounded-sm cursor-pointer">Actualizar</Button>
                            </ButtonGroup>
                        </form>

                        <form onSubmit={(e) => e.preventDefault()} hidden={isRowSelected} className="h-full w-full flex-col flex flex-1 justify-between">
                            <div className="mb-6">
                                <h2 className="text-xl font-bold">Registrar Nuevo Cliente</h2>
                                <p className="text-xs text-muted-foreground">Ingrese los datos del nuevo cliente.</p>
                            </div>
                            <div className="space-y-4 flex-1">
                                <div>
                                    <label className="text-xs font-semibold uppercase">Nombre</label>
                                    <Input name="name" value={formData.name} onChange={handleInputChange} placeholder="Nombre Completo" />
                                    {errors.customerName && <p className="text-red-500 text-xs mt-1">{errors.customerName[0]}</p>}
                                </div>
                                <div>
                                    <label htmlFor="create-customer-alias" className="text-xs font-semibold uppercase">Alias (opcional)</label>
                                    <Input id="create-customer-alias" name="alias" type="text" value={formData.alias} onChange={handleInputChange} placeholder="Ej. El Güero" />
                                    {errors.alias && <p className="text-red-500 text-xs mt-1">{errors.alias[0]}</p>}
                                </div>
                                <div>
                                    <label className="text-xs font-semibold uppercase">Teléfono (opcional)</label>
                                    <Input name="phone" type="text" value={formData.phone} onChange={handleInputChange} placeholder="XXXX-XXXX-XX" />
                                    {errors.phone && <p className="text-red-500 text-xs mt-1">{errors.phone[0]}</p>}
                                </div>
                            </div>
                            <ButtonGroup className="mt-6 flex gap-2 w-full">
                                <Button type="button" variant="outline" disabled={saving} onClick={resetForm} className="cursor-pointer flex-1 rounded-sm">Limpiar</Button>
                                <Button type="button" onClick={handleSave} disabled={saving} className="rounded-sm cursor-pointer">Registrar Nuevo Cliente</Button>
                            </ButtonGroup>
                        </form>
                </>


            </div>
        </div>
    );
}
