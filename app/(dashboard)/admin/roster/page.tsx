"use client";
import { parseCents, formatCents } from "@/lib/scaled-values";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DataPagination, PaginationErrorState, usePaginationState, usePaginatedResource } from "@/components/pagination";
import { useEffect, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronsUpDown } from "lucide-react";

import { getSalaryHistory, getUserPayrollInfo, getPayrollUsersPage, saveSalaryPayment } from "@/lib/actions/payrolls";
import { hasOpenJornada } from "@/lib/actions/jornada";
import { usePolling } from "@/lib/use-polling";



type PaymentMethod = "CASH" | "TRANSFER";
const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = { CASH: "Efectivo", TRANSFER: "Transferencia" };

type RosterUser = Extract<Awaited<ReturnType<typeof getPayrollUsersPage>>, { success: true }>["data"]["items"][number];

export default function RosterPage() {
  const [pickerPage, setPickerPage] = useState(1);
  const [userQuery, setUserQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const picker = usePaginatedResource(getPayrollUsersPage, { page: pickerPage, pageSize: 10, search: userQuery }, { enabled: pickerOpen, onPageClamp: setPickerPage });
  const users = picker.data?.items ?? [];
  const [loadedUser, setLoadedUser] = useState<RosterUser | null>(null);
  const pagination = usePaginationState({ filterKeys: ["userId"] });
  const userId = Number(pagination.query.filters?.userId) || 0;
  const selectedUser = loadedUser?.id === userId ? loadedUser : null;
  const { data, error, isPending, refresh } = usePaginatedResource(getSalaryHistory, pagination.query, { enabled: !!userId, onPageClamp: pagination.replacePage });
  const history = data?.items ?? [];

  // Form states
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  // Empty on purpose: the user must choose how the payment is made.
  const [paymentMethod, setPaymentMethod] = useState<"" | PaymentMethod>("");
  // Payments need an open jornada so the cash cut can deduct them.
  const [jornadaOpen, setJornadaOpen] = useState(true);
  const [pendingPayment, setPendingPayment] = useState<{
    type: "ADELANTO" | "BONO" | "SUELDO";
    userID: number;
    employeeName: string;
    amount: number;
    reason: string;
    paymentMethod: PaymentMethod;
  } | null>(null);
  const [confirmationStep, setConfirmationStep] = useState<"summary" | "confirm">("summary");
  const [savingPayment, setSavingPayment] = useState(false);

  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [alert, setAlert] = useState<{ message: string, type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    hasOpenJornada().then(setJornadaOpen);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!userId) return;
    getUserPayrollInfo(userId).then(user => { if (!cancelled && user) setLoadedUser(user); });
    return () => { cancelled = true; };
  }, [userId]);

  usePolling(() => { hasOpenJornada().then(setJornadaOpen); });

  const handlePayment = (type: "ADELANTO" | "BONO" | "SUELDO") => {
    setErrors({});
    setAlert(null);

    if (!selectedUser?.id) {
      setErrors({ userID: ["Seleccione un empleado"] });
      return;
    }
    const parsedAmount = parseCents(amount);
    if (parsedAmount === null || parsedAmount <= 0) {
      setErrors({ amount: ["Ingrese un monto válido mayor a cero"] });
      return;
    }
    if (parsedAmount > 100_000_000_000_000) {
      setErrors({ amount: ["El monto es inválido"] });
      return;
    }
    if (!paymentMethod) {
      setErrors({ payment_method: ["Selecciona el método de pago"] });
      return;
    }
    if (Array.from(reason.trim()).length > 50) {
      setErrors({ period: ["El motivo no puede superar los 50 caracteres"] });
      return;
    }

    setPendingPayment({
      type,
      userID: selectedUser.id,
      employeeName: selectedUser.name || "---",
      amount: parsedAmount!,
      reason,
      paymentMethod,
    });
    setConfirmationStep("summary");
  };

  const confirmPayment = async () => {
    if (!pendingPayment || savingPayment) return;

    setSavingPayment(true);
    try {
      const res = await saveSalaryPayment({
        userID: pendingPayment.userID,
        amount: pendingPayment.amount,
        period: pendingPayment.reason?.trim()
          ? `${pendingPayment.type}: ${pendingPayment.reason.trim()}`
          : pendingPayment.type,
        payment_method: pendingPayment.paymentMethod,
      });

      setPendingPayment(null);
      if (res.success) {
        setAmount("");
        setReason("");
        setPaymentMethod("");
        setAlert({ message: "Pago registrado exitosamente.", type: 'success' });
        setTimeout(() => setAlert(null), 4000);
        refresh();
      } else {
        if (res.error === "NO_OPEN_JORNADA") setJornadaOpen(false);
        setAlert({
          message: res.error === "NO_OPEN_JORNADA"
            ? "No hay jornada abierta. Abre una jornada para registrar pagos."
            : res.error || "Error al registrar pago.",
          type: 'error',
        });
        if (res.fieldErrors) setErrors(res.fieldErrors);
      }
    } catch {
      setPendingPayment(null);
      setAlert({ message: "Error al registrar pago.", type: 'error' });
    } finally {
      setSavingPayment(false);
    }
  };

  return (
    <div className="flex items-start md:items-center justify-center w-full min-h-full md:h-full p-2 md:p-4">
      <div className="flex flex-col items-center md:h-full outline rounded-md bg-white w-full max-w-6xl p-4 md:p-6 md:overflow-hidden">

        {/* User Selection */}
        <div className="w-full mb-6 shrink-0">
          {alert && (
            <div className={`w-full p-3 rounded mb-2 text-sm font-semibold ${alert.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
              {alert.message}
            </div>
          )}
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={pickerOpen}
                className="w-full md:w-75 justify-between font-normal"
              >
                <span className="truncate">
                  {selectedUser ? `${selectedUser.name} (@${selectedUser.username})` : "Seleccionar Empleado"}
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
              {/* shouldFilter off: results already come filtered from the server */}
              <Command shouldFilter={false}>
                <CommandInput
                  placeholder="Buscar por nombre o usuario..."
                  value={userQuery}
                  onValueChange={value => { setUserQuery(value); setPickerPage(1); }}
                />
                <CommandList>
                  {!picker.isPending && !picker.error && <CommandEmpty>No se encontraron empleados.</CommandEmpty>}
                  <CommandGroup>
                    {users.map((user) => (
                      <CommandItem
                        key={user.id}
                        value={user.id.toString()}
                        onSelect={() => {
                          setLoadedUser(user);
                          pagination.setFilters({ userId: String(user.id) });
                          setPickerOpen(false);
                        }}
                      >
                        {user.name} (@{user.username})
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
              {picker.error && <PaginationErrorState error={picker.error} onRetry={picker.refresh} />}
              {picker.data && <DataPagination {...picker.data} onPageChange={setPickerPage} isPending={picker.isPending} totalLabel="empleados" />}
            </PopoverContent>
          </Popover>
          {errors.userID && <p className="text-red-500 text-xs mt-1">{errors.userID[0]}</p>}

        </div>

        <div className="w-full flex-1 min-h-0 flex flex-col md:flex-row gap-6">
          {/* Controls */}
          <div className="md:h-full min-h-0 w-full md:w-1/2 flex flex-col gap-6">
            <div className="space-y-4 shrink-0">
              <div className="flex flex-col gap-2">
                <Label>Monto</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="$0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                {errors.amount && <p className="text-red-500 text-xs mt-1">{errors.amount[0]}</p>}

              </div>

              <div className="flex flex-col gap-2">
                <Label>Método de pago</Label>
                <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as PaymentMethod)}>
                  <SelectTrigger aria-label="Método de pago" className="w-full">
                    <SelectValue placeholder="Seleccionar método" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CASH">Efectivo</SelectItem>
                    <SelectItem value="TRANSFER">Transferencia</SelectItem>
                  </SelectContent>
                </Select>
                {errors.payment_method && <p className="text-red-500 text-xs mt-1">{errors.payment_method[0]}</p>}
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex justify-between items-center">
                  <Label>Motivo / Descripción</Label>
                  <span
                    className={`text-xs ${
                      Array.from(reason.trim()).length > 50
                        ? "text-red-500 font-semibold"
                        : "text-muted-foreground"
                    }`}
                  >
                    {Array.from(reason.trim()).length}/50
                  </span>
                </div>
                <Input
                  placeholder="Ej: Bono por puntualidad"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className={
                    Array.from(reason.trim()).length > 50
                      ? "border-red-500 focus-visible:ring-red-500 text-red-600"
                      : ""
                  }
                />
                {Array.from(reason.trim()).length > 50 && (
                  <p className="text-red-500 text-xs mt-1">
                    El motivo no puede superar los 50 caracteres
                  </p>
                )}
                {errors.period && <p className="text-red-500 text-xs mt-1">{errors.period[0]}</p>}
              </div>
            </div>

            <div className="flex flex-col gap-3 shrink-0">
              {!jornadaOpen && (
                <p role="status" className="text-sm text-amber-700">
                  No hay jornada abierta. Abre una jornada para registrar pagos.
                </p>
              )}
              <Button type="button" disabled={savingPayment || !jornadaOpen || Array.from(reason.trim()).length > 50} onClick={() => handlePayment("ADELANTO")} className="cursor-pointer" variant="outline">Adelantar Sueldo</Button>
              <Button type="button" disabled={savingPayment || !jornadaOpen || Array.from(reason.trim()).length > 50} onClick={() => handlePayment("BONO")} className="cursor-pointer bg-amber-500 hover:bg-amber-400">Otorgar Bono</Button>
              <Button type="button" disabled={savingPayment || !jornadaOpen || Array.from(reason.trim()).length > 50} onClick={() => handlePayment("SUELDO")} className="cursor-pointer" >Registrar Pago de Sueldo</Button>
            </div>
          </div>

          <Separator orientation="vertical" className="hidden md:block" />
          <Separator className="md:hidden" />

          {/* Info & History */}
          <div className="md:h-full min-h-0 w-full md:w-1/2 flex flex-col gap-5">
            <div className="bg-slate-50 p-4 rounded-lg">
              <p className="font-bold">Nombre: <span className="font-normal">{selectedUser?.name || "---"}</span></p>
              <p className="font-bold">Fecha de ingreso: <span className="font-normal">
                {selectedUser?.registeredAt
                  ? new Date(selectedUser.registeredAt).toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium" })
                  : "---"}
              </span></p>
            </div>

            <ScrollArea className="flex-1 min-h-0 h-72 md:h-auto w-full rounded-md border p-2 md:p-4 bg-white">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Concepto</TableHead>
                    <TableHead>Método</TableHead>
                    <TableHead className="text-right">Monto</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        {item.payDate
                          ? new Date(item.payDate).toLocaleDateString("es-MX", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" })
                          : "---"}
                      </TableCell>
                      <TableCell className="text-xs">{item.period}</TableCell>
                      <TableCell className="text-xs">{item.payment_method ? PAYMENT_METHOD_LABEL[item.payment_method] : "---"}</TableCell>
                      <TableCell className="text-right">${formatCents(item.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {error && <PaginationErrorState error={error} onRetry={refresh} />}
              {data && <DataPagination {...data} onPageChange={pagination.setPage} onPageSizeChange={pagination.setPageSize} isPending={isPending} totalLabel="pagos" />}
            </ScrollArea>
          </div>
        </div>
      </div>

      {pendingPayment && confirmationStep === "summary" && (
        <Dialog open onOpenChange={(open) => { if (!open) setPendingPayment(null); }}>
          <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden">
            <div role="region" aria-label="Resumen del movimiento" className="min-h-0 flex-1 space-y-4 overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Resumen del movimiento</DialogTitle>
                <DialogDescription>Revisa los datos antes de continuar.</DialogDescription>
              </DialogHeader>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Empleado</dt>
                  <dd className="break-words font-medium">{pendingPayment.employeeName}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Movimiento</dt>
                  <dd className="font-medium">
                    {pendingPayment.type === "SUELDO" ? "Pago de sueldo" : pendingPayment.type === "BONO" ? "Bono" : "Adelanto de sueldo"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Monto</dt>
                  <dd className="font-medium tabular-nums">
                    ${formatCents(pendingPayment.amount)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Método de pago</dt>
                  <dd className="font-medium">{PAYMENT_METHOD_LABEL[pendingPayment.paymentMethod]}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Motivo / Descripción</dt>
                  <dd className="break-words">{pendingPayment.reason || "Sin descripción"}</dd>
                </div>
              </dl>
            </div>
            <DialogFooter className="shrink-0">
              <Button type="button" variant="outline" onClick={() => setPendingPayment(null)}>Cancelar</Button>
              <Button type="button" onClick={() => setConfirmationStep("confirm")}>Continuar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {pendingPayment && confirmationStep === "confirm" && (
        <AlertDialog open onOpenChange={(open) => { if (!open && !savingPayment) setPendingPayment(null); }}>
          <AlertDialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden">
            <AlertDialogHeader className="min-h-0 flex-1 overflow-y-auto">
              <AlertDialogTitle>Confirmar operación no reversible</AlertDialogTitle>
              <AlertDialogDescription className="break-words">
                Se registrará {pendingPayment.type === "SUELDO" ? "el pago de sueldo" : pendingPayment.type === "BONO" ? "el bono" : "el adelanto de sueldo"} de{" "}
                ${formatCents(pendingPayment.amount)} para {pendingPayment.employeeName}, pagado en {PAYMENT_METHOD_LABEL[pendingPayment.paymentMethod].toLowerCase()}.
                {" "}Esta operación no se puede revertir.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="shrink-0">
              <AlertDialogCancel disabled={savingPayment}>Cancelar</AlertDialogCancel>
              <Button type="button" disabled={savingPayment} onClick={confirmPayment}>
                {savingPayment ? "Registrando..." : "Confirmar registro"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="text-sm font-medium leading-none">{children}</label>;
}
