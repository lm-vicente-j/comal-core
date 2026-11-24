"use server"
import { toSafeInteger } from "@/lib/scaled-values";
import { cache } from "react";
import { Prisma } from "@/app/generated/prisma/client";
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { getJornadaCashSummary } from "../jornada-cash";
import { isAdmin } from "@/lib/permissions";
import { acquireJornadaTicketLock, clearJornadaReservations } from "../ticket-reservations";
import { actionFail, actionOk, type ActionResult, type FieldErrors } from "../action-result";

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
const MAX_MONETARY_AMOUNT = 100_000_000_000_000;

function isValidInt4Id(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= INT4_MAX;
}

function revalidateShiftPaths(): void {
    revalidatePath("/admin/jornada");
    revalidatePath("/(dashboard)", "layout");
    revalidatePath("/pos");
    revalidatePath("/debtors");
    revalidatePath("/admin/savings");
}

type OpenAccountSummary = {
    sourceType: string;
    count: number;
    total: number;
};

export async function openJornada(
    openingAmount: number
): Promise<ActionResult<undefined, string, FieldErrors, { pendingJornadaId: number }>> {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) {
        return actionFail("PERMISSION DENIED");
    }

    const userId = Number(session.user.id);
    if (!isValidInt4Id(userId)) {
        return actionFail("PERMISSION DENIED");
    }

    if (typeof openingAmount !== "number" || !Number.isSafeInteger(openingAmount) || openingAmount < 0 || openingAmount > MAX_MONETARY_AMOUNT) {
        return actionFail("Monto inicial inválido");
    }

    try {
        const result = await prisma.$transaction(async (tx): Promise<ActionResult<undefined, string, FieldErrors, { pendingJornadaId: number }>> => {
            // Zero is reserved for opening; all existing jornadas use positive IDs.
            await acquireJornadaTicketLock(tx, 0);
            const pending = await tx.jornada.findFirst({
                where: { status: "OPEN" },
                select: { id: true },
            });
            if (pending) {
                return actionFail("PENDING_JORNADA", { data: { pendingJornadaId: pending.id } });
            }
            await tx.jornada.create({
                data: {
                    openedBy: userId,
                    openingAmountCents: BigInt(openingAmount),
                    status: "OPEN"
                },
            });
            return actionOk();
        });
        if (!result.success) return result;

        revalidateShiftPaths();
        return actionOk();
    } catch (e) {
        const isUniqueViolation =
            (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") ||
            (typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "P2002");
        if (isUniqueViolation) {
            const pending = await prisma.jornada.findFirst({
                where: { status: "OPEN" },
                select: { id: true },
            });
            if (pending) {
                return actionFail("PENDING_JORNADA", { data: { pendingJornadaId: pending.id } });
            }
        }
        return actionFail("INTERNAL ERROR");
    }
}

export async function closeJornada(
    jornadaId: number,
    actualClosingAmount: number
): Promise<ActionResult<undefined, string, FieldErrors, { openAccounts: OpenAccountSummary[] }>> {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) {
        return actionFail("PERMISSION DENIED");
    }

    const userId = Number(session.user.id);
    if (!isValidInt4Id(userId)) {
        return actionFail("PERMISSION DENIED");
    }

    if (!isValidInt4Id(jornadaId)) {
        return actionFail("Jornada inválida");
    }

    if (typeof actualClosingAmount !== "number" || !Number.isSafeInteger(actualClosingAmount) || actualClosingAmount < 0 || actualClosingAmount > MAX_MONETARY_AMOUNT) {
        return actionFail("Monto físico inválido");
    }

    try {
        const txResult = await prisma.$transaction(async (tx): Promise<ActionResult<undefined, string, FieldErrors, { openAccounts: OpenAccountSummary[] }>> => {
            await acquireJornadaTicketLock(tx, jornadaId);

            const current = await tx.jornada.findUnique({
                where: { id: jornadaId },
                select: { status: true, openingAmountCents: true },
            });
            if (!current) {
                return actionFail("Jornada no encontrada");
            }
            if (current.status !== "OPEN") {
                return actionFail("La jornada ya está cerrada");
            }

            // Open table/client accounts must be settled in the POS first (paid,
            // sent to debt or cancelled): closing over them would strand the sales
            // as UNPAID forever, with no UI left to resolve them.
            const currentOpen = await tx.sales.groupBy({
                by: ["source_type"],
                where: { jornadaId, status: "UNPAID" },
                _count: { id: true },
                _sum: { totalCents: true },
            });
            if (currentOpen.length > 0) {
                return actionFail("OPEN_ACCOUNTS", {
                    data: {
                        openAccounts: currentOpen.map((a) => ({
                            sourceType: a.source_type ?? "SIN ORIGEN",
                            count: a._count.id,
                            total: toSafeInteger(a._sum.totalCents ?? 0),
                        })),
                    },
                });
            }

            const cash = await getJornadaCashSummary(jornadaId, toSafeInteger(current.openingAmountCents), tx);
            const { count } = await tx.jornada.updateMany({
                where: { id: jornadaId, status: "OPEN" },
                data: {
                    status: "CLOSED",
                    closedAt: new Date(),
                    closedBy: userId,
                    expectedClosingAmountCents: BigInt(cash.expectedCash),
                    expectedTransferAmountCents: BigInt(cash.expectedTransfer),
                    actualClosingAmountCents: BigInt(actualClosingAmount),
                },
            });
            if (count !== 1) {
                return actionFail("La jornada ya está cerrada");
            }

            await clearJornadaReservations(tx, jornadaId);
            return actionOk();
        });

        if (!txResult.success) {
            return txResult;
        }

        revalidateShiftPaths();
        return actionOk();
    } catch (e) {
        return actionFail("INTERNAL ERROR");
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

    const cash = await getJornadaCashSummary(jornada.id, toSafeInteger(jornada.openingAmountCents));

    const currentUserId = Number(session.user.id);
    const isMine = jornada.openedBy === currentUserId;

    const serializedJornada = {
        id: jornada.id,
        openedAt: jornada.openedAt,
        closedAt: jornada.closedAt,
        openedBy: jornada.openedBy,
        closedBy: jornada.closedBy,
        status: jornada.status,
        openingAmount: toSafeInteger(jornada.openingAmountCents),
        expectedClosingAmount: jornada.expectedClosingAmountCents !== null
            ? toSafeInteger(jornada.expectedClosingAmountCents)
            : null,
        actualClosingAmount: jornada.actualClosingAmountCents !== null
            ? toSafeInteger(jornada.actualClosingAmountCents)
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
            _sum: { totalCents: true },
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
                totalSold: toSafeInteger(g._sum.totalCents ?? 0),
            }))
            .sort((a, b) => b.totalSold - a.totalSold);
    } catch {
        return [];
    }
}
