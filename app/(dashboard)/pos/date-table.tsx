"use client";
import { usePermission } from "@/components/auth/permission-provider";
import { formatCents } from "@/lib/scaled-values";

import { Input } from "@/components/ui/input";
import { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Product } from "@/lib/actions/schemas";

interface DataTableProps {
  data: Product[];
  // The parent owns the queued tap (optimistic add + sequential createSale);
  // this grid is presentational. coolingDownIds disables only the specific
  // product button that reached 3 consecutive taps for 1 second.
  onProductTap: (product: Product) => void;
  pendingId?: number | null;
  coolingDownIds?: ReadonlySet<number>;
}

export default function DataTable({ data = [], onProductTap, pendingId = null, coolingDownIds }: DataTableProps) {

  const canSell = usePermission("sales.create");
  const [query, setQuery] = useState("");
  const productsList = data ?? [];
  const searchLower = query.trim().toLowerCase();
  const dataProducts = productsList.filter((p) => (p.name ?? "").toLowerCase().includes(searchLower));

  function setFilterData(query: string) {
    setQuery(query);
  }

  return (
    <div className="w-full lg:h-full lg:mx-10">

      <div className="flex w-full items-center pt-2 pb-4 lg:pt-4">
        <Input
          placeholder="Buscar productos"
          value={query}
          disabled={productsList.length === 0}
          className="max-w-md"
          onChange={(e) => setFilterData(e.currentTarget.value)}
        />
      </div>

      {/* Desktop (lg+): product grid */}
      <ScrollArea className="hidden lg:grid h-[65%] w-full rounded-md border p-4">
        {dataProducts.length === 0 ? (
          <p role="status" aria-live="polite" className="py-8 text-center text-sm text-muted-foreground">
            {productsList.length === 0 ? "No se encontraron productos registrados" : "No hay productos."}
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-4">
            {dataProducts.map((val: Product) => {
              const isCoolingDown = (pendingId !== null && pendingId === val.id) || coolingDownIds?.has(val.id ?? -1) === true;
              return (
                <Button
                  onClick={() => onProductTap(val)}
                  disabled={!canSell || isCoolingDown}
                  variant="outline"
                  key={val.id}
                  className={`cursor-pointer w-full min-h-28 h-auto p-2 flex flex-col items-center justify-between gap-1 whitespace-normal text-wrap transition-colors active:bg-gray-300 ${isCoolingDown ? "bg-gray-300" : ""}`}
                >
                  <div className="w-full flex-1 flex items-center justify-center text-center">
                    <p className="line-clamp-3 text-xs font-medium break-words whitespace-normal text-wrap leading-tight">{val.name}</p>
                  </div>
                  <Badge className="shrink-0 text-xs px-1.5 py-0.5">${formatCents(Number(val.price))}</Badge>
                </Button>
              );
            })}
          </div>
        )}
      </ScrollArea>

      {/* Mobile (< lg): vertical list, same card style as the other mobile
          modules. Plain overflow-y-auto instead of ScrollArea: Radix wraps
          content in a display:table div sized to the intrinsic content
          width, which defeats truncation and cut the price badges off on
          narrow screens with long product names. */}
      <div className="lg:hidden h-[45vh] w-full overflow-y-auto rounded-md border p-2">
        <div className="flex flex-col gap-2">
          {dataProducts.map((val: Product) => {
            const isCoolingDown = (pendingId !== null && pendingId === val.id) || coolingDownIds?.has(val.id ?? -1) === true;
            return (
              <button
                type="button"
                onClick={() => onProductTap(val)}
                disabled={!canSell || isCoolingDown}
                key={val.id}
                className={`w-full p-3 rounded-xl shadow-sm border flex justify-between items-center gap-2 text-left transition-colors active:bg-gray-300 ${isCoolingDown ? "bg-gray-300 opacity-50" : "bg-white"}`}
              >
                <p className="min-w-0 flex-1 font-medium text-gray-800 break-words line-clamp-2">{val.name}</p>
                <Badge className="shrink-0 text-xs px-2 py-0.5">${formatCents(Number(val.price))}</Badge>
              </button>
            );
          })}
          {dataProducts.length === 0 && (
            <p role="status" aria-live="polite" className="text-sm text-center text-muted-foreground py-8">
              {productsList.length === 0 ? "No se encontraron productos registrados" : "No hay productos."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
