"use server"
import prisma from "../prisma";
import type { Prisma } from "../../app/generated/prisma/client";
import { lockOpenJornada } from "../ticket-reservations";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { isAdmin } from "../permissions";
import { isCalendarDate, toBusinessCalendarDate } from "../analytics";

const INT4_MAX = 2_147_483_647;
const MAX_MONETARY_AMOUNT = 1_000_000_000_000;

function isValidInt4Id(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= INT4_MAX;
}

function roundMoney(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

type ActionResult =
    | { success: true }
    | { success: false; message: string };


export async function getPoolBalance() {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) return { balance: 0, deposited: 0, withdrawn: 0 };

    return readPoolBalance(prisma);
}

async function readPoolBalance(db: Prisma.TransactionClient) {
    const [deposits, withdraws] = await Promise.all([
        db.savings_movement.aggregate({
            where: { type: "DEPOSIT" },
            _sum: { amount: true }
        }),
        db.savings_movement.aggregate({
            where: { type: "WITHDRAW" },
            _sum: { amount: true }
        })
    ]);

    const deposited = roundMoney(Number(deposits._sum.amount ?? 0));
    const withdrawn = roundMoney(Number(withdraws._sum.amount ?? 0));
    return { balance: roundMoney(deposited - withdrawn), deposited, withdrawn };
}

// Paginated: returns one page of movements and whether more remain.
export async function getRecentMovements(limit = 20, offset = 0) {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) return { items: [], hasMore: false };

    const safeLimit = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 20));
    const safeOffset = Math.min(INT4_MAX, Math.max(0, Number.isInteger(offset) ? offset : 0));

    try {
        const movements = await prisma.savings_movement.findMany({
            skip: safeOffset,
            // One extra row just to know whether another page exists.
            take: safeLimit + 1,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            include: { users: { select: { name: true } } }
        });

        return {
            items: movements.slice(0, safeLimit).map(m => ({
                id: m.id,
                amount: Number(m.amount),
                type: m.type,
                description: m.description,
                createdAt: m.createdAt,
                userName: m.users?.name ?? "Sin nombre"
            })),
            hasMore: movements.length > safeLimit,
        };
    } catch {
        return { items: [], hasMore: false };
    }
}

export async function saveMovement(
    amount: number,
    type: "DEPOSIT" | "WITHDRAW",
    description?: string
): Promise<ActionResult> {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) {
        return { success: false, message: "PERMISSION DENIED" };
    }

    const registeredBy = Number(session.user.id);
    if (!isValidInt4Id(registeredBy)) {
        return { success: false, message: "PERMISSION DENIED" };
    }

    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
        return { success: false, message: "Monto inválido" };
    }
    const normalizedAmount = roundMoney(amount);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount < 0.01 || normalizedAmount > MAX_MONETARY_AMOUNT) {
        return { success: false, message: "Monto inválido" };
    }

    if (type !== "DEPOSIT" && type !== "WITHDRAW") {
        return { success: false, message: "Tipo de movimiento inválido" };
    }

    if (description !== undefined && description !== null && typeof description !== "string") {
        return { success: false, message: "Descripción inválida" };
    }

    try {
        const result = await prisma.$transaction(async (tx): Promise<ActionResult> => {
            const jornadaActiva = await lockOpenJornada(tx);
            if (!jornadaActiva) return { success: false, message: "NO_OPEN_JORNADA" };

            if (type === "WITHDRAW") {
                const { balance } = await readPoolBalance(tx);
                if (normalizedAmount > balance) {
                    return { success: false, message: "Saldo insuficiente en el pool" };
                }
            }
            await tx.savings_movement.create({
                data: {
                    amount: normalizedAmount,
                    type,
                    description: description?.trim() ? description.trim() : null,
                    registered_by: registeredBy,
                    jornadaId: jornadaActiva.id
                }
            });
            return { success: true };
        });
        if (!result.success) return result;

        revalidatePath("/admin/savings");
        revalidatePath("/(dashboard)", "layout");  // affects the banner
        return { success: true };
    } catch (e) {
        return { success: false, message: "INTERNAL ERROR" };
    }
}


export async function getGoalsWithProgress() {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) return [];

    const goals = await prisma.savings_goal.findMany({
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        include: {
            contributions: {
                select: { amount: true }
            }
        }
    });

    return goals.map(g => {
        const current = roundMoney(g.contributions.reduce((sum, c) => sum + Number(c.amount), 0));
        const target = roundMoney(Number(g.targetAmount));
        return {
            id: g.id,
            name: g.name,
            targetAmount: target,
            currentAmount: current,
            deadline: g.deadline,
            status: g.status,
            description: g.description,
            createdAt: g.createdAt,
            progressPercent: target > 0 ? Math.min(100, (current / target) * 100) : 0
        };
    });
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
        return { success: false, message: "PERMISSION DENIED" };
    }

    if (!data || typeof data !== "object") {
        return { success: false, message: "Datos inválidos" };
    }

    const trimmedName = typeof data.name === "string" ? data.name.trim() : "";
    const normalizedTarget = typeof data.targetAmount === "number" && Number.isFinite(data.targetAmount)
        ? roundMoney(data.targetAmount)
        : NaN;
    if (
        !trimmedName ||
        trimmedName.length > 80 ||
        !Number.isFinite(normalizedTarget) ||
        normalizedTarget < 0.01 ||
        normalizedTarget > MAX_MONETARY_AMOUNT
    ) {
        return { success: false, message: "Datos inválidos" };
    }

    let normalizedDeadline: Date | null = null;
    if (data.deadline !== undefined && data.deadline !== null) {
        if (!(data.deadline instanceof Date) && typeof data.deadline !== "string") {
            return { success: false, message: "Fecha límite inválida" };
        }
        if (typeof data.deadline === "string") {
            const rawStr = (data.deadline as string).trim();
            const prefixMatch = rawStr.match(/^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/);
            if (!prefixMatch || !isCalendarDate(prefixMatch[1])) {
                return { success: false, message: "Fecha límite inválida" };
            }
        }
        const parsedDeadline = data.deadline instanceof Date ? data.deadline : new Date(data.deadline);
        if (!Number.isFinite(parsedDeadline.getTime())) {
            return { success: false, message: "Fecha límite inválida" };
        }
        normalizedDeadline = toBusinessCalendarDate(parsedDeadline);
        const deadlineYear = normalizedDeadline.getUTCFullYear();
        if (!Number.isFinite(normalizedDeadline.getTime()) || deadlineYear < 1900 || deadlineYear > 9999) {
            return { success: false, message: "Fecha límite inválida" };
        }
    }

    if (data.description !== undefined && data.description !== null && typeof data.description !== "string") {
        return { success: false, message: "Datos inválidos" };
    }

    const isUpdate = data.id !== undefined && data.id !== null;
    if (isUpdate && !isValidInt4Id(data.id)) {
        return { success: false, message: "Datos inválidos" };
    }

    try {
        const payload = {
            name: trimmedName,
            targetAmount: normalizedTarget,
            deadline: normalizedDeadline,
            description: data.description?.trim() ? data.description.trim() : null,
        };

        if (isUpdate) {
            const txResult = await prisma.$transaction(async (tx) => {
                const existing = await tx.savings_goal.findUnique({
                    where: { id: data.id! },
                    select: { id: true, status: true },
                });
                if (!existing) {
                    return { success: false as const, message: "Meta no encontrada" };
                }
                if (existing.status !== "ACTIVE") {
                    return { success: false as const, message: "Solo se pueden editar metas activas" };
                }

                const sum = await tx.goal_contribution.aggregate({
                    where: { goalId: data.id! },
                    _sum: { amount: true },
                });
                const currentTotal = roundMoney(Number(sum._sum.amount ?? 0));
                const nextStatus = currentTotal >= normalizedTarget ? "COMPLETED" : "ACTIVE";

                await tx.savings_goal.update({
                    where: { id: data.id! },
                    data: {
                        ...payload,
                        status: nextStatus,
                    },
                });
                return { success: true as const };
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
        return { success: true };
    } catch (e) {
        return { success: false, message: "INTERNAL ERROR" };
    }
}

export async function cancelGoal(id: number): Promise<ActionResult> {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) {
        return { success: false, message: "PERMISSION DENIED" };
    }

    if (!isValidInt4Id(id)) {
        return { success: false, message: "ID de meta inválido" };
    }

    try {
        const goal = await prisma.savings_goal.findUnique({
            where: { id },
            select: { id: true, status: true },
        });
        if (!goal) {
            return { success: false, message: "Meta no encontrada" };
        }
        if (goal.status !== "ACTIVE") {
            return { success: false, message: "Solo se pueden cancelar metas activas" };
        }

        await prisma.savings_goal.update({
            where: { id },
            data: { status: "CANCELLED" }
        });
        revalidatePath("/admin/savings");
        return { success: true };
    } catch (e) {
        return { success: false, message: "INTERNAL ERROR" };
    }
}


export async function addContribution(
    goalId: number,
    amount: number,
    note?: string
): Promise<ActionResult> {
    const session = await auth();
    if (!session?.user || !isAdmin(session.user.role)) {
        return { success: false, message: "PERMISSION DENIED" };
    }

    if (!isValidInt4Id(goalId)) {
        return { success: false, message: "ID de meta inválido" };
    }

    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
        return { success: false, message: "Monto inválido" };
    }
    const normalizedAmount = roundMoney(amount);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount < 0.01 || normalizedAmount > MAX_MONETARY_AMOUNT) {
        return { success: false, message: "Monto inválido" };
    }

    if (note !== undefined && note !== null && typeof note !== "string") {
        return { success: false, message: "Nota inválida" };
    }

    try {
        const txResult = await prisma.$transaction(async (tx) => {
            const goal = await tx.savings_goal.findUnique({ where: { id: goalId } });
            if (!goal) {
                return { success: false as const, message: "Meta no encontrada" };
            }
            if (goal.status !== "ACTIVE") {
                return { success: false as const, message: "Solo se pueden abonar metas activas" };
            }

            await tx.goal_contribution.create({
                data: { goalId, amount: normalizedAmount, note: note?.trim() ? note.trim() : null }
            });

            const sum = await tx.goal_contribution.aggregate({
                where: { goalId },
                _sum: { amount: true }
            });

            const total = roundMoney(Number(sum._sum.amount ?? 0));
            const target = roundMoney(Number(goal.targetAmount));

            if (total >= target) {
                await tx.savings_goal.update({
                    where: { id: goalId },
                    data: { status: "COMPLETED" }
                });
            }

            return { success: true as const };
        });

        if (!txResult.success) {
            return txResult;
        }

        revalidatePath("/admin/savings");
        return { success: true };
    } catch (e) {
        return { success: false, message: "INTERNAL ERROR" };
    }
}
