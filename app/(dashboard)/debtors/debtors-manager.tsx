"use client";

import { useState, useEffect, useTransition, useRef, useCallback } from "react";
import { DebtorListItem, getAllDebtors, getDebtsSummary } from "@/lib/actions/debts";
import { PaginatedResult } from "@/components/pagination";
import DebtorsTable from "./debts-table";

interface DebtorsManagerProps {
  initialDebtors: PaginatedResult<DebtorListItem>;
  initialSummary: { totalAmount: number; activeDebtors: number; todayPayments: number };
  jornadaOpen: boolean;
}

export default function DebtorsManager({
  initialDebtors,
  initialSummary,
  jornadaOpen,
}: DebtorsManagerProps) {
  const [data, setData] = useState<PaginatedResult<DebtorListItem>>(initialDebtors);
  const [summary, setSummary] = useState(initialSummary);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [pageSize, setPageSize] = useState(initialDebtors.pageSize || 10);
  const [isPending, startTransition] = useTransition();

  // 1. Real 300 ms debounce for the search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // 2. Unified concurrency control for pagination, search, and payments
  const latestRequestId = useRef(0);

  const fetchPage = useCallback((page: number, currentSize: number, currentSearch: string) => {
    const requestId = ++latestRequestId.current;
    startTransition(async () => {
      const res = await getAllDebtors({ page, pageSize: currentSize, search: currentSearch });
      if (requestId === latestRequestId.current) {
        startTransition(() => {
          setData(res);
        });
      }
    });
  }, []);

  // Fetch after debounce settles or when page size changes
  const isFirstMount = useRef(true);
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    fetchPage(1, pageSize, debouncedSearch);
  }, [debouncedSearch, pageSize, fetchPage]);

  // 3. Reactive refresh after payment using the same concurrency control
  const handlePaymentSuccess = useCallback(async () => {
    const requestId = ++latestRequestId.current;
    startTransition(async () => {
      const [newDebtors, newSummary] = await Promise.all([
        getAllDebtors({ page: data.page, pageSize, search: debouncedSearch }),
        getDebtsSummary(),
      ]);
      if (requestId === latestRequestId.current) {
        startTransition(() => {
          setData(newDebtors);
          setSummary(newSummary);
        });
      }
    });
  }, [data.page, pageSize, debouncedSearch]);

  return (
    <div className="flex flex-col z-0 w-full h-full gap-4 p-4">
      {/* Synchronized top summary */}
      <div className="grid grid-cols-3 divide-x rounded-md border bg-white shrink-0">
        <div className="flex flex-col items-center justify-center text-center px-2 py-4">
          <p className="text-muted-foreground text-xs md:text-sm">Total por cobrar</p>
          <p className="text-lg md:text-2xl font-bold text-red-600">${summary.totalAmount.toFixed(2)}</p>
        </div>
        <div className="flex flex-col items-center justify-center text-center px-2 py-4">
          <p className="text-muted-foreground text-xs md:text-sm">Deudores activos</p>
          <p className="text-lg md:text-2xl font-bold">{summary.activeDebtors}</p>
        </div>
        <div className="flex flex-col items-center justify-center text-center px-2 py-4">
          <p className="text-muted-foreground text-xs md:text-sm">Cobros del día</p>
          <p className="text-lg md:text-2xl font-bold text-green-600">${summary.todayPayments.toFixed(2)}</p>
        </div>
      </div>

      {/* Table with pagination and dynamic search */}
      <div className="flex-1 min-h-0 w-full">
        <DebtorsTable
          data={data}
          jornadaOpen={jornadaOpen}
          isPending={isPending}
          search={search}
          onSearchChange={setSearch}
          onPageChange={(p) => fetchPage(p, pageSize, debouncedSearch)}
          onPageSizeChange={setPageSize}
          onPaymentSuccess={handlePaymentSuccess}
        />
      </div>
    </div>
  );
}
