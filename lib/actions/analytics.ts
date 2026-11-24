"use server";

import { toSafeInteger } from "@/lib/scaled-values";
import { Prisma } from "@/app/generated/prisma/client";
import { Decimal } from "@prisma/client/runtime/client";
import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { formatSourceType } from "@/lib/pos-source";
import {
    analyticsPeriod, businessDate, businessHour, calendarDays, calendarRange,
    paymentMethodLabel, saleOrigin, shiftCalendarDate, specified, timestampRange,
    type AmountGroup, type AnalyticsFilter, type AnalyticsResult, type Comparison,
    type CustomerMetric, type ProductMetric, type ReportColumn, type ReportData,
    type ReportRow, type ReportType, type StatisticsData, type PaginatedReportData,
} from "@/lib/analytics";
import { AnalyticsFilterSchema, AnalyticsReportSchema, ReportFilterSchema } from "./schemas";
import { actionFail, actionOk, type ActionResult } from "@/lib/action-result";
import { getPaginationMeta, getPaginationOffset } from "@/lib/pagination";

const saleSelect = {
    id: true, totalCents: true, source_type: true, payment_method: true, createdAt: true,
    customer: { select: { id: true, customerName: true } },
    users: { select: { name: true } },
    sale_items: { select: { productID: true, quantity: true, subtotalCents: true, products: { select: { name: true } } } },
} as const satisfies Prisma.salesSelect;
type PaidSale = Prisma.salesGetPayload<{ select: typeof saleSelect }>;
const expenseSelect = {
    id: true, amountCents: true, category: true, description: true, date: true,
    users: { select: { name: true } },
} as const satisfies Prisma.billSelect;
const salarySelect = {
    id: true, amountCents: true, payDate: true, period: true, userID: true,
    users: { select: { name: true } },
} as const satisfies Prisma.salarySelect;

const permissionError = {
    success: false, error: "PERMISSION_DENIED", message: "Solo los administradores pueden consultar estadísticas y reportes.",
} as const;
const filterError = {
    success: false, error: "INVALID_FILTER", message: "Revisa el tipo de reporte, las fechas y el número de página.",
} as const;
const queryError = {
    success: false, error: "QUERY_FAILED", message: "No se pudo consultar la información. Intenta de nuevo.",
} as const;
const saleNotice = "Las ventas corresponden a su fecha de registro y estado actual; no existe una fecha general de cobro.";

function decimalSum(values: Decimal[]): Decimal {
    return values.reduce((total, value) => total.plus(value), new Decimal(0));
}
function saleAmount(sale: PaidSale): Decimal | null {
    if (sale.totalCents !== null) return new Decimal(sale.totalCents.toString());
    return sale.sale_items.length ? decimalSum(sale.sale_items.map(item => new Decimal(item.subtotalCents.toString()))) : null;
}
function saleUnits(sale: PaidSale): number {
    return sale.sale_items.reduce((total, item) => total + item.quantity, 0);
}
function salesTotal(sales: PaidSale[]): Decimal {
    return decimalSum(sales.flatMap(sale => {
        const amount = saleAmount(sale);
        return amount === null ? [] : [amount];
    }));
}
function monetaryNotices(sales: PaidSale[], periodLabel = "del periodo"): string[] {
    const recovered = sales.filter(sale => sale.totalCents === null && sale.sale_items.length > 0).length;
    const missing = sales.filter(sale => sale.totalCents === null && sale.sale_items.length === 0).length;
    return [
        ...(recovered ? [`${recovered} ventas ${periodLabel} no tienen total guardado: su importe se obtuvo de los subtotales históricos.`] : []),
        ...(missing ? [`${missing} ventas ${periodLabel} no tienen total ni partidas: su importe es desconocido y se excluye de las sumas monetarias.`] : []),
    ];
}
function comparison(current: Decimal, previous: Decimal): Comparison {
    const difference = current.minus(previous);
    return {
        previous: toSafeInteger(previous.toFixed()), difference: toSafeInteger(difference.toFixed()),
        percentage: previous.isZero() ? null : difference.dividedBy(previous).times(100).toNumber(),
    };
}
type DecimalGroup = { label: string; amount: Decimal; units: number; records: number };
function emptyGroup(label: string): DecimalGroup {
    return { label, amount: new Decimal(0), units: 0, records: 0 };
}
function addGroup(groups: Map<string, DecimalGroup>, key: string, amount: Decimal | null, units = 0, label = key) {
    const group = groups.get(key) ?? emptyGroup(label);
    if (amount !== null) group.amount = group.amount.plus(amount);
    group.units += units;
    group.records++;
    groups.set(key, group);
}
function serializeGroups(groups: Map<string, DecimalGroup>, sortByAmount = false): AmountGroup[] {
    const rows = [...groups.values()];
    if (sortByAmount) rows.sort((a, b) => b.amount.comparedTo(a.amount) || a.label.localeCompare(b.label, "es"));
    return rows.map(group => ({ ...group, amount: toSafeInteger(group.amount.toFixed()) }));
}
function productMetrics(sales: PaidSale[], total: Decimal): ProductMetric[] {
    const products = new Map<number, { id: number; name: string; amount: Decimal; units: number }>();
    for (const sale of sales) for (const item of sale.sale_items) {
        const product = products.get(item.productID) ?? {
            id: item.productID, name: specified(item.products.name), amount: new Decimal(0), units: 0,
        };
        product.amount = product.amount.plus(new Decimal(item.subtotalCents.toString()));
        product.units += item.quantity;
        products.set(item.productID, product);
    }
    return [...products.values()]
        .sort((a, b) => b.amount.comparedTo(a.amount) || b.units - a.units || a.id - b.id)
        .map(product => ({
            ...product, amount: toSafeInteger(product.amount.toFixed()),
            participation: total.isZero() ? 0 : product.amount.dividedBy(total).times(100).toNumber(),
        }));
}
function customerMetrics(sales: PaidSale[]): CustomerMetric[] {
    const customers = new Map<number, { id: number; name: string; amount: Decimal; units: number; days: Set<string> }>();
    for (const sale of sales) {
        if (!sale.customer) continue;
        const customer = customers.get(sale.customer.id) ?? {
            id: sale.customer.id, name: specified(sale.customer.customerName), amount: new Decimal(0), units: 0, days: new Set<string>(),
        };
        const amount = saleAmount(sale);
        if (amount !== null) customer.amount = customer.amount.plus(amount);
        customer.units += saleUnits(sale);
        customer.days.add(businessDate(sale.createdAt));
        customers.set(sale.customer.id, customer);
    }
    return [...customers.values()]
        .sort((a, b) => b.amount.comparedTo(a.amount) || a.id - b.id)
        .map(customer => ({ ...customer, amount: toSafeInteger(customer.amount.toFixed()), days: customer.days.size }));
}
function missingDateNotice(count: number, subject: string): string[] {
    return count ? [`Hay ${count} ${subject} sin fecha registrada; se excluyen de los resultados por periodo.`] : [];
}
function orderedSales(tx: Prisma.TransactionClient, filter: AnalyticsFilter) {
    return tx.sales.findMany({
        where: { status: "PAID", createdAt: timestampRange(filter) }, select: saleSelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
}

export async function getStatistics(input: unknown): Promise<AnalyticsResult<StatisticsData>> {
    try {
        if ((await auth())?.user?.role !== "ADMIN") return permissionError;
        const parsed = AnalyticsFilterSchema.safeParse(input);
        if (!parsed.success) return filterError;
        const period = analyticsPeriod(parsed.data);
        const previousFilter = { from: period.previousFrom, to: period.previousTo };
        const [sales, previousSales, expenses, salaries, undatedExpenses, undatedSalaries] = await prisma.$transaction(async tx => Promise.all([
            orderedSales(tx, parsed.data), orderedSales(tx, previousFilter),
            tx.bill.findMany({ where: { date: calendarRange(parsed.data) }, select: expenseSelect }),
            tx.salary.findMany({ where: { payDate: calendarRange(parsed.data) }, select: salarySelect }),
            tx.bill.count({ where: { date: null } }), tx.salary.count({ where: { payDate: null } }),
        ]), { isolationLevel: "RepeatableRead", timeout: 30_000 });

        const total = salesTotal(sales);
        const units = sales.reduce((sum, sale) => sum + saleUnits(sale), 0);
        const daily = new Map<string, DecimalGroup>();
        for (let day = period.from; day <= period.to; day = shiftCalendarDate(day, 1)) daily.set(day, emptyGroup(day));
        const hourly = new Map(Array.from({ length: 24 }, (_, hour) => {
            const label = `${String(hour).padStart(2, "0")}:00`;
            return [label, emptyGroup(label)] as const;
        }));
        const weekdayLabels = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
        const weekdays = new Map([...weekdayLabels.slice(1), weekdayLabels[0]].map(label => [label, emptyGroup(label)]));
        const methods = new Map<string, DecimalGroup>();
        const sources = new Map<string, DecimalGroup>();
        for (const sale of sales) {
            const date = businessDate(sale.createdAt);
            const amount = saleAmount(sale);
            const quantity = saleUnits(sale);
            addGroup(daily, date, amount, quantity);
            addGroup(hourly, `${String(businessHour(sale.createdAt)).padStart(2, "0")}:00`, amount, quantity);
            addGroup(weekdays, weekdayLabels[new Date(date + "T00:00:00Z").getUTCDay()], amount, quantity);
            addGroup(methods, paymentMethodLabel(sale.payment_method), amount, quantity);
            addGroup(sources, saleOrigin(sale.source_type), amount, quantity);
        }
        const expenseGroups = new Map<string, DecimalGroup>();
        for (const expense of expenses) addGroup(expenseGroups, specified(expense.category), new Decimal(expense.amountCents.toString()));
        const salaryGroups = new Map<string, DecimalGroup>();
        for (const salary of salaries) addGroup(salaryGroups, String(salary.userID), new Decimal(salary.amountCents.toString()), 0, specified(salary.users.name));
        const identifiedCustomers = new Set(sales.flatMap(sale => sale.customer ? [sale.customer.id] : [])).size;
        return { success: true, data: {
            period, generatedAt: new Date().toISOString(),
            notices: [saleNotice, ...monetaryNotices(sales), ...monetaryNotices(previousSales, "del periodo anterior"),
                ...missingDateNotice(undatedExpenses, "egresos"), ...missingDateNotice(undatedSalaries, "salarios")],
            paidAmount: toSafeInteger(total.toFixed()), units, paidRecords: sales.length, identifiedCustomers,
            expensesAmount: toSafeInteger(decimalSum(expenses.map(expense => new Decimal(expense.amountCents.toString()))).toFixed()), expensesCount: expenses.length,
            salariesAmount: toSafeInteger(decimalSum(salaries.map(salary => new Decimal(salary.amountCents.toString()))).toFixed()), salariesCount: salaries.length,
            amountComparison: comparison(total, salesTotal(previousSales)),
            unitsComparison: comparison(new Decimal(units), new Decimal(previousSales.reduce((sum, sale) => sum + saleUnits(sale), 0))),
            daily: serializeGroups(daily), hourly: serializeGroups(hourly), weekdays: serializeGroups(weekdays),
            products: productMetrics(sales, total), paymentMethods: serializeGroups(methods, true),
            sourceTypes: serializeGroups(sources, true), expenses: serializeGroups(expenseGroups, true), salaries: serializeGroups(salaryGroups, true),
        } };
    } catch {
        return queryError;
    }
}

const reportColumns: Record<ReportType, ReportColumn[]> = {
    sales: [
        { key: "id", label: "Venta", kind: "integer" }, { key: "date", label: "Fecha de registro", kind: "datetime" },
        { key: "products", label: "Productos y cantidades", kind: "text" }, { key: "units", label: "Unidades", kind: "integer" },
        { key: "amount", label: "Importe pagado", kind: "money" }, { key: "source", label: "Origen", kind: "text" },
        { key: "paymentMethod", label: "Forma de pago", kind: "text" }, { key: "customer", label: "Cliente", kind: "text" },
        { key: "employee", label: "Empleado", kind: "text" },
    ],
    products: [
        { key: "name", label: "Producto", kind: "text" }, { key: "units", label: "Unidades", kind: "integer" },
        { key: "amount", label: "Importe vendido", kind: "money" }, { key: "participation", label: "Participación (%)", kind: "percent" },
    ],
    expenses: [
        { key: "date", label: "Fecha", kind: "date" }, { key: "category", label: "Categoría", kind: "text" },
        { key: "description", label: "Descripción", kind: "text" }, { key: "amount", label: "Importe", kind: "money" },
        { key: "employee", label: "Responsable", kind: "text" },
    ],
    salaries: [
        { key: "date", label: "Fecha de pago", kind: "date" }, { key: "employee", label: "Empleado", kind: "text" },
        { key: "period", label: "Periodo", kind: "text" }, { key: "amount", label: "Importe", kind: "money" },
    ],
    customers: [
        { key: "name", label: "Cliente", kind: "text" }, { key: "amount", label: "Importe pagado", kind: "money" },
        { key: "units", label: "Unidades", kind: "integer" }, { key: "days", label: "Días con compras", kind: "integer" },
    ],
    debts: [
        { key: "id", label: "Fiado", kind: "integer" }, { key: "customer", label: "Cliente", kind: "text" },
        { key: "date", label: "Fecha de origen", kind: "datetime" }, { key: "amount", label: "Saldo pendiente actual", kind: "money" },
        { key: "ageDays", label: "Antigüedad (días)", kind: "integer" },
    ],
};

async function reportSnapshot(tx: Prisma.TransactionClient, filter: AnalyticsFilter, type: ReportType) {
    const rows: ReportRow[] = [];
    const totals: ReportRow = {};
    const notices: string[] = [];
    if (type === "sales" || type === "products" || type === "customers") {
        const sales = await orderedSales(tx, filter);
        const total = salesTotal(sales);
        notices.push(saleNotice, ...monetaryNotices(sales));
        if (type === "sales") {
            rows.push(...sales.map(sale => ({
                id: sale.id, date: sale.createdAt.toISOString(),
                products: sale.sale_items.map(item => `${specified(item.products.name)} × ${item.quantity}`).join("; ") || "Sin especificar",
                units: saleUnits(sale), amount: saleAmount(sale) === null ? null : toSafeInteger(saleAmount(sale)!.toFixed()),
                source: sale.source_type?.trim() ? formatSourceType(sale.source_type) : "Sin especificar", paymentMethod: paymentMethodLabel(sale.payment_method),
                customer: specified(sale.customer?.customerName), employee: specified(sale.users.name),
            })));
            totals.amount = toSafeInteger(total.toFixed());
            totals.units = sales.reduce((sum, sale) => sum + saleUnits(sale), 0);
        } else if (type === "products") {
            const products = productMetrics(sales, total);
            rows.push(...products.map(product => ({ name: product.name, units: product.units, amount: product.amount, participation: product.participation })));
            const productAmount = decimalSum(sales.flatMap(sale => sale.sale_items.map(item => new Decimal(item.subtotalCents.toString()))));
            totals.amount = toSafeInteger(productAmount.toFixed());
            totals.units = products.reduce((sum, product) => sum + product.units, 0);
            totals.participation = total.isZero() ? 0 : productAmount.dividedBy(total).times(100).toNumber();
        } else {
            const customers = customerMetrics(sales);
            rows.push(...customers.map(customer => ({ name: customer.name, amount: customer.amount, units: customer.units, days: customer.days })));
            totals.amount = toSafeInteger(salesTotal(sales.filter(sale => sale.customer !== null)).toFixed());
            totals.units = customers.reduce((sum, customer) => sum + customer.units, 0);
        }
    } else if (type === "expenses") {
        const [expenses, undated] = await Promise.all([
            tx.bill.findMany({ where: { date: calendarRange(filter) }, select: expenseSelect, orderBy: [{ date: "desc" }, { id: "desc" }] }),
            tx.bill.count({ where: { date: null } }),
        ]);
        rows.push(...expenses.map(expense => ({
            date: expense.date!.toISOString().slice(0, 10), category: specified(expense.category),
            description: specified(expense.description), amount: toSafeInteger(expense.amountCents), employee: specified(expense.users.name),
        })));
        totals.amount = toSafeInteger(decimalSum(expenses.map(expense => new Decimal(expense.amountCents.toString()))).toFixed());
        notices.push(...missingDateNotice(undated, "egresos"));
    } else if (type === "salaries") {
        const [salaries, undated] = await Promise.all([
            tx.salary.findMany({ where: { payDate: calendarRange(filter) }, select: salarySelect, orderBy: [{ payDate: "desc" }, { id: "desc" }] }),
            tx.salary.count({ where: { payDate: null } }),
        ]);
        rows.push(...salaries.map(salary => ({
            date: salary.payDate!.toISOString().slice(0, 10), employee: specified(salary.users.name),
            period: specified(salary.period), amount: toSafeInteger(salary.amountCents),
        })));
        totals.amount = toSafeInteger(decimalSum(salaries.map(salary => new Decimal(salary.amountCents.toString()))).toFixed());
        notices.push(...missingDateNotice(undated, "salarios"));
    } else {
        const debts = await tx.debtors.findMany({
            where: { status: "DEBT", paidAt: null, amountCents: { gt: BigInt(0) }, sales: { status: "DEBT", createdAt: timestampRange(filter) } },
            select: { id: true, amountCents: true, customer: { select: { customerName: true } }, sales: { select: { createdAt: true } } },
            orderBy: [{ sales: { createdAt: "asc" } }, { id: "asc" }],
        });
        const today = businessDate();
        rows.push(...debts.map(debt => ({
            id: debt.id, customer: specified(debt.customer.customerName), date: debt.sales.createdAt.toISOString(),
            amount: toSafeInteger(debt.amountCents), ageDays: Math.max(0, calendarDays(businessDate(debt.sales.createdAt), today)),
        })));
        totals.amount = toSafeInteger(decimalSum(debts.map(debt => new Decimal(debt.amountCents.toString()))).toFixed());
        notices.push("Saldo pendiente actual de los fiados originados en el periodo. No representa el saldo histórico al cierre; la antigüedad se calcula a la fecha de consulta.");
    }
    return { rows, totals, notices };
}

// Aggregation is performed before LIMIT/OFFSET. Every query in this snapshot
// sees the same database version, including the totals and warning counts.
function paidSalesCTE(filter: AnalyticsFilter) {
    const range = timestampRange(filter);
    return Prisma.sql`
      WITH item_totals AS (
        SELECT "saleID", SUM("subtotalCents") AS amount, SUM(quantity)::bigint AS units,
          STRING_AGG(COALESCE(NULLIF(BTRIM(p.name), ''), 'Sin especificar') || ' × ' || i.quantity, '; ' ORDER BY i.id) AS products
        FROM sale_items i JOIN products p ON p.id = i."productID" GROUP BY "saleID"
      ), paid AS (
        SELECT s.*, COALESCE(s."totalCents"::numeric, it.amount) AS amount,
          COALESCE(it.units, 0)::bigint AS units, it.products
        FROM sales s LEFT JOIN item_totals it ON it."saleID" = s.id
        WHERE s.status::text = 'PAID' AND s."createdAt" >= ${range.gte} AND s."createdAt" < ${range.lt}
      )`;
}
type RawRow = Record<string, unknown>;
function numberValue(value: unknown): number { return toSafeInteger(String(value ?? 0)); }
function reportRows(rows: RawRow[], type: ReportType, salesTotal: number): ReportRow[] {
    return rows.map((row): ReportRow => {
        if (type === "sales") return {
            id: numberValue(row.id), date: (row.date as Date).toISOString(), products: String(row.products ?? "Sin especificar"),
            units: numberValue(row.units), amount: row.amount === null ? null : numberValue(row.amount),
            source: typeof row.source === "string" && row.source.trim() ? formatSourceType(row.source) : "Sin especificar",
            paymentMethod: paymentMethodLabel(row.paymentMethod as string | null), customer: specified(row.customer as string | null), employee: specified(row.employee as string | null),
        };
        if (type === "products") return { name: specified(row.name as string | null), units: numberValue(row.units), amount: numberValue(row.amount), participation: salesTotal === 0 ? 0 : Number(row.amount) / salesTotal * 100 };
        if (type === "customers") return { id: numberValue(row.id), name: specified(row.name as string | null), amount: numberValue(row.amount), units: numberValue(row.units), days: numberValue(row.days) };
        if (type === "debts") return { id: numberValue(row.id), customer: specified(row.customer as string | null), date: (row.date as Date).toISOString(), amount: numberValue(row.amount), ageDays: Math.max(0, calendarDays(businessDate(row.date as Date), businessDate())) };
        return { date: (row.date as Date).toISOString().slice(0, 10), ...(type === "expenses" ? {category: specified(row.category as string | null), description: specified(row.description as string | null)} : {period: specified(row.period as string | null)}), amount: numberValue(row.amount), employee: specified(row.employee as string | null) };
    });
}
function reportQuery(filter: AnalyticsFilter, type: ReportType) {
    const paid = paidSalesCTE(filter);
    const dates = calendarRange(filter);
    const range = timestampRange(filter);
    if (type === "sales") return Prisma.sql`${paid} SELECT p.id, p."createdAt" AS date, p.products, p.units, p.amount, p.source_type AS source, p.payment_method::text AS "paymentMethod", c."customerName" AS customer, u.name AS employee FROM paid p LEFT JOIN customer c ON c.id=p."customerID" JOIN users u ON u.id=p."placedBy"`;
    if (type === "products") return Prisma.sql`${paid} SELECT pr.id, pr.name, SUM(i.quantity)::bigint AS units, SUM(i."subtotalCents") AS amount FROM paid p JOIN sale_items i ON i."saleID"=p.id JOIN products pr ON pr.id=i."productID" GROUP BY pr.id, pr.name`;
    if (type === "customers") return Prisma.sql`${paid} SELECT c.id, c."customerName" AS name, COALESCE(SUM(p.amount),0) AS amount, SUM(p.units)::bigint AS units, COUNT(DISTINCT (p."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Mexico_City')::date)::bigint AS days FROM paid p JOIN customer c ON c.id=p."customerID" GROUP BY c.id, c."customerName"`;
    if (type === "expenses") return Prisma.sql`SELECT b.id, b.date, b.category, b.description, b."amountCents" AS amount, u.name AS employee FROM bill b JOIN users u ON u.id=b.registered_by WHERE b.date >= ${dates.gte} AND b.date < ${dates.lt}`;
    if (type === "salaries") return Prisma.sql`SELECT s.id, s."payDate" AS date, s.period, s."amountCents" AS amount, u.name AS employee FROM salary s JOIN users u ON u.id=s."userID" WHERE s."payDate" >= ${dates.gte} AND s."payDate" < ${dates.lt}`;
    return Prisma.sql`SELECT d.id, c."customerName" AS customer, s."createdAt" AS date, d."amountCents" AS amount FROM debtors d JOIN customer c ON c.id=d."customerID" JOIN sales s ON s.id=d."saleID" WHERE d.status::text='DEBT' AND d."paidAt" IS NULL AND d."amountCents">0 AND s.status::text='DEBT' AND s."createdAt" >= ${range.gte} AND s."createdAt" < ${range.lt}`;
}
async function readPagedReport(tx: Prisma.TransactionClient, filter: AnalyticsFilter, type: ReportType, requestedPage: number, pageSize: number) {
    const query = reportQuery(filter, type);
    const [aggregate] = await tx.$queryRaw<RawRow[]>(Prisma.sql`SELECT COUNT(*)::bigint AS count, COALESCE(SUM(amount),0) AS amount ${type === "sales" || type === "products" || type === "customers" ? Prisma.sql`, COALESCE(SUM(units),0) AS units` : Prisma.empty} FROM (${query}) report`);
    const meta = getPaginationMeta(numberValue(aggregate.count), { page: requestedPage, pageSize });
    const order = type === "products" ? Prisma.sql`amount DESC, units DESC, id ASC` : type === "customers" ? Prisma.sql`amount DESC, id ASC` : type === "debts" ? Prisma.sql`date ASC, id ASC` : Prisma.sql`date DESC, id DESC`;
    const rows = await tx.$queryRaw<RawRow[]>(Prisma.sql`SELECT * FROM (${query}) report ORDER BY ${order} LIMIT ${meta.pageSize} OFFSET ${getPaginationOffset(meta)}`);
    const notices: string[] = [];
    let totalSales = 0;
    if (type === "sales" || type === "products" || type === "customers") {
        const [stats] = await tx.$queryRaw<RawRow[]>(Prisma.sql`${paidSalesCTE(filter)} SELECT COALESCE(SUM(amount),0) AS amount, COUNT(*) FILTER (WHERE "totalCents" IS NULL AND products IS NOT NULL)::bigint AS recovered, COUNT(*) FILTER (WHERE "totalCents" IS NULL AND products IS NULL)::bigint AS missing FROM paid`);
        totalSales = numberValue(stats.amount);
        notices.push(saleNotice);
        if (numberValue(stats.recovered)) notices.push(`${numberValue(stats.recovered)} ventas del periodo no tienen total guardado: su importe se obtuvo de los subtotales históricos.`);
        if (numberValue(stats.missing)) notices.push(`${numberValue(stats.missing)} ventas del periodo no tienen total ni partidas: su importe es desconocido y se excluye de las sumas monetarias.`);
    } else if (type === "expenses" || type === "salaries") {
        const undated = type === "expenses" ? await tx.bill.count({where:{date:null}}) : await tx.salary.count({where:{payDate:null}});
        notices.push(...missingDateNotice(undated, type === "expenses" ? "egresos" : "salarios"));
    } else notices.push("Saldo pendiente actual de los fiados originados en el periodo. No representa el saldo histórico al cierre; la antigüedad se calcula a la fecha de consulta.");
    const summary: ReportRow = {amount: numberValue(aggregate.amount)};
    if (type === "sales" || type === "products" || type === "customers") summary.units = numberValue(aggregate.units);
    if (type === "products") summary.participation = totalSales === 0 ? 0 : numberValue(aggregate.amount) / totalSales * 100;
    return { ...meta, items: reportRows(rows, type, totalSales), summary, notices };
}
export async function getReport(input: unknown): Promise<ActionResult<PaginatedReportData, "UNAUTHENTICATED" | "FORBIDDEN" | "INVALID_INPUT" | "QUERY_FAILED">> {
    try {
        const session = await auth();
        if (!session?.user) return actionFail("UNAUTHENTICATED");
        if (session.user.role !== "ADMIN") return actionFail("FORBIDDEN");
        const parsed = AnalyticsReportSchema.safeParse(input);
        if (!parsed.success || parsed.data.search !== "" || parsed.data.order !== undefined) return actionFail("INVALID_INPUT");
        const {page, pageSize, filters: {type, from, to}} = parsed.data;
        const filter = {from, to};
        const snapshot = await prisma.$transaction(tx => readPagedReport(tx, filter, type, page, pageSize), {isolationLevel:"RepeatableRead", timeout:30_000});
        return actionOk({...snapshot, type, period:analyticsPeriod(filter), generatedAt:new Date().toISOString(), columns:reportColumns[type]});
    } catch (error) { console.error("Report query failed", error); return actionFail("QUERY_FAILED"); }
}
export async function getReportExport(input: unknown): Promise<AnalyticsResult<ReportData>> {
    try {
        if ((await auth())?.user?.role !== "ADMIN") return permissionError;
        const parsed = ReportFilterSchema.safeParse(input);
        if (!parsed.success) return filterError;
        const {type, from, to} = parsed.data;
        const filter = {from, to};
        const snapshot = await prisma.$transaction(tx => reportSnapshot(tx, filter, type), {isolationLevel:"RepeatableRead", timeout:30_000});
        return {success:true, data:{type, period:analyticsPeriod(filter), generatedAt:new Date().toISOString(), notices:snapshot.notices, columns:reportColumns[type], totals:snapshot.totals, totalRows:snapshot.rows.length, rows:snapshot.rows}};
    } catch { return queryError; }
}
