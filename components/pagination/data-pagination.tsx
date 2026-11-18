"use client";

import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface DataPaginationProps {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  isPending?: boolean;
  className?: string;
}

export function DataPagination({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
  isPending = false,
  className,
}: DataPaginationProps) {
  const isEmpty = total === 0 || totalPages === 0;
  const safePage = Math.max(1, page);
  const rawFrom = isEmpty ? 0 : (safePage - 1) * pageSize + 1;
  const to = isEmpty ? 0 : Math.min(safePage * pageSize, total);
  const from = Math.min(rawFrom, to);

  const getPageNumbers = () => {
    if (isEmpty) return [];
    const pages: (number | "ellipsis")[] = [];
    if (totalPages <= 5) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (page > 3) pages.push("ellipsis");
      const start = Math.max(2, page - 1);
      const end = Math.min(totalPages - 1, page + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (page < totalPages - 2) pages.push("ellipsis");
      pages.push(totalPages);
    }
    return pages;
  };

  return (
    <div className={cn("flex flex-col md:flex-row items-center justify-between gap-4 py-3 px-2 text-sm", className)}>
      <div className="flex items-center gap-2 text-muted-foreground order-2 md:order-1">
        <span>
          {isEmpty ? (
            "Mostrando 0 de 0 deudores"
          ) : (
            <>
              Mostrando <strong className="text-foreground">{from}</strong> a <strong className="text-foreground">{to}</strong> de{" "}
              <strong className="text-foreground">{total}</strong> deudores
            </>
          )}
        </span>
        {onPageSizeChange && (
          <div className="flex items-center gap-1.5 ml-4">
            <span className="hidden sm:inline text-xs">Por página:</span>
            <Select
              disabled={isPending || isEmpty}
              value={String(pageSize)}
              onValueChange={(val) => onPageSizeChange(Number(val))}
            >
              <SelectTrigger className="h-8 w-16">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="20">20</SelectItem>
                <SelectItem value="50">50</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className={cn("order-1 md:order-2 transition-opacity", (isPending || isEmpty) && "opacity-60 pointer-events-none")}>
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (page > 1) onPageChange(page - 1);
                }}
                aria-disabled={page <= 1 || isEmpty}
                className={cn((page <= 1 || isEmpty) && "pointer-events-none opacity-40")}
              />
            </PaginationItem>

            {getPageNumbers().map((p, idx) =>
              p === "ellipsis" ? (
                <PaginationItem key={`ellipsis-${idx}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={p}>
                  <PaginationLink
                    href="#"
                    isActive={page === p}
                    onClick={(e) => {
                      e.preventDefault();
                      onPageChange(p);
                    }}
                  >
                    {p}
                  </PaginationLink>
                </PaginationItem>
              )
            )}

            <PaginationItem>
              <PaginationNext
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (page < totalPages) onPageChange(page + 1);
                }}
                aria-disabled={page >= totalPages || isEmpty}
                className={cn((page >= totalPages || isEmpty) && "pointer-events-none opacity-40")}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}
