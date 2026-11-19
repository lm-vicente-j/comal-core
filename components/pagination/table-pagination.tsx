"use client";

import { Table } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";

interface TablePaginationProps {
    table: Table<any>;
    className?: string;
}

export function TablePagination({ table, className }: TablePaginationProps) {
    const pageIndex = table.getState().pagination.pageIndex;
    const pageCount = Math.max(1, table.getPageCount());
    const totalRows = table.getFilteredRowModel().rows.length;
    const pageSize = table.getState().pagination.pageSize;
    const firstRow = totalRows === 0 ? 0 : pageIndex * pageSize + 1;
    const lastRow = Math.min((pageIndex + 1) * pageSize, totalRows);

    return (
        <div className={`flex items-center justify-between border-t px-4 py-2 bg-white shrink-0 ${className ?? ""}`}>
            <div className="text-xs text-muted-foreground">
                {totalRows > 0 ? (
                    <span>
                        Mostrando {firstRow}–{lastRow} de {totalRows} · Página {pageIndex + 1} de {pageCount}
                    </span>
                ) : (
                    <span>0 registros</span>
                )}
            </div>
            <div className="flex items-center gap-2">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => table.previousPage()}
                    disabled={!table.getCanPreviousPage()}
                >
                    Anterior
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => table.nextPage()}
                    disabled={!table.getCanNextPage()}
                >
                    Siguiente
                </Button>
            </div>
        </div>
    );
}
