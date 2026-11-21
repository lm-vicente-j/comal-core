"use server"
import { cache } from "react";
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { getJornadaCashSummary } from "../jornada-cash";
import { isAdmin } from "@/lib/permissions";
import { acquireJornadaTicketLock, clearJornadaReservations } from "../ticket-reservations";

// React.cache memoizes per server request: the dashboard layout (banner)
// and the /pos page ask for the same jornada data in a single render, so
// the query work runs once per render instead of once per caller.
const hasOpenJornadaCached = cache(async () => {
    const session = await auth();
    if (!session?.user) return null;

    const jornada = await prisma.jornada.findFirst({
        where: { status: "OPEN" },
        select: { id: true }
    });
    return jornada?.id ?? null;
});

// Lightweight check used by the UI to disable controls that need an open jornada.
export async function hasOpenJornada() {
    return (await hasOpenJornadaCached()) !== null;
}

export async function getOpenJornadaId() {
    return hasOpenJornadaCached();
}

const INT4_MAX = 2_147_483_647;
const MAX_MONETARY_AMOUNT = 1_000_000_000_000;

function isValidInt4Id(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= INT4_MAX;
}

export async function openJornada(openingAmount: number) {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) {
        return { success: false, error: "PERMISSION DENIED" };
    }

    const userId = Number(session.user.id);
    if (!isValidInt4Id(userId)) {
        return { success: false, error: "PERMISSION DENIED" };
    }

    if (typeof openingAmount !== "number" || !Number.isFinite(openingAmount) || openingAmount < 0 || openingAmount > MAX_MONETARY_AMOUNT) {
        return { success: false, error: "Monto inicial inválido" };
    }

    try {
        const result = await prisma.$transaction(async (tx) => {
            // Zero is reserved for opening; all existing jornadas use positive IDs.
            await acquireJornadaTicketLock(tx, 0);
            const pending = await tx.jornada.findFirst({
                where: { status: "OPEN" },
                select: { id: true },
            });
            if (pending) {
                return { success: false, error: "PENDING_JORNADA", pendingJornadaId: pending.id };
            }
            await tx.jornada.create({
                data: {
                    openedBy: userId,
                    openingAmount,
                    status: "OPEN"
                },
            });
            return { success: true };
        });
        if (!result.success) return result;

        revalidatePath("/admin/jornada");
        return { success: true };
    } catch (e) {
        return { success: false, error: "INTERNAL ERROR" };
    }
}

export async function closeJornada(
    jornadaId: number,
    actualClosingAmount: number
) {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) {
        return { success: false, error: "PERMISSION DENIED" };
    }

    const userId = Number(session.user.id);
    if (!isValidInt4Id(userId)) {
        return { success: false, error: "PERMISSION DENIED" };
    }

    if (!isValidInt4Id(jornadaId)) {
        return { success: false, error: "Jornada inválida" };
    }

    if (typeof actualClosingAmount !== "number" || !Number.isFinite(actualClosingAmount) || actualClosingAmount < 0 || actualClosingAmount > MAX_MONETARY_AMOUNT) {
        return { success: false, error: "Monto físico inválido" };
    }

    try {
        const jornada = await prisma.jornada.findUnique({
            where: { id: jornadaId }
        });

        if (!jornada) {
            return { success: false, error: "Jornada no encontrada" };
        }

        if (jornada.status !== "OPEN") {
            return { success: false, error: "La jornada ya está cerrada" };
        }

        // Open table/client accounts must be settled in the POS first (paid,
        // sent to debt or cancelled): closing over them would strand the sales
        // as UNPAID forever, with no UI left to resolve them.
        const openAccounts = await prisma.sales.groupBy({
            by: ["source_type"],
            where: { jornadaId: jornada.id, status: "UNPAID" },
            _count: { id: true },
            _sum: { total: true },
        });

        if (openAccounts.length > 0) {
            return {
                success: false,
                error: "OPEN_ACCOUNTS",
                openAccounts: openAccounts.map((a) => ({
                    sourceType: a.source_type ?? "SIN ORIGEN",
                    count: a._count.id,
                    total: Number(a._sum.total ?? 0),
                })),
            };
        }

        const txResult = await prisma.$transaction(async (tx) => {
            await acquireJornadaTicketLock(tx, jornadaId);

            const current = await tx.jornada.findUnique({
                where: { id: jornadaId },
                select: { status: true, openingAmount: true },
            });
            if (!current || current.status !== "OPEN") {
                return { success: false as const, error: "La jornada ya está cerrada" };
            }

            const currentOpen = await tx.sales.groupBy({
                by: ["source_type"],
                where: { jornadaId, status: "UNPAID" },
                _count: { id: true },
                _sum: { total: true },
            });
            if (currentOpen.length > 0) {
                return {
                    success: false as const,
                    error: "OPEN_ACCOUNTS",
                    openAccounts: currentOpen.map((a) => ({
                        sourceType: a.source_type ?? "SIN ORIGEN",
                        count: a._count.id,
                        total: Number(a._sum.total ?? 0),
                    })),
                };
            }

            const cash = await getJornadaCashSummary(jornadaId, Number(current.openingAmount), tx);
            await tx.jornada.update({
                where: { id: jornadaId },
                data: {
                    status: "CLOSED",
                    closedAt: new Date(),
                    closedBy: userId,
                    expectedClosingAmount: cash.expectedCash,
                    expectedTransferAmount: cash.expectedTransfer,
                    actualClosingAmount
                }
            });

            await clearJornadaReservations(tx, jornadaId);
            return { success: true as const };
        });

        if (!txResult.success) {
            return txResult;
        }

        revalidatePath("/admin/jornada");
        return { success: true };
    } catch (e) {
        return { success: false, error: "INTERNAL ERROR" };
    }
}

// Wrapped in React.cache for the same reason as hasOpenJornada: JornadaBanner
// and the /pos page both need these stats in the same render, and the
// aggregate queries are the heaviest part of a POS reload.
const getActiveJornadaWithStatsCached = cache(async () => {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) return null;

    const jornada = await prisma.jornada.findFirst({
        where: { status: "OPEN" },
        include: {
            openedByUser: { select: { id: true, name: true } }
        }
    });

    if (!jornada) {
        return {
            state: "NO_JORNADA" as const,
            currentUserId: Number(session.user.id)
        };
    }

    const cash = await getJornadaCashSummary(jornada.id, Number(jornada.openingAmount));

    const currentUserId = Number(session.user.id);
    const isMine = jornada.openedBy === currentUserId;

    const serializedJornada = {
        id: jornada.id,
        openedAt: jornada.openedAt,
        closedAt: jornada.closedAt,
        openedBy: jornada.openedBy,
        closedBy: jornada.closedBy,
        status: jornada.status,
        openingAmount: Number(jornada.openingAmount),
        expectedClosingAmount: jornada.expectedClosingAmount !== null
            ? Number(jornada.expectedClosingAmount)
            : null,
        actualClosingAmount: jornada.actualClosingAmount !== null
            ? Number(jornada.actualClosingAmount)
            : null,
        openedByUser: jornada.openedByUser
            ? { id: jornada.openedByUser.id, name: jornada.openedByUser.name }
            : null,
    };

    return {
        state: isMine ? "OWN_OPEN" as const : "OTHER_OPEN" as const,
        jornada: serializedJornada,
        stats: cash,
        currentUserId
    };
});

export async function getActiveJornadaWithStats() {
    return getActiveJornadaWithStatsCached();
}


export async function getJornadaEmployeeBreakdown(jornadaId: number) {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) return [];
    if (!isValidInt4Id(jornadaId)) return [];

    try {
        const grouped = await prisma.sales.groupBy({
            by: ['placedBy'],
            where: { jornadaId, status: 'PAID' },
            _sum: { total: true },
            _count: { id: true },
        });

        if (grouped.length === 0) return [];

        const userIds = grouped.map(g => g.placedBy).filter((id): id is number => id !== null);
        const users = await prisma.users.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true }
        });

        const usersMap = new Map(users.map(u => [u.id, u.name ?? 'Sin nombre']));

        return grouped
            .map(g => ({
                userId: g.placedBy,
                userName: g.placedBy ? usersMap.get(g.placedBy) ?? 'Desconocido' : 'Desconocido',
                salesCount: g._count.id,
                totalSold: Number(g._sum.total ?? 0),
            }))
            .sort((a, b) => b.totalSold - a.totalSold);
    } catch {
        return [];
    }
}
