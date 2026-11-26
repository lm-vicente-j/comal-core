"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  closeJornada,
  exportCashCountHistory,
  getCashCountHistory,
  getJornadaClosingSummary,
  getJornadaCollectionsByEmployee,
  openJornada,
  recordCashCount,
} from "@/lib/actions/jornada";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import CashCountForm from "@/components/cash-count-form";
import type { CashCountInput, CashCountView } from "@/lib/cash-count";
import { formatCurrencyCents } from "@/lib/scaled-values";
import { parseCents } from "@/lib/scaled-values";
import { formatSourceType } from "@/lib/pos-source";
import type { RolePermissions } from "@/lib/permissions";
import { Clock, Users } from "lucide-react";
import { DataPagination } from "@/components/pagination";
import { Input } from "@/components/ui/input";
import { saveMovement } from "@/lib/actions/savings";

type Props = {
  data: Awaited<
    ReturnType<typeof import("@/lib/actions/jornada").getActiveJornadaWithStats>
  >;
  employees: Awaited<
    ReturnType<
      typeof import("@/lib/actions/jornada").getJornadaEmployeeBreakdown
    >
  >;
  permissions: RolePermissions;
  isOwner: boolean;
  jornadaOpen: boolean;
  activeJornadaId: number | null;
  collections?: Awaited<ReturnType<typeof getJornadaCollectionsByEmployee>>;
  history: Awaited<ReturnType<typeof getCashCountHistory>>;
};
type OpenAccount = { sourceType: string; count: number; total: number };
type CollectionRow = {
  userId: number | null;
  userName: string;
  collectionsCount: number;
  totalCollected: number;
  cashCollected: number;
  transferCollected: number;
};
type ClosingSummary = {
  jornada: {
    id: number;
    status: string;
    openedAt: string;
    closedAt: string | null;
    openingAmount: number;
    expectedClosingAmount?: number | null;
    actualClosingAmount: number | null;
    expectedTransferAmount?: number | null;
  };
  counts: CashCountView[];
  collections: CollectionRow[];
};
type CountRequest = {
  id: number;
  title: string;
  type: "OPENING" | "INTERIM" | "CLOSING";
  jornadaId?: number;
  viewCash: boolean;
  triggerLabel?: string;
};

export default function JornadaManager(props: Props) {
  const [tab, setTab] = useState<"today" | "history">("today");
  // Keep the lifecycle dialog mounted at this stable level. Opening or closing
  // a jornada changes the Today branch in the refreshed server response.
  const [countRequest, setCountRequest] = useState<CountRequest | null>(null);
  const countOpener = useRef<HTMLElement | null>(null);
  const managerFallback = useRef<HTMLDivElement | null>(null);
  const startCount = (request: Omit<CountRequest, "id">) => {
    countOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setCountRequest({ ...request, id: Date.now() });
  };
  return (
    <div ref={managerFallback} tabIndex={-1} className="space-y-3">
      <CountDialog
        key={countRequest?.id ?? "closed"}
        request={countRequest}
        currentViewCash={!!props.permissions["jornada.viewCash"]}
        countOpener={countOpener}
        managerFallback={managerFallback}
        onRequestDismiss={() => setCountRequest(null)}
      />
      <div className="flex gap-2 border-b">
        <button
          onClick={() => setTab("today")}
          className={`px-3 py-2 text-sm ${tab === "today" ? "border-b-2 border-primary font-semibold" : "text-muted-foreground"}`}
        >
          Hoy
        </button>
        <button
          onClick={() => setTab("history")}
          className={`px-3 py-2 text-sm ${tab === "history" ? "border-b-2 border-primary font-semibold" : "text-muted-foreground"}`}
        >
          Historial
        </button>
      </div>
      {tab === "today" ? (
        <Today {...props} onStartCount={startCount} />
      ) : (
        <History
          initial={props.history}
          viewCash={!!props.permissions["jornada.viewCash"]}
          activeJornadaId={props.activeJornadaId}
        />
      )}
    </div>
  );
}

function Today({
  data,
  employees,
  permissions,
  isOwner,
  collections,
  jornadaOpen,
  activeJornadaId,
  onStartCount,
}: Props & {
  onStartCount: (request: Omit<CountRequest, "id">) => void;
}) {
  if (!data && jornadaOpen && activeJornadaId !== null)
    return (
      <Card className="p-4 space-y-3">
        <div>
          <h2 className="font-semibold">Jornada abierta</h2>
          <p className="text-xs text-muted-foreground">
            No tienes permiso para ver el resumen de caja.
          </p>
        </div>
        <div className="flex gap-2">
          {permissions["jornada.reconcile"] && (
            <CountLauncher
              title="Recuento"
              type="INTERIM"
              jornadaId={activeJornadaId}
              viewCash={false}
              onStart={onStartCount}
            />
          )}
          {permissions["jornada.close"] && (
            <CountLauncher
              title="Cerrar jornada"
              type="CLOSING"
              jornadaId={activeJornadaId}
              viewCash={false}
              onStart={onStartCount}
            />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Incluye movimientos confirmados hasta guardar el conteo.
        </p>
      </Card>
    );
  if (!data || data.state === "NO_JORNADA")
    return permissions["jornada.open"] ? (
      <OpenPanel onStartCount={onStartCount} />
    ) : (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">
          No hay una jornada activa.
        </p>
      </Card>
    );
  const own = data.state === "OWN_OPEN",
    { jornada, stats } = data;
  return (
    <div className="space-y-3">
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold">Jornada #{jornada.id}</h2>
            <p className="text-xs text-muted-foreground">
              Abierta por {jornada.openedByUser?.name ?? "Desconocido"} ·{" "}
              {new Date(jornada.openedAt).toLocaleString("es-MX")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {permissions["jornada.reconcile"] && (
              <CountLauncher
                title="Recuento"
                type="INTERIM"
                jornadaId={jornada.id}
                viewCash={!!permissions["jornada.viewCash"]}
                onStart={onStartCount}
              />
            )}
            {permissions["jornada.close"] && (
              <CountLauncher
                title="Cerrar jornada"
                type="CLOSING"
                jornadaId={jornada.id}
                viewCash={!!permissions["jornada.viewCash"]}
                onStart={onStartCount}
              />
            )}
          </div>
        </div>
        {!own && (
          <p className="text-xs text-amber-800">
            Esta jornada sigue abierta. Las diferencias no se atribuyen
            automáticamente a quien la abrió o contó.
          </p>
        )}
        {permissions["jornada.viewCash"] && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            {(
              [
                ["Inicio", jornada.openingAmount],
                ["Ventas efectivo", stats.cashSales],
                ["Cobros efectivo", stats.debtCollectedCash],
                ["Egresos", stats.cashBills],
                ...(isOwner
                  ? [
                      ["Sueldos", stats.cashSalaries] as [string, number],
                      ["Depósitos ahorros", stats.savingsOut] as [
                        string,
                        number,
                      ],
                    ]
                  : []),
                ["Esperado caja", stats.expectedCash],
                ["Ventas transferencia", stats.transferSales],
                ["Cobros transferencia", stats.debtCollectedTransfer],
                ["Egresos transferencia", stats.transferBills],
                ...(isOwner
                  ? [
                      ["Sueldos transferencia", stats.transferSalaries] as [
                        string,
                        number,
                      ],
                    ]
                  : []),
                ["Esperado transferencias", stats.expectedTransfer],
                ["Fiado generado", stats.debtCreated],
                ["Fiado pendiente", stats.debtPending],
              ] as [string, number][]
            ).map(([label, value]) => (
              <div key={label} className="rounded bg-muted p-2">
                <span className="text-muted-foreground">{label}</span>
                <div className="font-semibold">
                  {formatCurrencyCents(value)}
                </div>
              </div>
            ))}
          </div>
        )}
        {permissions["savings.deposit"] && <SavingsDeposit />}
        <p className="text-xs text-muted-foreground">
          Cuenta incluyendo movimientos confirmados hasta guardar. Las
          operaciones continúan durante el conteo.
        </p>
      </Card>
      {permissions["jornada.viewCash"] && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Card className="p-3">
            <h3 className="text-sm font-semibold flex gap-2 mb-2">
              <Users className="h-4 w-4" />
              Ventas por empleado
            </h3>
            <CompactPeople
              rows={employees.map((x) => ({
                name: x.userName,
                count: x.salesCount,
                total: x.totalSold,
                unit: "ventas",
              }))}
            />
          </Card>
          <Card className="p-3">
            <h3 className="text-sm font-semibold mb-2">Cobros por empleado</h3>
            <CompactPeople
              rows={(collections ?? []).map((x) => ({
                name: x.userName,
                count: x.collectionsCount,
                total: x.totalCollected,
                unit: "cobros",
              }))}
            />
          </Card>
        </div>
      )}
      {!permissions["jornada.viewCash"] && (
        <Card className="p-3">
          <p className="text-sm">
            Puedes registrar y consultar tus conteos autorizados. El resumen
            esperado está disponible para roles con permiso de ver caja.
          </p>
        </Card>
      )}
    </div>
  );
}
function CompactPeople({
  rows,
}: {
  rows: { name: string; count: number; total: number; unit: string }[];
}) {
  return rows.length === 0 ? (
    <p className="text-xs text-muted-foreground">Sin movimientos todavía.</p>
  ) : (
    <div className="divide-y">
      {rows.map((r, i) => (
        <div
          key={`${r.name}-${i}`}
          className="py-1.5 flex justify-between gap-2 text-xs"
        >
          <span className="truncate">
            {r.name} · {r.count} {r.unit}
          </span>
          <span className="shrink-0 font-medium">
            {formatCurrencyCents(r.total)}
          </span>
        </div>
      ))}
    </div>
  );
}

function OpenPanel({
  onStartCount,
}: {
  onStartCount: (request: Omit<CountRequest, "id">) => void;
}) {
  return (
    <Card className="p-4 max-w-xl mx-auto">
      <div className="flex items-center gap-2 mb-2">
        <Clock className="h-4 w-4" />
        <h2 className="font-semibold">Iniciar jornada</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-3">
        Cuenta el efectivo disponible para establecer el fondo inicial.
      </p>
      <CountLauncher
        title="Abrir jornada"
        type="OPENING"
        viewCash={true}
        triggerLabel="Abrir jornada"
        onStart={onStartCount}
      />
    </Card>
  );
}

function SavingsDeposit() {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  async function deposit() {
    const cents = parseCents(amount);
    if (cents === null || cents <= 0) {
      setError("Ingresa un monto válido mayor que cero.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await saveMovement(
        cents,
        "DEPOSIT",
        description.trim() || undefined,
      );
      if (result.success) setSaved(true);
      else
        setError(
          result.error === "NO_OPEN_JORNADA"
            ? "Se necesita una jornada abierta."
            : "No se pudo registrar el depósito.",
        );
    } catch {
      setError("No se pudo conectar. Intenta de nuevo.");
    } finally {
      setLoading(false);
    }
  }
  return (
    <Card className="p-3 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="text-sm font-semibold">Mover efectivo a ahorros</h3>
        <p className="text-xs text-muted-foreground">
          El depósito se descuenta de la caja esperada.
        </p>
      </div>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!loading) {
            setOpen(next);
            if (!next) {
              setSaved(false);
              setError("");
            }
          }
        }}
      >
        <AlertDialogTrigger asChild>
          <Button size="sm" variant="outline">
            Registrar depósito
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent className="w-[calc(100vw-1rem)] max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Depósito a ahorros</AlertDialogTitle>
            <AlertDialogDescription>
              Registra efectivo que sale de la caja y entra al fondo de ahorros.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {saved ? (
            <p className="text-sm text-green-700">Depósito registrado.</p>
          ) : (
            <div className="space-y-3">
              <label className="block text-sm" htmlFor="savings-deposit-amount">
                Monto en pesos
                <Input
                  id="savings-deposit-amount"
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  value={amount}
                  disabled={loading}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <label
                className="block text-sm"
                htmlFor="savings-deposit-description"
              >
                Descripción (opcional)
                <Input
                  id="savings-deposit-description"
                  maxLength={1000}
                  value={description}
                  disabled={loading}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              {error && (
                <p role="alert" className="text-sm text-red-600">
                  {error}
                </p>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Cancelar</AlertDialogCancel>
            {saved ? (
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  setOpen(false);
                  setSaved(false);
                  setAmount("");
                  setDescription("");
                }}
              >
                Listo
              </AlertDialogAction>
            ) : (
              <AlertDialogAction
                disabled={loading}
                onClick={(e) => {
                  e.preventDefault();
                  void deposit();
                }}
              >
                {loading ? "Guardando…" : "Guardar depósito"}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function CountLauncher({
  title,
  type,
  jornadaId,
  viewCash,
  triggerLabel,
  onStart,
}: Omit<CountRequest, "id"> & {
  onStart: (request: Omit<CountRequest, "id">) => void;
}) {
  return (
    <Button
      size="sm"
      variant={type === "CLOSING" ? "default" : "outline"}
      onClick={() => onStart({ title, type, jornadaId, viewCash, triggerLabel })}
    >
      {triggerLabel ?? title}
    </Button>
  );
}

function CountDialog({
  title: legacyTitle,
  type: legacyType,
  jornadaId: legacyJornadaId,
  viewCash: legacyViewCash,
  triggerLabel,
  recountOfId,
  request,
  currentViewCash,
  countOpener,
  managerFallback,
  onRequestDismiss,
}: {
  title?: string;
  type?: "OPENING" | "INTERIM" | "CLOSING";
  jornadaId?: number;
  viewCash?: boolean;
  triggerLabel?: string;
  recountOfId?: number;
  request?: CountRequest | null;
  currentViewCash?: boolean;
  countOpener?: { readonly current: HTMLElement | null };
  managerFallback?: { readonly current: HTMLElement | null };
  onRequestDismiss?: () => void;
}) {
  const title = request?.title ?? legacyTitle ?? "Recuento";
  const type = request?.type ?? legacyType ?? "INTERIM";
  const jornadaId = request?.jornadaId ?? legacyJornadaId;
  const viewCash = request
    ? request.viewCash && currentViewCash === true
    : legacyViewCash ?? false;
  const externallyControlled = request !== undefined;
  const router = useRouter();
  const [internal, setInternal] = useState(false);
  const [receipt, setReceipt] = useState<CashCountView | null>(null);
  const [openAccounts, setOpenAccounts] = useState<OpenAccount[]>([]);
  const open = externallyControlled ? request !== null : internal;
  const setOpen = setInternal;
  const [saving, setSaving] = useState(false);
  const dismiss = () => {
    const hasReceipt = receipt !== null;
    setReceipt(null);
    setOpenAccounts([]);
    if (externallyControlled) onRequestDismiss?.();
    else setOpen(false);
    if (hasReceipt) router.refresh();
  };
  const submit = async (input: CashCountInput) => {
    setOpenAccounts([]);
    setSaving(true);
    try {
      const r =
        type === "OPENING"
          ? await openJornada(input)
          : type === "CLOSING"
            ? await closeJornada(jornadaId!, input)
            : await recordCashCount(jornadaId!, input);
      if (!r.success) {
        if (r.error === "OPEN_ACCOUNTS") {
          setOpenAccounts(
            r.data && "openAccounts" in r.data ? r.data.openAccounts : [],
          );
          return { success: false, error: r.error };
        }
        return { success: false, error: r.error };
      }
      if (r.data?.id) {
        setReceipt(r.data);
      }
      return r;
    } finally {
      setSaving(false);
    }
  };
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) {
          if (next) setOpen(true);
          else dismiss();
        }
      }}
    >
      {!externallyControlled && (
        <AlertDialogTrigger asChild>
          <Button size="sm" variant={type === "CLOSING" ? "default" : "outline"}>
            {triggerLabel ?? title}
          </Button>
        </AlertDialogTrigger>
      )}
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          if (!externallyControlled) return;
          event.preventDefault();
          const target = countOpener?.current?.isConnected
            ? countOpener.current
            : managerFallback?.current;
          target?.focus();
        }}
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md flex-col overflow-hidden p-4 sm:p-6"
      >
        <AlertDialogHeader className="shrink-0 mb-3">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {type === "CLOSING"
              ? "El cierre no se completará mientras queden cuentas abiertas sin cobrar."
              : type === "OPENING"
                ? "Desglosa el efectivo del fondo inicial."
                : "Registra un nuevo corte; el conteo anterior permanece guardado."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div
          role="region"
          aria-label="Contenido del conteo"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {receipt ? (
            <Receipt receipt={receipt} viewCash={viewCash} />
          ) : (
            <CashCountForm
              key={`${type}-${open}-${recountOfId ?? "new"}`}
              type={type}
              submit={submit}
              onSaved={setReceipt}
              recountOfId={recountOfId}
              recountReasonRequired={recountOfId !== undefined}
            />
          )}
          {openAccounts.length > 0 && (
            <div className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm">
              <p className="font-semibold">
                No se puede cerrar: hay cuentas abiertas sin cobrar.
              </p>
              <ul className="list-disc pl-5">
                {openAccounts.map((x: OpenAccount) => (
                  <li key={x.sourceType}>
                    {formatSourceType(x.sourceType)} · {x.count} pedidos ·{" "}
                    {formatCurrencyCents(x.total)}
                  </li>
                ))}
              </ul>
              <p className="text-xs mt-1">
                Resuelve cada cuenta en el POS y vuelve a intentar el cierre.
              </p>
            </div>
          )}
        </div>
        <AlertDialogFooter className="shrink-0 pt-3">
          {!receipt && (
            <AlertDialogCancel disabled={saving}>Cancelar</AlertDialogCancel>
          )}
          {receipt && (
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                dismiss();
              }}
            >
              Listo
            </AlertDialogAction>
          )}
          {!receipt && (
            <Button
              type="submit"
              form="cash-count-form"
              disabled={saving}
              aria-label="Guardar conteo"
            >
              {saving ? "Guardando…" : "Guardar conteo"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
function Receipt({
  receipt,
  viewCash,
}: {
  receipt: CashCountView;
  viewCash: boolean;
}) {
  return (
    <div className="rounded border p-3 text-sm space-y-1">
      <p className="font-semibold">
        Conteo guardado · {new Date(receipt.cutoffAt).toLocaleString("es-MX")}
      </p>
      <p>
        {receipt.operatorName} · {formatCurrencyCents(receipt.countedAmount)}
      </p>
      {receipt.note && <p className="text-muted-foreground">{receipt.note}</p>}
      {viewCash && receipt.expectedAmount !== undefined && (
        <>
          <p>Esperado: {formatCurrencyCents(receipt.expectedAmount)}</p>
          <p>
            Diferencia: {formatCurrencyCents(receipt.difference ?? 0)} ·{" "}
            {receipt.result === "BALANCED" ? "Cuadra" : "Con diferencia"}
          </p>
        </>
      )}
    </div>
  );
}

function History({
  initial,
  viewCash,
  activeJornadaId,
}: {
  initial: Awaited<ReturnType<typeof getCashCountHistory>>;
  viewCash: boolean;
  activeJornadaId: number | null;
}) {
  const [page, setPage] = useState(1),
    [data, setData] = useState(initial.success ? initial.data : undefined),
    [detail, setDetail] = useState<ClosingSummary | null>(null),
    [pending, setPending] = useState(false),
    [failed, setFailed] = useState(!initial.success);
  const requestVersion = useRef(0);
  const [jornadaFilter, setJornadaFilter] = useState(""),
    [operatorFilter, setOperatorFilter] = useState(""),
    [typeFilter, setTypeFilter] = useState("");
  const filters = () => ({
    ...(jornadaFilter && Number.isInteger(Number(jornadaFilter))
      ? { jornadaId: Number(jornadaFilter) }
      : {}),
    ...(operatorFilter && Number.isInteger(Number(operatorFilter))
      ? { operatorId: Number(operatorFilter) }
      : {}),
    ...(typeFilter
      ? { type: typeFilter as "OPENING" | "INTERIM" | "CLOSING" }
      : {}),
  });
  async function load(p: number) {
    const version = ++requestVersion.current;
    setPending(true);
    const r = await getCashCountHistory({
      page: p,
      pageSize: 10,
      ...filters(),
    });
    if (version !== requestVersion.current) return;
    setPending(false);
    if (r.success) {
      setPage(r.data.page);
      setData(r.data);
      setFailed(false);
    } else {
      setFailed(true);
    }
  }
  async function apply() {
    await load(1);
  }
  async function exportCsv() {
    const r = await exportCashCountHistory(filters());
    if (r.success) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(
        new Blob([r.data], { type: "text/csv;charset=utf-8" }),
      );
      a.download = "conteos-caja.csv";
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap justify-between items-center gap-2">
        <h2 className="font-semibold">Conteos guardados</h2>
        <Button size="sm" variant="outline" onClick={exportCsv}>
          Exportar CSV
        </Button>
      </div>
      <Card className="p-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <label className="text-xs">
            Jornada
            <Input
              className="mt-1 h-8"
              inputMode="numeric"
              value={jornadaFilter}
              onChange={(e) => setJornadaFilter(e.target.value)}
            />
          </label>
          <label className="text-xs">
            ID operador
            <Input
              className="mt-1 h-8"
              inputMode="numeric"
              value={operatorFilter}
              onChange={(e) => setOperatorFilter(e.target.value)}
            />
          </label>
          <label className="text-xs">
            Tipo
            <select
              className="mt-1 h-8 w-full rounded border bg-background px-2"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="">Todos</option>
              <option value="OPENING">Apertura</option>
              <option value="INTERIM">Recuento</option>
              <option value="CLOSING">Cierre</option>
            </select>
          </label>
          <Button size="sm" className="self-end" onClick={apply}>
            Filtrar
          </Button>
        </div>
      </Card>
      {failed && (
        <div role="alert" className="rounded-md border p-3 text-sm">
          <p>No se pudieron cargar los conteos. Intenta de nuevo.</p>
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            onClick={() => load(page)}
          >
            Reintentar
          </Button>
        </div>
      )}
      <Card className="divide-y" aria-busy={pending}>
        {(data?.items ?? []).map((c) => (
          <div key={c.id} className="p-3 flex justify-between gap-2 text-sm">
            <button
              className="min-w-0 text-left"
              onClick={async () => {
                const r = await getJornadaClosingSummary(c.jornadaId);
                if (r.success) setDetail(r.data);
              }}
            >
              <b>
                {c.type === "OPENING"
                  ? "Apertura"
                  : c.type === "CLOSING"
                    ? "Cierre"
                    : "Recuento"}
              </b>
              <span className="block text-xs text-muted-foreground">
                Jornada #{c.jornadaId} · {c.operatorName} ·{" "}
                {new Date(c.cutoffAt).toLocaleString("es-MX")}
              </span>
            </button>
            <span className="text-right shrink-0">
              {formatCurrencyCents(c.countedAmount)}
              {c.type === "INTERIM" && c.jornadaId === activeJornadaId && (
                <span className="block">
                  <CountDialog
                    title="Recontar"
                    type="INTERIM"
                    jornadaId={c.jornadaId}
                    recountOfId={c.id}
                    viewCash={viewCash}
                    triggerLabel="Recontar"
                  />
                </span>
              )}
            </span>
          </div>
        ))}
        {!data?.items.length && (
          <p className="p-3 text-sm text-muted-foreground">
            Aún no hay conteos registrados.
          </p>
        )}
      </Card>
      {data && (
        <DataPagination
          {...data}
          onPageChange={load}
          isPending={pending}
          totalLabel="conteos"
          mode="responsive"
          placement="inline"
        />
      )}
      {detail && (
        <Card className="p-3 space-y-2">
          <div className="flex justify-between">
            <b>Resumen jornada #{detail.jornada.id}</b>
            <button onClick={() => setDetail(null)} aria-label="Cerrar detalle">
              ×
            </button>
          </div>
          {viewCash && (
            <p className="text-sm">
              Apertura {formatCurrencyCents(detail.jornada.openingAmount)} ·{" "}
              {detail.jornada.status === "OPEN"
                ? "Jornada en curso"
                : `Cierre esperado ${formatCurrencyCents(detail.jornada.expectedClosingAmount ?? 0)} · contado ${formatCurrencyCents(detail.jornada.actualClosingAmount ?? 0)}`}
            </p>
          )}
          <p className="text-xs font-medium">
            Conteos: {detail.counts.length} · Cobros:{" "}
            {detail.collections.length}
          </p>
          {detail.counts.map((c) => (
            <div key={c.id} className="text-xs border-t pt-2 space-y-1">
              <div className="font-medium">
                {c.type === "OPENING"
                  ? "Apertura"
                  : c.type === "CLOSING"
                    ? "Cierre"
                    : "Recuento"}{" "}
                · {c.operatorName} ·{" "}
                {new Date(c.cutoffAt).toLocaleString("es-MX")}
              </div>
              {viewCash && c.expectedAmount !== undefined && (
                <div className="flex flex-wrap gap-x-3">
                  <span>Contado {formatCurrencyCents(c.countedAmount)}</span>
                  <span>Esperado {formatCurrencyCents(c.expectedAmount)}</span>
                  <span>
                    Diferencia {formatCurrencyCents(c.difference ?? 0)}
                  </span>
                  <span>
                    {c.result === "BALANCED" ? "Cuadra" : "Con diferencia"}
                  </span>
                </div>
              )}
              {!viewCash && (
                <div>Contado {formatCurrencyCents(c.countedAmount)}</div>
              )}
              <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-muted-foreground">
                <span>Denominación</span>
                <span>Cantidad</span>
                <span>Subtotal</span>
                {c.denominations.map((d, i) => (
                  <span
                    key={`${d.kind}-${d.valueCents}-${i}`}
                    className="contents"
                  >
                    <span>
                      {d.kind === "BILL" ? "Billete" : "Moneda"}{" "}
                      {formatCurrencyCents(d.valueCents)}
                    </span>
                    <span className="text-right">{d.quantity}</span>
                    <span className="text-right">
                      {formatCurrencyCents(d.valueCents * d.quantity)}
                    </span>
                  </span>
                ))}
              </div>
              {c.note && (
                <p className="text-muted-foreground">Nota: {c.note}</p>
              )}
            </div>
          ))}
          {viewCash &&
            detail.collections.map((c) => (
              <div key={`${c.userId}-${c.userName}`} className="text-xs">
                {c.userName} · {c.collectionsCount} cobros · efectivo{" "}
                {formatCurrencyCents(c.cashCollected)} · transferencia{" "}
                {formatCurrencyCents(c.transferCollected)}
              </div>
            ))}
        </Card>
      )}
    </div>
  );
}
