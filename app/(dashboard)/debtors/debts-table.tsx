"use client";

import type { DebtorListItem } from "@/lib/actions/debts";
import type { PaginatedResult } from "@/components/pagination";
import type { PaginationError } from "@/lib/pagination";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DataPagination } from "@/components/pagination";
import { debtsColumns } from "./debts-columns";
import { Loader2 } from "lucide-react";

interface DebtorsTableProps {
  data: PaginatedResult<DebtorListItem>;
  jornadaOpen: boolean;
  isPending: boolean;
  error?: PaginationError;
  search: string;
  onSearchChange: (search: string) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onPaymentSuccess: () => void;
}

export default function DebtorsTable({
  data,
  jornadaOpen,
  isPending,
  error,
  search,
  onSearchChange,
  onPageChange,
  onPageSizeChange,
  onPaymentSuccess,
}: DebtorsTableProps) {
  const table = useReactTable({
    data: data.items,
    columns: debtsColumns,
    getRowId: (row) => String(row.customerID),
    meta: { jornadaOpen, onPaymentSuccess },
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex flex-col h-full min-h-0 w-full rounded-md border bg-white p-2 md:p-4 overflow-hidden">
      <div className="flex items-center py-1 md:py-2 w-full gap-2 relative shrink-0">
        <Input
          placeholder="Buscar deudor por nombre o alias..."
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          className="w-full pr-8"
        />
        {isPending && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
      </div>

      <ScrollArea className="flex-1 min-h-0 w-full">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className={header.column.columnDef.meta?.className}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={debtsColumns.length} className="h-24 text-center text-muted-foreground">
                  {error ? "No se pudieron cargar los deudores." : isPending ? "Cargando deudores..." : "No se encontraron clientes con deudas pendientes."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ScrollArea>

      <DataPagination
        {...data}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        isPending={isPending}
        totalLabel="deudores"
        className="border-t shrink-0"
      />
    </div>
  );
}
