import type { Prisma } from "@/app/generated/prisma/client";
import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("../integration/helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import fs from "fs";
import path from "path";
import prisma from "@/lib/prisma";
import { PaymentMethod, SaleStatus } from "@/app/generated/prisma/enums";
import { actionData, loginAs, resetDb, seedBase } from "../integration/helpers";
import { getAllDebtors, getDebtsSummary } from "@/lib/actions/debts";

export interface BenchmarkMetrics {
    scenario: string;
    role: "ADMIN" | "STAFF";
    datasetCustomers: number;
    datasetDebts: number;
    samples: number;
    minMs: number;
    medianMs: number;
    p95Ms: number;
    maxMs: number;
    avgMs: number;
    errors: number;
    pageSize: number;
}

const benchmarkResults: BenchmarkMetrics[] = [];

async function runBenchmark(
    scenario: string,
    role: "ADMIN" | "STAFF",
    userId: number,
    datasetCustomers: number,
    datasetDebts: number,
    totalPages: number
): Promise<BenchmarkMetrics> {
    loginAs(role, userId);

    // 5 warm-up queries
    for (let i = 0; i < 5; i++) {
        actionData(await getAllDebtors({ page: (i % 5) + 1, pageSize: 10 }));
    }

    // 30 measured queries alternating first, mid, last page, and selective search
    const latencies: number[] = [];
    let errors = 0;
    const testPages = [1, Math.floor(totalPages / 2), totalPages];

    for (let i = 0; i < 30; i++) {
        const page = testPages[i % testPages.length];
        const isSearch = i % 4 === 0;
        const start = performance.now();
        try {
            const res = isSearch
                ? actionData(await getAllDebtors({ search: "Cliente Deudor 00", pageSize: 10 }))
                : actionData(await getAllDebtors({ page, pageSize: 10 }));
            const duration = performance.now() - start;
            latencies.push(duration);

            if (res.items.length > 10) errors++;
            if (res.total <= 0) errors++;
        } catch {
            errors++;
        }
    }

    latencies.sort((a, b) => a - b);
    const minMs = Math.round(latencies[0] * 100) / 100;
    const maxMs = Math.round(latencies[latencies.length - 1] * 100) / 100;
    const medianMs = Math.round(latencies[Math.floor(latencies.length / 2)] * 100) / 100;
    const p95Ms = Math.round(latencies[Math.floor(latencies.length * 0.95)] * 100) / 100;
    const avgMs = Math.round((latencies.reduce((s, x) => s + x, 0) / latencies.length) * 100) / 100;

    const metrics: BenchmarkMetrics = {
        scenario,
        role,
        datasetCustomers,
        datasetDebts,
        samples: latencies.length,
        minMs,
        medianMs,
        p95Ms,
        maxMs,
        avgMs,
        errors,
        pageSize: 10,
    };

    benchmarkResults.push(metrics);
    return metrics;
}

describe("Issue #32 — Performance Benchmarks (Normal, Alto, Sesgo)", { timeout: 120_000 }, () => {
    let adminId: number;
    let jornadaId: number;

    beforeAll(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;
    });

    it("Benchmark Escenario Normal — 1,000 deudores / 3,000 deudas activas", async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;

        const customerCount = 1000;
        const customersData: Prisma.customerCreateManyInput[] = [];
        const salesData: Prisma.salesCreateManyInput[] = [];
        const debtorsData: Prisma.debtorsCreateManyInput[] = [];

        let saleId = 1;
        const pastDate = new Date("2026-11-17T10:00:00Z");

        for (let i = 1; i <= customerCount; i++) {
            const name = `Cliente Deudor ${String(i).padStart(4, "0")}`;
            customersData.push({
                id: i,
                customerName: name,
                phone: `555${String(i).padStart(7, "0")}`,
                alias: `Alias${i}`,
                currentBalanceCents: 6000,
                registeredDate: new Date("2026-01-01"),
                lastConsumption: new Date("2026-11-01"),
            });

            for (const amt of [10, 20, 30]) {
                const sId = saleId++;
                salesData.push({
                    id: sId,
                    totalCents: amt * 100,
                    status: SaleStatus.DEBT,
                    source_type: `CL- ${name}`,
                    customerID: i,
                    placedBy: adminId,
                    jornadaId: jornadaId,
                    createdAt: pastDate,
                });
                debtorsData.push({
                    saleID: sId,
                    customerID: i,
                    amountCents: amt * 100,
                    status: SaleStatus.DEBT,
                    createdJornadaId: jornadaId,
                    createdAt: pastDate,
                    paidAt: null,
                    paidJornadaId: null,
                    collectedBy: null,
                });
            }
        }

        // 200 historical paid customers
        for (let i = 1; i <= 200; i++) {
            const cId = customerCount + i;
            const name = `Cliente Historico ${String(i).padStart(4, "0")}`;
            customersData.push({
                id: cId,
                customerName: name,
                phone: `555999${String(i).padStart(4, "0")}`,
                alias: `Historico${i}`,
                currentBalanceCents: 0,
                registeredDate: new Date("2026-01-01"),
                lastConsumption: pastDate,
            });

            const sId = saleId++;
            salesData.push({
                id: sId,
                totalCents: 5000,
                status: SaleStatus.PAID,
                payment_method: PaymentMethod.CASH,
                source_type: `CL- ${name}`,
                customerID: cId,
                placedBy: adminId,
                jornadaId: jornadaId,
                createdAt: pastDate,
            });
            debtorsData.push({
                saleID: sId,
                customerID: cId,
                amountCents: 5000,
                status: SaleStatus.PAID,
                createdJornadaId: jornadaId,
                paidJornadaId: jornadaId,
                paidAt: pastDate,
                collectedBy: adminId,
                createdAt: pastDate,
            });
        }

        for (let i = 0; i < customersData.length; i += 1000) {
            await prisma.customer.createMany({ data: customersData.slice(i, i + 1000) });
        }
        for (let i = 0; i < salesData.length; i += 1000) {
            await prisma.sales.createMany({ data: salesData.slice(i, i + 1000) });
        }
        for (let i = 0; i < debtorsData.length; i += 1000) {
            await prisma.debtors.createMany({ data: debtorsData.slice(i, i + 1000) });
        }

        await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('customer', 'id'), (SELECT COALESCE(MAX(id), 1) FROM customer))`);
        await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('sales', 'id'), (SELECT COALESCE(MAX(id), 1) FROM sales))`);
        await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('debtors', 'id'), (SELECT COALESCE(MAX(id), 1) FROM debtors))`);

        loginAs("ADMIN", adminId);
        const summary = await getDebtsSummary();
        expect(summary.activeDebtors).toBe(1000);
        expect(summary.totalAmount).toBe(6000000);
        expect(summary.todayPayments).toBe(0);

        const adminMetrics = await runBenchmark("Normal (1,000 / 3,000)", "ADMIN", adminId, 1000, 3000, 100);
        expect(adminMetrics.errors).toBe(0);
        expect(adminMetrics.p95Ms).toBeLessThanOrEqual(2000);

        const staffMetrics = await runBenchmark("Normal (1,000 / 3,000)", "STAFF", 999, 1000, 3000, 100);
        expect(staffMetrics.errors).toBe(0);
        expect(staffMetrics.p95Ms).toBeLessThanOrEqual(2000);
    });

    it("Benchmark Escenario Alto — 5,000 deudores / 15,000 deudas activas (Criterio Principal)", async () => {
        console.log("Preparing Escenario Alto dataset: 5,000 customers & 15,000 debts...");
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;

        const customerCount = 5000;
        const customersData: Prisma.customerCreateManyInput[] = [];
        const salesData: Prisma.salesCreateManyInput[] = [];
        const debtorsData: Prisma.debtorsCreateManyInput[] = [];

        let saleId = 1;
        const pastDate = new Date("2026-11-17T10:00:00Z");

        for (let i = 1; i <= customerCount; i++) {
            const name = `Cliente Deudor ${String(i).padStart(5, "0")}`;
            customersData.push({
                id: i,
                customerName: name,
                phone: `555${String(i).padStart(7, "0")}`,
                alias: `Alias${i}`,
                currentBalanceCents: 6000,
                registeredDate: new Date("2026-01-01"),
                lastConsumption: new Date("2026-11-01"),
            });

            for (const amt of [10, 20, 30]) {
                const sId = saleId++;
                salesData.push({
                    id: sId,
                    totalCents: amt * 100,
                    status: SaleStatus.DEBT,
                    source_type: `CL- ${name}`,
                    customerID: i,
                    placedBy: adminId,
                    jornadaId: jornadaId,
                    createdAt: pastDate,
                });
                debtorsData.push({
                    saleID: sId,
                    customerID: i,
                    amountCents: amt * 100,
                    status: SaleStatus.DEBT,
                    createdJornadaId: jornadaId,
                    createdAt: pastDate,
                    paidAt: null,
                    paidJornadaId: null,
                    collectedBy: null,
                });
            }
        }

        // 200 historical paid customers
        for (let i = 1; i <= 200; i++) {
            const cId = customerCount + i;
            const name = `Cliente Historico ${String(i).padStart(4, "0")}`;
            customersData.push({
                id: cId,
                customerName: name,
                phone: `555999${String(i).padStart(4, "0")}`,
                alias: `Historico${i}`,
                currentBalanceCents: 0,
                registeredDate: new Date("2026-01-01"),
                lastConsumption: pastDate,
            });

            const sId = saleId++;
            salesData.push({
                id: sId,
                totalCents: 5000,
                status: SaleStatus.PAID,
                payment_method: PaymentMethod.CASH,
                source_type: `CL- ${name}`,
                customerID: cId,
                placedBy: adminId,
                jornadaId: jornadaId,
                createdAt: pastDate,
            });
            debtorsData.push({
                saleID: sId,
                customerID: cId,
                amountCents: 5000,
                status: SaleStatus.PAID,
                createdJornadaId: jornadaId,
                paidJornadaId: jornadaId,
                paidAt: pastDate,
                collectedBy: adminId,
                createdAt: pastDate,
            });
        }

        // Chunks
        for (let i = 0; i < customersData.length; i += 1000) {
            await prisma.customer.createMany({ data: customersData.slice(i, i + 1000) });
        }
        for (let i = 0; i < salesData.length; i += 1000) {
            await prisma.sales.createMany({ data: salesData.slice(i, i + 1000) });
        }
        for (let i = 0; i < debtorsData.length; i += 1000) {
            await prisma.debtors.createMany({ data: debtorsData.slice(i, i + 1000) });
        }

        await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('customer', 'id'), (SELECT COALESCE(MAX(id), 1) FROM customer))`);
        await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('sales', 'id'), (SELECT COALESCE(MAX(id), 1) FROM sales))`);
        await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('debtors', 'id'), (SELECT COALESCE(MAX(id), 1) FROM debtors))`);

        // Check Financial Oracle on Alto dataset:
        loginAs("ADMIN", adminId);
        const summary = await getDebtsSummary();
        expect(summary.activeDebtors).toBe(5000);
        expect(summary.totalAmount).toBe(30000000); // 5000 * 6000 cents
        expect(summary.todayPayments).toBe(0);

        // Run ADMIN benchmark
        const adminMetrics = await runBenchmark("Alto (5,000 / 15,000)", "ADMIN", adminId, 5000, 15000, 500);
        console.log("ADMIN Alto metrics:", adminMetrics);
        expect(adminMetrics.errors).toBe(0);
        expect(adminMetrics.p95Ms).toBeLessThanOrEqual(2000); // Criterion: P95 <= 2s

        // Run STAFF benchmark
        const staffMetrics = await runBenchmark("Alto (5,000 / 15,000)", "STAFF", 999, 5000, 15000, 500);
        console.log("STAFF Alto metrics:", staffMetrics);
        expect(staffMetrics.errors).toBe(0);
        expect(staffMetrics.p95Ms).toBeLessThanOrEqual(2000); // Criterion: P95 <= 2s
    });

    it("Benchmark Escenario Sesgo (Skew) — Cliente con 300 deudas activas", async () => {
        // Customer 1 will receive 300 extra debts
        loginAs("ADMIN", adminId);

        const currentMaxSale = (await prisma.sales.aggregate({ _max: { id: true } }))._max.id ?? 100000;
        let sId = currentMaxSale + 1;
        const pastDate = new Date("2026-11-17T10:00:00Z");

        const skewSales: Prisma.salesCreateManyInput[] = [];
        const skewDebtors: Prisma.debtorsCreateManyInput[] = [];
        const targetCustomerId = 1;

        for (let i = 0; i < 300; i++) {
            const saleId = sId++;
            skewSales.push({
                id: saleId,
                totalCents: 1000,
                status: SaleStatus.DEBT,
                source_type: "CL- Skew Debt",
                customerID: targetCustomerId,
                placedBy: adminId,
                jornadaId: jornadaId,
                createdAt: pastDate,
            });
            skewDebtors.push({
                saleID: saleId,
                customerID: targetCustomerId,
                amountCents: 1000,
                status: SaleStatus.DEBT,
                createdJornadaId: jornadaId,
                createdAt: pastDate,
            });
        }

        for (let i = 0; i < skewSales.length; i += 500) {
            await prisma.sales.createMany({ data: skewSales.slice(i, i + 500) });
        }
        for (let i = 0; i < skewDebtors.length; i += 500) {
            await prisma.debtors.createMany({ data: skewDebtors.slice(i, i + 500) });
        }

        // Query page 1 (which contains targetCustomerId) 30 times
        const latencies: number[] = [];
        for (let i = 0; i < 30; i++) {
            const start = performance.now();
            const res = actionData(await getAllDebtors({ page: 1, pageSize: 10 }));
            latencies.push(performance.now() - start);

            const skewCustomer = res.items.find((c) => c.customerID === targetCustomerId);
            expect(skewCustomer).toBeDefined();
            // Original $60 + 300 * $10 = $3,060
            expect(skewCustomer?.amount).toBe(306000);
        }

        latencies.sort((a, b) => a - b);
        const p95 = Math.round(latencies[Math.floor(latencies.length * 0.95)] * 100) / 100;
        const median = Math.round(latencies[Math.floor(latencies.length / 2)] * 100) / 100;
        const max = Math.round(latencies[latencies.length - 1] * 100) / 100;

        const skewMetrics: BenchmarkMetrics = {
            scenario: "Sesgo (1 cliente con 303 deudas)",
            role: "ADMIN",
            datasetCustomers: 5000,
            datasetDebts: 15300,
            samples: 30,
            minMs: Math.round(latencies[0] * 100) / 100,
            medianMs: median,
            p95Ms: p95,
            maxMs: max,
            avgMs: Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100,
            errors: 0,
            pageSize: 10,
        };

        benchmarkResults.push(skewMetrics);
        console.log("Skew scenario metrics:", skewMetrics);
        expect(p95).toBeLessThanOrEqual(2000);

        // Save JSON results to disk for comprehensive reporting
        fs.writeFileSync(
            path.resolve(__dirname, "../../benchmark-issue32-results.json"),
            JSON.stringify(benchmarkResults, null, 2)
        );
    });
});
