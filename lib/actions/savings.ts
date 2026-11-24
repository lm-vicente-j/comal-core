"use server"
import prisma from "../prisma";
import type { Prisma } from "../../app/generated/prisma/client";
import { acquireSavingsPoolLock, lockOpenJornada } from "../ticket-reservations";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { isAdmin } from "../permissions";
import { isCalendarDate, toBusinessCalendarDate } from "../analytics";
import { toSafeInteger } from "@/lib/scaled-values";
import { actionFail, actionOk, type ActionResult } from "../action-result";
import { createPaginationSchema, getPaginationMeta, getPaginationOffset, escapeListSearch, type PaginationOptions } from "@/lib/pagination";
import { z } from "zod";

const INT4_MAX = 2_147_483_647;
const MAX_MONETARY_AMOUNT = 100_000_000_000_000;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

function isValidInt4Id(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= INT4_MAX;
}

function isSafeBigInt(value: bigint): boolean {
    return value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT;
}

function roundMoney(value: number): number {
    return toSafeInteger(value);
}


export async function getPoolBalance() {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) return { balance: 0, deposited: 0, withdrawn: 0 };

    return readPoolBalance(prisma);
}

async function readPoolBalanceRaw(db: Prisma.TransactionClient) {
    const [deposits, withdraws] = await Promise.all([
        db.savings_movement.aggregate({
            where: { type: "DEPOSIT" },
            _sum: { amountCents: true }
        }),
        db.savings_movement.aggregate({
            where: { type: "WITHDRAW" },
            _sum: { amountCents: true }
        })
    ]);

    const deposited = deposits._sum.amountCents ?? BigInt(0);
    const withdrawn = withdraws._sum.amountCents ?? BigInt(0);
    return { balance: deposited - withdrawn, deposited, withdrawn };
}

async function readPoolBalance(db: Prisma.TransactionClient) {
    const raw = await readPoolBalanceRaw(db);
    const deposited = roundMoney(toSafeInteger(raw.deposited));
    const withdrawn = roundMoney(toSafeInteger(raw.withdrawn));
    return { balance: toSafeInteger(BigInt(deposited) - BigInt(withdrawn)), deposited, withdrawn };
}

export async function getRecentMovements(options: PaginationOptions = {}) {
    const session = await auth();
    if (!session?.user) return actionFail("UNAUTHENTICATED" as const);
    if (!isAdmin(session.user.role)) return actionFail("FORBIDDEN" as const);
    const parsed = createPaginationSchema({ filters: z.object({}).strict(), sortFields: [] }).safeParse(options);
    if (!parsed.success) return actionFail("INVALID_INPUT" as const);
    try {
        return await prisma.$transaction(async tx => {
            const where: Prisma.savings_movementWhereInput = parsed.data.search ? { description: { contains: escapeListSearch(parsed.data.search), mode: "insensitive" } } : {};
            const total = await tx.savings_movement.count({ where });
            const meta = getPaginationMeta(total, parsed.data);
            const movements = await tx.savings_movement.findMany({ where, skip: getPaginationOffset(meta), take: meta.pageSize, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { users: { select: { name: true } } } });
            return actionOk({ ...meta, items: movements.map(m => ({ id: m.id, amount: toSafeInteger(m.amountCents), type: m.type, description: m.description, createdAt: m.createdAt, userName: m.users?.name ?? "Sin nombre" })) });
        }, { isolationLevel: "RepeatableRead" });
    } catch (error) { console.error(error); return actionFail("QUERY_FAILED" as const); }
}

export async function saveMovement(
    amount: number,
    type: "DEPOSIT" | "WITHDRAW",
    description?: string
): Promise<ActionResult> {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) {
        return actionFail("PERMISSION DENIED");
    }

    const registeredBy = Number(session.user.id);
    if (!isValidInt4Id(registeredBy)) {
        return actionFail("PERMISSION DENIED");
    }

    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
        return actionFail("Monto inválido");
    }
    const normalizedAmount = roundMoney(amount);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount < 1 || normalizedAmount > MAX_MONETARY_AMOUNT) {
        return actionFail("Monto inválido");
    }

    if (type !== "DEPOSIT" && type !== "WITHDRAW") {
        return actionFail("Tipo de movimiento inválido");
    }

    if (description !== undefined && description !== null && typeof description !== "string") {
        return actionFail("Descripción inválida");
    }

    try {
        const amountBig = BigInt(normalizedAmount);
        const result = await prisma.$transaction(async (tx): Promise<ActionResult> => {
            const jornadaActiva = await lockOpenJornada(tx);
            if (!jornadaActiva) return actionFail("NO_OPEN_JORNADA");

            await acquireSavingsPoolLock(tx);

            const poolRaw = await readPoolBalanceRaw(tx);
            if (type === "WITHDRAW") {
                if (amountBig > poolRaw.balance) {
                    return actionFail("Saldo insuficiente en el pool");
                }
                const nextWithdrawn = poolRaw.withdrawn + amountBig;
                const nextBalance = poolRaw.balance - amountBig;
                if (!isSafeBigInt(nextWithdrawn) || !isSafeBigInt(nextBalance)) {
                    return actionFail("Monto inválido");
                }
            } else {
                const nextDeposited = poolRaw.deposited + amountBig;
                const nextBalance = poolRaw.balance + amountBig;
                if (!isSafeBigInt(nextDeposited) || !isSafeBigInt(nextBalance)) {
                    return actionFail("Monto inválido");
                }

                const [
                    jornadaRow,
                    cashSalesAgg,
                    cashDebtAgg,
                    cashBillsAgg,
                    cashSalariesAgg,
                    jornadaDepositsAgg,
                ] = await Promise.all([
                    tx.jornada.findUnique({ where: { id: jornadaActiva.id }, select: { openingAmountCents: true } }),
                    tx.sales.aggregate({
                        where: { jornadaId: jornadaActiva.id, status: "PAID", debtors: { is: null }, payment_method: "CASH" },
                        _sum: { totalCents: true },
                    }),
                    tx.debtors.aggregate({
                        where: { paidJornadaId: jornadaActiva.id, status: "PAID", sales: { status: "PAID", payment_method: "CASH" } },
                        _sum: { amountCents: true },
                    }),
                    tx.bill.aggregate({ where: { jornadaId: jornadaActiva.id, payment_method: "CASH" }, _sum: { amountCents: true } }),
                    tx.salary.aggregate({ where: { jornadaId: jornadaActiva.id, payment_method: "CASH" }, _sum: { amountCents: true } }),
                    tx.savings_movement.aggregate({ where: { jornadaId: jornadaActiva.id, type: "DEPOSIT" }, _sum: { amountCents: true } }),
                ]);

                const nextSavingsOut = (jornadaDepositsAgg._sum.amountCents ?? BigInt(0)) + amountBig;
                const nextExpectedCash = (jornadaRow?.openingAmountCents ?? BigInt(0))
                    + (cashSalesAgg._sum.totalCents ?? BigInt(0))
                    + (cashDebtAgg._sum.amountCents ?? BigInt(0))
                    - (cashBillsAgg._sum.amountCents ?? BigInt(0))
                    - (cashSalariesAgg._sum.amountCents ?? BigInt(0))
                    - nextSavingsOut;

                if (!isSafeBigInt(nextSavingsOut) || !isSafeBigInt(nextExpectedCash)) {
                    return actionFail("Monto inválido");
                }
            }

            await tx.savings_movement.create({
                data: {
                    amountCents: amountBig,
                    type,
                    description: description?.trim() ? description.trim() : null,
                    registered_by: registeredBy,
                    jornadaId: jornadaActiva.id
                }
            });
            return actionOk();
        });
        if (!result.success) return result;

        revalidatePath("/admin/savings");
        revalidatePath("/(dashboard)", "layout");
        revalidatePath("/admin/jornada");
        return actionOk();
    } catch (e) {
        return actionFail("INTERNAL ERROR");
    }
}


export async function getGoalsWithProgress(options: PaginationOptions<{ status?: string }> = {}) {
    const session = await auth();
    if (!session?.user) return actionFail("UNAUTHENTICATED" as const);
    if (!isAdmin(session.user.role)) return actionFail("FORBIDDEN" as const);
    const parsed = createPaginationSchema({ filters: z.object({ status: z.enum(["ACTIVE", "inactive", "all"]).optional() }).strict(), sortFields: [] }).safeParse(options);
    if (!parsed.success) return actionFail("INVALID_INPUT" as const);
    const status = parsed.data.filters.status ?? "ACTIVE";
    const where: Prisma.savings_goalWhereInput = { ...(status === "all" ? {} : status === "inactive" ? { status: { in: ["COMPLETED", "CANCELLED"] } } : { status: "ACTIVE" }), ...(parsed.data.search ? { OR: [{ name: { contains: escapeListSearch(parsed.data.search), mode: "insensitive" } }, { description: { contains: escapeListSearch(parsed.data.search), mode: "insensitive" } }] } : {}) };
    try {
        return await prisma.$transaction(async tx => {
            const total = await tx.savings_goal.count({ where });
            const meta = getPaginationMeta(total, parsed.data);
            const goals = await tx.savings_goal.findMany({ where, skip: getPaginationOffset(meta), take: meta.pageSize, orderBy: [{ status: "asc" }, { createdAt: "desc" }, { id: "desc" }], include: { contributions: { select: { amountCents: true } } } });
            return actionOk({ ...meta, items: goals.map(g => {
                const current = toSafeInteger(g.contributions.reduce((sum, c) => sum + c.amountCents, BigInt(0)));
                const target = roundMoney(toSafeInteger(g.targetAmountCents));
                return { id: g.id, name: g.name, targetAmount: target, currentAmount: current, deadline: g.deadline, status: g.status, description: g.description, createdAt: g.createdAt, progressPercent: target > 0 ? Math.min(100, (current / target) * 100) : 0 };
            }) });
        }, { isolationLevel: "RepeatableRead" });
    } catch (error) { console.error(error); return actionFail("QUERY_FAILED" as const); }
}

function parseGoalDeadline(deadline: unknown): Date | null | undefined {
    if (deadline === undefined || deadline === null) return null;

    let normalizedDeadline: Date;
    if (deadline instanceof Date) {
        if (!Number.isFinite(deadline.getTime())) return undefined;
        normalizedDeadline = toBusinessCalendarDate(deadline);
    } else if (typeof deadline === "string") {
        const rawStr = deadline.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(rawStr)) {
            if (!isCalendarDate(rawStr)) return undefined;
            normalizedDeadline = new Date(`${rawStr}T00:00:00.000Z`);
        } else {
            const isoUtcMatch = rawStr.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/);
            if (!isoUtcMatch || !isCalendarDate(isoUtcMatch[1])) return undefined;
            const hour = Number(isoUtcMatch[2]);
            const minute = Number(isoUtcMatch[3]);
            const second = Number(isoUtcMatch[4]);
            if (hour > 23 || minute > 59 || second > 59) return undefined;
            const parsed = new Date(rawStr);
            if (!Number.isFinite(parsed.getTime())) return undefined;
            normalizedDeadline = toBusinessCalendarDate(parsed);
        }
    } else {
        return undefined;
    }

    const deadlineYear = normalizedDeadline.getUTCFullYear();
    if (!Number.isFinite(normalizedDeadline.getTime()) || deadlineYear < 1900 || deadlineYear > 9999) {
        return undefined;
    }
    return normalizedDeadline;
}

export async function saveGoal(data: {
    id?: number;
    name: string;
    targetAmount: number;
    deadline?: Date | null;
    description?: string;
}): Promise<ActionResult> {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) {
        return actionFail("PERMISSION DENIED");
    }

    if (!data || typeof data !== "object") {
        return actionFail("Datos inválidos");
    }

    const trimmedName = typeof data.name === "string" ? data.name.trim() : "";
    const normalizedTarget = typeof data.targetAmount === "number" && Number.isSafeInteger(data.targetAmount)
        ? roundMoney(data.targetAmount)
        : NaN;
    if (
        !trimmedName ||
        trimmedName.length > 80 ||
        !Number.isFinite(normalizedTarget) ||
        normalizedTarget < 1 ||
        normalizedTarget > MAX_MONETARY_AMOUNT
    ) {
        return actionFail("Datos inválidos");
    }

    const normalizedDeadline = parseGoalDeadline(data.deadline);
    if (normalizedDeadline === undefined) {
        return actionFail("Fecha límite inválida");
    }

    if (data.description !== undefined && data.description !== null && typeof data.description !== "string") {
        return actionFail("Datos inválidos");
    }

    const isUpdate = data.id !== undefined && data.id !== null;
    if (isUpdate && !isValidInt4Id(data.id)) {
        return actionFail("Datos inválidos");
    }

    try {
        const payload = {
            name: trimmedName,
            targetAmountCents: BigInt(normalizedTarget),
            deadline: normalizedDeadline,
            description: data.description?.trim() ? data.description.trim() : null,
        };

        if (isUpdate) {
            const txResult = await prisma.$transaction(async (tx): Promise<ActionResult> => {
                await tx.$executeRaw`SELECT id FROM savings_goal WHERE id = ${data.id!} FOR UPDATE`;
                const existing = await tx.savings_goal.findUnique({
                    where: { id: data.id! },
                    select: { id: true, status: true },
                });
                if (!existing) {
                    return actionFail("Meta no encontrada");
                }
                if (existing.status !== "ACTIVE") {
                    return actionFail("Solo se pueden editar metas activas");
                }

                const sum = await tx.goal_contribution.aggregate({
                    where: { goalId: data.id! },
                    _sum: { amountCents: true },
                });
                const currentTotal = roundMoney(toSafeInteger(sum._sum.amountCents ?? 0));
                const nextStatus = currentTotal >= normalizedTarget ? "COMPLETED" : "ACTIVE";

                await tx.savings_goal.update({
                    where: { id: data.id! },
                    data: {
                        ...payload,
                        status: nextStatus,
                    },
                });
                return actionOk();
            });

            if (!txResult.success) {
                return txResult;
            }
        } else {
            await prisma.savings_goal.create({
                data: payload,
            });
        }

        revalidatePath("/admin/savings");
        return actionOk();
    } catch (e) {
        return actionFail("INTERNAL ERROR");
    }
}

export async function cancelGoal(id: number): Promise<ActionResult> {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) {
        return actionFail("PERMISSION DENIED");
    }

    if (!isValidInt4Id(id)) {
        return actionFail("ID de meta inválido");
    }

    try {
        const txResult = await prisma.$transaction(async (tx): Promise<ActionResult> => {
            await tx.$executeRaw`SELECT id FROM savings_goal WHERE id = ${id} FOR UPDATE`;
            const goal = await tx.savings_goal.findUnique({
                where: { id },
                select: { id: true, status: true },
            });
            if (!goal) {
                return actionFail("Meta no encontrada");
            }
            if (goal.status !== "ACTIVE") {
                return actionFail("Solo se pueden cancelar metas activas");
            }

            await tx.savings_goal.update({
                where: { id },
                data: { status: "CANCELLED" }
            });
            return actionOk();
        });

        if (!txResult.success) {
            return txResult;
        }

        revalidatePath("/admin/savings");
        return actionOk();
    } catch (e) {
        return actionFail("INTERNAL ERROR");
    }
}


export async function addContribution(
    goalId: number,
    amount: number,
    note?: string
): Promise<ActionResult> {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) {
        return actionFail("PERMISSION DENIED");
    }

    if (!isValidInt4Id(goalId)) {
        return actionFail("ID de meta inválido");
    }

    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
        return actionFail("Monto inválido");
    }
    const normalizedAmount = roundMoney(amount);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount < 1 || normalizedAmount > MAX_MONETARY_AMOUNT) {
        return actionFail("Monto inválido");
    }

    if (note !== undefined && note !== null && typeof note !== "string") {
        return actionFail("Nota inválida");
    }

    try {
        const txResult = await prisma.$transaction(async (tx): Promise<ActionResult> => {
            await tx.$executeRaw`SELECT id FROM savings_goal WHERE id = ${goalId} FOR UPDATE`;
            const goal = await tx.savings_goal.findUnique({ where: { id: goalId } });
            if (!goal) {
                return actionFail("Meta no encontrada");
            }
            if (goal.status !== "ACTIVE") {
                return actionFail("Solo se pueden abonar metas activas");
            }

            await tx.goal_contribution.create({
                data: { goalId, amountCents: BigInt(normalizedAmount), note: note?.trim() ? note.trim() : null }
            });

            const sum = await tx.goal_contribution.aggregate({
                where: { goalId },
                _sum: { amountCents: true }
            });

            const total = roundMoney(toSafeInteger(sum._sum.amountCents ?? 0));
            const target = roundMoney(toSafeInteger(goal.targetAmountCents));

            if (total >= target) {
                await tx.savings_goal.update({
                    where: { id: goalId },
                    data: { status: "COMPLETED" }
                });
            }

            return actionOk();
        });

        if (!txResult.success) {
            return txResult;
        }

        revalidatePath("/admin/savings");
        return actionOk();
    } catch (e) {
        return actionFail("INTERNAL ERROR");
    }
}
