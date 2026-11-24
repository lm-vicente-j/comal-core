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
import { PAGE_SIZE_OPTIONS } from "@/lib/pagination";
import { MobilePagination } from "./mobile-pagination";

interface DataPaginationProps {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  isPending?: boolean;
  totalLabel?: string;
  className?: string;
  mode?: "desktop" | "mobile" | "responsive";
  getPageHref?: (page: number) => string;
}

export function DataPagination({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
  isPending = false,
  totalLabel = "registros",
  className,
  mode = "responsive",
  getPageHref,
}: DataPaginationProps) {
  const isEmpty = total === 0 || totalPages === 0;
  const safePage = Math.max(1, page);
  const rawFrom = isEmpty ? 0 : (safePage - 1) * pageSize + 1;
  const to = isEmpty ? 0 : Math.min(safePage * pageSize, total);
  const from = Math.min(rawFrom, to);
  const navigate = (target: number) => {
    if (!isPending && !isEmpty && target >= 1 && target <= totalPages && target !== page) onPageChange(target);
  };
  const sizeSelector = onPageSizeChange && (
    <div className="flex items-center gap-1.5">
      <span className="text-xs">Por página:</span>
      <Select disabled={isPending} value={String(pageSize)} onValueChange={value => onPageSizeChange(Number(value))}>
        <SelectTrigger className="h-8 w-16" aria-label="Registros por página"><SelectValue /></SelectTrigger>
        <SelectContent>{PAGE_SIZE_OPTIONS.map(size => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );

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
    <div className={className} aria-busy={isPending}>
    {mode !== "desktop" && <div className={cn("space-y-2 border-t bg-white p-2 text-sm", mode === "responsive" && "md:hidden")}>
      <div className="flex items-center justify-between gap-2 text-muted-foreground"><span>{isEmpty ? `0 ${totalLabel}` : `${from}–${to} de ${total} ${totalLabel}`}</span>{sizeSelector}</div>
      <MobilePagination page={safePage} totalPages={totalPages} total={total} onPageChange={navigate} isPending={isPending} label={`Paginación de ${totalLabel}`} />
    </div>}
    {mode !== "mobile" && <div className={cn("flex items-center justify-between gap-4 py-3 px-2 text-sm", mode === "responsive" && "hidden md:flex")}>
      <div className="flex items-center gap-2 text-muted-foreground order-2 md:order-1">
        <span>
          {isEmpty ? (
            `Mostrando 0 de 0 ${totalLabel}`
          ) : (
            <>
              Mostrando <strong className="text-foreground">{from}</strong> a <strong className="text-foreground">{to}</strong> de{" "}
              <strong className="text-foreground">{total}</strong> {totalLabel}
            </>
          )}
        </span>
        {sizeSelector}
      </div>

      <div className={cn("order-1 md:order-2 transition-opacity", (isPending || isEmpty) && "opacity-60 pointer-events-none")}>
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href={getPageHref?.(Math.max(1, page - 1)) ?? "#"}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(page - 1);
                }}
                aria-disabled={isPending || page <= 1 || isEmpty}
                tabIndex={isPending || page <= 1 || isEmpty ? -1 : 0}
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
                    href={getPageHref?.(p) ?? "#"}
                    isActive={page === p}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(p);
                    }}
                    aria-disabled={isPending}
                    tabIndex={isPending ? -1 : 0}
                  >
                    {p}
                  </PaginationLink>
                </PaginationItem>
              )
            )}

            <PaginationItem>
              <PaginationNext
                href={getPageHref?.(Math.min(totalPages, page + 1)) ?? "#"}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(page + 1);
                }}
                aria-disabled={isPending || page >= totalPages || isEmpty}
                tabIndex={isPending || page >= totalPages || isEmpty ? -1 : 0}
                className={cn((page >= totalPages || isEmpty) && "pointer-events-none opacity-40")}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>}
    </div>
  );
}
