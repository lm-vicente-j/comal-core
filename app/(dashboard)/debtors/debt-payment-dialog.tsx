"use client";
import { usePermission } from "@/components/auth/permission-provider";
import { formatCents } from "@/lib/scaled-values";

import { useId, useState, useEffect, type RefObject } from "react";
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
  returnFocusRef,
  open: controlledOpen,
  onOpenChange: setControlledOpen,
}: {
  debtor: DebtorListItem;
  jornadaOpen: boolean;
  onAccountClose?: () => void;
  onPaymentSuccess?: () => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
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

  const mayCollect = usePermission("debts.collect");
  const canCollect = mayCollect && jornadaOpen && !jornadaRejected;
  const inputId = useId();
  const changeId = useId();
  const errorId = useId();

  const customerName = debtor.customerName || debtor.alias || "Cliente";
  const toSafeBigInt = (val: unknown): bigint => {
    const n = Number(val ?? 0);
    return Number.isFinite(n) ? BigInt(Math.trunc(n)) : BigInt(0);
  };
  const activeAmount = accounts.length > 0
    ? accounts.reduce((sum, a) => sum + toSafeBigInt(a.amount), BigInt(0))
    : loadingAccounts
    ? toSafeBigInt(debtor.amount)
    : BigInt(0);
  const totalCents = activeAmount;
  const total = formatCents(activeAmount);

  // Lazy load the customer's open debt accounts when opening the dialog
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoadingAccounts(true);
      setError("");
      setAccounts([]);
      return getCustomerDebtAccounts(debtor.customerID);
    })
      .then((res) => {
        if (cancelled || !res) return;
        if (res.success && res.data) {
          setAccounts(res.data);
        } else {
          setError("No se pudieron cargar las cuentas activas.");
        }
      })
      .catch(() => {
        if (!cancelled) setError("Error al consultar las cuentas del cliente.");
      })
      .finally(() => {
        if (!cancelled) setLoadingAccounts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debtor.customerID]);

  const value = cashReceived.trim().replace(",", ".");
  let cashReceivedCents: bigint | null = null;
  let cashReceivedInvalid = false;
  if (value !== "") {
    if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value)) {
      cashReceivedInvalid = true;
    } else {
      const [whole, decimals = ""] = value.split(".");
      cashReceivedCents = BigInt(whole || "0") * BigInt(100) + BigInt(decimals.padEnd(2, "0"));
      if (cashReceivedCents > BigInt(Number.MAX_SAFE_INTEGER)) {
        cashReceivedCents = null;
        cashReceivedInvalid = true;
      }
    }
  }
  const changeCents = cashReceivedCents === null || cashReceivedInvalid ? null : cashReceivedCents - totalCents;
  const cashReceivedInsufficient = changeCents !== null && changeCents < BigInt(0);

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
    if (settling || !canCollect || (paymentMethod === PaymentMethod.CASH && (changeCents === null || changeCents < BigInt(0)))) return false;
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
      if (result.success) {
        setOpen(false);
        setCashDialogOpen(false);
        setCashReceived("");
        setTransferDialogOpen(false);
        setAccounts([]);
        onAccountClose?.();
        onPaymentSuccess?.();
        return true;
      } else if (result.error === "NO_OPEN_JORNADA") {
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
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden"
          onCloseAutoFocus={(event) => {
            const trigger = returnFocusRef?.current;
            if (open || !trigger?.isConnected) return;
            event.preventDefault();
            trigger.focus();
          }}
        >
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
                    ? "Faltan $" + formatCents(-changeCents!)
                    : "Cambio a entregar: " + (changeCents === null ? "—" : "$" + formatCents(changeCents))}
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
                  disabled={settling || !canCollect || cashReceivedCents === null || cashReceivedInvalid || cashReceivedInsufficient}
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
                  <span className="text-lg font-bold text-red-600">{error && accounts.length === 0 ? "—" : `$${total}`}</span>
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
                {!loadingAccounts && !error && accounts.length === 0 && (
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
                    setError("");
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
          onCancel={() => { setError(""); setTransferDialogOpen(false); }}
          onConfirm={handlePayAccount}
          errorMessage={error}
        />
      )}
    </>
  );
}
