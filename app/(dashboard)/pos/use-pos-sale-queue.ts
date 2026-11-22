"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Product } from "@/lib/actions/schemas";
import { Sale, createSale } from "@/lib/actions/sales";
import { makeOptimisticSale } from "./optimistic-sale";
import { trackAction } from "@/lib/action-tracker";
import { freeTicketNumber } from "@/lib/pos-source";

const CONSECUTIVE_TAP_LIMIT = 3;
const PRODUCT_COOLDOWN_MS = 1000;

interface PendingSaleEntry {
    tempId: number;
    sale: Sale;
    serverSaleId?: number;
    /** Snapshot of the `sales` prop when `createSale` resolved, so any later server refresh retires the placeholder even if the sale was cancelled elsewhere. */
    resolvedAtSales?: Sale[];
}

interface QueuedTap {
    tempId: number;
    productId: number;
}

interface LiveQueueContext {
    sourceType: string | null;
    customerId: number;
    ticketSaleIds: number[];
    ticketAccountId: string | undefined;
}

interface UsePosSaleQueueOptions {
    sales: Sale[];
    activeSource: string | null;
    currentCustomerID: number;
    ticketSaleIds: number[];
    ticketAccountId: string | undefined;
    reservationRef: React.RefObject<{ ticketNumber: number; token: string } | null>;
    requestNewTicket: () => Promise<{ sourceType: string; reservationToken: string } | null>;
    isBlockedByOtherMutation: (queueActive: boolean) => boolean;
    onTicketSaleCreated: (saleId: number, ticketAccountId: string | undefined) => void;
    onClearAccountSelection: () => void;
}

/**
 * Sequential FIFO sale queue for rapid product taps on the POS.
 *
 * Instead of disabling a product button on every tap while createSale runs,
 * each tap immediately adds an optimistic placeholder row (gray) and queues
 * the server action sequentially. If the exact same product is tapped 3 times
 * in a row, only that product button enters a 1-second cooldown while the
 * queue continues flushing in the background.
 */
export function usePosSaleQueue({
    sales,
    activeSource,
    currentCustomerID,
    ticketSaleIds,
    ticketAccountId,
    reservationRef,
    requestNewTicket,
    isBlockedByOtherMutation,
    onTicketSaleCreated,
    onClearAccountSelection,
}: UsePosSaleQueueOptions) {
    const [pendingEntries, setPendingEntries] = useState<PendingSaleEntry[]>([]);
    const [queueActive, setQueueActive] = useState(false);
    const [coolingDownIds, setCoolingDownIds] = useState<ReadonlySet<number>>(() => new Set());

    const optimisticIdRef = useRef(0);
    const queueRef = useRef<QueuedTap[]>([]);
    const queueActiveRef = useRef(false);
    const hasPendingSalesRef = useRef(false);
    const liveContextRef = useRef<LiveQueueContext | null>(null);

    const consecutiveTapRef = useRef<{ productId: number | null; count: number }>({
        productId: null,
        count: 0,
    });
    const cooldownTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

    // Keep latest callbacks in refs so the async FIFO worker always invokes fresh closures.
    const requestNewTicketRef = useRef(requestNewTicket);
    const onTicketSaleCreatedRef = useRef(onTicketSaleCreated);
    const onClearAccountSelectionRef = useRef(onClearAccountSelection);
    useLayoutEffect(() => {
        requestNewTicketRef.current = requestNewTicket;
        onTicketSaleCreatedRef.current = onTicketSaleCreated;
        onClearAccountSelectionRef.current = onClearAccountSelection;
    });

    // Clear all cooldown timers on unmount.
    useEffect(() => {
        const timers = cooldownTimersRef.current;
        return () => {
            for (const timer of timers.values()) {
                clearTimeout(timer);
            }
            timers.clear();
        };
    }, []);

    const committedSaleIds = useMemo(() => new Set(sales.map((sale) => sale.id)), [sales]);
    const committedSaleIdsRef = useRef(committedSaleIds);
    const salesRef = useRef(sales);
    useLayoutEffect(() => {
        committedSaleIdsRef.current = committedSaleIds;
        salesRef.current = sales;
    }, [committedSaleIds, sales]);

    // Permanently prune resolved optimistic entries once their server row lands
    // (or once a newer server `sales` snapshot arrives). Without removing them
    // from state, later cancelling/removing that sale from `sales` would cause
    // `!committedSaleIds.has(serverSaleId)` to flip back to true, resurrecting
    // the gray placeholder and locking the POS permanently.
    const isEntryRetired = (entry: PendingSaleEntry) =>
        entry.serverSaleId !== undefined &&
        (committedSaleIds.has(entry.serverSaleId) ||
            (entry.resolvedAtSales !== undefined && entry.resolvedAtSales !== sales));

    if (pendingEntries.some(isEntryRetired)) {
        setPendingEntries((prev) => {
            const next = prev.filter((entry) => !isEntryRetired(entry));
            return next.length === prev.length ? prev : next;
        });
    }

    const unresolvedEntries = useMemo(
        () =>
            pendingEntries.filter(
                (entry) =>
                    entry.serverSaleId === undefined ||
                    (!committedSaleIds.has(entry.serverSaleId) &&
                        (entry.resolvedAtSales === undefined || entry.resolvedAtSales === sales)),
            ),
        [pendingEntries, committedSaleIds, sales],
    );

    const pendingSales = useMemo(
        () => unresolvedEntries.filter((entry) => entry.sale.source_type !== "").map((entry) => entry.sale),
        [unresolvedEntries],
    );

    const hasPendingSales = queueActive || unresolvedEntries.length > 0;

    // Sync ref right after commit so synchronous guards (isMutatingSelection) see the exact state.
    useLayoutEffect(() => {
        if (!hasPendingSales) {
            hasPendingSalesRef.current = false;
            liveContextRef.current = null;
        }
    }, [hasPendingSales]);

    const resetConsecutiveTaps = useCallback(() => {
        consecutiveTapRef.current = { productId: null, count: 0 };
        if (!queueActiveRef.current && !hasPendingSalesRef.current) {
            liveContextRef.current = null;
        }
    }, []);

    const drainQueue = useCallback(async () => {
        try {
            while (queueRef.current.length > 0) {
                const item = queueRef.current.shift()!;
                const ctx = liveContextRef.current;
                if (!ctx) break;

                let sourceType = ctx.sourceType;
                let reservationToken: string | null = null;

                if (sourceType) {
                    const ticketNum = freeTicketNumber(sourceType);
                    if (ticketNum !== null && reservationRef.current?.ticketNumber === ticketNum) {
                        reservationToken = reservationRef.current.token;
                    }
                } else {
                    let opened: { sourceType: string; reservationToken: string } | null = null;
                    try {
                        opened = await requestNewTicketRef.current();
                    } catch {
                        opened = null;
                    }
                    if (!opened) {
                        const droppedIds = new Set<number>([
                            item.tempId,
                            ...queueRef.current.map((q) => q.tempId),
                        ]);
                        queueRef.current = [];
                        setPendingEntries((prev) => prev.filter((e) => !droppedIds.has(e.tempId)));
                        break;
                    }
                    sourceType = opened.sourceType;
                    reservationToken = opened.reservationToken;
                    ctx.sourceType = sourceType;
                    ctx.customerId = 0;
                    ctx.ticketSaleIds = [];
                    ctx.ticketAccountId = undefined;

                    setPendingEntries((prev) =>
                        prev.map((e) =>
                            e.sale.source_type === ""
                                ? { ...e, sale: { ...e.sale, source_type: sourceType! } }
                                : e,
                        ),
                    );
                }

                const isWalkIn = freeTicketNumber(sourceType) !== null;
                try {
                    const result = await trackAction(createSale(
                        [{ productID: item.productId, quantity: 1 }],
                        "UNPAID",
                        sourceType,
                        ctx.customerId,
                        "CASH",
                        reservationToken ?? undefined,
                        isWalkIn && !reservationToken && ctx.ticketSaleIds.length > 0 ? ctx.ticketSaleIds : undefined,
                        isWalkIn ? ctx.ticketAccountId : undefined,
                    ));

                    if (result.success) {
                        if (reservationToken && reservationRef.current?.token === reservationToken) {
                            reservationRef.current = null;
                        }
                        const serverSaleId = result.data.saleId;
                        const nextAccountId = result.data.ticketAccountId;

                        if (isWalkIn && serverSaleId !== undefined) {
                            ctx.ticketSaleIds = [...ctx.ticketSaleIds, serverSaleId];
                            if (nextAccountId !== undefined) {
                                ctx.ticketAccountId = nextAccountId;
                            }
                            onTicketSaleCreatedRef.current(serverSaleId, nextAccountId);
                        }

                        setPendingEntries((prev) => {
                            const committed = committedSaleIdsRef.current;
                            const resolvedAtSales = salesRef.current;
                            const next: PendingSaleEntry[] = [];
                            for (const e of prev) {
                                if (e.tempId === item.tempId) {
                                    if (serverSaleId !== undefined && !committed.has(serverSaleId)) {
                                        next.push({ ...e, serverSaleId, resolvedAtSales });
                                    }
                                } else if (
                                    e.serverSaleId === undefined ||
                                    (!committed.has(e.serverSaleId) &&
                                        (e.resolvedAtSales === undefined || e.resolvedAtSales === resolvedAtSales))
                                ) {
                                    next.push(e);
                                }
                            }
                            return next;
                        });
                    } else {
                        const droppedIds = new Set<number>([
                            item.tempId,
                            ...queueRef.current.map((q) => q.tempId),
                        ]);
                        queueRef.current = [];
                        setPendingEntries((prev) => prev.filter((e) => !droppedIds.has(e.tempId)));

                        if (result.error === "TICKET_TAKEN") {
                            onClearAccountSelectionRef.current();
                            alert("El ticket cambió. Selecciona la cuenta vigente antes de agregar productos.");
                        } else if (result.error === "NO_OPEN_JORNADA") {
                            if (reservationToken && reservationRef.current?.token === reservationToken) {
                                reservationRef.current = null;
                            }
                            onClearAccountSelectionRef.current();
                            alert("No hay jornada activa. Pide al administrador que abra la jornada antes de registrar ventas.");
                        } else {
                            alert("No se pudo registrar la venta. Revisa la consola del servidor para más detalle.");
                        }
                        break;
                    }
                } catch {
                    const droppedIds = new Set<number>([
                        item.tempId,
                        ...queueRef.current.map((q) => q.tempId),
                    ]);
                    queueRef.current = [];
                    setPendingEntries((prev) => prev.filter((e) => !droppedIds.has(e.tempId)));
                    alert("No se pudo registrar la venta. Revisa tu conexión e intenta de nuevo.");
                    break;
                }
            }
        } finally {
            queueActiveRef.current = false;
            setQueueActive(false);
        }
    }, [reservationRef]);

    const enqueueProductTap = useCallback((product: Product) => {
        const productId = product.id ?? -1;
        if (cooldownTimersRef.current.has(productId)) return;
        if (isBlockedByOtherMutation(queueActiveRef.current)) return;

        // Track consecutive taps on the same product; on the 3rd consecutive tap,
        // cool down ONLY this product button for 1 second.
        if (consecutiveTapRef.current.productId === productId) {
            consecutiveTapRef.current.count += 1;
        } else {
            consecutiveTapRef.current = { productId, count: 1 };
        }
        if (consecutiveTapRef.current.count >= CONSECUTIVE_TAP_LIMIT) {
            consecutiveTapRef.current = { productId: null, count: 0 };
            setCoolingDownIds((prev) => {
                const next = new Set(prev);
                next.add(productId);
                return next;
            });
            const timer = setTimeout(() => {
                cooldownTimersRef.current.delete(productId);
                setCoolingDownIds((prev) => {
                    if (!prev.has(productId)) return prev;
                    const next = new Set(prev);
                    next.delete(productId);
                    return next;
                });
            }, PRODUCT_COOLDOWN_MS);
            cooldownTimersRef.current.set(productId, timer);
        }

        if (!liveContextRef.current || (!queueActiveRef.current && !hasPendingSalesRef.current)) {
            liveContextRef.current = {
                sourceType: activeSource,
                customerId: Number(currentCustomerID),
                ticketSaleIds: [...ticketSaleIds],
                ticketAccountId,
            };
        }

        const tempId = --optimisticIdRef.current;
        const initialSourceType = liveContextRef.current.sourceType ?? "";
        const entry: PendingSaleEntry = {
            tempId,
            sale: makeOptimisticSale(tempId, product, initialSourceType),
        };

        hasPendingSalesRef.current = true;
        setPendingEntries((prev) => {
            const committed = committedSaleIdsRef.current;
            const currentSales = salesRef.current;
            const unresolved = prev.filter(
                (e) =>
                    e.serverSaleId === undefined ||
                    (!committed.has(e.serverSaleId) &&
                        (e.resolvedAtSales === undefined || e.resolvedAtSales === currentSales)),
            );
            return [entry, ...unresolved];
        });
        queueRef.current.push({ tempId, productId });

        if (!queueActiveRef.current) {
            queueActiveRef.current = true;
            setQueueActive(true);
            void drainQueue();
        }
    }, [
        activeSource,
        currentCustomerID,
        ticketSaleIds,
        ticketAccountId,
        isBlockedByOtherMutation,
        drainQueue,
    ]);

    return {
        pendingSales,
        hasPendingSales,
        hasPendingSalesRef,
        coolingDownIds,
        enqueueProductTap,
        resetConsecutiveTaps,
    };
}
