"use client";
import { usePermission } from "@/components/auth/permission-provider";
import { formatCents } from "@/lib/scaled-values";

import { ColumnDef, RowData } from "@tanstack/react-table";
import { useEffect, useRef, useState } from "react";

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Generic parameters must match TanStack's declarations for interface merging.
  interface ColumnMeta<TData extends RowData, TValue> {
    className?: string;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Generic parameter must match TanStack's declaration for interface merging.
  interface TableMeta<TData extends RowData> {
    jornadaOpen?: boolean;
    onPaymentSuccess?: () => void;
  }
}

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal, Loader2, Receipt } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DebtorListItem,
  getCustomerDebtAccounts,
  getSaleOrderItems,
} from "@/lib/actions/debts";
import DebtPaymentDialog from "./debt-payment-dialog";
import { businessDate, calendarDays } from "@/lib/analytics";
import { formatSourceType } from "@/lib/pos-source";

function DebtStatusBadge({ lastConsumption }: { lastConsumption?: string | Date | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!lastConsumption) return <Badge variant="outline">--</Badge>;

  const iso = typeof lastConsumption === "string" ? lastConsumption : lastConsumption.toISOString();
  const match = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  const diffDays = match
    ? calendarDays(match[1], businessDate(new Date(now)))
    : Math.floor((now - new Date(lastConsumption).getTime()) / (1000 * 60 * 60 * 24));

  return (
    <Badge variant={diffDays >= 15 ? "destructive" : "default"}>
      {diffDays >= 15 ? "Moroso" : "Pendiente"}
    </Badge>
  );
}

function DebtOperations({
  debtor,
  jornadaOpen,
  onPaymentSuccess,
}: {
  debtor: DebtorListItem;
  jornadaOpen: boolean;
  onPaymentSuccess?: () => void;
}) {
  const mayCollect = usePermission("debts.collect");
  const [menuOpen, setMenuOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);

  // Lazy loading state for customer accounts
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [accounts, setAccounts] = useState<
    { id: number; saleId: number; amount: number; createdAt: string; sourceType: string | null }[]
  >([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [accountsError, setAccountsError] = useState("");

  // Lazy loading state for sale order items (order breakdown subdialog)
  const [breakdownSaleId, setBreakdownSaleId] = useState<number | null>(null);
  const [orderItems, setOrderItems] = useState<
    { id: number; quantity: number; productName: string; unitPrice: number; subtotal: number }[]
  >([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [itemsError, setItemsError] = useState("");

  const detailsEpochRef = useRef(0);
  const breakdownEpochRef = useRef(0);

  const customerName = debtor.customerName || "Cliente";

  const handleOpenDetails = async (open: boolean) => {
    setDetailsOpen(open);
    const epoch = ++detailsEpochRef.current;
    if (open) {
      setLoadingAccounts(true);
      setAccountsError("");
      try {
        const res = await getCustomerDebtAccounts(debtor.customerID);
        if (detailsEpochRef.current !== epoch) return;
        if (res.success && res.data) {
          setAccounts(res.data);
        } else {
          setAccountsError("No se pudieron cargar las cuentas.");
        }
      } catch {
        if (detailsEpochRef.current !== epoch) return;
        setAccountsError("Error al cargar las cuentas.");
      } finally {
        if (detailsEpochRef.current === epoch) {
          setLoadingAccounts(false);
        }
      }
    }
  };

  const handleOpenBreakdown = async (saleId: number) => {
    const epoch = ++breakdownEpochRef.current;
    setBreakdownSaleId(saleId);
    setOrderItems([]);
    setLoadingItems(true);
    setItemsError("");
    try {
      const res = await getSaleOrderItems(saleId);
      if (breakdownEpochRef.current !== epoch) return;
      if (res.success && res.data) {
        setOrderItems(res.data);
      } else {
        setItemsError("No se pudieron cargar los artículos de la comanda.");
      }
    } catch {
      if (breakdownEpochRef.current !== epoch) return;
      setItemsError("Error al cargar la comanda.");
    } finally {
      if (breakdownEpochRef.current === epoch) {
        setLoadingItems(false);
      }
    }
  };

  return (
    <div className="flex items-center justify-center">
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button ref={actionsButtonRef} variant="outline" className="h-8 w-8 p-0 cursor-pointer">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <button
            type="button"
            disabled={!mayCollect}
            onClick={() => {
              setMenuOpen(false);
              setPaymentOpen(true);
            }}
            className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground w-full"
          >
            Cobrar
          </button>
          <Separator />
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              handleOpenDetails(true);
            }}
            className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground w-full"
          >
            Detalles
          </button>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Payment dialog (extracted outside DropdownMenu to avoid unmounting in Radix UI) */}
      <DebtPaymentDialog
        debtor={debtor}
        jornadaOpen={jornadaOpen}
        returnFocusRef={actionsButtonRef}
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        onPaymentSuccess={onPaymentSuccess}
      />

      {/* Customer accounts dialog (lazy loaded) */}
      <Dialog open={detailsOpen} onOpenChange={handleOpenDetails}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Historial de cuentas de {customerName}</DialogTitle>
            <DialogDescription>
              Notas activas pendientes de pago cargadas bajo demanda.
            </DialogDescription>
          </DialogHeader>

          {loadingAccounts ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span>Cargando cuentas...</span>
            </div>
          ) : accountsError ? (
            <div className="py-6 text-center text-sm text-destructive">{accountsError}</div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Tipo / Origen</TableHead>
                    <TableHead className="text-right">Monto</TableHead>
                    <TableHead className="text-center">Comanda</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.length > 0 ? (
                    accounts.map((acc) => (
                      <TableRow key={acc.id}>
                        <TableCell>
                          {new Date(acc.createdAt).toLocaleDateString("es-MX", { timeZone: "America/Mexico_City" })}
                        </TableCell>
                        <TableCell>{acc.sourceType ? formatSourceType(acc.sourceType) : "Venta libre"}</TableCell>
                        <TableCell className="text-right font-medium">
                          ${formatCents(acc.amount)}
                        </TableCell>
                        <TableCell className="text-center">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1.5 cursor-pointer text-xs"
                            onClick={() => handleOpenBreakdown(acc.saleId)}
                          >
                            <Receipt className="h-3.5 w-3.5" />
                            Ver comanda
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-4 text-muted-foreground">
                        Sin cobros pendientes.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Order items breakdown subdialog (lazy loaded) */}
      <Dialog open={breakdownSaleId !== null} onOpenChange={(open) => !open && setBreakdownSaleId(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Desglose de comanda #{breakdownSaleId}</DialogTitle>
            <DialogDescription>Artículos solicitados en esta nota.</DialogDescription>
          </DialogHeader>

          {loadingItems ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span>Cargando artículos...</span>
            </div>
          ) : itemsError ? (
            <div className="py-6 text-center text-sm text-destructive">{itemsError}</div>
          ) : (
            <div className="max-h-[50vh] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cant.</TableHead>
                    <TableHead>Producto</TableHead>
                    <TableHead className="text-right">P. Unit.</TableHead>
                    <TableHead className="text-right">Subtotal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orderItems.length > 0 ? (
                    orderItems.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-medium">{item.quantity}x</TableCell>
                        <TableCell>{item.productName}</TableCell>
                        <TableCell className="text-right">${formatCents(item.unitPrice)}</TableCell>
                        <TableCell className="text-right font-medium">
                          ${formatCents(item.subtotal)}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-4 text-muted-foreground">
                        Sin artículos registrados.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const debtsColumns: ColumnDef<DebtorListItem>[] = [
  {
    id: "customer",
    accessorFn: (row) => `${row.customerName ?? ""} ${row.alias ?? ""}`.trim(),
    header: "Cliente",
    meta: { className: "md:hidden" },
    cell: ({ row }) => {
      const item = row.original;
      return (
        <div className="flex flex-col gap-0.5">
          <span className="font-bold whitespace-normal break-words">{item.customerName || "Cliente"}</span>
          <span className="text-xs text-muted-foreground">{item.alias}</span>
          <div className="flex flex-wrap items-center gap-1.5 md:hidden">
            <DebtStatusBadge lastConsumption={item.lastConsumption} />
            {item.lastConsumption && (
              <span className="text-xs text-muted-foreground">
                {new Date(item.lastConsumption).toLocaleDateString("es-MX", { timeZone: "UTC" })}
              </span>
            )}
          </div>
        </div>
      );
    },
  },
  {
    accessorKey: "customerName",
    header: "Nombre",
    meta: { className: "hidden md:table-cell" },
    cell: ({ row }) => <span>{row.original.customerName || "—"}</span>,
  },
  {
    accessorKey: "alias",
    header: "Alias",
    meta: { className: "hidden md:table-cell" },
    cell: ({ row }) => <span>{row.original.alias || "—"}</span>,
  },
  {
    accessorKey: "lastConsumption",
    header: "Último consumo",
    meta: { className: "hidden md:table-cell" },
    cell: ({ row }) => {
      const dateValue = row.original.lastConsumption;
      if (!dateValue) return <div>-</div>;
      const date = new Date(dateValue);
      return <div>{date.toLocaleDateString("es-MX", { timeZone: "UTC" })}</div>;
    },
  },
  {
    accessorKey: "amount",
    header: () => (
      <>
        <span className="md:hidden">Monto</span>
        <span className="hidden md:inline">Monto pendiente</span>
      </>
    ),
    cell: ({ row }) => {
      const amount = row.original.amount;
      return <div className="font-bold text-red-600">${formatCents(amount)}</div>;
    },
  },
  {
    header: () => <div className="flex items-center justify-center">Estado</div>,
    id: "status",
    meta: { className: "hidden md:table-cell" },
    cell: ({ row }) => {
      return (
        <div className="flex items-center justify-center">
          <DebtStatusBadge lastConsumption={row.original.lastConsumption} />
        </div>
      );
    },
  },
  {
    header: () => (
      <div className="flex items-center justify-center">
        <span className="md:hidden">Ops.</span>
        <span className="hidden md:inline">Operaciones</span>
      </div>
    ),
    id: "actions",
    cell: ({ row, table }) => (
      <DebtOperations
        debtor={row.original}
        jornadaOpen={table.options.meta?.jornadaOpen ?? true}
        onPaymentSuccess={table.options.meta?.onPaymentSuccess}
      />
    ),
  },
];
