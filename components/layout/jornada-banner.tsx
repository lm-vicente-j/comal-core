
import { formatCurrencyCents } from "@/lib/scaled-values";
import Link from 'next/link';
import { AlertTriangle, AlertCircle, CalendarDays } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuLabel } from '@radix-ui/react-dropdown-menu';
import { getActiveJornadaWithStats, hasOpenJornada } from '@/lib/actions/jornada';
import { auth } from '@/lib/auth';


export default async function JornadaBanner({ role, mobile = false }: { role?: string; mobile?: boolean } = {}) {
    const userRole = role ?? (await auth())?.user?.role;
    if (!userRole) return null;

    // Opening/closing jornadas is ADMIN-only (server actions and the
    // /admin/jornada route already enforce it). STAFF only gets an
    // informative notice while sales are blocked — and no banner at all,
    // cash expectations included, while a jornada is open.
    if (userRole !== "ADMIN") {
        const open = await hasOpenJornada();
        if (mobile) {
            return (
                <DropdownMenuLabel className="flex items-start gap-3 px-2 py-2 text-sm text-gray-700">
                    <CalendarDays aria-hidden="true" className="m-1 size-4 shrink-0" />
                    <span>
                        {open ? "Jornada activa" : "Sin jornada activa"}
                        {!open && <span className="block text-xs text-red-800">Solicita a un administrador abrirla.</span>}
                    </span>
                </DropdownMenuLabel>
            );
        }
        if (open) return null;

        return (
            <div className="bg-red-50 border-b border-red-200 px-3 py-1.5 sm:px-4 md:px-6 sm:py-2 flex items-center gap-2 text-xs sm:text-sm text-red-800">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span className="min-w-0 leading-tight sm:leading-normal">No hay jornada activa. Las ventas y gastos están bloqueados; solicite a un administrador abrirla.</span>
            </div>
        );
    }

    const data = await getActiveJornadaWithStats();
    if (!data) return null;

    if (mobile) {
        return (
            <DropdownMenuItem asChild className="flex min-h-10 cursor-pointer items-center gap-3 rounded-sm px-2 py-1.5 text-sm outline-0 data-highlighted:bg-gray-100">
                <Link href="/admin/jornada">
                    <CalendarDays aria-hidden="true" className="m-1 size-4 shrink-0" />
                    <span>
                        {data.state === "NO_JORNADA" ? "Abrir jornada" : `Jornada #${data.jornada.id}`}
                        {data.state === "OTHER_OPEN" && (
                            <span className="block text-xs text-amber-800">
                                {data.jornada.openedByUser?.name
                                    ? `De ${data.jornada.openedByUser.name} · pendiente`
                                    : "Pendiente de cerrar"}
                            </span>
                        )}
                        {data.state === "OWN_OPEN" && (
                            <span className="block text-xs text-emerald-700 tabular-nums">
                                Caja: {formatCurrencyCents(data.stats.expectedCash)}
                            </span>
                        )}
                    </span>
                </Link>
            </DropdownMenuItem>
        );
    }

    if (data.state === "NO_JORNADA") {
        return (
            <div className="bg-red-50 border-b border-red-200 px-3 py-1.5 sm:px-4 md:px-6 sm:py-2 flex items-center justify-between gap-2 text-xs sm:text-sm">
                <div className="flex items-center gap-1.5 sm:gap-2 text-red-800 min-w-0">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span className="leading-tight sm:leading-normal">No hay jornada activa. Las ventas y gastos están bloqueados.</span>
                </div>
                <Link href="/admin/jornada"
                      className="px-2.5 py-1 sm:px-3 bg-red-600 text-white rounded-md hover:bg-red-700 text-center shrink-0 whitespace-nowrap">
                    Abrir jornada
                </Link>
            </div>
        );
    }

    if (data.state === "OTHER_OPEN") {
        return (
            <div className="bg-amber-50 border-b border-amber-200 px-3 py-1.5 sm:px-4 md:px-6 sm:py-2 flex items-center justify-between gap-2 text-xs sm:text-sm">
                <div className="flex items-center gap-1.5 sm:gap-2 text-amber-800 min-w-0">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span className="leading-tight sm:leading-normal">
                        Jornada #{data.jornada.id} abierta por <strong>{data.jornada.openedByUser?.name}</strong> — pendiente de cerrar
                    </span>
                </div>
                <Link href="/admin/jornada"
                      className="px-2.5 py-1 sm:px-3 bg-amber-600 text-white rounded-md hover:bg-amber-700 text-center shrink-0 whitespace-nowrap">
                    Cerrar y abrir nueva
                </Link>
            </div>
        );
    }

    // OWN_OPEN: hidden on < lg so the mobile topbar user menu remains the single Jornada entry point.
    const { expectedCash, cashSales, debtCollectedCash, cashBills, cashSalaries } = data.stats;
    return (
        <div className="hidden lg:flex bg-emerald-50 border-b border-emerald-200 px-4 md:px-6 py-2 items-center justify-between gap-3 text-sm">
            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-4 text-emerald-900 min-w-0">
                <span className="font-medium shrink-0">Jornada #{data.jornada.id}</span>
                <span className='hidden sm:block'>
                    Esperado en caja: <strong>{formatCurrencyCents(expectedCash)}</strong>
                </span>
                <span className="hidden sm:block text-emerald-700/70  text-xs sm:text-sm">
                    Ventas efectivo: {formatCurrencyCents(cashSales)} · Cobros de fiado: {formatCurrencyCents(debtCollectedCash)} · Egresos: {formatCurrencyCents(BigInt(cashBills) + BigInt(cashSalaries))}
                </span>
            </div>
            <Link href="/admin/jornada"
                  className="px-3 py-1 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 text-center shrink-0 whitespace-nowrap">
                Ver detalles
            </Link>
        </div>
    );
}
