"use client";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { InfiniteScroll } from "@/components/ui/infinite-scroll";
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose
} from "@/components/ui/dialog";
import { format } from "date-fns";
import { Calendar as CalendarIcon, Loader2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

import { saveExpense, getExpenses } from "@/lib/actions/expenses";
import { hasOpenJornada } from "@/lib/actions/jornada";
import { usePolling } from "@/lib/use-polling";
import { businessDate } from "@/lib/analytics";

const PAGE_SIZE = 30;

function defaultExpenseDate() {
    return new Date(`${businessDate()}T00:00:00`);
}

const PAYMENT_METHOD_LABEL = { CASH: "Efectivo", TRANSFER: "Transferencia" } as const;

function formatExpenseDate(value: Date | string | null | undefined): string {
    if (!value) return "---";
    const iso = typeof value === "string" ? value : value.toISOString();
    const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return "---";
    const [, y, m, d] = match;
    return `${d}/${m}/${y.slice(2)}`;
}

type ExpenseRow = Awaited<ReturnType<typeof getExpenses>>["items"][number];

export default function ExpensesPage() {
    const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
    const [total, setTotal] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [jornadaOpen, setJornadaOpen] = useState(true);

    // Form States
    const [amount, setAmount] = useState("");
    const [category, setCategory] = useState("");
    // Empty on purpose: the user must choose how the expense was paid.
    const [paymentMethod, setPaymentMethod] = useState<"" | "CASH" | "TRANSFER">("");
    const [description, setDescription] = useState("");
    const [date, setDate] = useState<Date>(defaultExpenseDate);

    const [errors, setErrors] = useState<Record<string, string[]>>({});
    const [alert, setAlert] = useState<{ message: string; type: "success" | "error" } | null>(null);

    const listEpochRef = useRef(0);
    const pollSequence = useRef(0);
    const jornadaRequest = useRef(0);

    const refreshJornada = async () => {
        const sequence = ++jornadaRequest.current;
        const open = await hasOpenJornada();
        if (jornadaRequest.current === sequence) setJornadaOpen(open);
    };

    // Reloads the first page (used on mount and after saving an expense).
    const fetchData = async () => {
        const epoch = ++listEpochRef.current;
        const res = await getExpenses(0, PAGE_SIZE);
        if (listEpochRef.current !== epoch) return;
        listEpochRef.current++;
        setExpenses(res.items);
        setTotal(res.total);
        setHasMore(res.hasMore);
    };

    const loadMore = async () => {
        if (loadingMore) return;
        const epoch = ++listEpochRef.current;
        setLoadingMore(true);
        try {
            const res = await getExpenses(expenses.length, PAGE_SIZE);
            if (listEpochRef.current !== epoch) return;
            // Advance epoch on commit so any usePolling tick started while loadMore was in flight is discarded.
            listEpochRef.current++;
            setExpenses((prev) => {
                const seen = new Set(prev.map((item) => item.id));
                const next = res.items.filter((item) => !seen.has(item.id));
                return [...prev, ...next];
            });
            setTotal(res.total);
            setHasMore(res.hasMore);
        } finally {
            setLoadingMore(false);
        }
    };

    useEffect(() => {
        fetchData();
        // New expenses need an open jornada; the history stays available regardless.
        void refreshJornada();
    }, []);

    // Keep the list and the jornada gate in sync with the other open sessions.
    // Refetches the window already on screen in chunks of up to 100 so infinite scroll is never truncated.
    usePolling(() => {
        const startEpoch = listEpochRef.current;
        const sequence = ++pollSequence.current;
        const targetCount = Math.max(PAGE_SIZE, expenses.length);
        void (async () => {
            const collected: ExpenseRow[] = [];
            const seen = new Set<number>();
            let latestTotal = 0;
            let latestHasMore = false;
            let offset = 0;
            while (offset < targetCount) {
                const chunkLimit = Math.min(100, targetCount - offset);
                const res = await getExpenses(offset, chunkLimit);
                if (listEpochRef.current !== startEpoch || pollSequence.current !== sequence) return;
                latestTotal = res.total;
                latestHasMore = res.hasMore;
                for (const item of res.items) {
                    if (!seen.has(item.id)) {
                        seen.add(item.id);
                        collected.push(item);
                    }
                }
                if (!res.hasMore || res.items.length === 0) break;
                offset += res.items.length;
            }
            if (listEpochRef.current !== startEpoch || pollSequence.current !== sequence) return;
            setExpenses(collected);
            setTotal(latestTotal);
            setHasMore(latestHasMore);
        })();
        void refreshJornada();
    });

    const resetForm = () => {
        setAmount("");
        setDescription("");
        setCategory("");
        setPaymentMethod("");
        setDate(defaultExpenseDate());
        setErrors({});
    };

    const handleSave = async () => {
        setErrors({});
        setAlert(null);

        const localErrors: Record<string, string[]> = {};
        const parsedAmount = parseFloat(amount);
        if (!amount || !Number.isFinite(parsedAmount) || parsedAmount <= 0)
            localErrors.amount = ["Ingrese un monto válido mayor a 0."];
        if (!category)
            localErrors.category = ["Seleccione una categoría."];
        if (!description.trim())
            localErrors.description = ["Ingresa una descripción del gasto."];
        if (!paymentMethod)
            localErrors.payment_method = ["Selecciona el método de pago."];

        if (Object.keys(localErrors).length > 0) {
            setErrors(localErrors);
            setAlert({ message: "Corrija los campos marcados.", type: "error" });
            return;
        }

        setLoading(true);
        try {
            // Convert the user's selected calendar date to UTC midnight so toBusinessCalendarDate
            // preserves the exact displayed day regardless of browser timezone.
            const selectedDate = date || new Date();
            const calendarDate = new Date(
                Date.UTC(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate())
            );
            // registered_by is no longer sent from the client: the server derives it from the session.
            const res = await saveExpense({
                amount: parseFloat(amount),
                category,
                description,
                date: calendarDate,
                payment_method: paymentMethod as "CASH" | "TRANSFER",
            });

            if (res.success) {
                resetForm();
                setDialogOpen(false);
                setAlert({ message: "Gasto guardado exitosamente.", type: "success" });
                setTimeout(() => setAlert(null), 4000);
                fetchData();
            } else {
                if (res.error === "NO_OPEN_JORNADA") {
                    setJornadaOpen(false);
                }
                setAlert({
                    message:
                        res.error === "NO_OPEN_JORNADA"
                            ? "No hay jornada abierta. Abre una jornada para registrar gastos."
                            : res.error || "Error al guardar el gasto.",
                    type: "error",
                });
                if (res.fieldErrors) {
                    setErrors(res.fieldErrors);
                }
            }
        } catch {
            setAlert({ message: "Error al guardar el gasto. Inténtalo de nuevo.", type: "error" });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex h-full w-full flex-col items-center justify-start gap-3 p-3 lg:gap-6 lg:p-6">

            {/* Compact summary cards: min-w-0 + truncate keep long amounts
                inside their container on narrow screens. */}
            <div className="grid w-full max-w-6xl shrink-0 grid-cols-2 gap-2 lg:gap-4">
                <div className="flex min-w-0 flex-col items-center justify-center rounded-md border bg-white p-3 lg:p-5">
                    <p className="w-full truncate text-center text-xs text-muted-foreground lg:text-sm">Gastos Totales Registrados</p>
                    <p className="w-full truncate text-center text-lg font-bold text-red-600 lg:text-2xl">${total.toFixed(2)}</p>
                </div>
                <div className="flex min-w-0 flex-col items-center justify-center rounded-md border bg-white p-3 lg:p-5">
                    <p className="w-full truncate text-center text-xs text-muted-foreground lg:text-sm">Último Gasto</p>
                    <p className="w-full truncate text-center text-lg font-bold lg:text-2xl">{expenses[0]?.category ?? "---"}</p>
                </div>
            </div>

            {/* Full-width history with the add dialog opened from the top button */}
            <div className="flex min-h-0 w-full max-w-6xl flex-1 flex-col rounded-md border bg-white p-3 lg:p-6">

                {alert && (
                    <div className={`mb-3 w-full shrink-0 rounded p-3 text-sm font-semibold ${alert.type === "success" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                        {alert.message}
                    </div>
                )}

                <div className="mb-3 flex shrink-0 items-center justify-between gap-2">
                    <h2 className="truncate text-base font-bold lg:text-lg">Historial de Gastos</h2>

                    <Dialog
                        open={dialogOpen}
                        onOpenChange={(nextOpen) => {
                            if (!nextOpen && loading) return;
                            setDialogOpen(nextOpen);
                            if (nextOpen) setDate(defaultExpenseDate());
                            if (!nextOpen) {
                                resetForm();
                                setAlert((prev) => (prev?.type === "error" ? null : prev));
                            }
                        }}
                    >
                        <DialogTrigger asChild>
                            <Button className="cursor-pointer shrink-0" size="sm" disabled={!jornadaOpen}>
                                <Plus className="h-4 w-4" />
                                Nuevo gasto
                            </Button>
                        </DialogTrigger>
                        <DialogContent className="max-h-[85vh] overflow-y-auto">
                            <DialogHeader>
                                <DialogTitle>Registrar Nuevo Gasto</DialogTitle>
                            </DialogHeader>

                            {alert?.type === "error" && (
                                <div className="w-full rounded bg-red-100 p-3 text-sm font-semibold text-red-700">
                                    {alert.message}
                                </div>
                            )}

                            <div className="space-y-3">
                                <div className="flex flex-col gap-2">
                                    <Label>Monto</Label>
                                    <Input
                                        type="number"
                                        value={amount}
                                        onChange={(e) => setAmount(e.target.value)}
                                        placeholder="0.00"
                                        className={errors.amount ? "border-red-500 focus-visible:ring-red-500" : ""}
                                    />
                                    <p className="h-4 text-xs text-red-500">{errors.amount ? errors.amount[0] : ""}</p>
                                </div>

                                <div className="flex flex-col gap-2">
                                    <Label>Categoría</Label>
                                    <Select onValueChange={setCategory} value={category}>
                                        <SelectTrigger
                                            className={errors.category ? "border-red-500 focus-visible:ring-red-500" : ""}
                                        >
                                            <SelectValue placeholder="Seleccionar categoría" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="Insumos">Insumos</SelectItem>
                                            <SelectItem value="Servicios">Servicios (Luz/Agua)</SelectItem>
                                            <SelectItem value="Mantenimiento">Mantenimiento</SelectItem>
                                            <SelectItem value="Otros">Otros</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <p className="h-4 text-xs text-red-500">{errors.category ? errors.category[0] : ""}</p>
                                </div>

                                <div className="flex flex-col gap-2">
                                    <Label>Método de pago</Label>
                                    <Select onValueChange={(v) => setPaymentMethod(v as "CASH" | "TRANSFER")} value={paymentMethod}>
                                        <SelectTrigger
                                            aria-label="Método de pago"
                                            className={errors.payment_method ? "border-red-500 focus-visible:ring-red-500" : ""}
                                        >
                                            <SelectValue placeholder="Seleccionar método" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="CASH">Efectivo</SelectItem>
                                            <SelectItem value="TRANSFER">Transferencia</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <p className="h-4 text-xs text-red-500">{errors.payment_method ? errors.payment_method[0] : ""}</p>
                                </div>

                                <div className="flex flex-col gap-2">
                                    <Label htmlFor="expense-description">Descripción</Label>
                                    <Input
                                        id="expense-description"
                                        value={description}
                                        onChange={(e) => {
                                            setDescription(e.target.value);
                                            if (errors.description) {
                                                setErrors((prev) => ({ ...prev, description: [] }));
                                            }
                                        }}
                                        placeholder="Detalle del gasto..."
                                        aria-invalid={!!errors.description?.length}
                                        aria-describedby={errors.description?.length ? "expense-description-error" : undefined}
                                        className={errors.description?.length ? "border-red-500 focus-visible:ring-red-500" : ""}
                                    />
                                    {errors.description?.length ? (
                                        <p id="expense-description-error" role="alert" className="text-xs text-red-600">
                                            {errors.description[0]}
                                        </p>
                                    ) : null}
                                </div>

                                <div className="flex flex-col gap-2">
                                    <Label>Fecha</Label>
                                    <Popover>
                                        <PopoverTrigger asChild>
                                            <Button
                                                variant="outline"
                                                className={cn(
                                                    "justify-start text-left font-normal",
                                                    !date && "text-muted-foreground",
                                                    errors.date && "border-red-500"
                                                )}
                                            >
                                                <CalendarIcon className="mr-2 h-4 w-4" />
                                                {date ? format(date, "PPP") : <span>Seleccionar fecha</span>}
                                            </Button>
                                        </PopoverTrigger>
                                        <PopoverContent className="w-auto p-0">
                                            <Calendar
                                                mode="single"
                                                selected={date}
                                                onSelect={(d) => d && setDate(d)}
                                                autoFocus
                                            />
                                        </PopoverContent>
                                    </Popover>
                                    <p className="h-4 text-xs text-red-500">{errors.date ? errors.date[0] : ""}</p>
                                </div>
                            </div>

                            <DialogFooter>
                                <DialogClose asChild>
                                    <Button className="cursor-pointer" variant="outline" disabled={loading}>Cancelar</Button>
                                </DialogClose>
                                <Button className="cursor-pointer" onClick={handleSave} disabled={loading}>
                                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    Guardar Gasto
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>
                </div>

                <ScrollArea className="min-h-0 flex-1 pr-2 lg:pr-4">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Fecha</TableHead>
                                <TableHead>Categoría</TableHead>
                                <TableHead className="text-right">Monto</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {expenses.map((expense) => (
                                <TableRow key={expense.id}>
                                    <TableCell className="text-xs">
                                        {formatExpenseDate(expense.date)}
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex min-w-0 flex-col">
                                            <span className="font-medium break-words">{expense.description?.trim() ? expense.description : "*NO DESC"}</span>
                                            <span className="text-[10px] text-muted-foreground">
                                                {expense.category}
                                                {expense.payment_method ? ` · ${PAYMENT_METHOD_LABEL[expense.payment_method]}` : ""}
                                            </span>
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-right font-bold text-red-600">
                                        ${Number(expense.amount).toFixed(2)}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                    <InfiniteScroll onLoadMore={loadMore} hasMore={hasMore} loading={loadingMore} />
                </ScrollArea>
            </div>
        </div>
    );
}
