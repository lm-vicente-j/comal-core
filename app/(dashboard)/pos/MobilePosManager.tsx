"use client";
import { formatCents, formatCurrencyCents } from "@/lib/scaled-values";

import { useCallback, useEffect, useMemo, useOptimistic, useRef, useState, startTransition } from "react";
import Link from "next/link";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import TransferConfirmationDialog from "@/components/Transfer-confirmation-dialog";
import { cn } from "@/lib/utils";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { Product } from "@/lib/actions/schemas";
import {
    Sale,
    cancelSaleAction,
    closeAccountAction,
    nextFreeSaleTicket,
    releaseTicketReservationAction,
    updateSaleQuantity,
} from "@/lib/actions/sales";
import { searchCustomers } from "@/lib/actions/customers";
import { toDebt } from "@/lib/actions/debts";
import type { JornadaCashSummary } from "@/lib/jornada-cash";
import { salesOptimisticReducer } from "./optimistic-sale";
import { usePosSaleQueue } from "./use-pos-sale-queue";
import { trackAction } from "@/lib/action-tracker";
import {
    customerSource,
    formatSourceType,
    freeTicketNumber,
    freeTicketSource,
    tableSource,
} from "@/lib/pos-source";
import {
    Banknote,
    ChevronUp,
    ChevronsUpDown,
    CreditCard,
    Minus,
    Plus,
    Search,
    Trash2,
    X,
} from "lucide-react";

interface MobilePosManagerProps {
    products: Product[];
    sales: Sale[];
    customerList: PickerCustomer[];
    jornadaOpen: boolean;
    activeJornadaId: number | null;
    jornadaInfo: MobileJornadaInfo | null;
}

/**
 * The jornada summary the desktop banner hides on phones ("Esperado en
 * caja", "Ventas efectivo · Egresos"), assembled by the server page. Null
 * for STAFF — the banner keeps cash expectations away from that role — and
 * whenever there is no open jornada of their own.
 */
export interface MobileJornadaInfo extends JornadaCashSummary {
    id: number;
    openedBy: string | null;
    openedAt: string | null;
    openingAmount: number;
}

// Only the fields the picker needs; matches searchCustomers' selection so the
// SSR list and the server search results share one shape.
type PickerCustomer = { id: number; customerName: string | null; alias: string | null };

// Where a new sale lands; the same account model as the desktop POS.
type ContextTab = "tables" | "tickets" | "customer";

/**
 * Mobile (< lg) POS, mounted next to the desktop PosManager the same way the
 * admin modules mount their Mobile*Manager: the page picks one per breakpoint
 * and this one owns the small-screen flow end to end.
 *
 * Laid out for the thumb, top to bottom:
 *   1. Context selector — one segmented tab row (Mesas / De paso / Cliente)
 *      with a single chip row underneath, so picking where the sale goes
 *      never pushes the products off screen.
 *   2. Product grid — gets every pixel left over and scrolls internally.
 *   3. Bottom bar — always above the bottom nav: the open account with its
 *      live total once something is selected, or the jornada cash summary
 *      the desktop banner hides on phones (admin only) until then. Both
 *      open a bottom sheet (same sheet idiom as the mobile nav menu).
 *
 * The sale itself stays a 3-tap flow: context (or nothing, which opens a
 * walk-in ticket) -> tap products -> charge from the sheet.
 */
export default function MobilePosManager({ products, sales, customerList, jornadaOpen, activeJornadaId, jornadaInfo }: MobilePosManagerProps) {
    const [tableNumber, setTableNumber] = useState(0);
    const [freeTicket, setFreeTicket] = useState(0);
    const [creatingTicket, setCreatingTicket] = useState(false);
    const [currentCustomerID, setCurrentCustomerID] = useState(0);
    const [clientSelected, setClientSelected] = useState(false);
    const [query, setQuery] = useState("");
    const [contextTab, setContextTab] = useState<ContextTab>("tickets");

    const [productQuery, setProductQuery] = useState("");

    // Optimistic overlay for quantity changes and line deletions.
    const [optimisticSales, applyOptimistic] = useOptimistic(sales, salesOptimisticReducer);
    const [reservedTicket, setReservedTicket] = useState(0);
    const [ticketSaleIds, setTicketSaleIds] = useState<number[]>([]);
    const [ticketAccountId, setTicketAccountId] = useState<string>();
    const [deletingCount, setDeletingCount] = useState(0);
    const reservationRef = useRef<{ ticketNumber: number; token: string } | null>(null);
    const creatingTicketRef = useRef(false);
    const deletingLineCountRef = useRef(0);

    // Server-committed open walk-in ticket numbers (from `sales`, without
    // optimistic overlay). Used to retire `reservedTicket` and drop ghost
    // selections only after revalidated server props actually land.
    const committedOpenTickets = useMemo(() => {
        const numbers = new Set<number>();
        for (const sale of sales) {
            if (sale.status !== "UNPAID" || activeJornadaId === null || sale.jornadaId !== activeJornadaId) continue;
            const number = freeTicketNumber(sale.source_type);
            if (number !== null) numbers.add(number);
        }
        return numbers;
    }, [sales, activeJornadaId]);

    const [sheetOpen, setSheetOpen] = useState(false);
    const [jornadaSheetOpen, setJornadaSheetOpen] = useState(false);
    const [closeMethod, setCloseMethod] = useState<"CASH" | "TRANSFER">("CASH");
    const [cashReceived, setCashReceived] = useState("");
    const [cashDialogOpen, setCashDialogOpen] = useState(false);
    const [cashSubmitError, setCashSubmitError] = useState("");
    const [transferDialogOpen, setTransferDialogOpen] = useState(false);
    const [checkout, setCheckout] = useState<{ source: string; label: string | null; ids: number[]; total: bigint; totalCents: bigint } | null>(null);
    const [settling, setSettling] = useState(false);
    const [debtConfirm, setDebtConfirm] = useState(false);
    const [debtSales, setDebtSales] = useState<Sale[]>([]);
    const toSafeSaleCents = (val: unknown): bigint => {
        const n = Number(val ?? 0);
        return Number.isFinite(n) ? BigInt(Math.trunc(n)) : BigInt(0);
    };
    const debtTotal = debtSales.reduce((sum, sale) => sum + toSafeSaleCents(sale.total), BigInt(0));
    const [sendingToDebt, setSendingToDebt] = useState(false);
    const sendingToDebtRef = useRef(false);
    const [updatingQtyCount, setUpdatingQtyCount] = useState(0);
    const updatingQtyCountRef = useRef(0);

    // The account every new sale goes to; null means no account selected and
    // the bottom bar falls back to today's charged free sales.
    const activeSource =
        tableNumber > 0 ? tableSource(tableNumber)
        : clientSelected && currentCustomerID > 0 ? customerSource(currentCustomerID)
        : freeTicket > 0 ? freeTicketSource(freeTicket)
        : null;

    const clearAccountSelection = useCallback(() => {
        setTicketSaleIds([]);
        setTicketAccountId(undefined);
        reservationRef.current = null;
        setReservedTicket(0);
        setTableNumber(0);
        setQuery("");
        setClientSelected(false);
        // Cleared with the rest: a stale customer id would otherwise get
        // attached to the next walk-in sale (and touch that customer's
        // lastConsumption) long after leaving their account.
        setCurrentCustomerID(0);
        setFreeTicket(0);
        setContextTab("tickets");
        setSheetOpen(false);
        setDebtConfirm(false);
        setCashReceived("");
        setCashDialogOpen(false);
        setCashSubmitError("");
        setTransferDialogOpen(false);
    }, []);

    // The number is reserved on the server so two terminals can't hand the same
    // one to two different customers.
    const requestNewTicket = useCallback(async (): Promise<{ sourceType: string; reservationToken: string } | null> => {
        if (creatingTicketRef.current) return null;
        creatingTicketRef.current = true;
        setCreatingTicket(true);
        try {
            const pending = reservationRef.current;
            if (pending) {
                reservationRef.current = null;
                clearAccountSelection();
                try {
                    await trackAction(
                        releaseTicketReservationAction(freeTicketSource(pending.ticketNumber), pending.token)
                    );
                } catch {
                    // Best-effort release; TTL expires any unreachable reservation.
                }
            }

            const result = await trackAction(nextFreeSaleTicket());

            if (!result.success) {
                alert(result.error === "NO_OPEN_JORNADA"
                    ? "No hay jornada activa. Pide al administrador que abra la jornada antes de registrar ventas."
                    : "No se pudo abrir el ticket. Intenta de nuevo.");
                return null;
            }

            const number = freeTicketNumber(result.data.sourceType);
            if (number === null) return null;

            clearAccountSelection();
            setFreeTicket(number);
            setReservedTicket(number);
            setContextTab("tickets");
            reservationRef.current = { ticketNumber: number, token: result.data.reservationToken };
            return { sourceType: result.data.sourceType, reservationToken: result.data.reservationToken };
        } catch {
            alert("No se pudo abrir el ticket. Revisa tu conexión e intenta de nuevo.");
            return null;
        } finally {
            creatingTicketRef.current = false;
            setCreatingTicket(false);
        }
    }, [clearAccountSelection]);

    const isBlockedByOtherMutation = useCallback((queueActive: boolean) =>
        (creatingTicketRef.current && !queueActive) ||
        deletingLineCountRef.current > 0 ||
        updatingQtyCountRef.current > 0 ||
        sendingToDebtRef.current ||
        settling,
    [settling]);

    const handleTicketSaleCreated = useCallback((saleId: number, nextAccountId: string | undefined) => {
        setTicketSaleIds((ids) => [...ids, saleId]);
        if (nextAccountId !== undefined) setTicketAccountId(nextAccountId);
    }, []);

    const {
        pendingSales,
        hasPendingSales,
        hasPendingSalesRef,
        coolingDownIds,
        enqueueProductTap: handleProductTap,
        resetConsecutiveTaps,
    } = usePosSaleQueue({
        sales,
        activeSource,
        currentCustomerID,
        ticketSaleIds,
        ticketAccountId,
        reservationRef,
        requestNewTicket,
        isBlockedByOtherMutation,
        onTicketSaleCreated: handleTicketSaleCreated,
        onClearAccountSelection: clearAccountSelection,
    });

    const activeSales = useMemo(() => {
        if (activeJornadaId === null) return [];
        const committed = optimisticSales.filter((sale) => sale.jornadaId === activeJornadaId);
        return pendingSales.length > 0 ? [...pendingSales, ...committed] : committed;
    }, [optimisticSales, activeJornadaId, pendingSales]);

    // Customer picker, copied from the desktop SalesInputClient: server-side
    // search, seeded with the SSR list to avoid an empty first paint.
    const [pickerOpen, setPickerOpen] = useState(false);
    const [customerQuery, setCustomerQuery] = useState("");
    const [customers, setCustomers] = useState<PickerCustomer[]>(() =>
        (customerList ?? []).map((c) => ({ id: c.id, customerName: c.customerName, alias: c.alias }))
    );

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

    const hasCustomers = (Array.isArray(customerList) && customerList.length > 0) || customers.length > 0;

    // Open walk-in tickets, derived from the sales the server component
    // already loaded — the layout's AutoRefresh keeps them in sync with the
    // other terminals.
    const openTickets = useMemo(() => {
        const byNumber = new Map<number, { sourceType: string; number: number; total: bigint }>();

        for (const sale of activeSales) {
            if (sale.status !== "UNPAID") continue;
            const number = freeTicketNumber(sale.source_type);
            if (number === null) continue;

            const ticket = byNumber.get(number)
                ?? { sourceType: sale.source_type, number, total: BigInt(0) };
            const saleCents = Number(sale.total ?? 0);
            ticket.total += Number.isFinite(saleCents) ? BigInt(Math.trunc(saleCents)) : BigInt(0);
            byNumber.set(number, ticket);
        }

        return byNumber;
    }, [activeSales]);

    // A ticket that was just opened has no sales yet, so it only exists in
    // this component's state while this terminal holds its active reservation.
    const tickets = useMemo(() => {
        const list = Array.from(openTickets.values());
        if (freeTicket > 0 && freeTicket === reservedTicket && !openTickets.has(freeTicket)) {
            list.push({ sourceType: freeTicketSource(freeTicket), number: freeTicket, total: BigInt(0) });
        }
        return list.sort((a, b) => a.number - b.number);
    }, [openTickets, freeTicket, reservedTicket]);

    const accountSales = useMemo(
        () => {
            const matching = activeSales.filter((sale) => sale.source_type === activeSource && sale.status === "UNPAID");
            if (freeTicket === 0) return matching;
            if (ticketAccountId) {
                return matching.filter((sale) =>
                    sale.id < 0 ||
                    sale.ticketAccountId === ticketAccountId ||
                    (sale.ticketAccountId == null && ticketSaleIds.includes(sale.id))
                );
            }
            if (matching.some((sale) => ticketSaleIds.includes(sale.id))) return matching;
            return matching.filter((sale) => sale.id < 0);
        },
        [activeSales, activeSource, freeTicket, ticketSaleIds, ticketAccountId]
    );
    const hasPreviousAccount = sales.some((sale) =>
        sale.status === "UNPAID" && (activeJornadaId === null || sale.jornadaId !== activeJornadaId) &&
        (!activeSource || sale.source_type === activeSource)
    );

    // One row per sale_item, like the desktop order list: each tap is its own
    // UNPAID sale and the stepper/trash act on that sale directly.
    const accountLines = useMemo(
        () =>
            accountSales.flatMap((sale) =>
                sale.sale_items.map((item, k) => ({
                    key: `${sale.id}-${k}`,
                    saleId: sale.id,
                    productID: item.productID,
                    name: item.products?.name ?? "Producto",
                    quantity: item.quantity,
                    subtotal: Number(item.subtotal || 0),
                    // Placeholder lines keep their controls disabled: the
                    // steppers and trash need the real sale id.
                    optimistic: sale.id < 0,
                }))
            ),
        [accountSales]
    );

    const accountTotal = useMemo(
        () => accountSales.reduce((acc, s) => {
            const n = Number(s.total ?? 0);
            return acc + (Number.isFinite(n) ? BigInt(Math.trunc(n)) : BigInt(0));
        }, BigInt(0)),
        [accountSales]
    );
    // Keep the calculator local and subtract integer cents, including each
    // sale total, so floating-point sums cannot affect the change.
    const { cashReceivedCents, cashReceivedInvalid } = useMemo(() => {
        const value = cashReceived.trim().replace(",", ".");
        if (value === "") return { cashReceivedCents: null as bigint | null, cashReceivedInvalid: false };
        if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value)) {
            return { cashReceivedCents: null as bigint | null, cashReceivedInvalid: true };
        }
        const [whole, decimals = ""] = value.split(".");
        const cents = BigInt(whole || "0") * BigInt(100) + BigInt(decimals.padEnd(2, "0"));
        return { cashReceivedCents: cents, cashReceivedInvalid: false };
    }, [cashReceived]);
    const accountTotalCents = accountTotal;
    const checkoutTotalCents = checkout?.totalCents ?? BigInt(0);
    const changeCents = cashReceivedCents === null || cashReceivedInvalid
        ? null
        : cashReceivedCents - checkoutTotalCents;
    const cashReceivedInsufficient = changeCents !== null && changeCents < BigInt(0);

    const accountCount = useMemo(
        () => accountLines.reduce((acc, line) => acc + line.quantity, 0),
        [accountLines]
    );

    // Short label for the bottom bar: "Ticket #2" reads better than
    // "Venta libre #2" where space is tight; tables and customers keep
    // formatSourceType's wording.
    const accountLabel = activeSource
        ? freeTicketNumber(activeSource) !== null
            ? `Ticket #${freeTicketNumber(activeSource)}`
            : clientSelected && query
                ? `Cliente ${query}`
                : formatSourceType(activeSource)
        : null;

    const filteredProducts = useMemo(() => {
        const list = products ?? [];
        const q = productQuery.trim().toLowerCase();
        if (q === "") return list;
        return list.filter((p) => (p.name ?? "").toLowerCase().includes(q));
    }, [products, productQuery]);

    const releasePendingReservation = () => {
        const pending = reservationRef.current;
        reservationRef.current = null;
        setReservedTicket(0);
        if (pending) {
            void trackAction(
                releaseTicketReservationAction(freeTicketSource(pending.ticketNumber), pending.token)
            ).catch(() => {});
        }
    };

    // Once the server-revalidated `sales` prop contains our newly populated
    // guest ticket, retire the local `reservedTicket` flag so the ticket is
    // tracked solely from `committedOpenTickets`.
    useEffect(() => {
        if (reservedTicket > 0 && !reservationRef.current && committedOpenTickets.has(reservedTicket)) {
            setReservedTicket(0);
        }
    }, [reservedTicket, committedOpenTickets, ticketSaleIds]);

    // If another terminal settles or empties the walk-in ticket we had
    // selected (without a local empty reservation), or after our own last
    // delete finishes and server-committed sales show it empty, drop the
    // stale selection instead of keeping a ghost $0 ticket.
    useEffect(() => {
        if (
            freeTicket > 0 &&
            freeTicket !== reservedTicket &&
            !(ticketAccountId
                ? sales.some((sale) => sale.status === "UNPAID" && sale.jornadaId === activeJornadaId &&
                    sale.ticketAccountId === ticketAccountId && sale.source_type === freeTicketSource(freeTicket))
                : committedOpenTickets.has(freeTicket)) &&
            !hasPendingSales &&
            !cashDialogOpen &&
            !transferDialogOpen &&
            !hasPendingSalesRef.current &&
            deletingCount === 0 &&
            deletingLineCountRef.current === 0
        ) {
            clearAccountSelection();
            resetConsecutiveTaps();
        }
    }, [freeTicket, reservedTicket, committedOpenTickets, hasPendingSales, hasPendingSalesRef, deletingCount, ticketAccountId, activeJornadaId, sales, cashDialogOpen, transferDialogOpen, clearAccountSelection, resetConsecutiveTaps]);

    const isMutatingSelection = () =>
        creatingTicketRef.current ||
        hasPendingSalesRef.current ||
        deletingLineCountRef.current > 0 ||
        updatingQtyCountRef.current > 0 ||
        sendingToDebtRef.current ||
        settling;

    const resetToFreeSaleView = () => {
        if (isMutatingSelection()) return;
        releasePendingReservation();
        clearAccountSelection();
        resetConsecutiveTaps();
    };

    // Tapping the selected chip again leaves the account without settling
    // it — the mobile counterpart of "Cambiar a venta libre".
    const handleTableSelect = (num: number) => {
        if (isMutatingSelection()) return;
        if (num === tableNumber) {
            resetToFreeSaleView();
            return;
        }
        resetToFreeSaleView();
        setTableNumber(num);
        setContextTab("tables");
    };

    const handleTicketSelect = (num: number) => {
        if (isMutatingSelection()) return;
        if (num === freeTicket) {
            resetToFreeSaleView();
            return;
        }
        resetToFreeSaleView();
        setFreeTicket(num);
        const ticketSales = activeSales.filter((sale) =>
            sale.status === "UNPAID" && sale.id > 0 && sale.source_type === freeTicketSource(num)
        );
        setTicketSaleIds(ticketSales.map((sale) => sale.id));
        setTicketAccountId(ticketSales.find((sale) => sale.ticketAccountId)?.ticketAccountId ?? undefined);
        setContextTab("tickets");
    };

    const handleClientSelect = (customer: { id: number; name: string }) => {
        if (isMutatingSelection()) return;
        resetToFreeSaleView();
        setQuery(customer.name);
        setClientSelected(true);
        setCurrentCustomerID(customer.id);
        setContextTab("customer");
    };

    const openNewTicket = async (): Promise<{ sourceType: string; reservationToken: string } | null> => {
        if (isMutatingSelection()) return null;
        resetConsecutiveTaps();
        return await requestNewTicket();
    };

    const handleCloseAccount = async () => {
        if (!checkout || settling || isMutatingSelection()) return false;
        if (closeMethod === "CASH" && (changeCents === null || changeCents < BigInt(0))) return false;
        if (closeMethod === "TRANSFER" && !transferDialogOpen) return false;
        setSettling(true);
        try {
            setCashSubmitError("");
            const expectedTotal = Number(checkout.total);
            const result = await trackAction(closeAccountAction(checkout.source, closeMethod, checkout.ids, expectedTotal));
            if (result.success) {
                // Settled: back to venta libre so the table or ticket number
                // is free for the next customer. closeAccountAction already
                // revalidates "/pos", no extra refresh needed.
                releasePendingReservation();
                clearAccountSelection();
                resetConsecutiveTaps();
                setCloseMethod("CASH");
                setCashSubmitError("");
            } else {
                const message =
                    result.error === "NO_OPEN_JORNADA"
                        ? "No hay jornada abierta. Abre una jornada para registrar cobros."
                        : result.error === "DIFFERENT_JORNADA"
                            ? "No se pudo registrar el cobro. La cuenta pertenece a otra jornada."
                            : result.error === "SALES_CHANGED"
                                ? "La cuenta cambió. Vuelve a la cuenta y revisa el nuevo total."
                                : "No se pudo cerrar la cuenta. Intenta de nuevo.";
                setCashSubmitError(message);
            }
            return result.success;
        } catch {
            const message = "No se pudo cerrar la cuenta. Revisa tu conexión e intenta de nuevo.";
            setCashSubmitError(message);
            return false;
        } finally {
            setSettling(false);
        }
    };

    const handleToDebt = async () => {
        if (sendingToDebtRef.current || isMutatingSelection() || debtSales.length === 0 || debtSales.some((s) => s.id < 0)) return;
        sendingToDebtRef.current = true;
        setSendingToDebt(true);
        try {
            const res = await trackAction(toDebt(currentCustomerID, debtSales, Number(debtTotal)));
            if (res.success) {
                // Resolved as debt: same clean slate as after charging. toDebt
                // already revalidates "/pos", no extra refresh needed.
                releasePendingReservation();
                clearAccountSelection();
                resetConsecutiveTaps();
            } else {
                alert(
                    res.error === "NO_OPEN_JORNADA"
                        ? "No hay jornada abierta. Abre una jornada para registrar deudas."
                        : "No se pudo enviar la cuenta a deuda. Intenta de nuevo."
                );
            }
        } catch {
            alert("No se pudo enviar la cuenta a deuda. Revisa tu conexión.");
        } finally {
            sendingToDebtRef.current = false;
            setSendingToDebt(false);
        }
    };

    // Show quantity changes immediately while the server confirms them.
    const handleUpdateQuantity = (saleId: number, quantity: number, productId: number) => {
        if (isMutatingSelection()) return;
        if (quantity === 0) {
            handleDeleteLine(saleId);
            return;
        }
        if (!Number.isInteger(quantity) || quantity < 1) return;

        updatingQtyCountRef.current += 1;
        setUpdatingQtyCount(updatingQtyCountRef.current);
        startTransition(async () => {
            applyOptimistic({ type: "setQuantity", saleId, productId, quantity });
            try {
                const res = await trackAction(updateSaleQuantity(saleId, quantity, productId));
                if (!res.success) {
                    alert(
                        res.error === "JORNADA_CLOSED"
                            ? "La jornada de esta venta ya está cerrada."
                            : res.error === "UNAUTHORIZED"
                                ? "No tienes permisos para modificar esta venta."
                                : "No se pudo actualizar la cantidad."
                    );
                }
            } catch {
                alert("No se pudo actualizar la cantidad. Revisa tu conexión.");
            } finally {
                updatingQtyCountRef.current = Math.max(0, updatingQtyCountRef.current - 1);
                setUpdatingQtyCount(updatingQtyCountRef.current);
            }
        });
    };

    const handleDeleteLine = (saleId: number) => {
        if (isMutatingSelection()) return;
        deletingLineCountRef.current += 1;
        setDeletingCount(deletingLineCountRef.current);
        startTransition(async () => {
            applyOptimistic({ type: "remove", saleId });
            try {
                const res = await trackAction(cancelSaleAction(saleId));
                if (!res.success) {
                    alert(
                        res.error === "JORNADA_CLOSED"
                            ? "La jornada de esta venta ya está cerrada."
                            : res.error === "UNAUTHORIZED"
                                ? "No tienes permisos para eliminar esta venta."
                                : res.error === "CANNOT_CANCEL_PAID_DEBT"
                                    ? "No se puede cancelar una venta cuya deuda ya fue pagada."
                                    : "No se pudo eliminar el producto."
                    );
                }
            } catch {
                alert("No se pudo eliminar el producto. Revisa tu conexión e intenta de nuevo.");
            } finally {
                deletingLineCountRef.current = Math.max(0, deletingLineCountRef.current - 1);
                setDeletingCount(deletingLineCountRef.current);
            }
        });
    };

    const gated = !jornadaOpen ? "pointer-events-none opacity-50 select-none" : "";

    const TABS: { id: ContextTab; label: string }[] = [
        { id: "tables", label: "Mesas" },
        { id: "tickets", label: "De paso" },
        { id: "customer", label: "Cliente" },
    ];

    return (
        <div className={cn("flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-gray-50", (activeSource || jornadaInfo) && "pb-20")}>
            {/* 1. Context selector + product search. Inert without an open
                jornada, same as the desktop sale controls. */}
            <div aria-disabled={!jornadaOpen} className={cn("shrink-0", gated)}>
                <div className="px-3 pt-3">
                    <div className="grid grid-cols-3 gap-1 rounded-full bg-gray-200/70 p-1">
                        {TABS.map((tab) => (
                            <button
                                key={tab.id}
                                type="button"
                                onClick={() => setContextTab(tab.id)}
                                className={cn(
                                    "h-9 rounded-full text-sm font-medium text-gray-600 transition-colors cursor-pointer",
                                    contextTab === tab.id && "bg-white text-gray-900 shadow-sm"
                                )}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* One chip row per tab; the row height stays fixed so the
                    products below never jump when switching tabs. */}
                <div className="flex h-14 items-center px-3">
                    {contextTab === "tables" && (
                        <div className="flex items-center gap-2 overflow-x-auto pb-1">
                            {Array.from({ length: 10 }).map((_, index) => {
                                const num = index + 1;
                                const isSelected = tableNumber === num;
                                return (
                                    <button
                                        key={num}
                                        type="button"
                                        onClick={() => handleTableSelect(num)}
                                        className={cn(
                                            "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border bg-white font-medium text-gray-800 shadow-sm transition-colors cursor-pointer active:bg-gray-200",
                                            isSelected && "border-amber-300 bg-amber-300 text-black"
                                        )}
                                    >
                                        {num}
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {contextTab === "tickets" && (
                        <div className="flex items-center gap-2 overflow-x-auto pb-1">
                            {tickets.map((ticket) => {
                                const isSelected = ticket.number === freeTicket;
                                return (
                                    <button
                                        key={ticket.sourceType}
                                        type="button"
                                        onClick={() => handleTicketSelect(ticket.number)}
                                        className={cn(
                                            "flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border bg-white px-3 text-gray-800 shadow-sm transition-colors cursor-pointer active:bg-gray-200",
                                            isSelected && "border-amber-300 bg-amber-300 text-black"
                                        )}
                                    >
                                        <span>#{ticket.number}</span>
                                        <span className="tabular-nums opacity-70">{formatCurrencyCents(ticket.total)}</span>
                                    </button>
                                );
                            })}
                            <button
                                type="button"
                                onClick={openNewTicket}
                                disabled={creatingTicket || hasPendingSales || deletingCount > 0 || updatingQtyCount > 0 || settling || sendingToDebt}
                                className="flex h-11 shrink-0 items-center justify-center gap-1 rounded-xl border border-dashed bg-white px-3 font-medium text-gray-600 shadow-sm transition-colors cursor-pointer active:bg-gray-200"
                            >
                                <Plus className="h-4 w-4" />
                                Nuevo
                            </button>
                            {tickets.length === 0 && (
                                <p className="shrink-0 pl-1 text-xs text-muted-foreground">
                                    Toca un producto o &quot;Nuevo&quot; para abrir un ticket.
                                </p>
                            )}
                        </div>
                    )}

                    {contextTab === "customer" && (
                        <div className="flex w-full items-center gap-2">
                            <Popover open={pickerOpen} onOpenChange={(nextOpen) => { if (isMutatingSelection()) return; setPickerOpen(nextOpen); }}>
                                <PopoverTrigger asChild>
                                    <Button
                                        variant="outline"
                                        role="combobox"
                                        aria-expanded={pickerOpen}
                                        disabled={!hasCustomers || creatingTicket || hasPendingSales || deletingCount > 0 || updatingQtyCount > 0 || settling || sendingToDebt}
                                        className="h-11 w-full justify-between rounded-xl bg-white font-normal shadow-sm"
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
                                                            handleClientSelect({ id: item.id, name: displayName });
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
                            {clientSelected && (
                                <button
                                    type="button"
                                    onClick={resetToFreeSaleView}
                                    aria-label="Quitar cliente"
                                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border bg-white text-gray-500 shadow-sm cursor-pointer active:bg-gray-200"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            )}
                        </div>
                    )}
                </div>

                <div className="px-3 pb-3">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                        <Input
                            placeholder="Buscar productos"
                            value={productQuery}
                            disabled={(products ?? []).length === 0}
                            onChange={(e) => setProductQuery(e.currentTarget.value)}
                            className="h-11 rounded-xl bg-white pl-9 shadow-sm"
                        />
                    </div>
                </div>
            </div>

            {hasPreviousAccount && (
                <p role="status" className="px-3 py-2 text-sm text-amber-800">
                    Solo puedes cobrar las ventas de la jornada activa. Hay ventas de otra jornada.
                </p>
            )}

            {/* 2. Product grid: takes all the space the context selector left
                and scrolls internally, so the account bar never moves. */}
            <div aria-disabled={!jornadaOpen} className={cn("min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-3 pb-3", gated)}>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2">
                    {filteredProducts.map((product) => {
                        const isCoolingDown = coolingDownIds.has(product.id ?? -1);
                        return (
                            <button
                                key={product.id}
                                type="button"
                                onClick={() => handleProductTap(product)}
                                disabled={isCoolingDown}
                                className={cn(
                                    "flex min-h-24 flex-col items-start justify-between gap-1 rounded-xl border bg-white p-2.5 text-left shadow-sm transition-colors cursor-pointer active:bg-gray-300",
                                    isCoolingDown && "bg-gray-300 opacity-50 cursor-not-allowed"
                                )}
                            >
                                <p className="w-full min-w-0 line-clamp-3 text-sm font-medium leading-snug text-gray-800 break-words">{product.name}</p>
                                <Badge className="shrink-0 text-xs px-2 py-0.5 mt-auto">{formatCurrencyCents(Number(product.price))}</Badge>
                            </button>
                        );
                    })}
                </div>
                {filteredProducts.length === 0 && (
                    <p role="status" aria-live="polite" className="py-8 text-center text-sm text-muted-foreground">
                        {(products ?? []).length === 0 ? "No se encontraron productos registrados" : "No hay productos."}
                    </p>
                )}
            </div>

            {/* 3. Bottom bar, pinned above the mobile nav: the open account
                with its live total once something is selected, or the
                jornada cash summary the phone banner hides (admin only)
                until then. */}
            {(activeSource || jornadaInfo) && (
                <div className="fixed inset-x-0 bottom-16 z-40 flex h-20 flex-col justify-center border-t border-gray-100 bg-white px-3 py-2.5 shadow-[0_-4px_12px_rgba(0,0,0,0.05)] lg:hidden">
                    {activeSource ? (
                        <div aria-disabled={!jornadaOpen} className={cn("flex items-center gap-3 rounded-xl border bg-white px-3 py-2 shadow-sm", gated)}>
                            <button
                                type="button"
                                aria-label="Abrir cuenta"
                                disabled={hasPendingSales || creatingTicket || deletingCount > 0 || updatingQtyCount > 0 || settling || sendingToDebt}
                                onClick={() => { setDebtConfirm(false); setSheetOpen(true); }}
                                className="min-w-0 flex-1 cursor-pointer text-left disabled:opacity-50"
                            >
                                <span className="block truncate text-sm font-semibold text-gray-800">{accountLabel}</span>
                                <span className="block text-xs tabular-nums text-gray-500">
                                    {accountCount} art. · {formatCurrencyCents(accountTotal)}
                                </span>
                            </button>
                            <Button
                                disabled={hasPendingSales || creatingTicket || deletingCount > 0 || updatingQtyCount > 0 || settling || sendingToDebt}
                                onClick={() => { setDebtConfirm(false); setSheetOpen(true); }}
                                className="h-11 shrink-0 cursor-pointer"
                            >
                                Cobrar
                            </Button>
                        </div>
                    ) : jornadaInfo ? (
                        <button
                            type="button"
                            aria-label="Ver resumen de jornada"
                            onClick={() => setJornadaSheetOpen(true)}
                            className="flex w-full items-center justify-between gap-3 rounded-xl border bg-white px-3 py-2 shadow-sm transition-colors cursor-pointer active:bg-gray-100"
                        >
                            <span className="min-w-0 text-left">
                                <span className="block text-xs text-gray-500">Jornada #{jornadaInfo.id}</span>
                                <span className="block truncate text-sm font-bold tabular-nums text-gray-800">
                                    Esperado en caja {formatCurrencyCents(jornadaInfo.expectedCash)}
                                </span>
                            </span>
                            <ChevronUp className="h-4 w-4 shrink-0 text-gray-400" />
                        </button>
                    ) : null}
                </div>
            )}

            {/* Account sheet: the open account's lines with quantity controls,
                the payment method and the charge button. Same bottom-sheet
                idiom as the mobile nav menu. */}
            {!cashDialogOpen && !transferDialogOpen && (
                <DialogPrimitive.Root
                    open={sheetOpen}
                    onOpenChange={(open) => {
                        if (!open && (settling || sendingToDebt)) return;
                        setSheetOpen(open);
                        if (!open) setDebtConfirm(false);
                    }}
                >
                    <DialogPrimitive.Portal>
                        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
                        <DialogPrimitive.Content
                            className={cn(
                                "fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col overflow-hidden rounded-t-2xl border-t border-gray-100 bg-white shadow-lg outline-none",
                                "data-[state=open]:animate-in data-[state=closed]:animate-out",
                                "data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom duration-300"
                            )}
                        >
                            <div className="flex shrink-0 flex-col items-center pt-3 pb-2">
                                <div className="h-1.5 w-10 rounded-full bg-gray-300" />
                                <div className="mt-3 flex w-full items-center justify-between px-5">
                                    <DialogPrimitive.Title className="text-lg font-bold text-gray-900">
                                        Cuenta · {accountLabel}
                                    </DialogPrimitive.Title>
                                    <DialogPrimitive.Close
                                        disabled={settling || sendingToDebt}
                                        className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-600 transition-colors hover:bg-gray-200 outline-none disabled:opacity-50"
                                    >
                                        <X size={18} />
                                        <span className="sr-only">Cerrar</span>
                                    </DialogPrimitive.Close>
                                </div>
                            </div>
                            <DialogPrimitive.Description className="sr-only">
                                Detalle de la cuenta abierta: productos, cantidades y cobro.
                            </DialogPrimitive.Description>

                            <div role="region" aria-label="Contenido de la cuenta" className="min-h-0 flex-1 overflow-y-auto px-5 pb-3">
                                <div className="flex flex-col items-start gap-2 pb-3">
                                    <span className="text-sm font-medium text-gray-700">Método de pago</span>
                                    <div className="inline-flex rounded-full border border-gray-200 bg-white p-0.5">
                                        <button
                                            type="button"
                                            onClick={() => { if (closeMethod !== "CASH") setCashReceived(""); setCloseMethod("CASH"); }}
                                            aria-pressed={closeMethod === "CASH"}
                                            className={cn(
                                                "flex h-11 items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                                                closeMethod === "CASH" ? "bg-emerald-600 text-white" : "text-gray-600"
                                            )}
                                        >
                                            <Banknote className="h-4 w-4" />
                                            Efectivo
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => { if (closeMethod !== "TRANSFER") setCashReceived(""); setCloseMethod("TRANSFER"); }}
                                            aria-pressed={closeMethod === "TRANSFER"}
                                            className={cn(
                                                "flex h-11 items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                                                closeMethod === "TRANSFER" ? "bg-amber-500 text-white" : "text-gray-600"
                                            )}
                                        >
                                            <CreditCard className="h-4 w-4" />
                                            Transferencia
                                        </button>
                                    </div>
                                </div>

                                {accountLines.length === 0 ? (
                                    <p className="py-6 text-center text-sm text-gray-500">
                                        Esta cuenta no tiene productos.
                                    </p>
                                ) : (
                                    <ul className="mt-3">
                                        {accountLines.map((line) => (
                                            <li key={line.key} className={cn("border-b border-gray-100 py-3 last:border-0", line.optimistic && "opacity-60")}>
                                                <div className="flex items-start justify-between gap-3">
                                                    <p className="min-w-0 flex-1 text-sm font-medium text-gray-800">
                                                        <span className="text-gray-500">{line.quantity}×</span> {line.name}
                                                    </p>
                                                    <span className="shrink-0 text-sm font-semibold tabular-nums">
                                                        {formatCurrencyCents(line.subtotal)}
                                                    </span>
                                                </div>
                                                <div className="mt-2 flex items-center justify-between">
                                                    <div className="flex items-center gap-2">
                                                        <button
                                                            type="button"
                                                            aria-label="Reducir cantidad"
                                                            disabled={line.optimistic || settling || sendingToDebt || debtConfirm || deletingCount > 0 || updatingQtyCount > 0}
                                                            onClick={() => handleUpdateQuantity(line.saleId, line.quantity - 1, line.productID)}
                                                            className="flex h-9 w-9 items-center justify-center rounded-full border bg-white text-gray-700 shadow-sm cursor-pointer active:bg-gray-200"
                                                        >
                                                            <Minus className="h-4 w-4" />
                                                        </button>
                                                        <span className="w-6 text-center text-sm font-bold tabular-nums">{line.quantity}</span>
                                                        <button
                                                            type="button"
                                                            aria-label="Aumentar cantidad"
                                                            disabled={line.optimistic || settling || sendingToDebt || debtConfirm || deletingCount > 0 || updatingQtyCount > 0}
                                                            onClick={() => handleUpdateQuantity(line.saleId, line.quantity + 1, line.productID)}
                                                            className="flex h-9 w-9 items-center justify-center rounded-full border bg-white text-gray-700 shadow-sm cursor-pointer active:bg-gray-200"
                                                        >
                                                            <Plus className="h-4 w-4" />
                                                        </button>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        aria-label="Eliminar línea"
                                                        disabled={line.optimistic || settling || sendingToDebt || debtConfirm || deletingCount > 0 || updatingQtyCount > 0}
                                                        onClick={() => handleDeleteLine(line.saleId)}
                                                        className="flex h-9 w-9 items-center justify-center rounded-full bg-red-50 text-red-600 cursor-pointer active:bg-red-100"
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </button>
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                )}

                                <div className="mt-3 flex gap-2">
                                    <Button
                                        variant="outline"
                                        disabled={settling || sendingToDebt || deletingCount > 0 || updatingQtyCount > 0}
                                        onClick={resetToFreeSaleView}
                                        className="h-11 flex-1 cursor-pointer"
                                    >
                                        Salir de la cuenta
                                    </Button>
                                    {clientSelected && (
                                        <Button
                                            onClick={() => { setDebtSales(accountSales); setDebtConfirm(true); }}
                                            disabled={accountLines.length === 0 || settling || deletingCount > 0 || updatingQtyCount > 0 || sendingToDebt || accountSales.some((s) => s.id < 0)}
                                            className="h-11 flex-1 cursor-pointer bg-amber-500 text-black hover:bg-amber-400"
                                        >
                                            A deuda
                                        </Button>
                                    )}
                                </div>

                                {/* Inline confirm instead of a nested alert dialog:
                                    one modal at a time on a phone. */}
                                {debtConfirm && clientSelected && (
                                    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
                                        <p className="text-sm text-amber-900">
                                            ¿Enviar la cuenta de &quot;{query}&quot; a deuda? Total: {formatCurrencyCents(debtTotal)}
                                        </p>
                                        <div className="mt-2 flex gap-2">
                                            <Button
                                                variant="outline"
                                                disabled={sendingToDebt}
                                                onClick={() => setDebtConfirm(false)}
                                                className="h-10 flex-1 cursor-pointer"
                                            >
                                                Cancelar
                                            </Button>
                                            <Button
                                                disabled={sendingToDebt || deletingCount > 0 || updatingQtyCount > 0 || accountLines.length === 0 || accountSales.some((s) => s.id < 0)}
                                                onClick={handleToDebt}
                                                className="h-10 flex-1 cursor-pointer bg-amber-500 text-black hover:bg-amber-400"
                                            >
                                                Sí, a deuda
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="shrink-0 border-t border-gray-100 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3">
                                <div className="flex items-center justify-between pb-3 text-lg font-bold">
                                    <span>Total</span>
                                    <span className="tabular-nums">{formatCurrencyCents(accountTotal)}</span>
                                </div>

                                <Button
                                    onClick={() => {
                                        if (!activeSource) return;
                                        setCheckout({
                                            source: activeSource,
                                            label: accountLabel,
                                            ids: accountSales.map((sale) => sale.id),
                                            total: accountTotal,
                                            totalCents: accountTotalCents,
                                        });
                                        setCashSubmitError("");
                                        if (closeMethod === "CASH") setCashDialogOpen(true);
                                        else setTransferDialogOpen(true);
                                    }}
                                    disabled={accountLines.length === 0 || settling || sendingToDebt || deletingCount > 0 || updatingQtyCount > 0 || accountSales.some((s) => s.id < 0)}
                                    className="h-12 w-full cursor-pointer text-base font-bold"
                                >
                                    Cobrar {formatCurrencyCents(accountTotal)}
                                </Button>

                            </div>
                        </DialogPrimitive.Content>
                    </DialogPrimitive.Portal>
                </DialogPrimitive.Root>
            )}

            {/* Cash confirmation replaces the account sheet while open;
                cancelling returns to the same account without settling it. */}
            {cashDialogOpen && (
                <DialogPrimitive.Root
                    open={cashDialogOpen}
                    onOpenChange={(nextOpen) => {
                        if (!nextOpen && settling) return;
                        setCashDialogOpen(nextOpen);
                    }}
                >
                    <DialogPrimitive.Portal>
                        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
                        <DialogPrimitive.Content
                            className={cn(
                                "fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-lg outline-none",
                                "data-[state=open]:animate-in data-[state=closed]:animate-out",
                                "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 duration-200"
                            )}
                        >
                            <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-3 pt-4">
                                <div className="min-w-0">
                                    <DialogPrimitive.Title className="text-lg font-bold text-gray-900">
                                        Cobrar en efectivo
                                    </DialogPrimitive.Title>
                                    <DialogPrimitive.Description className="mt-1 text-sm text-gray-600">
                                        {checkout?.label}
                                    </DialogPrimitive.Description>
                                </div>
                                <DialogPrimitive.Close
                                    disabled={settling}
                                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600 transition-colors hover:bg-gray-200 outline-none disabled:opacity-50"
                                >
                                    <X size={18} />
                                    <span className="sr-only">Cerrar diálogo de efectivo</span>
                                </DialogPrimitive.Close>
                            </div>

                            <form
                                onSubmit={(event) => event.preventDefault()}
                                className="flex min-h-0 flex-1 flex-col"
                            >
                                <div role="region" aria-label="Datos del pago en efectivo" className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
                                    <label htmlFor="mobile-cash-received" className="mb-2 block text-sm font-medium text-gray-700">
                                        Efectivo recibido
                                    </label>
                                    <Input
                                        id="mobile-cash-received"
                                        type="text"
                                        inputMode="decimal"
                                        enterKeyHint="done"
                                        autoComplete="off"
                                        autoFocus
                                        required
                                        value={cashReceived}
                                        onChange={(event) => {
                                            setCashSubmitError("");
                                            setCashReceived(event.currentTarget.value);
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") {
                                                event.preventDefault();
                                                event.currentTarget.blur();
                                            }
                                        }}
                                        aria-invalid={cashReceivedInvalid || cashReceivedInsufficient}
                                        aria-describedby={cashReceivedInvalid || cashReceivedInsufficient ? "mobile-cash-change mobile-cash-error" : "mobile-cash-change"}
                                        className="h-11 bg-white text-base md:text-base"
                                    />
                                    <p id="mobile-cash-change" role="status" className="mt-2 text-sm font-semibold tabular-nums text-gray-800">
                                        {changeCents !== null && changeCents < BigInt(0)
                                            ? "Faltan $" + formatCents(-changeCents)
                                            : "Cambio a entregar: " + (changeCents === null ? "—" : "$" + formatCents(changeCents))}
                                    </p>
                                    {(cashReceivedInvalid || cashReceivedInsufficient) && (
                                        <p id="mobile-cash-error" role="alert" className="mt-1 text-sm text-destructive">
                                            {cashReceivedInvalid
                                                ? "Introduce un importe válido con hasta dos decimales, usando punto o coma."
                                                : "El monto recibido es menor al total del cobro. Ingresa un monto igual o mayor."}
                                        </p>
                                    )}
                                    {cashSubmitError && (
                                        <p id="mobile-cash-submit-error" role="alert" className="mt-1 text-sm text-destructive">
                                            {cashSubmitError}
                                        </p>
                                    )}
                                </div>

                                <div className="shrink-0 border-t border-gray-100 px-5 pb-4 pt-3">
                                    <div className="flex items-center justify-between pb-3 text-lg font-bold">
                                        <span>Total</span>
                                        <span className="tabular-nums">{formatCurrencyCents(checkoutTotalCents)}</span>
                                    </div>
                                    <Button
                                        type="button"
                                        onClick={() => void handleCloseAccount()}
                                        disabled={!checkout || settling || changeCents === null || changeCents < BigInt(0)}
                                        className="h-12 w-full cursor-pointer text-base font-bold"
                                    >
                                        Cobrar {formatCurrencyCents(checkoutTotalCents)}
                                    </Button>
                                    <DialogPrimitive.Close asChild>
                                        <Button type="button" variant="outline" disabled={settling} className="mt-2 h-11 w-full cursor-pointer">
                                            Volver a la cuenta
                                        </Button>
                                    </DialogPrimitive.Close>
                                </div>
                            </form>
                        </DialogPrimitive.Content>
                    </DialogPrimitive.Portal>
                </DialogPrimitive.Root>
            )}

            {transferDialogOpen && (
                <TransferConfirmationDialog
                    accountLabel={checkout?.label ?? null}
                    total={checkoutTotalCents}
                    onCancel={() => { if (!settling) setTransferDialogOpen(false); }}
                    onConfirm={handleCloseAccount}
                    errorMessage={cashSubmitError}
                />
            )}

            {/* Jornada sheet: the cash summary the desktop banner hides on
                phones, one tap away while no account is selected. */}
            <DialogPrimitive.Root open={jornadaSheetOpen} onOpenChange={setJornadaSheetOpen}>
                <DialogPrimitive.Portal>
                    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
                    <DialogPrimitive.Content
                        className={cn(
                            "fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl border-t border-gray-100 bg-white shadow-lg outline-none",
                            "data-[state=open]:animate-in data-[state=closed]:animate-out",
                            "data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom duration-300"
                        )}
                    >
                        <div className="flex shrink-0 flex-col items-center pt-3 pb-2">
                            <div className="h-1.5 w-10 rounded-full bg-gray-300" />
                            <div className="mt-3 flex w-full items-center justify-between px-5">
                                <DialogPrimitive.Title className="text-lg font-bold text-gray-900">
                                    Jornada #{jornadaInfo?.id}
                                </DialogPrimitive.Title>
                                <DialogPrimitive.Close className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-600 transition-colors hover:bg-gray-200 outline-none">
                                    <X size={18} />
                                    <span className="sr-only">Cerrar</span>
                                </DialogPrimitive.Close>
                            </div>
                        </div>
                        <DialogPrimitive.Description className="sr-only">
                            Resumen de caja de la jornada abierta.
                        </DialogPrimitive.Description>

                        {jornadaInfo && (
                            <div className="flex-1 overflow-y-auto px-5 pb-6">
                                <div className="rounded-xl border bg-emerald-50 px-4 py-3">
                                    <p className="text-xs font-medium text-emerald-800">Esperado en caja</p>
                                    <p className="text-2xl font-bold tabular-nums text-emerald-900">
                                        {formatCurrencyCents(jornadaInfo.expectedCash)}
                                    </p>
                                </div>

                                <dl className="mt-3 divide-y rounded-xl border">
                                    {[
                                        ["Fondo inicial", jornadaInfo.openingAmount],
                                        ["Ventas en efectivo", jornadaInfo.cashSales],
                                        ["Cobros de fiado en efectivo", jornadaInfo.debtCollectedCash],
                                        ["Egresos en efectivo", jornadaInfo.cashBills],
                                        ["Sueldos en efectivo", jornadaInfo.cashSalaries],
                                        ["Depósitos a ahorros", jornadaInfo.savingsOut],
                                    ].map(([label, value]) => (
                                        <div key={label as string} className="flex items-center justify-between px-4 py-2.5 text-sm">
                                            <dt className="text-gray-600">{label}</dt>
                                            <dd className="font-semibold tabular-nums text-gray-800">
                                                {formatCurrencyCents(Number(value))}
                                            </dd>
                                        </div>
                                    ))}
                                </dl>

                                {/* Same structure as the cash block, without an opening amount. */}
                                <div className="mt-3 rounded-xl border bg-sky-50 px-4 py-3">
                                    <p className="text-xs font-medium text-sky-800">Esperado en transferencias</p>
                                    <p className="text-2xl font-bold tabular-nums text-sky-900">
                                        {formatCurrencyCents(jornadaInfo.expectedTransfer)}
                                    </p>
                                </div>

                                <dl className="mt-3 divide-y rounded-xl border">
                                    {[
                                        ["Ventas por transferencia", jornadaInfo.transferSales],
                                        ["Cobros de fiado por transferencia", jornadaInfo.debtCollectedTransfer],
                                        ["Egresos por transferencia", jornadaInfo.transferBills],
                                        ["Sueldos por transferencia", jornadaInfo.transferSalaries],
                                    ].map(([label, value]) => (
                                        <div key={label as string} className="flex items-center justify-between px-4 py-2.5 text-sm">
                                            <dt className="text-gray-600">{label}</dt>
                                            <dd className="font-semibold tabular-nums text-gray-800">
                                                {formatCurrencyCents(Number(value))}
                                            </dd>
                                        </div>
                                    ))}
                                </dl>

                                <p className="mt-3 text-xs text-gray-500">
                                    {jornadaInfo.openedBy ? `Abierta por ${jornadaInfo.openedBy}` : ""}
                                    {jornadaInfo.openedAt
                                        ? ` · ${new Date(jornadaInfo.openedAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}`
                                        : ""}
                                </p>

                                <Link
                                    href="/admin/jornada"
                                    className="mt-3 block rounded-md bg-emerald-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-emerald-700"
                                >
                                    Ver detalles
                                </Link>
                            </div>
                        )}
                    </DialogPrimitive.Content>
                </DialogPrimitive.Portal>
            </DialogPrimitive.Root>
        </div>
    );
}
