"use client";

import { useMemo, useState } from "react";
import {
  CASH_DENOMINATIONS,
  type CashCountInput,
  type CashCountView,
} from "@/lib/cash-count";
import { Input } from "@/components/ui/input";
import { formatCurrencyCents } from "@/lib/scaled-values";
import { Checkbox } from "@/components/ui/checkbox";

type CountType = CashCountView["type"];
type Props = {
  type: CountType;
  submit: (
    input: CashCountInput,
  ) => Promise<{ success: boolean; data?: CashCountView; error?: string }>;
  onSaved: (receipt: CashCountView) => void;
  recountOfId?: number;
  recountReasonRequired?: boolean;
};

export default function CashCountForm({
  type,
  submit,
  onSaved,
  recountOfId,
  recountReasonRequired = false,
}: Props) {
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const rows = useMemo(
    () =>
      CASH_DENOMINATIONS.map((d) => ({
        ...d,
        key: `${d.kind}-${d.valueCents}`,
      })),
    [],
  );
  const validQuantities = rows.every((d) => {
    const raw = quantities[d.key] ?? "";
    return (
      raw === "" || (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)))
    );
  });
  const total = validQuantities
    ? rows.reduce(
        (sum, d) =>
          sum +
          d.valueCents * (quantities[d.key] ? Number(quantities[d.key]) : 0),
        0,
      )
    : NaN;
  const validTotal =
    Number.isSafeInteger(total) && total >= 0 && total <= 100_000_000_000_000;
  const countLabel =
    type === "OPENING"
      ? "conteo inicial"
      : type === "CLOSING"
        ? "cierre"
        : "recuento";

  async function save() {
    if (loading) return;
    setError("");
    if (!validQuantities || !validTotal) {
      setError(
        "Revisa las cantidades: usa enteros no negativos y un total válido.",
      );
      return;
    }
    if (recountReasonRequired && !note.trim()) {
      setError("Escribe el motivo del reconteo.");
      return;
    }
    const denominations = rows.map((d) => ({
      kind: d.kind,
      valueCents: d.valueCents,
      quantity: quantities[d.key] ? Number(quantities[d.key]) : 0,
    }));
    if (total === 0 && !confirmEmpty) {
      setError(
        "Confirma que la caja está vacía para guardar un conteo de $0.00.",
      );
      return;
    }
    setLoading(true);
    try {
      const result = await submit({
        requestId,
        denominations,
        note: note.trim() || undefined,
        recountOfId,
        confirmEmpty: total === 0 ? true : undefined,
      });
      if (result.success && result.data) {
        onSaved(result.data);
        return;
      }
      if (result.error === "NOTE_REQUIRED")
        setError("Agrega una nota para este conteo y vuelve a guardar.");
      else if (result.error === "OPEN_ACCOUNTS")
        setError(
          "No se puede cerrar mientras haya cuentas abiertas sin cobrar. Resuelve la lista y vuelve a intentar.",
        );
      else if (result.error === "PERMISSION DENIED")
        setError("No tienes permiso para registrar este conteo.");
      else if (
        result.error === "JORNADA_CLOSED" ||
        result.error === "La jornada ya está cerrada"
      )
        setError("La jornada ya está cerrada. Actualiza la página.");
      else
        setError(
          "No se pudo guardar el conteo. Revisa los datos e inténtalo de nuevo.",
        );
    } catch {
      setError("No se pudo conectar. Puedes reintentar el mismo conteo.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      id="cash-count-form"
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="text-sm text-muted-foreground mb-3">
        Cuenta billetes y monedas. Incluye movimientos confirmados hasta guardar
        el {countLabel}.
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {(["BILL", "COIN"] as const).map((kind) => (
          <section
            key={kind}
            className="mb-3"
            aria-label={kind === "BILL" ? "Billetes" : "Monedas"}
          >
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
              {kind === "BILL" ? "Billetes" : "Monedas"}
            </h4>
            <div className="grid grid-cols-[minmax(5rem,1fr)_4.5rem_5.5rem] gap-x-2 px-1 text-[11px] text-muted-foreground">
              <span>Denominación</span>
              <span className="text-right">Cantidad</span>
              <span className="text-right">Subtotal</span>
            </div>
            {rows
              .filter((d) => d.kind === kind)
              .map((d) => {
                const raw = quantities[d.key] ?? "";
                const qty = raw === "" ? 0 : Number(raw);
                const subtotal = d.valueCents * qty;
                return (
                  <div
                    key={d.key}
                    className="grid grid-cols-[minmax(5rem,1fr)_4.5rem_5.5rem] items-center gap-x-2 py-1 border-b last:border-0"
                  >
                    <span className="text-sm">
                      {formatCurrencyCents(d.valueCents)}
                    </span>
                    <Input
                      aria-label={`Cantidad ${formatCurrencyCents(d.valueCents)} ${kind === "BILL" ? "billete" : "moneda"}`}
                      className="h-8 px-2 text-right"
                      inputMode="numeric"
                      type="number"
                      min="0"
                      step="1"
                      value={quantities[d.key] ?? ""}
                      disabled={loading}
                      onChange={(e) => {
                        setQuantities((q) => ({
                          ...q,
                          [d.key]: e.target.value,
                        }));
                        setRequestId(crypto.randomUUID());
                      }}
                    />
                    <span className="text-right text-sm tabular-nums">
                      {Number.isSafeInteger(subtotal) && subtotal >= 0
                        ? formatCurrencyCents(subtotal)
                        : "—"}
                    </span>
                  </div>
                );
              })}
          </section>
        ))}
        <div className="flex justify-between border-t pt-2 font-semibold">
          <span>Total contado</span>
          <span>{validTotal ? formatCurrencyCents(total) : "—"}</span>
        </div>
        {total === 0 && validTotal && (
          <label className="mt-2 flex items-center gap-2 text-sm">
            <Checkbox
              disabled={loading}
              checked={confirmEmpty}
              onCheckedChange={(v) => {
                setConfirmEmpty(v === true);
                setRequestId(crypto.randomUUID());
              }}
            />
            <span>Confirmo que la caja está vacía</span>
          </label>
        )}
        <label
          className="block text-sm font-medium mt-3"
          htmlFor="cash-count-note"
        >
          Nota {recountReasonRequired ? "(motivo requerido)" : "(opcional)"}
        </label>
        <textarea
          id="cash-count-note"
          maxLength={1000}
          className="mt-1 w-full min-h-16 rounded-md border bg-background px-3 py-2 text-sm"
          value={note}
          disabled={loading}
          onChange={(e) => {
            setNote(e.target.value);
            setRequestId(crypto.randomUUID());
          }}
        />
        {error && (
          <p role="alert" className="text-sm text-red-600 mt-2">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
