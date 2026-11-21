"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useState, useEffect, ChangeEvent } from "react";
import {
    flexRender,
    getCoreRowModel,
    useReactTable,
    type ColumnDef,
    type ColumnFiltersState,
    type SortingState,
} from "@tanstack/react-table"
import { ButtonGroup } from "@/components/ui/button-group"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
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
    Field,
    FieldContent,
    FieldLabel,
} from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getCustomerPage, saveCustomer } from "@/lib/actions/customers";
import { getStaffPage, saveUser } from "@/lib/actions/users";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ListFilter } from "lucide-react";
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";



type StaffRow = Awaited<ReturnType<typeof getStaffPage>>["rows"][number];
type CustomerRow = Awaited<ReturnType<typeof getCustomerPage>>["rows"][number];

export const staffColumns: ColumnDef<StaffRow>[] = [
    {
        id: "select",
        header: () => <div className="pl-1 text-xs font-bold text-muted-foreground">Sel.</div>,
        cell: ({ row, table }) => (
            <div onClick={(e) => e.stopPropagation()}>
                <Checkbox
                    checked={row.getIsSelected()}
                    disabled={(table.options.meta as any)?.isSaving}
                    onCheckedChange={(value) => {
                        const meta = (table.options.meta as any);
                        if (meta?.isSaving) return;
                        if (meta?.onSelectStaff) {
                            table.setRowSelection(value ? { [row.id]: true } : {});
                            meta.onSelectStaff(value ? row.original : null);
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
        accessorKey: "name",
        header: "Nombre",
        cell: ({ row }) => <Badge variant="secondary">{row.original.name}</Badge>,
    },
    {
        accessorKey: "username",
        header: "Usuario - Email",
        cell: ({row}) => {
            
            if(row.original.email){
                return <p>{row.original.username + " - " + row.original.email}</p>
            }else{
                return <p>{row.original.username}</p>

            }
        }
    },
    {
        accessorKey: "role",
        header: "Rol",
        cell: ({ row }) => <Badge variant="secondary">{row.original.role}</Badge>,
    },
    {
        accessorKey: "active",
        header: "Estado",
        cell: ({ row }) => {
            const isActive = row.original.active;
            return (
                <Badge variant={isActive ? "outline" : "destructive"} className={isActive ? "border-green-600 text-green-600" : ""}>
                    {isActive ? "Activo" : "Inactivo"}
                </Badge>
            );
        },
    },
]

export const customerColumns: ColumnDef<CustomerRow>[] = [
    {
        id: "select",
        header: () => <div className="pl-1 text-xs font-bold text-muted-foreground">Sel.</div>,
        cell: ({ row, table }) => (
            <div onClick={(e) => e.stopPropagation()}>
                <Checkbox
                    checked={row.getIsSelected()}
                    disabled={(table.options.meta as any)?.isSaving}
                    onCheckedChange={(value) => {
                        const meta = (table.options.meta as any);
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
            const balance = parseFloat(row.getValue("currentBalance") || "0");
            return (
                <div className={`text-right font-mono ${balance > 0 ? 'text-red-500' : 'text-green-600'}`}>
                    ${balance.toFixed(2)}
                </div>
            );
        },
    },
]


export function PasswordField({
    role,
    pin,
    setPin,
    formData,
    setFormData,
    handleInputChange,
    errors,
    hasCredential = false,
}: {
    role: string;
    pin: string;
    setPin: (v: string) => void;
    formData: any;
    setFormData: (fn: (prev: any) => any) => void;
    handleInputChange: (e: ChangeEvent<HTMLInputElement>) => void;
    errors: Record<string, string[] | undefined>;
    hasCredential?: boolean;
}) {
    return (
        <div>
            <label className="text-xs font-semibold uppercase">Contraseña</label>
            {role === "STAFF" ? (
                <>
                    <input type="hidden" name="pin" value={pin} />
                    <InputOTP maxLength={4} value={pin} onChange={(v) => {
                        setPin(v);
                        setFormData(prev => ({ ...prev, pin: v }));
                    }}>
                        <InputOTPGroup>
                            <InputOTPSlot index={0} />
                            <InputOTPSlot index={1} />
                            <InputOTPSlot index={2} />
                            <InputOTPSlot index={3} />
                        </InputOTPGroup>
                    </InputOTP>
                    {hasCredential && (
                        <p className="text-xs text-muted-foreground mt-1">Ya existe un PIN registrado. Deje el campo vacío para conservarlo.</p>
                    )}
                    {errors.pin && <p className="text-red-500 text-xs mt-1">{errors.pin[0]}</p>}
                </>
            ) : (
                <>
                    <Input
                        name="password"
                        type="password"
                        value={formData.password}
                        onChange={handleInputChange}
                        placeholder={hasCredential ? "••••••••" : "Contraseña..."}
                    />
                    {hasCredential && (
                        <p className="text-xs text-muted-foreground mt-1">Ya existe una contraseña registrada. Deje el campo vacío para conservarla.</p>
                    )}
                    {errors.password && <p className="text-red-500 text-xs mt-1">{errors.password[0]}</p>}
                </>
            )}
        </div>
    );
}


export default function CRMManager({ customers, staff }: { customers: Awaited<ReturnType<typeof getCustomerPage>>; staff: Awaited<ReturnType<typeof getStaffPage>> }) {

    const [pin, setPin] = useState("");
    const [listEditing, setListEditing] = useState<"CUSTOMERS" | "STAFF">("CUSTOMERS");

    const [customerOrder, setCustomerOrder] = useState<"recent" | "name">("recent");
    const [customerSorting, setCustomerSorting] = useState<SortingState>([]);
    const [customerFilters, setCustomerFilters] = useState<ColumnFiltersState>([]);
    const [staffSorting, setStaffSorting] = useState<SortingState>([]);
    const [staffFilters, setStaffFilters] = useState<ColumnFiltersState>([]);
    const [rowSelection, setRowSelection] = useState({});

    const [currentItem, setCurrentItem] = useState<any>(null);

    const [formData, setFormData] = useState({
        name: "",
        customerName: "",
        phone: "",
        role: "",
        active: true,
        password: "",
        pin: "",
        email: "",
    });

    const customerPage = useAdminList(
        customers, getCustomerPage, String(customerFilters[0]?.value ?? ""),
        customerSorting[0]?.id ?? (customerOrder === "name" ? "customerName" : undefined),
        customerSorting[0]?.desc,
    );
    const staffPage = useAdminList(
        staff, getStaffPage, String(staffFilters[0]?.value ?? ""), staffSorting[0]?.id, staffSorting[0]?.desc,
    );

    const [errors, setErrors] = useState<Record<string, string[] | undefined>>({});
    const [alert, setAlert] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
    const [saving, setSaving] = useState(false);

    const customerTable = useReactTable({
        data: customerPage.rows,
        getRowId: (row) => String(row.id),
        columns: customerColumns,
        meta: { onSelectCustomer: setCurrentItem, isSaving: saving } as any,
        onSortingChange: setCustomerSorting,
        onColumnFiltersChange: setCustomerFilters,
        getCoreRowModel: getCoreRowModel(),
        manualPagination: true,
        manualSorting: true,
        manualFiltering: true,
        rowCount: customerPage.total,
        onPaginationChange: customerPage.onPaginationChange,
        onRowSelectionChange: setRowSelection,
        enableMultiRowSelection: false,
        state: { sorting: customerSorting, columnFilters: customerFilters, rowSelection, pagination: customerPage.pagination },
    });

    const staffTable = useReactTable({
        data: staffPage.rows,
        getRowId: (row) => String(row.id),
        columns: staffColumns,
        meta: { onSelectStaff: setCurrentItem, isSaving: saving } as any,
        onSortingChange: setStaffSorting,
        onColumnFiltersChange: setStaffFilters,
        getCoreRowModel: getCoreRowModel(),
        manualPagination: true,
        manualSorting: true,
        manualFiltering: true,
        rowCount: staffPage.total,
        onPaginationChange: staffPage.onPaginationChange,
        onRowSelectionChange: setRowSelection,
        enableMultiRowSelection: false,
        state: { sorting: staffSorting, columnFilters: staffFilters, rowSelection, pagination: staffPage.pagination },
    });

    useEffect(() => {
        setPin("");
        setErrors({});
        setAlert((previous) => currentItem || previous?.type === 'error' ? null : previous);

        if (currentItem) {
            // Credentials are never loaded into the form; blank means "keep the current one".
            setFormData({
                name: currentItem.name || "",
                customerName: currentItem.customerName || "",
                phone: currentItem.phone || "",
                role: currentItem.role || "",
                active: currentItem.active ?? true,
                password: "",
                pin: "",
                email: currentItem.email || "",
            });
        } else {
            setFormData({ name: "", customerName: "", phone: "", role: "", active: true, password: "", pin: "", email: "" });
        }
    }, [currentItem]);

    const resetForm = () => {
        setCurrentItem(null);
        setRowSelection({});
        setFormData({ name: "", customerName: "", phone: "", role: "", active: true, password: "", pin: "", email: "" });
        setPin("");
        setErrors({});
        setAlert(null);
    };

    const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        const stringFields = ["name", "customerName", "phone", "password", "pin", "email"];
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
            let response;
            if (listEditing === "CUSTOMERS") {
                response = await saveCustomer({
                    id: currentItem?.id,
                    customerName: formData.name || formData.customerName,
                    phone: formData.phone,
                });
            } else {
                if (!formData.name || formData.name.trim().split(/\s+/).filter(Boolean).length < 2) {
                    setErrors({ name: ["Debe ingresar nombre y apellido(s)"] });
                    return;
                }
                // Send null when the credential was left blank so the server keeps the stored one.
                response = await saveUser({
                    id: currentItem?.id,
                    name: formData.name,
                    role: formData.role as "ADMIN" | "STAFF",
                    active: formData.active,
                    email: formData.role === "ADMIN" ? (formData.email?.trim() || null) : null,
                    password: formData.role === "STAFF" ? null : (formData.password || null),
                    pin: formData.role === "STAFF" ? (pin || null) : null,
                });
            }

            if (response?.success) {
                (listEditing === "CUSTOMERS" ? customerPage : staffPage).invalidate();
                resetForm();
                setAlert({ message: "Guardado exitosamente.", type: 'success' });
                setTimeout(() => setAlert(null), 4000);
            } else {
                setAlert({ message: response?.error || "Error al guardar.", type: 'error' });
                if (response?.fieldErrors) {
                    setErrors(response.fieldErrors);
                }
            }
        } catch {
            setAlert({ message: "Error de conexión al guardar.", type: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const isRowSelected = currentItem !== null;

    // Shared props for PasswordField
    const passwordFieldProps = {
        role: formData.role,
        pin,
        setPin,
        formData,
        setFormData,
        handleInputChange,
        errors,
        hasCredential: currentItem
            ? (formData.role === "STAFF" ? !!currentItem.hasPin : !!currentItem.hasPassword)
            : false,
    };

    return (
        <div className="flex flex-row items-center justify-around w-full h-full gap-4 p-4">
            <div className="bg-white flex flex-col w-[70%] h-[90%] border rounded-md p-5 shadow-sm">
                <Tabs
                    value={listEditing === "CUSTOMERS" ? "customers" : "STAFF"}
                    onValueChange={(value) => {
                        if (saving) return;
                        setListEditing(value === "customers" ? "CUSTOMERS" : "STAFF");
                        resetForm();
                    }}
                    className="w-full h-full min-h-0"
                >
                    <TabsList>
                        <TabsTrigger className="cursor-pointer" value="customers">Clientes</TabsTrigger>
                        <TabsTrigger className="cursor-pointer" value="STAFF">Empleados</TabsTrigger>
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
                            <TablePagination table={customerTable} />
                        </div>
                    </TabsContent>
                    <TabsContent value="STAFF" className="flex flex-col min-h-0">
                        <div className="flex w-full items-center py-4">
                            <Input
                                placeholder="Buscar empleado..."
                                value={(staffTable.getColumn("name")?.getFilterValue() as string) ?? ""}
                                onChange={(event) => staffTable.getColumn("name")?.setFilterValue(event.target.value)}
                                className="max-w-sm"
                            />
                        </div>
                        <div className="rounded-md border flex flex-col overflow-hidden flex-1 min-h-0">
                            <ScrollArea className="flex-1 min-h-0">
                                <Table>
                                    <TableHeader className="sticky top-0 bg-white z-10 shadow-sm">
                                        {staffTable.getHeaderGroups().map(hg => (
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
                                        {staffPage.loading && (
                                            <TableRow><TableCell colSpan={staffTable.getVisibleLeafColumns().length} role="status">Cargando…</TableCell></TableRow>
                                        )}
                                        {staffTable.getRowModel().rows.map(row => (
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
                            <TablePagination table={staffTable} />
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

                {listEditing === "CUSTOMERS" && (
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
                )}

                {listEditing === "STAFF" && (
                    <>
                        <form onSubmit={(e) => e.preventDefault()} hidden={!isRowSelected} className="h-full w-full flex-col flex flex-1 justify-between">
                            <div className="flex flex-col gap-2">
                                <div className="flex flex-row items-center justify-between">
                                    <h2 className="text-xl font-bold">Editar usuario</h2>
                                    <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={resetForm} className="text-orange-600 font-bold">+ Nuevo</Button>
                                </div>
                                <p className="text-xs text-muted-foreground">Revise los datos antes de actualizar.</p>
                            </div>
                            <div className="space-y-4 mt-6 flex-1">
                                <div>
                                    <label className="text-xs font-semibold uppercase">Nombre</label>
                                    <Input name="name" value={formData.name} onChange={handleInputChange} />
                                    {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name[0]}</p>}
                                </div>
                                <div>
                                    <label className="text-xs font-semibold uppercase">Rol</label>
                                    <Select value={formData.role} onValueChange={(value) => setFormData(prev => ({ ...prev, role: value }))}>
                                        <SelectTrigger className="w-45">
                                            <SelectValue placeholder="Seleccionar Rol" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="STAFF">Staff</SelectItem>
                                            <SelectItem value="ADMIN">Administrador</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    {errors.role && <p className="text-red-500 text-xs mt-1">{errors.role[0]}</p>}
                                </div>
                                {formData.role === "ADMIN" && (
                                    <div>
                                        <label className="text-xs font-semibold uppercase">Correo electrónico</label>
                                        <Input name="email" type="email" value={formData.email} onChange={handleInputChange} placeholder="admin@ejemplo.com" />
                                        {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email[0]}</p>}
                                    </div>
                                )}
                                <div>
                                    <label className="text-xs font-semibold uppercase">Activo</label>
                                    <Field orientation="horizontal">
                                        <Checkbox
                                            name="active"
                                            checked={formData.active}
                                            onCheckedChange={(value) =>
                                                setFormData(prev => ({ ...prev, active: !!value }))
                                            }
                                        />
                                        <FieldContent>
                                            <FieldLabel>Usuario habilitado en sistema</FieldLabel>
                                        </FieldContent>
                                    </Field>
                                </div>
                                <PasswordField {...passwordFieldProps} />
                            </div>
                            <ButtonGroup className="mt-6 flex gap-2 w-full">
                                <Button type="button" variant="outline" disabled={saving} onClick={resetForm} className="flex-1 cursor-pointer">Cancelar</Button>
                                <Button type="button" onClick={handleSave} disabled={saving} className="rounded-sm cursor-pointer">Actualizar</Button>
                            </ButtonGroup>
                        </form>

                        <form onSubmit={(e) => e.preventDefault()} hidden={isRowSelected} className="h-full w-full flex-col flex flex-1 justify-between">
                            <div className="mb-6">
                                <h2 className="text-xl font-bold">Registrar Nuevo Empleado</h2>
                                <p className="text-xs text-muted-foreground">Ingrese los datos del nuevo empleado.</p>
                            </div>
                            <div className="space-y-4 flex-1">
                                <div>
                                    <label className="text-xs font-semibold uppercase">Nombre</label>
                                    <Input name="name" value={formData.name} onChange={handleInputChange} placeholder="Nombre Completo" />
                                    {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name[0]}</p>}
                                </div>
                                <div>
                                    <label className="text-xs font-semibold uppercase">Rol</label>
                                    <Select value={formData.role} onValueChange={(value) => setFormData(prev => ({ ...prev, role: value }))}>
                                        <SelectTrigger className="w-45">
                                            <SelectValue placeholder="Seleccionar Rol" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="STAFF">Staff</SelectItem>
                                            <SelectItem value="ADMIN">Administrador</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    {errors.role && <p className="text-red-500 text-xs mt-1">{errors.role[0]}</p>}
                                </div>
                                {formData.role === "ADMIN" && (
                                    <div>
                                        <label className="text-xs font-semibold uppercase">Correo electrónico</label>
                                        <Input name="email" type="email" value={formData.email} onChange={handleInputChange} placeholder="admin@ejemplo.com" />
                                        {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email[0]}</p>}
                                    </div>
                                )}
                                <PasswordField {...passwordFieldProps} />
                            </div>
                            <ButtonGroup className="mt-6 flex gap-2 w-full">
                                <Button type="button" variant="outline" disabled={saving} onClick={resetForm} className="cursor-pointer flex-1 rounded-sm">Limpiar</Button>
                                <Button type="button" onClick={handleSave} disabled={saving} className="rounded-sm cursor-pointer">Registrar Nuevo Empleado</Button>
                            </ButtonGroup>
                        </form>
                    </>
                )}
            </div>
        </div>
    );
}
