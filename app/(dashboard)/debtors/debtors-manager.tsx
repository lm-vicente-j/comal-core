"use client";
import { formatCents } from "@/lib/scaled-values";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { getAllDebtors } from "@/lib/actions/debts";
import { usePaginationState, usePaginatedResource, PaginationErrorState } from "@/components/pagination";
import { emptyPage } from "@/lib/pagination";
import DebtorsTable from "./debts-table";

interface DebtorsManagerProps {
  initialSummary: { totalAmount: number; activeDebtors: number; todayPayments: number };
  jornadaOpen: boolean;
}

export default function DebtorsManager({
  initialSummary,
  jornadaOpen,
}: DebtorsManagerProps) {
  const router = useRouter();
  const state = usePaginationState();
  const resource = usePaginatedResource(getAllDebtors, state.query, { onPageClamp: state.replacePage });
  const refresh = resource.refresh;
  const data = resource.data ?? emptyPage(state.query.pageSize);
  const summary = initialSummary;
  const handlePaymentSuccess = useCallback(() => {
    refresh();
    router.refresh();
  }, [refresh, router]);

  return (
    <div className="flex flex-col z-0 w-full flex-1 min-h-[22rem] md:min-h-0 h-full gap-2 p-2 md:gap-4 md:p-4 overflow-hidden">
      {/* Synchronized top summary */}
      <div className="grid grid-cols-3 divide-x rounded-md border bg-white shrink-0">
        <div className="flex flex-col items-center justify-center text-center px-2 py-2 md:py-4">
          <p className="text-muted-foreground text-xs md:text-sm">Total por cobrar</p>
          <p className="text-base md:text-2xl font-bold text-red-600">${formatCents(summary.totalAmount)}</p>
        </div>
        <div className="flex flex-col items-center justify-center text-center px-2 py-2 md:py-4">
          <p className="text-muted-foreground text-xs md:text-sm">Deudores activos</p>
          <p className="text-base md:text-2xl font-bold">{summary.activeDebtors}</p>
        </div>
        <div className="flex flex-col items-center justify-center text-center px-2 py-2 md:py-4">
          <p className="text-muted-foreground text-xs md:text-sm">Cobros del día</p>
          <p className="text-base md:text-2xl font-bold text-green-600">${formatCents(summary.todayPayments)}</p>
        </div>
      </div>

      {/* Table with pagination and dynamic search */}
      <div className="flex-1 min-h-0 w-full flex flex-col">
        <PaginationErrorState error={resource.error} onRetry={resource.refresh} />
        <DebtorsTable
          data={data}
          jornadaOpen={jornadaOpen}
          isPending={resource.isPending}
          error={resource.error}
          search={state.query.search ?? ""}
          onSearchChange={state.setSearch}
          onPageChange={state.setPage}
          onPageSizeChange={state.setPageSize}
          onPaymentSuccess={handlePaymentSuccess}
        />
      </div>
    </div>
  );
}
