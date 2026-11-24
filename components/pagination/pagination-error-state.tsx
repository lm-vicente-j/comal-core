"use client";

import type { PaginationError } from "@/lib/pagination";
import { Button } from "@/components/ui/button";

const messages: Record<PaginationError, string> = {
    UNAUTHENTICATED: "Tu sesión terminó. Inicia sesión para consultar los registros.",
    FORBIDDEN: "No tienes permiso para consultar estos registros.",
    INVALID_INPUT: "Revisa los filtros y las opciones de la lista.",
    QUERY_FAILED: "No se pudieron cargar los registros. Intenta de nuevo.",
};

export function PaginationErrorState({ error, onRetry }: { error?: PaginationError; onRetry: () => void }) {
    if (!error) return null;
    return <div role="alert" className="rounded-md border p-4 space-y-3"><p>{messages[error]}</p><Button type="button" variant="outline" onClick={onRetry}>Reintentar</Button></div>;
}
