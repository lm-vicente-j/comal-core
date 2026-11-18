"use client";

import { useId, useState, useEffect } from "react";
import { PaymentMethod } from "@/app/generated/prisma/enums";
import { payAccount, getCustomerDebtAccounts, type DebtorListItem } from "@/lib/actions/debts";
import type { Sale } from "@/lib/actions/sales";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import TransferConfirmationDialog from "@/components/Transfer-confirmation-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";

export default function DebtPaymentDialog({
  debtor,
  jornadaOpen,
  onAccountClose,
  onPaymentSuccess,
  open: controlledOpen,
  onOpenChange: setControlledOpen,
}: {
  debtor: DebtorListItem;
  jornadaOpen: boolean;
  onAccountClose?: () => void;
  onPaymentSuccess?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (isControlled) {
      setControlledOpen?.(next);
    } else {
      setInternalOpen(next);
    }
  };
  const [cashDialogOpen, setCashDialogOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(PaymentMethod.CASH);
  const [cashReceived, setCashReceived] = useState("");
  const [settling, setSettling] = useState(false);
  const [error, setError] = useState("");
  const [jornadaRejected, setJornadaRejected] = useState(false);
  const [accounts, setAccounts] = useState<{ id: number; saleId: number; amount: number }[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  const canCollect = jornadaOpen && !jornadaRejected;
  const inputId = useId();
  const changeId = useId();
  const errorId = useId();

  const customerName = debtor.customerName || debtor.alias || "Cliente";
  const activeAmount = accounts.length > 0
    ? accounts.reduce((sum, a) => sum + a.amount, 0)
    : loadingAccounts
    ? debtor.amount
    : 0;
  const totalCents = Math.round(activeAmount * 100);
  const total = activeAmount.toFixed(2);

  // Lazy load the customer's open debt accounts when opening the dialog
  useEffect(() => {
    if (open) {
      setLoadingAccounts(true);
      getCustomerDebtAccounts(debtor.customerID)
        .then((res) => {
          if (res.success && res.data) {
            setAccounts(res.data);
          } else {
            setError("No se pudieron cargar las cuentas activas.");
          }
        })
        .catch(() => setError("Error al consultar las cuentas del cliente."))
        .finally(() => setLoadingAccounts(false));
    }
  }, [open, debtor.customerID]);

  const value = cashReceived.trim().replace(",", ".");
  let cashReceivedCents: number | null = null;
  if (value !== "") {
    if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value)) {
      cashReceivedCents = NaN;
    } else {
      const [whole, decimals = ""] = value.split(".");
      const cents = Number(whole || "0") * 100 + Number(decimals.padEnd(2, "0"));
      cashReceivedCents = Number.isSafeInteger(cents) ? cents : NaN;
    }
  }
  const cashReceivedInvalid = cashReceivedCents !== null && Number.isNaN(cashReceivedCents);
  const changeCents = cashReceivedCents === null || cashReceivedInvalid ? null : cashReceivedCents - totalCents;
  const cashReceivedInsufficient = changeCents !== null && changeCents < 0;

  const handleOpenChange = (nextOpen: boolean) => {
    if (settling) return;
    if (!nextOpen && cashDialogOpen) {
      setCashDialogOpen(false);
      setError("");
      return;
    }
    setOpen(nextOpen);
    if (!nextOpen) {
      setCashDialogOpen(false);
      setCashReceived("");
      setTransferDialogOpen(false);
      setJornadaRejected(false);
      setAccounts([]);
      setError("");
      onAccountClose?.();
    }
  };

  const handlePayAccount = async () => {
    if (settling || !canCollect || (paymentMethod === PaymentMethod.CASH && (changeCents === null || changeCents < 0))) return false;
    if (paymentMethod === PaymentMethod.TRANSFER && !transferDialogOpen) return false;
    if (accounts.length === 0) {
      setError("No hay cuentas activas disponibles para cobrar.");
      return false;
    }

    setSettling(true);
    setError("");
    try {
      const salesToPay = accounts.map((a) => ({ id: a.saleId })) as unknown as Sale[];
      const result = await payAccount(debtor.customerID, salesToPay, paymentMethod);
      if (result.msg === "SUCCESS") {
        setOpen(false);
        setCashDialogOpen(false);
        setCashReceived("");
        setTransferDialogOpen(false);
        setAccounts([]);
        onAccountClose?.();
        onPaymentSuccess?.();
        return true;
      } else if (result.msg === "NO_OPEN_JORNADA") {
        setJornadaRejected(true);
        setError("No hay jornada abierta. Abre una jornada para registrar cobros.");
      } else {
        setError("No se pudo registrar el cobro. Revisa la cuenta e inténtalo de nuevo.");
      }
    } catch {
      setError("No se pudo registrar el cobro. Revisa la cuenta e inténtalo de nuevo.");
    } finally {
      setSettling(false);
    }
    return false;
  };

  return (
    <>
      <Dialog open={open && !transferDialogOpen} onOpenChange={handleOpenChange}>
        {!isControlled && (
          <DialogTrigger className="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground w-full">
            Cobrar
          </DialogTrigger>
        )}
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle className="break-words">
              {cashDialogOpen ? "Cobrar en efectivo" : "Cobrar cuenta de " + customerName}
            </DialogTitle>
            <DialogDescription>
              {cashDialogOpen ? customerName : "Confirma el total y el método de pago para registrar el cobro."}
            </DialogDescription>
          </DialogHeader>

          {loadingAccounts ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span>Cargando cuentas pendientes...</span>
            </div>
          ) : cashDialogOpen ? (
            <form onSubmit={(event) => event.preventDefault()} className="flex min-h-0 flex-1 flex-col gap-4">
              <div role="region" aria-label="Datos del pago en efectivo" className="min-h-0 flex-1 overflow-y-auto">
                <label htmlFor={inputId} className="mb-2 block text-sm font-medium">
                  Efectivo recibido
                </label>
                <Input
                  id={inputId}
                  type="text"
                  inputMode="decimal"
                  enterKeyHint="done"
                  autoComplete="off"
                  autoFocus
                  required
                  disabled={settling}
                  value={cashReceived}
                  onChange={(event) => setCashReceived(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                  aria-invalid={cashReceivedInvalid || cashReceivedInsufficient}
                  aria-describedby={cashReceivedInvalid || cashReceivedInsufficient ? changeId + " " + errorId : changeId}
                  className="h-11 text-base md:text-base"
                />
                <p id={changeId} role="status" className="mt-2 text-sm font-semibold tabular-nums">
                  {cashReceivedInsufficient
                    ? "Faltan $" + (-changeCents! / 100).toFixed(2)
                    : "Cambio a entregar: " + (changeCents === null ? "—" : "$" + (changeCents / 100).toFixed(2))}
                </p>
                {cashReceivedInvalid ? (
                  <p id={errorId} role="alert" className="mt-1 text-sm text-destructive">
                    Ingresa un monto válido (ejemplo: 50 o 50.00).
                  </p>
                ) : null}
                {error ? (
                  <p role="alert" className="mt-2 text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>

              <DialogFooter className="mt-auto shrink-0 flex-col gap-2 pt-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={settling}
                  onClick={() => {
                    setCashDialogOpen(false);
                    setError("");
                  }}
                  className="w-full sm:w-auto"
                >
                  Regresar
                </Button>
                <Button
                  type="button"
                  disabled={settling || cashReceivedCents === null || cashReceivedInvalid || cashReceivedInsufficient}
                  onClick={handlePayAccount}
                  className="w-full sm:w-auto"
                >
                  {settling ? "Registrando cobro..." : "Confirmar y cerrar"}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-4">
              <div role="region" aria-label="Resumen de la deuda" className="min-h-0 flex-1 overflow-y-auto space-y-4">
                <div className="flex items-center justify-between border-b pb-2">
                  <span className="text-sm text-muted-foreground">Notas a saldar:</span>
                  <span className="font-semibold">{accounts.length}</span>
                </div>
                <div className="flex items-center justify-between border-b pb-2">
                  <span className="text-sm text-muted-foreground">Total a cobrar:</span>
                  <span className="text-lg font-bold text-red-600">${total}</span>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Método de pago</label>
                  <Select
                    value={paymentMethod}
                    onValueChange={(val) => setPaymentMethod(val as PaymentMethod)}
                    disabled={settling}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={PaymentMethod.CASH}>Efectivo</SelectItem>
                      <SelectItem value={PaymentMethod.TRANSFER}>Transferencia</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {!canCollect && (
                  <p role="alert" className="text-sm text-destructive">
                    No hay jornada abierta. Abre una jornada para registrar cobros.
                  </p>
                )}
                {!loadingAccounts && accounts.length === 0 && (
                  <p role="status" className="text-sm text-muted-foreground">
                    No hay cuentas activas pendientes para este cliente.
                  </p>
                )}
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </div>

              <DialogFooter className="mt-auto shrink-0 flex-col gap-2 pt-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={settling}
                  onClick={() => handleOpenChange(false)}
                  className="w-full sm:w-auto"
                >
                  Cancelar
                </Button>
                <Button
                  type="button"
                  disabled={settling || !canCollect || accounts.length === 0}
                  onClick={() => {
                    if (paymentMethod === PaymentMethod.CASH) {
                      setCashDialogOpen(true);
                      setCashReceived(total);
                    } else {
                      setTransferDialogOpen(true);
                    }
                  }}
                  className="w-full sm:w-auto"
                >
                  {paymentMethod === PaymentMethod.CASH ? "Ingresar efectivo" : "Confirmar transferencia"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {transferDialogOpen && (
        <TransferConfirmationDialog
          accountLabel={`Cuenta de ${customerName}`}
          total={activeAmount}
          onCancel={() => setTransferDialogOpen(false)}
          onConfirm={handlePayAccount}
        />
      )}
    </>
  );
}
