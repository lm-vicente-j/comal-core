"use client"

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import TransferConfirmationDialog from "@/components/Transfer-confirmation-dialog";
import { calculateCashChange, sumSaleTotalsCents } from "@/lib/cash-change";

import { toDebt } from "@/lib/actions/debts";

import {
    Command,
    CommandGroup,
    CommandItem,
    CommandList,
    CommandEmpty,
    CommandInput,
} from "@/components/ui/command"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover"

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    DialogClose,

} from "@/components/ui/dialog"

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { closeAccountAction } from "@/lib/actions/sales";
import { Sale } from "@/lib/actions/sales";
import { searchCustomers } from "@/lib/actions/customers";
import { trackAction } from "@/lib/action-tracker";
import { Banknote, ChevronsUpDown, CreditCard } from "lucide-react";

interface SalesInputProps {
    currentCustomerSales: Sale[];
    // The account the POS is currently on (table, customer or walk-in
    // ticket), already resolved by the parent; null when none is selected.
    sourceType: string | null;
    accountLabel: string;
    query: string;
    clientSelected: boolean;
    onClientSelect: (customer: { id: number; name: string }) => void;
    onFreeSaleView: () => void;
    onAccountSettled: () => void;
    setDialogOpen: (val: boolean) => void;
    dialogOpen: boolean;
    customerList: PickerCustomer[]
    currentCustomerID: number;
    isMutating?: boolean;
    onBusyChange?: (busy: boolean) => void;
}

// Only the fields the picker needs; matches searchCustomers' selection so the
// SSR list and the server search results share one shape.
type PickerCustomer = { id: number; customerName: string | null; alias: string | null };



export default function SalesInputClient({ currentCustomerSales, sourceType, accountLabel, query, clientSelected, onClientSelect, onFreeSaleView, onAccountSettled, dialogOpen, setDialogOpen, customerList, currentCustomerID, isMutating = false, onBusyChange }: SalesInputProps) {

    const isAlreadyFreeSale = sourceType === null;
    // One settle path for every account kind: tables, customers and walk-in
    // tickets are all charged from this "Cerrar cuenta" dialog.
    const [pickerOpen, setPickerOpen] = useState(false);
    const [customerQuery, setCustomerQuery] = useState("");
    const [customers, setCustomers] = useState<PickerCustomer[]>(() =>
        (customerList ?? []).map((c) => ({ id: c.id, customerName: c.customerName, alias: c.alias }))
    );
    const hasCustomers = (Array.isArray(customerList) && customerList.length > 0) || customers.length > 0;

    // Debounced server-side search so the picker scales to thousands of clients.
    useEffect(() => {
        let cancelled = false;
        const timer = setTimeout(() => {
            searchCustomers(customerQuery).then((res) => {
                if (!cancelled) setCustomers(res);
            });
        }, 300);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [customerQuery]);

    // How the account is being settled; asked in the close dialog since the
    // method is only known when the money actually changes hands.
    const [closeMethod, setCloseMethod] = useState<"CASH" | "TRANSFER">("CASH");
    // Informational-only cash received input for the desktop close-sale dialog,
    // scoped to the active account so switching accounts resets it without an effect.
    const [cashInputState, setCashInputState] = useState<{ source: string | null; value: string }>({ source: null, value: "" });
    const cashReceived = cashInputState.source === sourceType ? cashInputState.value : "";
    const setCashReceived = (value: string) => setCashInputState({ source: sourceType, value });
    const [transferDialogOpen, setTransferDialogOpen] = useState(false);
    const [checkout, setCheckout] = useState<{ source: string; label: string; sales: Sale[] } | null>(null);
    const [cashSettling, setCashSettling] = useState(false);
    const [cashError, setCashError] = useState("");
    const cashSettlingRef = useRef(false);
    const [sendingToDebt, setSendingToDebt] = useState(false);
    const sendingToDebtRef = useRef(false);
    const [debtDialogOpen, setDebtDialogOpen] = useState(false);
    const [debtSales, setDebtSales] = useState<Sale[]>([]);
    const debtTotal = debtSales.reduce((sum, sale) => sum + Number(sale.total), 0);

    useEffect(() => {
        onBusyChange?.(cashSettling || sendingToDebt || transferDialogOpen);
    }, [cashSettling, sendingToDebt, transferDialogOpen, onBusyChange]);

    // Receipt shown in the close dialog: stay live with `currentCustomerSales`
    // while reviewing the account so items added/edited from another terminal
    // update the receipt and total on refresh. Only freeze `checkout` once the
    // operator commits (submitting cash or confirming a transfer).
    const useCheckoutSnapshot = (transferDialogOpen || cashSettling) && checkout !== null;
    const receiptSales = useCheckoutSnapshot ? checkout.sales : currentCustomerSales;
    const receiptLabel = useCheckoutSnapshot ? checkout.label : accountLabel;
    const receiptLines = useMemo(() => {
        const byProduct = new Map<string, { name: string; quantity: number; subtotal: number }>();
        for (const sale of receiptSales) {
            for (const item of sale.sale_items) {
                const name = item.products?.name ?? "Producto";
                const acc = byProduct.get(name) ?? { name, quantity: 0, subtotal: 0 };
                acc.quantity += item.quantity;
                acc.subtotal += Number(item.subtotal);
                byProduct.set(name, acc);
            }
        }
        return Array.from(byProduct.values());
    }, [receiptSales]);

    const receiptTotal = useMemo(
        () => receiptSales.reduce((acc, s) => acc + Number(s.total), 0),
        [receiptSales]
    );

    const receiptTotalCents = useMemo(
        () => sumSaleTotalsCents(receiptSales.map((s) => s.total)),
        [receiptSales]
    );

    const cashChange = useMemo(
        () => calculateCashChange(cashReceived, receiptTotalCents),
        [cashReceived, receiptTotalCents]
    );

    const handleCloseAccount = async (target: { source: string; label: string; sales: Sale[] } | null = checkout) => {
        if (
            !target ||
            cashSettlingRef.current ||
            sendingToDebtRef.current ||
            isMutating ||
            target.sales.length === 0 ||
            target.sales.some((s) => s.id < 0) ||
            (closeMethod === "TRANSFER" && !transferDialogOpen)
        ) {
            return false;
        }

        cashSettlingRef.current = true;
        setCashSettling(true);
        try {
            setCashError("");
            const saleIds = target.sales.map((s) => s.id);
            const expectedTotal = target.sales.reduce((acc, s) => acc + Number(s.total), 0);
            const result = await trackAction(closeAccountAction(target.source, closeMethod, saleIds, expectedTotal));

            if (result.success) {
                // The account is settled: return to venta libre so the table
                // can be occupied again with a clean slate.
                onAccountSettled();
                setDialogOpen(false);
                setCloseMethod("CASH");
                setCashReceived("");
                setTransferDialogOpen(false);
                setCheckout(null);
            } else {
                setCashError(
                    result.error === "NO_OPEN_JORNADA"
                        ? "No hay jornada abierta. Abre una jornada para registrar cobros."
                        : result.error === "DIFFERENT_JORNADA"
                            ? "No se pudo registrar el cobro. La cuenta pertenece a otra jornada."
                            : result.error === "SALES_CHANGED"
                                ? "La cuenta cambió. Cierra el diálogo y revisa el nuevo total."
                                : "No se pudo registrar el cobro. Inténtalo de nuevo."
                );
            }
            return result.success;
        } finally {
            cashSettlingRef.current = false;
            setCashSettling(false);
        }
    };

    const handleCashCloseAccount = async () => {
        if (
            !sourceType ||
            cashSettlingRef.current ||
            sendingToDebtRef.current ||
            isMutating ||
            currentCustomerSales.length === 0 ||
            currentCustomerSales.some((s) => s.id < 0)
        ) {
            return;
        }
        const snapshot = { source: sourceType, label: accountLabel, sales: currentCustomerSales };
        setCheckout(snapshot);
        setCashError("");
        try {
            await handleCloseAccount(snapshot);
        } catch {
            setCashError("No se pudo registrar el cobro. Inténtalo de nuevo.");
        }
    };

    const handleToDebt = async (idCustomer: number, sales: Sale[]) => {
        if (sendingToDebtRef.current || cashSettlingRef.current || isMutating || sales.length === 0 || sales.some((s) => s.id < 0)) return;
        sendingToDebtRef.current = true;
        setSendingToDebt(true);
        try {
            const res = await trackAction(toDebt(idCustomer, sales, debtTotal));
            if (res.success) {
                // Same as closing: the account was resolved (as debt), so the
                // POS returns to venta libre.
                setDebtDialogOpen(false);
                onAccountSettled();
            } else {
                alert(
                    res.error === "NO_OPEN_JORNADA"
                        ? "No hay jornada abierta. Abre una jornada para registrar deudas."
                        : "No se pudo enviar la cuenta a deuda. Inténtalo de nuevo."
                );
            }
        } catch {
            alert("No se pudo enviar la cuenta a deuda. Revisa tu conexión e inténtalo de nuevo.");
        } finally {
            sendingToDebtRef.current = false;
            setSendingToDebt(false);
        }
    }

    const controlsBusy = cashSettling || sendingToDebt || isMutating;

    return (

        <div className="flex flex-col items-stretch justify-between gap-3 my-4 lg:my-5 lg:h-20 lg:items-start lg:gap-0">
            <Popover open={pickerOpen} onOpenChange={(nextOpen) => { if (controlsBusy) return; setPickerOpen(nextOpen); }}>
                <PopoverTrigger asChild>
                    <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={pickerOpen}
                        disabled={!hasCustomers || controlsBusy}
                        className="w-full justify-between font-normal lg:w-75"
                    >
                        <span className="truncate">
                            {clientSelected && query
                                ? query
                                : hasCustomers
                                    ? "Nombre de cliente"
                                    : "No hay clientes registrados"}
                        </span>
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                    {/* shouldFilter off: results already come filtered from the server */}
                    <Command shouldFilter={false}>
                        <CommandInput
                            placeholder="Buscar por nombre o alias..."
                            value={customerQuery}
                            onValueChange={setCustomerQuery}
                        />
                        <CommandList>
                            <CommandEmpty>No se encontraron clientes.</CommandEmpty>
                            <CommandGroup>
                                {customers.map((item) => (
                                    <CommandItem
                                        key={item.id}
                                        value={item.id.toString()}
                                        onSelect={() => {
                                            const displayName = item.alias
                                                ? `${item.customerName || "NONAME"} (${item.alias})`
                                                : (item.customerName || "NONAME");
                                            onClientSelect({ id: item.id, name: displayName });
                                            setPickerOpen(false);
                                        }}
                                        className="cursor-pointer"
                                    >
                                        {item.alias ? `${item.alias} | ` : ""}{item.customerName}
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        </CommandList>
                    </Command>
                </PopoverContent>
            </Popover>
            {/* Wrapping action row: full-width touch buttons on mobile,
                inline group on desktop. Long labels shrink on mobile. */}
            <div className="flex w-full flex-nowrap gap-2 lg:w-fit">
                {/* Leaves the current account (without settling it) and puts
                    the order list back on today's charged free sales. */}
                <Button className="cursor-pointer flex-1 lg:flex-none" disabled={isAlreadyFreeSale || controlsBusy} onClick={onFreeSaleView} ><span className="lg:hidden">Venta libre</span><span className="hidden lg:inline">Cambiar a venta libre</span></Button>
                <Dialog open={dialogOpen && !transferDialogOpen} onOpenChange={(open) => {
                    if (cashSettlingRef.current || sendingToDebtRef.current) return;
                    setCashError("");
                    setCashReceived("");
                    if (!open) setCheckout(null);
                    setDialogOpen(open);
                }}>
                    <DialogTrigger asChild>

                        <Button variant="destructive" className="cursor-pointer flex-1 lg:flex-none" disabled={!sourceType || controlsBusy || currentCustomerSales.length === 0 || currentCustomerSales.some((s) => s.id < 0)}>Cerrar cuenta <span className="hidden lg:inline">{query}</span></Button>

                    </DialogTrigger>
                    <DialogContent className="max-h-[90dvh] overflow-y-auto">
                        <DialogHeader>
                            <DialogTitle>Pago de cuenta {receiptLabel}</DialogTitle>
                            <DialogDescription>
                                Asegurate de haber procesado el pago antes de continuar.
                            </DialogDescription>
                        </DialogHeader>
                        {/* Payment method: wraps to its own line below sm so it
                            never overflows on narrow phones. */}
                        <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
                            <span className="text-sm font-medium text-gray-700">Método de pago:</span>
                            <div className="inline-flex rounded-md border border-gray-200 bg-white p-0.5">
                                <button
                                    type="button"
                                    disabled={cashSettling}
                                    onClick={() => {
                                        if (closeMethod !== "CASH") setCashReceived("");
                                        setCloseMethod("CASH");
                                    }}
                                    className={`px-3 py-1.5 text-sm font-medium rounded transition-colors flex items-center gap-1.5 cursor-pointer ${
                                        closeMethod === "CASH"
                                            ? "bg-emerald-600 text-white"
                                            : "text-gray-600 hover:bg-gray-50"
                                    }`}
                                >
                                    <Banknote className="h-4 w-4" />
                                    Efectivo
                                </button>
                                <button
                                    type="button"
                                    disabled={cashSettling}
                                    onClick={() => {
                                        if (closeMethod !== "TRANSFER") setCashReceived("");
                                        setCloseMethod("TRANSFER");
                                    }}
                                    className={`px-3 py-1.5 text-sm font-medium rounded transition-colors flex items-center gap-1.5 cursor-pointer ${
                                        closeMethod === "TRANSFER"
                                            ? "bg-amber-500 text-white"
                                            : "text-gray-600 hover:bg-gray-50"
                                    }`}
                                >
                                    <CreditCard className="h-4 w-4" />
                                    Transferencia
                                </button>
                            </div>
                        </div>

                        {/* Receipt: the account's products and total, so the
                            operator confirms exactly what is being charged. */}
                        <div className="rounded-md border">
                            <div className="border-b bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-700">
                                Recibo — {receiptLabel}
                            </div>
                            {receiptLines.length === 0 ? (
                                <p className="px-3 py-4 text-sm text-gray-500">
                                    Esta cuenta no tiene productos.
                                </p>
                            ) : (
                                <ul className="max-h-[35dvh] divide-y overflow-y-auto">
                                    {receiptLines.map((line) => (
                                        <li
                                            key={line.name}
                                            className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                                        >
                                            <span className="min-w-0 flex-1 truncate">
                                                <span className="font-medium text-gray-500">{line.quantity}×</span>{" "}
                                                {line.name}
                                            </span>
                                            <span className="shrink-0 tabular-nums">
                                                ${line.subtotal.toFixed(2)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <div className="flex items-center justify-between border-t px-3 py-2 text-base font-bold">
                                <span>Total</span>
                                <span className="tabular-nums">${receiptTotal.toFixed(2)}</span>
                            </div>
                        </div>

                        {closeMethod === "CASH" && (
                            <div className="space-y-2 rounded-md border bg-gray-50/70 p-3">
                                <div className="flex items-center justify-between gap-2">
                                    <label htmlFor="desktop-cash-received" className="text-sm font-medium text-gray-700">
                                        Efectivo recibido
                                    </label>
                                    <span className="text-xs text-muted-foreground">Solo informativo</span>
                                </div>
                                <Input
                                    id="desktop-cash-received"
                                    type="text"
                                    inputMode="decimal"
                                    autoComplete="off"
                                    placeholder="0.00"
                                    disabled={cashSettling}
                                    value={cashReceived}
                                    onChange={(event) => setCashReceived(event.currentTarget.value)}
                                    aria-invalid={cashChange.status === "invalid" || undefined}
                                    aria-describedby={cashChange.status === "invalid" ? "desktop-cash-change desktop-cash-hint" : "desktop-cash-change"}
                                    className="bg-white tabular-nums"
                                />
                                <div id="desktop-cash-change" role="status" className="flex items-center justify-between text-sm">
                                    {cashChange.status === "insufficient" ? (
                                        <>
                                            <span className="font-medium text-amber-700">Monto insuficiente</span>
                                            <span className="font-semibold tabular-nums text-amber-700">
                                                Faltan {cashChange.formattedAmount}
                                            </span>
                                        </>
                                    ) : (
                                        <>
                                            <span className="font-medium text-gray-700">Cambio a devolver</span>
                                            <span
                                                className={`font-bold tabular-nums ${
                                                    cashChange.status === "change"
                                                        ? "text-emerald-700"
                                                        : "text-gray-800"
                                                }`}
                                            >
                                                {cashChange.formattedAmount ?? "—"}
                                            </span>
                                        </>
                                    )}
                                </div>
                                {cashChange.status === "invalid" && (
                                    <p id="desktop-cash-hint" className="text-xs text-amber-700">
                                        Ingresa un monto válido con hasta dos decimales (punto o coma).
                                    </p>
                                )}
                            </div>
                        )}

                        {cashError && <p role="alert" className="text-sm text-red-600">{cashError}</p>}
                        <DialogFooter>
                            <DialogClose asChild>
                                <Button
                                    className="cursor-pointer"
                                    variant="outline"
                                    disabled={cashSettling}
                                >
                                    Cancelar
                                </Button>
                            </DialogClose>

                            <Button
                                type="button"
                                className="cursor-pointer"
                                disabled={controlsBusy || !sourceType || receiptSales.length === 0 || receiptSales.some((s) => s.id < 0)}
                                onClick={() => {
                                    if (closeMethod === "TRANSFER") {
                                        if (!sourceType || currentCustomerSales.length === 0 || currentCustomerSales.some((s) => s.id < 0)) return;
                                        setCheckout({ source: sourceType, label: accountLabel, sales: currentCustomerSales });
                                        setCashError("");
                                        setTransferDialogOpen(true);
                                    }
                                    else void handleCashCloseAccount();
                                }}
                            >
                                Confirmar y Cerrar
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
                {transferDialogOpen && (
                    <TransferConfirmationDialog
                        accountLabel={receiptLabel}
                        total={receiptTotal}
                        onCancel={() => { setCashError(""); setTransferDialogOpen(false); setCheckout(null); }}
                        onConfirm={() => handleCloseAccount(checkout)}
                        errorMessage={cashError}
                    />
                )}
                <AlertDialog
                    open={debtDialogOpen}
                    onOpenChange={(nextOpen) => {
                        if (!nextOpen && sendingToDebt) return;
                        if (nextOpen) setDebtSales(currentCustomerSales);
                        setDebtDialogOpen(nextOpen);
                    }}
                >
                    <AlertDialogTrigger asChild>
                        <Button className="cursor-pointer flex-1 lg:flex-none bg-amber-500 text-black hover:bg-amber-400" disabled={!clientSelected || controlsBusy || currentCustomerSales.length === 0 || currentCustomerSales.some((s) => s.id < 0)}>A deuda <span className="hidden lg:inline truncate  max-w-24">{query}</span></Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>¿Desea enviar la cuenta de &quot;{query}&quot; a deuda?</AlertDialogTitle>
                            <AlertDialogDescription>
                                Total a registrar como deuda: ${debtTotal.toFixed(2)}
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel asChild>
                                <Button className="cursor-pointer" variant={"outline"} disabled={sendingToDebt}>Cancelar</Button>
                            </AlertDialogCancel>
                            <Button
                                type="button"
                                disabled={sendingToDebt || controlsBusy}
                                onClick={() => void handleToDebt(currentCustomerID, debtSales)}
                                className="cursor-pointer"
                            >
                                Aceptar
                            </Button>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </div>

        </div>
    );
}
