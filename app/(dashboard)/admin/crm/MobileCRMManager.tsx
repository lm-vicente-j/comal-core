"use client";

import { useState, useRef, ChangeEvent } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Field,
    FieldContent,
    FieldLabel,
} from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAdminList } from "@/components/pagination/use-admin-list";
import { DataPagination } from "@/components/pagination";
import { getCustomerPage } from "@/lib/actions/customers";
import { getStaffPage } from "@/lib/actions/users";
import { saveCustomer } from "@/lib/actions/customers";
import { saveUser } from "@/lib/actions/users";
import { PlusIcon, Edit2Icon, ListFilter } from "lucide-react";
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { PasswordField } from "./crm-manager";

export default function MobileCRMManager({ customers, staff }: { customers: Awaited<ReturnType<typeof getCustomerPage>>; staff: Awaited<ReturnType<typeof getStaffPage>> }) {
    const [listEditing, setListEditing] = useState<"CUSTOMERS" | "STAFF">("CUSTOMERS");
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [currentItem, setCurrentItem] = useState<any>(null);
    const [pin, setPin] = useState("");
    const [customerSearch, setCustomerSearch] = useState("");
    const [customerOrder, setCustomerOrder] = useState<"recent" | "name">("recent");
    const [staffSearch, setStaffSearch] = useState("");

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

    const resetForm = () => {
        setCurrentItem(null);
        setFormData({ name: "", customerName: "", phone: "", role: "", active: true, password: "", pin: "", email: "" });
        setPin("");
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
        // Credentials are never loaded into the form; blank means "keep the current one".
        setFormData({
            name: item.name || "",
            customerName: item.customerName || "",
            phone: item.phone || "",
            role: item.role || "",
            active: item.active ?? true,
            password: "",
            pin: "",
            email: item.email || "",
        });
        setPin("");
        setErrors({});
        setAlert(null);
        setIsDialogOpen(true);
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
                    customerName: formData.customerName || formData.name,
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

    const customerPage = useAdminList(customers, getCustomerPage, customerSearch, customerOrder === "name" ? "customerName" : undefined);
    const staffPage = useAdminList(staff, getStaffPage, staffSearch);

    return (
        <div className="flex flex-col w-full h-full p-4 space-y-4 bg-gray-50">
            <h1 className="text-xl font-bold">CRM</h1>

            <Tabs
                value={listEditing === "CUSTOMERS" ? "customers" : "staff"}
                onValueChange={(value) => {
                    setListEditing(value === "customers" ? "CUSTOMERS" : "STAFF");
                    resetForm();
                }}
                className="w-full flex-1 min-h-0 flex flex-col"
            >
                <TabsList className="w-full grid grid-cols-2">
                    <TabsTrigger className="cursor-pointer" value="customers">Clientes</TabsTrigger>
                    <TabsTrigger className="cursor-pointer" value="staff">Empleados</TabsTrigger>
                </TabsList>

                <TabsContent value="customers" className="flex flex-col min-h-0 space-y-3">
                    <div className="flex gap-2 items-center pt-2">
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

                    <div className="flex-1 overflow-y-auto space-y-3 pb-20">
                        {customerPage.rows.map(item => {
                            const balance = parseFloat(String(item.currentBalance ?? "0"));
                            return (
                                <div key={item.id} className="bg-white p-4 rounded-xl shadow-sm border flex justify-between items-center gap-2">
                                    <div className="min-w-0 flex-1">
                                        <p className="font-bold text-gray-800 truncate">{item.customerName}</p>
                                        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500 mt-1">
                                            <span>Tel: {item.phone || "---"}</span>
                                            <span>
                                                Saldo: <span className={`font-mono ${balance > 0 ? "text-red-500" : "text-green-600"}`}>${balance.toFixed(2)}</span>
                                            </span>
                                        </div>
                                    </div>
                                    <Button variant="ghost" size="icon" className="shrink-0" onClick={() => openEdit(item)}>
                                        <Edit2Icon className="w-4 h-4 text-gray-500" />
                                    </Button>
                                </div>
                            );
                        })}
                        {customerPage.rows.length === 0 && (
                            <p className="text-sm text-center text-muted-foreground py-8">{customerPage.loading ? "Cargando…" : "No hay clientes."}</p>
                        )}
                        {customerPage.total > 10 && <DataPagination page={customerPage.page} pageSize={10} total={customerPage.total} totalPages={Math.ceil(customerPage.total / 10)} onPageChange={customerPage.setPage} totalLabel="clientes" />}
                    </div>
                </TabsContent>

                <TabsContent value="staff" className="flex flex-col min-h-0 space-y-3">
                    <div className="flex gap-2 items-center pt-2">
                        <Input
                            placeholder="Buscar empleado..."
                            value={staffSearch}
                            onChange={(e) => setStaffSearch(e.target.value)}
                        />
                        <Button onClick={openNew} size="sm" className="shrink-0">
                            <PlusIcon className="w-4 h-4 mr-1" /> Nuevo
                        </Button>
                    </div>

                    <div className="flex-1 overflow-y-auto space-y-3 pb-20">
                        {staffPage.rows.map(item => (
                            <div key={item.id} className="bg-white p-4 rounded-xl shadow-sm border flex justify-between items-center gap-2">
                                <div className="min-w-0 flex-1">
                                    <p className="font-bold text-gray-800 truncate">{item.name}</p>
                                    <p className="text-xs text-gray-500 mt-0.5 truncate">
                                        {item.username}{item.email ? ` - ${item.email}` : ""}
                                    </p>
                                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                                        <Badge variant="secondary">{item.role}</Badge>
                                        <Badge variant={item.active ? "outline" : "destructive"} className={item.active ? "border-green-600 text-green-600" : ""}>
                                            {item.active ? "Activo" : "Inactivo"}
                                        </Badge>
                                    </div>
                                </div>
                                <Button variant="ghost" size="icon" className="shrink-0" onClick={() => openEdit(item)}>
                                    <Edit2Icon className="w-4 h-4 text-gray-500" />
                                </Button>
                            </div>
                        ))}
                        {staffPage.rows.length === 0 && (
                            <p className="text-sm text-center text-muted-foreground py-8">{staffPage.loading ? "Cargando…" : "No hay empleados."}</p>
                        )}
                        {staffPage.total > 10 && <DataPagination page={staffPage.page} pageSize={10} total={staffPage.total} totalPages={Math.ceil(staffPage.total / 10)} onPageChange={staffPage.setPage} totalLabel="empleados" />}
                    </div>
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
                            {listEditing === "CUSTOMERS"
                                ? (currentItem ? "Editar Cliente" : "Registrar Nuevo Cliente")
                                : (currentItem ? "Editar Empleado" : "Registrar Nuevo Empleado")}
                        </DialogTitle>
                    </DialogHeader>

                    {alert && (
                        <div className={`p-2 text-xs rounded font-semibold ${alert.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                            {alert.message}
                        </div>
                    )}

                    {listEditing === "CUSTOMERS" ? (
                        <div className="space-y-4">
                            <div>
                                <label className="text-xs font-semibold uppercase">Nombre</label>
                                <Input name="customerName" value={formData.customerName} onChange={handleInputChange} placeholder="Nombre Completo" />
                                {errors.customerName && <p className="text-red-500 text-xs mt-1">{errors.customerName[0]}</p>}
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
                    ) : (
                        <div className="space-y-4">
                            <div>
                                <label className="text-xs font-semibold uppercase">Nombre</label>
                                <Input name="name" value={formData.name} onChange={handleInputChange} placeholder="Nombre Completo" />
                                {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name[0]}</p>}
                            </div>
                            <div>
                                <label className="text-xs font-semibold uppercase">Rol</label>
                                <Select value={formData.role} onValueChange={(value) => setFormData(prev => ({ ...prev, role: value }))}>
                                    <SelectTrigger className="w-full">
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
                            {currentItem && (
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
                            )}
                            <PasswordField {...passwordFieldProps} />
                            <Button className="w-full mt-2" onClick={handleSave} disabled={saving || alert?.type === "success"}>
                                {currentItem ? "Actualizar" : "Registrar"}
                            </Button>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}
