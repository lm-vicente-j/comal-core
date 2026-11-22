"use client";

import { useCallback, useEffect, useMemo, useOptimistic, useRef, useState, startTransition } from "react";
import Seatings from "@/components/Seatings";
import FreeSaleTickets, { FreeSaleTicket } from "@/components/FreeSaleTickets";
import SalesInputClient from "@/components/Sales-input-client";
import DataTable from "./date-table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCaption, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { Product } from "@/lib/actions/schemas";
import { Sale, cancelSaleAction, createSale, nextFreeSaleTicket, releaseTicketReservationAction, updateSaleQuantity } from "@/lib/actions/sales";
import { SalesRow } from "./saleRow";
import { makeOptimisticSale, salesOptimisticReducer } from "./optimistic-sale";
import { trackAction } from "@/lib/action-tracker";
import {
    customerSource,
    formatSourceType,
    freeTicketNumber,
    freeTicketSource,
    isAccountSource,
    tableSource,
} from "@/lib/pos-source";

interface PosManagerProps {
    products: Product[];
    sales: Sale[];
    customerList: { id: number; customerName: string | null; alias: string | null }[];
    jornadaOpen: boolean;
    activeJornadaId: number | null;
}

function FilterSales(sales:Sale[], src:string):Sale[]{
    // Account views (table, customer, walk-in ticket) show only the open
    // (UNPAID) account: once it is settled the table can be occupied again
    // with a clean slate, so its settled history stays out of the POS view.
    const isAccountView = isAccountSource(src);
    return sales.filter(s => s.source_type == src && (!isAccountView || s.status === "UNPAID"));
}


export default function PosManager({ products, sales, customerList, jornadaOpen, activeJornadaId }: PosManagerProps) {

    const [tableNumber, setTableNumber] = useState(0);
    const [query, setQuery] = useState("");
    const [clientSelected, setClientSelected] = useState(false);
    // Walk-in ticket being served, 0 when none. Mutually exclusive with the
    // table and customer selections: a sale belongs to exactly one account.
    const [freeTicket, setFreeTicket] = useState(0);
    const [creatingTicket, setCreatingTicket] = useState(false);

    const [currentCustomerID, setCurrentCustomerID] = useState(0);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [pendingId, setPendingId] = useState<number | null>(null);

    // Optimistic overlay: a tapped product shows up in the order list, the
    // ticket totals and the close-account receipt in the same instant,
    // before createSale answers. When the revalidated sales arrive, the
    // placeholder is swapped for the real row. If the action fails, the
    // overlay simply reverts to the props.
    const [optimisticSales, applyOptimistic] = useOptimistic(sales, salesOptimisticReducer);
    const activeSales = useMemo(
        () => optimisticSales.filter((sale) => sale.id < 0
            ? pendingId !== null
            : activeJornadaId !== null && sale.jornadaId === activeJornadaId),
        [optimisticSales, activeJornadaId, pendingId],
    );

    // Per-tap feedback: the pressed product darkens while its sale is being
    // registered (and further taps on it are ignored meanwhile).
    const optimisticIdRef = useRef(0);
    // Tracks the server-issued reservation token for an empty guest ticket
    // selected on this terminal before its first product is added.
    const [reservedTicket, setReservedTicket] = useState(0);
    const [ticketSaleIds, setTicketSaleIds] = useState<number[]>([]);
    const [ticketAccountId, setTicketAccountId] = useState<string>();
    const [deletingCount, setDeletingCount] = useState(0);
    const [updatingQtyCount, setUpdatingQtyCount] = useState(0);
    const [settlingAccount, setSettlingAccount] = useState(false);
    const reservationRef = useRef<{ ticketNumber: number; token: string } | null>(null);
    const creatingTicketRef = useRef(false);
    const pendingTapRef = useRef(false);
    const deletingLineCountRef = useRef(0);
    const updatingQtyCountRef = useRef(0);
    const settlingAccountRef = useRef(false);
    const handleSettlementBusyChange = useCallback((busy: boolean) => {
        settlingAccountRef.current = busy;
        setSettlingAccount(busy);
    }, []);

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

    // Open walk-in tickets, derived from the sales the server component
    // already loaded — no extra query, and the layout's AutoRefresh keeps
    // them in sync with the other terminals.
    const openTickets = useMemo(() => {
        const byNumber = new Map<number, FreeSaleTicket>();

        for (const sale of activeSales) {
            if (sale.status !== "UNPAID") continue;
            const number = freeTicketNumber(sale.source_type);
            if (number === null) continue;

            const ticket = byNumber.get(number)
                ?? { sourceType: sale.source_type, number, total: 0 };
            ticket.total += Number(sale.total);
            byNumber.set(number, ticket);
        }

        return byNumber;
    }, [activeSales]);

    // A ticket that was just opened has no sales yet, so it only exists in
    // this component's state while this terminal holds its active reservation.
    const tickets = useMemo(() => {
        const list = Array.from(openTickets.values());
        if (freeTicket > 0 && freeTicket === reservedTicket && !openTickets.has(freeTicket)) {
            list.push({ sourceType: freeTicketSource(freeTicket), number: freeTicket, total: 0 });
        }
        return list.sort((a, b) => a.number - b.number);
    }, [openTickets, freeTicket, reservedTicket]);

    // The account every new sale goes to; null means no account is selected
    // and the order list below stays empty until the next tap opens a ticket.
    const activeSource =
        tableNumber > 0 ? tableSource(tableNumber)
        : clientSelected && currentCustomerID > 0 ? customerSource(currentCustomerID)
        : freeTicket > 0 ? freeTicketSource(freeTicket)
        : null;

    // Derived instead of a second piece of state: keeping a `salesFilter`
    // in sync by hand meant every selector had to remember to update both.
    // With no account selected the list stays clean: a settled account must
    // not keep showing its products as if the sale were still open (the
    // day's history lives in the reports, not in the order list).
    const visibleSales = useMemo(
        () => {
            if (!activeSource) return [];
            const matching = FilterSales(activeSales, activeSource);
            if (freeTicket === 0) return matching;
            if (ticketAccountId) return matching.filter((sale) => sale.id < 0 || sale.ticketAccountId === ticketAccountId);
            if (matching.some((sale) => ticketSaleIds.includes(sale.id))) return matching;
            return matching.filter((sale) => sale.id < 0);
        },
        [activeSales, activeSource, freeTicket, ticketSaleIds, ticketAccountId]
    );
    const hasPreviousAccount = sales.some((sale) =>
        sale.status === "UNPAID" && (activeJornadaId === null || sale.jornadaId !== activeJornadaId) &&
        (!activeSource || sale.source_type === activeSource)
    );

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

    const clearAccountSelection = () => {
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
        setDialogOpen(false);
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
            pendingId === null &&
            !dialogOpen &&
            !pendingTapRef.current &&
            deletingCount === 0 &&
            deletingLineCountRef.current === 0
        ) {
            clearAccountSelection();
        }
    }, [freeTicket, reservedTicket, committedOpenTickets, pendingId, deletingCount, ticketAccountId, activeJornadaId, sales, dialogOpen]);

    const isMutatingSelection = () =>
        creatingTicketRef.current ||
        pendingTapRef.current ||
        deletingLineCountRef.current > 0 ||
        updatingQtyCountRef.current > 0 ||
        settlingAccountRef.current;

    const handleAccountSettled = () => {
        releasePendingReservation();
        clearAccountSelection();
    };

    const handleSetDialogOpen = (open: boolean) => {
        if (open && isMutatingSelection()) return;
        setDialogOpen(open);
    };

    const resetToFreeSaleView = () => {
        if (isMutatingSelection()) return;
        releasePendingReservation();
        clearAccountSelection();
    };

    const handleTableSelect = (num: number) => {
        if (isMutatingSelection()) return;
        resetToFreeSaleView();
        setTableNumber(num);
    };

    const handleClientSelect = (customer: { id: number; name: string }) => {
        if (isMutatingSelection()) return;
        resetToFreeSaleView();
        setQuery(customer.name);
        setClientSelected(true);
        setCurrentCustomerID(customer.id);
    };

    const handleTicketSelect = (ticketNumber: number) => {
        if (isMutatingSelection()) return;
        if (ticketNumber === freeTicket && (visibleSales.length > 0 || reservedTicket === ticketNumber)) return;
        resetToFreeSaleView();
        setFreeTicket(ticketNumber);
        const ticketSales = activeSales.filter((sale) =>
            sale.status === "UNPAID" && sale.id > 0 && sale.source_type === freeTicketSource(ticketNumber)
        );
        setTicketSaleIds(ticketSales.map((sale) => sale.id));
        setTicketAccountId(ticketSales.find((sale) => sale.ticketAccountId)?.ticketAccountId ?? undefined);
    };

    // Opening a ticket doesn't close the others: it only changes which one
    // receives the next products. The number is reserved on the server so two
    // terminals can't hand the same one to two different customers.
    const requestNewTicket = async (): Promise<{ sourceType: string; reservationToken: string } | null> => {
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
                alert(result.message === "NO_OPEN_JORNADA"
                    ? "No hay jornada activa. Pide al administrador que abra la jornada antes de registrar ventas."
                    : "No se pudo abrir el ticket. Intenta de nuevo.");
                return null;
            }

            const number = freeTicketNumber(result.sourceType);
            if (number === null) return null;

            clearAccountSelection();
            setFreeTicket(number);
            setReservedTicket(number);
            reservationRef.current = { ticketNumber: number, token: result.reservationToken };
            return { sourceType: result.sourceType, reservationToken: result.reservationToken };
        } catch {
            alert("No se pudo abrir el ticket. Revisa tu conexión e intenta de nuevo.");
            return null;
        } finally {
            creatingTicketRef.current = false;
            setCreatingTicket(false);
        }
    };

    const openNewTicket = async (): Promise<{ sourceType: string; reservationToken: string } | null> => {
        if (isMutatingSelection()) return null;
        return await requestNewTicket();
    };

    // Tapping a product with nothing selected opens a walk-in ticket on the
    // spot, so the quick "tap and done" flow survives: the only change is
    // that the sale now waits in an account until it is charged.
    const ensureSourceType = async (): Promise<{ sourceType: string; reservationToken: string | null } | null> => {
        if (activeSource) {
            const token =
                freeTicket > 0 && reservationRef.current?.ticketNumber === freeTicket
                    ? reservationRef.current.token
                    : null;
            return { sourceType: activeSource, reservationToken: token };
        }
        return await requestNewTicket();
    };

    // Optimistic add: the line, the totals and the receipt update instantly;
    // the server action runs inside the transition and its revalidated
    // payload replaces the placeholder when it lands.
    const handleProductTap = (product: Product) => {
        if (isMutatingSelection()) return;
        const productId = product.id ?? -1;

        pendingTapRef.current = true;
        setPendingId(productId);
        void (async () => {
            let target: { sourceType: string; reservationToken: string | null } | null = null;
            try {
                target = await ensureSourceType();
            } catch {
                target = null;
            }
            if (!target) {
                pendingTapRef.current = false;
                setPendingId(null);
                return;
            }

            const { sourceType, reservationToken } = target;

            startTransition(async () => {
                applyOptimistic({ type: "add", sale: makeOptimisticSale(--optimisticIdRef.current, product, sourceType) });
                try {
                    const result = await trackAction(createSale(
                        [{ productID: productId, quantity: 1 }],
                        "UNPAID",
                        sourceType,
                        Number(currentCustomerID),
                        "CASH",
                        reservationToken ?? undefined,
                        freeTicketNumber(sourceType) !== null && !reservationToken && ticketSaleIds.length > 0 ? ticketSaleIds : undefined,
                        ticketAccountId,
                    ));
                    if (result.success) {
                        if (freeTicketNumber(sourceType) !== null && "saleId" in result && typeof result.saleId === "number") {
                            const saleId = result.saleId;
                            setTicketSaleIds((ids) => [...ids, saleId]);
                            if ("ticketAccountId" in result) setTicketAccountId(result.ticketAccountId);
                        }
                        if (reservationToken && reservationRef.current?.token === reservationToken) {
                            reservationRef.current = null;
                        }
                    } else if (result.error === "TICKET_TAKEN") {
                        clearAccountSelection();
                        alert("El ticket cambió. Selecciona la cuenta vigente antes de agregar productos.");
                    } else if (result.message === "NO_OPEN_JORNADA") {
                        if (reservationToken && reservationRef.current?.token === reservationToken) {
                            reservationRef.current = null;
                        }
                        clearAccountSelection();
                        alert("No hay jornada activa. Pide al administrador que abra la jornada antes de registrar ventas.");
                    } else {
                        alert("No se pudo registrar la venta. Revisa la consola del servidor para más detalle.");
                    }
                } catch {
                    alert("No se pudo registrar la venta. Revisa tu conexión e intenta de nuevo.");
                } finally {
                    pendingTapRef.current = false;
                    setPendingId(null);
                }
            });
        })();
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
                        res.message === "JORNADA_CLOSED"
                            ? "La jornada de esta venta ya está cerrada."
                            : res.message === "UNAUTHORIZED"
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

    return (
        // Mobile (< lg): single scrollable column ordered for the 3-tap sale
        // flow (context selector -> product grid -> recent orders).
        // Desktop (lg+): 40/60 two-column layout, products spanning the left.
        <div className="z-0 flex w-full flex-col gap-3 p-3 lg:grid lg:h-full lg:grid-cols-[2fr_3fr] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-0 lg:p-0">
            {/* Sale controls go inert without an open jornada; the history below stays usable. */}
            <div
                aria-disabled={!jornadaOpen}
                className={`order-2 lg:order-none lg:col-start-1 lg:row-start-1 lg:row-span-2 lg:flex lg:h-full lg:items-center lg:justify-center ${!jornadaOpen ? "pointer-events-none opacity-50 select-none" : ""}`}
            >
                <DataTable data={products} onProductTap={handleProductTap} pendingId={pendingId} />
            </div>

            <div
                aria-disabled={!jornadaOpen}
                className={`order-1 lg:order-none lg:col-start-2 lg:row-start-1 lg:px-5 lg:pt-5 ${!jornadaOpen ? "pointer-events-none opacity-50 select-none" : ""}`}
            >
                <div className="flex flex-col rounded-md">
                    <p className="font-bold mb-2">Mesas</p>
                    <Seatings
                        tableNumber={tableNumber}
                        setTableNumber={handleTableSelect}
                    />
                </div>

                <div className="flex flex-col rounded-md mt-4">
                    <p className="font-bold mb-2">Clientes de paso</p>
                    <FreeSaleTickets
                        tickets={tickets}
                        activeTicket={freeTicket}
                        onSelect={handleTicketSelect}
                        onNew={openNewTicket}
                        creating={creatingTicket || pendingId !== null}
                    />
                </div>

                <SalesInputClient
                    currentCustomerSales={visibleSales}
                    sourceType={activeSource}
                    accountLabel={activeSource ? (clientSelected && query ? `Cliente ${query}` : formatSourceType(activeSource)) : "Venta libre"}
                    query={query}
                    clientSelected={clientSelected}
                    onClientSelect={handleClientSelect}
                    onFreeSaleView={resetToFreeSaleView}
                    onAccountSettled={handleAccountSettled}
                    setDialogOpen={handleSetDialogOpen}
                    dialogOpen={dialogOpen}
                    customerList={customerList}
                    currentCustomerID={currentCustomerID}
                    isMutating={creatingTicket || pendingId !== null || deletingCount > 0 || updatingQtyCount > 0}
                    onBusyChange={handleSettlementBusyChange}
                />
            </div>

            <ScrollArea className="order-3 h-[50vh] w-full rounded-md border p-2 lg:order-none lg:col-start-2 lg:row-start-2 lg:mx-5 lg:mb-5 lg:h-auto lg:w-auto lg:p-4">
                <Table>
                    <TableCaption>Pedidos de la cuenta seleccionada.</TableCaption>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="hidden sm:table-cell">Cliente/Mesa</TableHead>
                            {/* Short labels + tight padding below sm so the
                                operations column never gets cut off. */}
                            <TableHead className="px-1 sm:px-2">
                                <span className="sm:hidden">Cant.</span>
                                <span className="hidden sm:inline">Cantidad</span>
                            </TableHead>
                            <TableHead className="px-1 sm:px-2">Platillo</TableHead>
                            <TableHead className="px-1 text-right sm:px-2">Precio</TableHead>
                            <TableHead className="px-1 text-center sm:px-2">
                                <span className="sm:hidden">Ops.</span>
                                <span className="hidden sm:inline">Operacion</span>
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        <SalesRow
                            sales={visibleSales}
                            onUpdateQuantity={handleUpdateQuantity}
                            onDeleteLine={handleDeleteLine}
                            disabled={creatingTicket || pendingId !== null || deletingCount > 0 || updatingQtyCount > 0 || settlingAccount}
                        />

                    </TableBody>
                </Table>
                {hasPreviousAccount && (
                    <p role="status" className="px-4 py-2 text-sm text-amber-800">
                        Solo puedes cobrar las ventas de la jornada activa. Hay ventas de otra jornada.
                    </p>
                )}
                {visibleSales.length === 0 && (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                        {activeSource
                            ? "Esta cuenta no tiene productos."
                            : "Sin cuenta seleccionada: toca un producto para abrir un ticket, o elige una mesa, ticket o cliente."}
                    </p>
                )}
            </ScrollArea>
        </div>
    );
}
