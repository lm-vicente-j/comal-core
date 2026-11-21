// lib/ticket-reservations.ts
import { randomUUID } from "crypto";
import { Prisma } from "@/app/generated/prisma/client";
import prisma from "./prisma";

export const TICKET_RESERVATION_PREFIX = "TICKET_RES:";
export const TICKET_RESERVATION_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Fixed int4 namespace for PostgreSQL transaction-scoped advisory locks
// serializing guest ticket allocations, first-sale consumption, releases, and
// jornada closure per jornadaId across all processes and serverless instances.
const TICKET_LOCK_NAMESPACE = 290001;

export type TicketReservationData = {
    token: string;
    userId: number;
    expiresAt: number;
};

type DbClient = Prisma.TransactionClient | typeof prisma;

export function reservationKey(jornadaId: number, ticketNumber: number): string {
    return `${TICKET_RESERVATION_PREFIX}${jornadaId}:${ticketNumber}`;
}

function parseReservationKey(key: string): { jornadaId: number; ticketNumber: number } | null {
    const match = /^TICKET_RES:([1-9]\d*):([1-9]\d*)$/.exec(key);
    if (!match) return null;
    const jornadaId = Number(match[1]);
    const ticketNumber = Number(match[2]);
    if (!Number.isSafeInteger(jornadaId) || !Number.isSafeInteger(ticketNumber)) return null;
    return { jornadaId, ticketNumber };
}

function parseReservationValue(value: string | null): TicketReservationData | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as Partial<TicketReservationData>;
        if (
            typeof parsed.token === "string" &&
            parsed.token.length > 0 &&
            typeof parsed.userId === "number" &&
            Number.isInteger(parsed.userId) &&
            typeof parsed.expiresAt === "number" &&
            Number.isFinite(parsed.expiresAt)
        ) {
            return {
                token: parsed.token,
                userId: parsed.userId,
                expiresAt: parsed.expiresAt,
            };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Acquires a PostgreSQL transaction-scoped advisory lock for guest ticket
 * operations on a given jornada. Released automatically on COMMIT or ROLLBACK
 * and compatible with transaction poolers (e.g., PgBouncer / Supabase :6543).
 */
export async function acquireJornadaTicketLock(
    tx: Prisma.TransactionClient,
    jornadaId: number
): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TICKET_LOCK_NAMESPACE}::int4, ${jornadaId}::int4)`;
}

/**
 * Prunes expired or malformed ticket reservations across ALL jornadas and
 * returns the currently active reservations for `jornadaId`.
 */
export async function pruneAndListReservations(
    tx: DbClient,
    jornadaId: number,
    now = Date.now()
): Promise<Map<number, TicketReservationData>> {
    const rows = await tx.setting.findMany({
        where: { key: { startsWith: TICKET_RESERVATION_PREFIX } },
        select: { key: true, value: true },
    });

    const expiredKeys: string[] = [];
    const active = new Map<number, TicketReservationData>();

    for (const row of rows) {
        const parsedKey = parseReservationKey(row.key);
        const parsedVal = parseReservationValue(row.value);

        if (!parsedKey || !parsedVal || parsedVal.expiresAt <= now) {
            expiredKeys.push(row.key);
            continue;
        }

        if (parsedKey.jornadaId === jornadaId) {
            active.set(parsedKey.ticketNumber, parsedVal);
        }
    }

    if (expiredKeys.length > 0) {
        await tx.setting.deleteMany({
            where: { key: { in: expiredKeys } },
        });
    }

    return active;
}

/**
 * Persists a guest ticket reservation in PostgreSQL for an open jornada.
 */
export async function createReservation(
    tx: DbClient,
    jornadaId: number,
    ticketNumber: number,
    userId: number,
    ttlMs = TICKET_RESERVATION_TTL_MS,
    now = Date.now()
): Promise<TicketReservationData> {
    const data: TicketReservationData = {
        token: randomUUID(),
        userId,
        expiresAt: now + ttlMs,
    };

    const key = reservationKey(jornadaId, ticketNumber);
    const serialized = JSON.stringify(data);

    await tx.setting.upsert({
        where: { key },
        update: { value: serialized },
        create: { key, value: serialized },
    });

    return data;
}

/**
 * Reads an active reservation for `(jornadaId, ticketNumber)`.
 * Deletes and returns null if expired or malformed.
 */
export async function getReservation(
    tx: DbClient,
    jornadaId: number,
    ticketNumber: number,
    now = Date.now()
): Promise<TicketReservationData | null> {
    const key = reservationKey(jornadaId, ticketNumber);
    const row = await tx.setting.findUnique({
        where: { key },
        select: { value: true },
    });

    if (!row) return null;

    const parsed = parseReservationValue(row.value);
    if (!parsed || parsed.expiresAt <= now) {
        await tx.setting.deleteMany({ where: { key } });
        return null;
    }

    return parsed;
}

/**
 * Deletes any reservation for `(jornadaId, ticketNumber)`.
 */
export async function deleteReservation(
    tx: DbClient,
    jornadaId: number,
    ticketNumber: number
): Promise<void> {
    await tx.setting.deleteMany({
        where: { key: reservationKey(jornadaId, ticketNumber) },
    });
}

/**
 * Deletes a reservation only when it is active and its token matches the
 * caller-provided token, preventing cross-terminal sabotage.
 */
export async function deleteReservationByToken(
    tx: DbClient,
    jornadaId: number,
    ticketNumber: number,
    token: string,
    now = Date.now()
): Promise<boolean> {
    const existing = await getReservation(tx, jornadaId, ticketNumber, now);
    if (!existing || existing.token !== token) {
        return false;
    }
    await tx.setting.deleteMany({
        where: { key: reservationKey(jornadaId, ticketNumber) },
    });
    return true;
}

/**
 * Clears all reservations belonging to `jornadaId` (called atomically when
 * closing a jornada).
 */
export async function clearJornadaReservations(
    tx: DbClient,
    jornadaId: number
): Promise<void> {
    await tx.setting.deleteMany({
        where: { key: { startsWith: `${TICKET_RESERVATION_PREFIX}${jornadaId}:` } },
    });
}

/**
 * Clears all ticket reservations across all jornadas (primarily for tests).
 */
export async function resetAllTicketReservations(): Promise<void> {
    await prisma.setting.deleteMany({
        where: { key: { startsWith: TICKET_RESERVATION_PREFIX } },
    });
}
