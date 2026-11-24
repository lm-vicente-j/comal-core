"use client"
import { parseCents, formatCents, formatCurrencyCents } from "@/lib/scaled-values";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveMovement, saveGoal, addContribution, cancelGoal, getRecentMovements, getGoalsWithProgress } from "@/lib/actions/savings";
import { DataPagination, PaginationErrorState, usePaginationState, usePaginatedResource } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose
} from "@/components/ui/dialog";
import { Plus, ArrowDownLeft, ArrowUpRight, Target, CheckCircle2, XCircle, PiggyBank } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Props = {
    pool: { balance: number; deposited: number; withdrawn: number };
    jornadaOpen: boolean;
};

export default function SavingsManager({ pool, jornadaOpen }: Props) {
    const pagination = usePaginationState({ filterKeys: ["status"], defaultTab: "pool" });
    const tab = pagination.tab === "goals" ? "goals" : "pool";
    const movements = usePaginatedResource(getRecentMovements, pagination.query, { enabled: tab === "pool", onPageClamp: pagination.replacePage });
    const goals = usePaginatedResource(getGoalsWithProgress, pagination.query, { enabled: tab === "goals", onPageClamp: pagination.replacePage });
    return (
        <Tabs value={tab} onValueChange={pagination.setTab} className="w-full gap-4">
            <TabsList className="w-full sm:w-auto grid grid-cols-2 sm:inline-flex">
                <TabsTrigger value="pool" className="cursor-pointer">
                    <PiggyBank className="h-4 w-4" /> Alcancía
                </TabsTrigger>
                <TabsTrigger value="goals" className="cursor-pointer">
                    <Target className="h-4 w-4" /> Metas
                </TabsTrigger>
            </TabsList>
            <TabsContent value="pool">
                <PoolCard pool={pool} movements={movements.data?.items ?? []} jornadaOpen={jornadaOpen} onChange={movements.refresh} showEmpty={!!movements.data && !movements.error} />
                {movements.error && <PaginationErrorState error={movements.error} onRetry={movements.refresh} />}
                {movements.data && <DataPagination {...movements.data} onPageChange={pagination.setPage} onPageSizeChange={pagination.setPageSize} isPending={movements.isPending} totalLabel="movimientos" />}
            </TabsContent>
            <TabsContent value="goals">
                <div className="mb-3"><Select value={String(pagination.query.filters?.status ?? "ACTIVE")} onValueChange={status => pagination.setFilters({ status })}><SelectTrigger aria-label="Estado de metas"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ACTIVE">Activas</SelectItem><SelectItem value="inactive">Inactivas</SelectItem><SelectItem value="all">Todas</SelectItem></SelectContent></Select></div>
                <GoalsSection goals={goals.data?.items ?? []} onChange={goals.refresh} showEmpty={!!goals.data && !goals.error} />
                {goals.error && <PaginationErrorState error={goals.error} onRetry={goals.refresh} />}
                {goals.data && <DataPagination {...goals.data} onPageChange={pagination.setPage} onPageSizeChange={pagination.setPageSize} isPending={goals.isPending} totalLabel="metas" />}
            </TabsContent>
        </Tabs>
    );
}

type Movement = Extract<Awaited<ReturnType<typeof getRecentMovements>>, { success: true }>["data"]["items"][number];
type Goal = Extract<Awaited<ReturnType<typeof getGoalsWithProgress>>, { success: true }>["data"]["items"][number];
function PoolCard({ pool, movements: items, jornadaOpen, onChange, showEmpty }: { pool: Props["pool"]; movements: Movement[]; jornadaOpen: boolean; onChange: () => void; showEmpty: boolean }) {
    return (
        <Card className="p-4 md:p-6">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
                <div>
                    <h2 className="text-lg font-semibold text-gray-700">Alcancia</h2>
                    <p className="text-3xl font-bold text-emerald-700 mt-1">{formatCurrencyCents(pool.balance)}</p>
                    <p className="text-xs text-gray-500 mt-1">
                        Depositado total: ${formatCents(pool.deposited)} · Retirado total: ${formatCents(pool.withdrawn)}
                    </p>
                </div>
                <MovementDialog jornadaOpen={jornadaOpen} onChange={onChange} />
            </div>

            <h3 className="text-sm font-medium text-gray-700 mt-6 mb-2">Movimientos recientes</h3>
            {items.length === 0 ? (
                showEmpty &&
                <p className="text-sm text-gray-500">Aún no hay movimientos registrados.</p>
            ) : (
                <div className="divide-y">
                    {items.map(m => (
                        <div key={m.id} className="py-2.5 flex items-center justify-between gap-2 text-sm">
                            <div className="flex items-center gap-2.5 min-w-0">
                                {m.type === "DEPOSIT"
                                    ? <ArrowDownLeft className="h-4 w-4 text-emerald-600 shrink-0" />
                                    : <ArrowUpRight className="h-4 w-4 text-red-600 shrink-0" />}
                                <div className="min-w-0">
                                    <p className="font-medium break-words">{m.description || (m.type === "DEPOSIT" ? "Depósito" : "Retiro")}</p>
                                    <p className="text-xs text-gray-500">
                                        {new Date(m.createdAt).toLocaleString("es-MX")} · {m.userName}
                                    </p>
                                </div>
                            </div>
                            <span className={`font-semibold shrink-0 ${m.type === "DEPOSIT" ? "text-emerald-700" : "text-red-700"}`}>
                                {m.type === "DEPOSIT" ? "+" : "−"}${formatCents(m.amount)}
                            </span>
                        </div>
                    ))}
                </div>
            )}

        </Card>
    );
}

function MovementDialog({ jornadaOpen, onChange }: { jornadaOpen: boolean; onChange: () => void }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [type, setType] = useState<"DEPOSIT" | "WITHDRAW">("DEPOSIT");
    const [amount, setAmount] = useState("");
    const [description, setDescription] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSave = async () => {
        if (loading) return;
        setError(null);
        const parsed = parseCents(amount);
        if (parsed === null || parsed <= 0) {
            setError("Monto inválido");
            return;
        }
        setLoading(true);
        try {
            const res = await saveMovement(parsed, type, description.trim() || undefined);
            if (res.success) {
                setOpen(false);
                setAmount("");
                setDescription("");
                setType("DEPOSIT");
                onChange();
                router.refresh();
            } else {
                setError(
                    res.error === "NO_OPEN_JORNADA"
                        ? "Necesitas abrir una jornada antes de registrar movimientos."
                        : res.error
                );
            }
        } catch {
            setError("Error de conexión al guardar el movimiento");
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen && loading) return;
                setOpen(nextOpen);
                if (!nextOpen) {
                    setError(null);
                    setAmount("");
                    setDescription("");
                    setType("DEPOSIT");
                }
            }}
        >
            <DialogTrigger asChild>
                {/* Movements post against the open jornada, so the button locks without one. */}
                <Button className="w-full sm:w-auto shrink-0" disabled={!jornadaOpen}>
                    <Plus className="h-4 w-4 mr-1" /> Registrar movimiento
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Registrar movimiento</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                    <div>
                        <Label>Tipo</Label>
                        <Select value={type} onValueChange={v => setType(v as "DEPOSIT" | "WITHDRAW")}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="DEPOSIT">Depósito (entra a la alcancia, sale de caja)</SelectItem>
                                <SelectItem value="WITHDRAW">Retiro (solo de la alcancía)</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div>
                        <Label htmlFor="amt">Monto</Label>
                        <Input id="amt" type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
                    </div>
                    <div>
                        <Label htmlFor="desc">Descripción (opcional)</Label>
                        <Input id="desc" value={description} onChange={e => setDescription(e.target.value)} placeholder="Ej: ahorro del viernes" />
                    </div>
                    {error && <p className="text-sm text-red-600">{error}</p>}
                </div>
                <DialogFooter>
                    <DialogClose asChild><Button variant="outline" disabled={loading}>Cancelar</Button></DialogClose>
                    <Button onClick={handleSave} disabled={loading}>{loading ? "Guardando..." : "Guardar"}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function GoalsSection({ goals, onChange, showEmpty }: { goals: Goal[]; onChange: () => void; showEmpty: boolean }) {
    return <div className="space-y-4"><div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"><h2 className="text-lg font-semibold">Metas</h2><GoalDialog onChange={onChange} /></div>{goals.length ? goals.map(goal => <GoalCard key={goal.id} goal={goal} onChange={onChange} />) : showEmpty && <Card className="p-6 text-center text-sm text-gray-500">No hay metas para este filtro.</Card>}</div>;
}

function GoalCard({ goal, onChange }: { goal: Goal; onChange: () => void }) {
    const router = useRouter();
    const [cancelling, setCancelling] = useState(false);
    const isActive = goal.status === "ACTIVE";
    const isCompleted = goal.status === "COMPLETED";
    const isCancelled = goal.status === "CANCELLED";

    const handleCancel = async () => {
        if (cancelling) return;
        if (!confirm(`¿Cancelar la meta "${goal.name}"? Su historial se conservará.`)) return;
        setCancelling(true);
        try {
            const res = await cancelGoal(goal.id);
            if (res.success) {
                onChange();
                router.refresh();
            } else {
                alert(res.error || "No se pudo cancelar la meta.");
            }
        } catch {
            alert("Error de conexión al cancelar la meta.");
        } finally {
            setCancelling(false);
        }
    };

    return (
        <Card className={`p-4 ${isCancelled ? "opacity-60" : ""}`}>
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-3">
                <div>
                    <div className="flex items-center gap-2">
                        {isCompleted && <CheckCircle2 className="h-5 w-5 text-emerald-600" />}
                        {isCancelled && <XCircle className="h-5 w-5 text-gray-400" />}
                        {isActive && <Target className="h-5 w-5 text-blue-600" />}
                        <h3 className="font-semibold">{goal.name}</h3>
                    </div>
                    {goal.description && <p className="text-xs text-gray-600 mt-1">{goal.description}</p>}
                    {goal.deadline && (
                        <p className="text-xs text-gray-500 mt-1">
                            Vence: {new Date(goal.deadline).toLocaleDateString("es-MX", { timeZone: "UTC" })}
                        </p>
                    )}
                </div>
                {isActive && (
                    <div className="flex flex-wrap gap-2 shrink-0">
                        <ContributionDialog goalId={goal.id} goalName={goal.name} onChange={onChange} />
                        <Button variant="ghost" size="sm" onClick={handleCancel} disabled={cancelling}>
                            {cancelling ? "Cancelando..." : "Cancelar"}
                        </Button>
                    </div>
                )}
            </div>

            <div className="space-y-1.5">
                <div className="flex justify-between text-sm">
                    <span className="font-medium">${formatCents(goal.currentAmount)} de ${formatCents(goal.targetAmount)}</span>
                    <span className="text-gray-600">{goal.progressPercent.toFixed(0)}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                        className={`h-2 rounded-full transition-all ${isCompleted ? "bg-emerald-600" : isCancelled ? "bg-gray-400" : "bg-blue-600"}`}
                        style={{ width: `${goal.progressPercent}%` }}
                    />
                </div>
            </div>
        </Card>
    );
}

function GoalDialog({ onChange }: { onChange: () => void }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [target, setTarget] = useState("");
    const [deadline, setDeadline] = useState("");
    const [description, setDescription] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSave = async () => {
        if (loading) return;
        setError(null);
        const parsedTarget = parseCents(target);
        if (!name.trim()) { setError("Nombre requerido"); return; }
        if (parsedTarget === null || parsedTarget <= 0) { setError("Monto objetivo inválido"); return; }
        if (deadline) {
            const trimmedDeadline = deadline.trim();
            const parsedDate = new Date(`${trimmedDeadline}T00:00:00.000Z`);
            if (
                !/^\d{4}-\d{2}-\d{2}$/.test(trimmedDeadline) ||
                !Number.isFinite(parsedDate.getTime()) ||
                parsedDate.toISOString().slice(0, 10) !== trimmedDeadline
            ) {
                setError("Fecha límite inválida");
                return;
            }
        }

        setLoading(true);
        try {
            const res = await saveGoal({
                name: name.trim(),
                targetAmount: parsedTarget,
                deadline: deadline ? new Date(`${deadline.trim()}T00:00:00.000Z`) : null,
                description: description.trim() || undefined
            });
            if (res.success) {
                setOpen(false);
                setName(""); setTarget(""); setDeadline(""); setDescription("");
                onChange();
                router.refresh();
            } else {
                setError(res.error);
            }
        } catch {
            setError("Error de conexión al guardar la meta");
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen && loading) return;
                setOpen(nextOpen);
                if (!nextOpen) {
                    setError(null);
                    setName("");
                    setTarget("");
                    setDeadline("");
                    setDescription("");
                }
            }}
        >
            <DialogTrigger asChild>
                <Button variant="outline" className="w-full sm:w-auto"><Plus className="h-4 w-4 mr-1" /> Nueva meta</Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Nueva meta</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                    <div>
                        <Label>Nombre</Label>
                        <Input value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Horno industrial" />
                    </div>
                    <div>
                        <Label>Monto objetivo</Label>
                        <Input type="number" step="0.01" min="0" value={target} onChange={e => setTarget(e.target.value)} placeholder="50000" />
                    </div>
                    <div>
                        <Label>Fecha límite (opcional)</Label>
                        <Input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} />
                    </div>
                    <div>
                        <Label>Descripción (opcional)</Label>
                        <Input value={description} onChange={e => setDescription(e.target.value)} />
                    </div>
                    {error && <p className="text-sm text-red-600">{error}</p>}
                </div>
                <DialogFooter>
                    <DialogClose asChild><Button variant="outline" disabled={loading}>Cancelar</Button></DialogClose>
                    <Button onClick={handleSave} disabled={loading}>{loading ? "Guardando..." : "Crear meta"}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function ContributionDialog({ goalId, goalName, onChange }: { goalId: number; goalName: string; onChange: () => void }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [amount, setAmount] = useState("");
    const [note, setNote] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const handleSave = async () => {
        if (loading) return;
        setError(null);
        const parsed = parseCents(amount);
        if (parsed === null || parsed <= 0) { setError("Monto inválido"); return; }

        setLoading(true);
        try {
            const res = await addContribution(goalId, parsed, note.trim() || undefined);
            if (res.success) {
                setOpen(false);
                setAmount(""); setNote("");
                onChange();
                router.refresh();
            } else {
                setError(res.error);
            }
        } catch {
            setError("Error de conexión al registrar la contribución");
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen && loading) return;
                setOpen(nextOpen);
                if (!nextOpen) {
                    setError(null);
                    setAmount("");
                    setNote("");
                }
            }}
        >
            <DialogTrigger asChild>
                <Button size="sm">Sumar contribución</Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Sumar a &quot;{goalName}&quot;</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                    <div>
                        <Label>Monto</Label>
                        <Input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
                    </div>
                    <div>
                        <Label>Nota (opcional)</Label>
                        <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Ej: bono del mes" />
                    </div>
                    {error && <p className="text-sm text-red-600">{error}</p>}
                </div>
                <DialogFooter>
                    <DialogClose asChild><Button variant="outline" disabled={loading}>Cancelar</Button></DialogClose>
                    <Button onClick={handleSave} disabled={loading}>{loading ? "Guardando..." : "Confirmar"}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}