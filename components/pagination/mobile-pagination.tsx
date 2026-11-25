"use client";

import { useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface MobilePaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  total?: number;
  isPending?: boolean;
  label?: string;
  className?: string;
  pageSizeSelector?: ReactNode;
  onFocusFallback?: () => void;
}

const MAX_GRID_PAGES = 200;

function parseStrictPageInput(raw: string, maxPage: number): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxPage) return null;
  return parsed;
}

/**
 * Compact 3-button mobile pagination control (previous, current-page selector,
 * next) designed to stay pinned above the mobile navigation bar while scrolling.
 */
export function MobilePagination({
  page,
  totalPages,
  onPageChange,
  total,
  isPending = false,
  label = "Paginación",
  className,
  pageSizeSelector,
  onFocusFallback,
}: MobilePaginationProps) {
  const selectorTrigger = useRef<HTMLButtonElement>(null);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [jumpInput, setJumpInput] = useState("");

  const normalizedTotalPages = Number.isFinite(totalPages) ? Math.trunc(totalPages) : 1;
  const normalizedPage = Number.isFinite(page) ? Math.trunc(page) : 1;
  const safeTotalPages = Math.max(1, normalizedTotalPages);

  if (safeTotalPages <= 1 && normalizedPage <= 1) {
    return null;
  }

  const displayTotalPages = Math.max(safeTotalPages, normalizedPage);
  const displayPage = Math.max(1, normalizedPage);

  const goToPage = (target: number) => {
    const clamped = Math.min(Math.max(1, Math.trunc(target)), displayTotalPages);
    setSelectorOpen(false);
    if (clamped !== displayPage) {
      onPageChange(clamped);
    }
  };

  const handleOpenSelector = () => {
    setJumpInput(String(displayPage));
    setSelectorOpen(true);
  };

  const parsedJump = parseStrictPageInput(jumpInput, displayTotalPages);
  const jumpValid = parsedJump !== null;

  const handleJumpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (parsedJump !== null) {
      goToPage(parsedJump);
    }
  };

  const pageNumbers = (() => {
    if (displayTotalPages <= MAX_GRID_PAGES) {
      return Array.from({ length: displayTotalPages }, (_, index) => index + 1);
    }
    const half = Math.floor(MAX_GRID_PAGES / 2);
    const start = Math.max(1, Math.min(displayPage - half, displayTotalPages - MAX_GRID_PAGES + 1));
    return Array.from({ length: MAX_GRID_PAGES }, (_, index) => start + index);
  })();

  return (
    <>
      <nav
        aria-label={label}
        className={cn(
          "flex items-center justify-between gap-2 border-t border-border bg-white/95 px-3 py-2 font-rounded backdrop-blur-sm shadow-[0_-2px_8px_rgba(0,0,0,0.05)]",
          className
        )}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isPending || displayPage <= 1}
          onClick={() => onPageChange(displayPage - 1)}
          aria-label="Página anterior"
          className="h-9 min-w-11 px-3 cursor-pointer"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>

        <Button
          ref={selectorTrigger}
          type="button"
          variant="outline"
          size="sm"
          disabled={isPending}
          onClick={handleOpenSelector}
          aria-label={`Seleccionar página, página actual ${displayPage} de ${displayTotalPages}`}
          className="h-9 flex-1 max-w-48 justify-center gap-1.5 font-medium tabular-nums cursor-pointer"
        >
          <span className="truncate">
            Página {displayPage} de {displayTotalPages}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Button>

        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isPending || displayPage >= displayTotalPages}
          onClick={() => onPageChange(displayPage + 1)}
          aria-label="Página siguiente"
          className="h-9 min-w-11 px-3 cursor-pointer"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </nav>

      <Dialog open={selectorOpen} onOpenChange={setSelectorOpen}>
        <DialogContent
          data-pagination-dialog
          className="max-h-[calc(100dvh-1rem)] w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-2xl p-4 sm:p-5"
          onCloseAutoFocus={event => {
            event.preventDefault();
            const trigger = selectorTrigger.current;
            if (trigger && !trigger.disabled && trigger.getClientRects().length > 0) {
              trigger.focus({ preventScroll: true });
            } else {
              onFocusFallback?.();
            }
          }}
        >
          <DialogHeader className="text-left">
            <DialogTitle>Ir a página</DialogTitle>
            <DialogDescription className="tabular-nums">
              Página {displayPage} de {displayTotalPages}
              {total !== undefined ? ` · ${total} registros` : ""}
            </DialogDescription>
          </DialogHeader>

          {pageSizeSelector}

          {displayTotalPages > 12 && (
            <form onSubmit={handleJumpSubmit} className="flex items-center gap-2">
              <Input
                type="text"
                inputMode="numeric"
                value={jumpInput}
                onChange={(e) => setJumpInput(e.target.value)}
                aria-label="Número de página"
                placeholder={`1–${displayTotalPages}`}
                className="h-9 tabular-nums"
              />
              <Button type="submit" size="sm" disabled={!jumpValid} className="h-9 shrink-0 cursor-pointer">
                Ir
              </Button>
            </form>
          )}

          <ul
            aria-label="Páginas disponibles"
            className="always-visible-scrollbar grid max-h-[min(45dvh,15rem)] grid-cols-4 gap-2 p-0.5 pr-1.5 sm:grid-cols-5"
          >
            {pageNumbers.map((pageNumber) => {
              const isCurrent = pageNumber === displayPage;
              return (
                <li key={pageNumber}>
                  <Button
                    type="button"
                    variant={isCurrent ? "default" : "outline"}
                    size="sm"
                    aria-current={isCurrent ? "page" : undefined}
                    onClick={() => goToPage(pageNumber)}
                    className="h-10 w-full tabular-nums cursor-pointer"
                  >
                    {pageNumber}
                  </Button>
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
