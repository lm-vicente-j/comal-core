"use client";

import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AnalyticsPeriodFilter } from "@/components/analytics-period-filter";
import { DataPagination, PaginationErrorState, usePaginationState, usePaginatedResource, preparePaginationNavigation } from "@/components/pagination";
import { getStatistics, getReport } from "@/lib/actions/analytics";
import { getAutoRefreshTick, subscribeAutoRefresh } from "@/components/layout/auto-refresh";
import type { PaginationOptions } from "@/lib/pagination";
import {
    businessDateTimeLabel, calendarDateLabel, money, defaultAnalyticsFilter,
    type AmountGroup, type AnalyticsResult, type Comparison,
    type ProductMetric, type StatisticsData, type PaginatedReportData,
} from "@/lib/analytics";

const number = (value: number) => new Intl.NumberFormat("es-MX", { maximumFractionDigits: 2 }).format(value);
const percent = (value: number) => new Intl.NumberFormat("es-MX", { maximumFractionDigits: 1 }).format(value) + "%";

export default function StatisticsManager() {
    const { query, setFilters, setPage, setPageSize, replacePage } = usePaginationState({filterKeys:["from", "to"]});
    const fields = query.filters as Record<string, string> | undefined;
    const defaults = defaultAnalyticsFilter();
    const filter = {from: fields?.from ?? defaults.from, to: fields?.to ?? defaults.to};
    const [loaded, setLoaded] = useState<{key:string; requestKey:string; result: AnalyticsResult<StatisticsData>} | null>(null);
    const [retry, setRetry] = useState(0);
    const tick = useSyncExternalStore(subscribeAutoRefresh, getAutoRefreshTick, getAutoRefreshTick);
    const filterKey = JSON.stringify([filter.from, filter.to]);
    const requestKey = JSON.stringify([filterKey, retry, tick]);
    const result = loaded?.key === filterKey ? loaded.result : null;
    const pending = loaded?.requestKey !== requestKey;
    useEffect(() => {
        let current = true;
        getStatistics({from: filter.from, to: filter.to}).then(value => { if (current) setLoaded({key: filterKey, requestKey, result: value}); }).catch(() => { if (current) setLoaded({key:filterKey, requestKey, result:{success:false,error:"QUERY_FAILED",message:"No se pudo consultar la información. Intenta de nuevo."}}); });
        return () => { current = false; };
    }, [filter.from, filter.to, filterKey, requestKey]);
    const load = useCallback((q: PaginationOptions) => {
        const filters = q.filters as Record<string, string> | undefined;
        const fallback = defaultAnalyticsFilter();
        return getReport({...q, filters:{from:filters?.from ?? fallback.from, to:filters?.to ?? fallback.to, type:"customers"}});
    }, []);
    const customers = usePaginatedResource(load, query, {onPageClamp:replacePage});
    const reportLink = (type: string) => () => preparePaginationNavigation("/admin/reports", {page:1, pageSize:10, filters:{...filter, type}});
    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-bold">Estadísticas</h1>
                    <p className="text-sm text-muted-foreground mt-1">Ventas pagadas y registros del negocio para apoyar tus decisiones comerciales.</p>
                </div>
                <Button asChild variant="outline" className="min-h-10">
                    <Link href="/admin/reports" onClick={reportLink("sales")}>Ver reportes</Link>
                </Button>
            </div>

            <AnalyticsPeriodFilter filter={filter} pending={pending} onApply={setFilters} />

            {result && !result.success ? (
                <Card className="p-4 md:p-6 gap-3" role="alert">
                    <h2 className="font-semibold">No se pudieron cargar las estadísticas</h2>
                    <p className="text-sm">{result.message}</p>
                    <div>
                        <Button disabled={pending} onClick={() => setRetry(value => value + 1)} className="min-h-10">
                            {pending ? "Reintentando…" : "Reintentar"}
                        </Button>
                    </div>
                </Card>
            ) : result?.success ? (
                <StatisticsContent data={result.data} reportLink={reportLink} customers={customers.data} customerError={customers.error} customerPending={customers.isPending} onRetry={customers.refresh} onPage={setPage} onPageSize={setPageSize} />
            ) : <p role="status">Cargando estadísticas…</p>}

            <section className="rounded-xl border bg-card p-4 md:p-5 space-y-1" aria-label="Estado de predicción">
                <h2 className="text-sm font-semibold">Predicción pendiente de historial</h2>
                <p className="text-sm text-muted-foreground">Esta beta muestra estadísticas descriptivas y reportes. El modelo de predicción estará pendiente hasta contar con historial suficiente.</p>
            </section>
        </div>
    );
}

function StatisticsContent({ data, reportLink, customers, customerError, customerPending, onRetry, onPage, onPageSize }: { data: StatisticsData; reportLink: (type:string) => () => void; customers?: PaginatedReportData; customerError?: "UNAUTHENTICATED" | "FORBIDDEN" | "INVALID_INPUT" | "QUERY_FAILED"; customerPending: boolean; onRetry: () => void; onPage: (n:number) => void; onPageSize: (n:number) => void }) {
    const previous = calendarDateLabel(data.period.previousFrom) + " al " + calendarDateLabel(data.period.previousTo);
    return (
        <>
            <div className="space-y-2">
                <p className="text-sm font-medium">
                    {calendarDateLabel(data.period.from)} al {calendarDateLabel(data.period.to)}
                </p>
                <p className="text-sm text-muted-foreground max-w-prose">
                    Solo ventas pagadas. Se atribuyen a su fecha de registro y reflejan su estado actual; no existe una fecha general de cobro.
                </p>
                {data.period.includesToday && (
                    <p role="status" className="text-sm font-medium text-amber-800 bg-amber-50 rounded-md px-3 py-2">
                        El periodo incluye el día en curso. Sus resultados todavía están incompletos.
                    </p>
                )}
                {data.notices.map((notice, index) => <p key={index} className="text-sm text-muted-foreground">{notice}</p>)}
                <p className="text-xs text-muted-foreground">
                    Actualizado: <time dateTime={data.generatedAt}>{businessDateTimeLabel(data.generatedAt)}</time>
                </p>
            </div>

            <Card className="p-4 md:p-6 gap-4">
                <dl className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-5">
                    <Metric title="Ventas pagadas" value={money(data.paidAmount)}>
                        <ComparisonText comparison={data.amountComparison} monetary />
                        {data.paidRecords === 0 && <span>Sin ventas pagadas en este periodo.</span>}
                    </Metric>
                    <Metric title="Unidades vendidas" value={number(data.units)}>
                        <ComparisonText comparison={data.unitsComparison} />
                    </Metric>
                    <Metric title="Egresos registrados" value={money(data.expensesAmount)}>
                        <span>{number(data.expensesCount)} registros. Se presentan por separado.</span>
                    </Metric>
                    <Metric title="Salarios registrados" value={money(data.salariesAmount)}>
                        <span>{number(data.salariesCount)} pagos. Se presentan por separado.</span>
                    </Metric>
                </dl>
                <p className="text-xs text-muted-foreground border-t pt-3">Comparación de ventas y unidades con el periodo anterior: {previous}.</p>
            </Card>

            <GroupSection title="Evolución diaria" groups={data.daily} dateLabels
                description="Importe y unidades de ventas pagadas por fecha de registro." empty="Sin ventas pagadas para mostrar la evolución diaria."
                href={reportLink("sales")} />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <ProductRanking title="Productos principales por importe" products={data.products} order="amount" href={reportLink("products")} />
                <ProductRanking title="Productos principales por unidades" products={data.products} order="units" href={reportLink("products")} />
                <GroupSection title="Actividad por hora" groups={data.hourly} description="Hora de registro en America/Mexico_City."
                    empty="Sin ventas pagadas para mostrar la actividad por hora." href={reportLink("sales")} />
                <GroupSection title="Actividad por día de la semana" groups={data.weekdays} description="Importe y unidades acumulados del periodo."
                    empty="Sin ventas pagadas para mostrar la actividad por día." href={reportLink("sales")} />
                <GroupSection title="Formas de pago" groups={data.paymentMethods} empty="Sin ventas pagadas para mostrar formas de pago." href={reportLink("sales")} />
                <GroupSection title="Tipos de venta" groups={data.sourceTypes} empty="Sin ventas pagadas para mostrar tipos de venta." href={reportLink("sales")} />
                <GroupSection title="Egresos por categoría" groups={data.expenses} description="Según la fecha calendario registrada. No calcula utilidad."
                    empty="Sin egresos registrados en este periodo." href={reportLink("expenses")} showUnits={false} />
                <GroupSection title="Salarios por empleado" groups={data.salaries} description="Según la fecha calendario de pago."
                    empty="Sin salarios registrados en este periodo." href={reportLink("salaries")} showUnits={false} />
            </div>

            <CustomersSection customers={customers} error={customerError} pending={customerPending} onRetry={onRetry} onPage={onPage} onPageSize={onPageSize} count={customers?.total ?? data.identifiedCustomers} href={reportLink("customers")} />
        </>
    );
}

function Metric({ title, value, children }: { title: string; value: string; children: ReactNode }) {
    return (
        <div className="min-w-0 space-y-1">
            <dt className="text-sm font-medium text-muted-foreground">{title}</dt>
            <dd className="text-2xl font-bold tabular-nums break-words">{value}</dd>
            <dd className="flex flex-col gap-1 text-xs text-muted-foreground">{children}</dd>
        </div>
    );
}

function ComparisonText({ comparison, monetary = false }: { comparison: Comparison; monetary?: boolean }) {
    const difference = (comparison.difference > 0 ? "+" : "") + (monetary ? money(comparison.difference) : number(comparison.difference));
    return <span>{difference} frente al anterior · {comparison.percentage === null ? "Sin base de comparación" : (comparison.percentage > 0 ? "+" : "") + percent(comparison.percentage)}</span>;
}

function SectionHeader({ title, description, href }: { title: string; description?: string; href: () => void }) {
    return (
        <div className="flex flex-wrap justify-between items-start gap-2">
            <div className="min-w-0">
                <h2 className="text-lg font-semibold">{title}</h2>
                {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
            </div>
            <Link href="/admin/reports" onClick={href} aria-label={"Ver reporte: " + title} className="text-sm font-medium underline underline-offset-4 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">Ver reporte</Link>
        </div>
    );
}

function GroupSection({ title, groups, description, empty, href, dateLabels = false, showUnits = true }: {
    title: string; groups: AmountGroup[]; description?: string; empty: string; href: () => void; dateLabels?: boolean; showUnits?: boolean;
}) {
    const populated = groups.some(group => group.records > 0 || group.amount !== 0 || group.units !== 0);
    const maximum = Math.max(...groups.map(group => Math.abs(group.amount)), 0);
    return (
        <Card className="p-4 md:p-6 gap-4 min-w-0">
            <SectionHeader title={title} description={description} href={href} />
            {!populated ? <p className="text-sm text-muted-foreground">{empty}</p> : (
                <dl className="space-y-3 max-h-96 overflow-y-auto pr-1" aria-label={title}>
                    {groups.map((group, index) => (
                        <div key={group.label + index} className="space-y-1">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
                                <dt className="font-medium break-words min-w-0">{dateLabels && /^\d{4}-\d{2}-\d{2}$/.test(group.label) ? calendarDateLabel(group.label) : group.label}</dt>
                                <dd className="tabular-nums">{money(group.amount)}</dd>
                            </div>
                            <dd className="text-xs text-muted-foreground tabular-nums">
                                {showUnits ? number(group.units) + " unidades · " : ""}{number(group.records)} registros
                            </dd>
                            <dd aria-hidden="true" className="h-1.5 bg-muted rounded-sm overflow-hidden">
                                <div className="h-full bg-primary rounded-sm" style={{ width: (maximum === 0 ? 0 : Math.abs(group.amount) / maximum * 100) + "%" }} />
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
        </Card>
    );
}

function ProductRanking({ title, products, order, href }: { title: string; products: ProductMetric[]; order: "amount" | "units"; href: () => void }) {
    const ranked = [...products].sort((left, right) => right[order] - left[order] || left.id - right.id).slice(0, 10);
    return (
        <Card className="p-4 md:p-6 gap-4 min-w-0">
            <SectionHeader title={title} description="Hasta 10 productos. Importes calculados con subtotales históricos." href={href} />
            {ranked.length === 0 ? <p className="text-sm text-muted-foreground">Sin productos en ventas pagadas para este periodo.</p> : (
                <ol className="divide-y">
                    {ranked.map(product => (
                        <li key={product.id} className="py-2.5 flex flex-wrap justify-between gap-x-3 gap-y-1 text-sm">
                            <span className="font-medium break-words min-w-0">{product.name}</span>
                            <span className="tabular-nums shrink-0">{order === "amount" ? money(product.amount) : number(product.units) + " unidades"}</span>
                            <span className="w-full text-xs text-muted-foreground tabular-nums">
                                {order === "amount" ? number(product.units) + " unidades" : money(product.amount)} · {percent(product.participation)} de las ventas
                            </span>
                        </li>
                    ))}
                </ol>
            )}
        </Card>
    );
}

function CustomersSection({ customers, error, pending, onRetry, onPage, onPageSize, count, href }: { customers?: PaginatedReportData; error?: "UNAUTHENTICATED" | "FORBIDDEN" | "INVALID_INPUT" | "QUERY_FAILED"; pending:boolean; onRetry:()=>void; onPage:(n:number)=>void; onPageSize:(n:number)=>void; count:number; href:()=>void }) {
    return (
        <Card className="p-4 md:p-6 gap-4 min-w-0">
            <SectionHeader title="Clientes identificados" description={number(count) + " clientes con ventas pagadas. Los días cuentan fechas distintas con compras registradas."} href={href} />
            {error ? <PaginationErrorState error={error} onRetry={onRetry} /> : !customers ? <p role="status">Cargando clientes…</p> : customers.total === 0 ? <p className="text-sm text-muted-foreground">Sin clientes identificados con ventas pagadas en este periodo.</p> : <>
                <Table><TableHeader><TableRow><TableHead scope="col">Cliente</TableHead><TableHead scope="col" className="text-right">Importe pagado</TableHead><TableHead scope="col" className="text-right">Unidades</TableHead><TableHead scope="col" className="text-right">Días con compras</TableHead></TableRow></TableHeader>
                    <TableBody>{customers.items.map(customer => <TableRow key={String(customer.id)}><TableCell className="whitespace-normal min-w-32 break-words">{customer.name}</TableCell><TableCell className="text-right tabular-nums">{money(Number(customer.amount))}</TableCell><TableCell className="text-right tabular-nums">{number(Number(customer.units))}</TableCell><TableCell className="text-right tabular-nums">{number(Number(customer.days))}</TableCell></TableRow>)}</TableBody>
                </Table>
                <DataPagination {...customers} onPageChange={onPage} onPageSizeChange={onPageSize} isPending={pending} />
            </>}
        </Card>
    );
}
