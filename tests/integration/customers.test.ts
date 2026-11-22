import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { getAllCustomers, getCustomerPage, saveCustomer } from "@/lib/actions/customers";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TablePagination } from "@/components/pagination";

describe("customers actions", () => {
    beforeAll(async () => {
        await resetDb();
        await seedBase();
    });

    it("rejects saveCustomer without a session and writes nothing", async () => {
        logout();
        const res = await saveCustomer({ customerName: "Juan Cliente", phone: "5551234" });
        expect(res).toMatchObject({ success: false, error: "UNAUTHORIZED" });
        expect(await prisma.customer.count()).toBe(0);
    });

    it("creates a customer and persists it", async () => {
        loginAs("ADMIN");
        const res = await saveCustomer({ customerName: "Juan Cliente", phone: "5551234" });
        expect(res).toMatchObject({ success: true });

        const row = await prisma.customer.findFirst({ where: { customerName: "Juan Cliente" } });
        expect(row).not.toBeNull();
        expect(row!.phone).toBe("5551234");
        expect(Number(row!.currentBalanceCents)).toBe(0);
        expect(row!.registeredDate).not.toBeNull();
    });

    it("updates an existing customer by id", async () => {
        loginAs("ADMIN");
        const existing = await prisma.customer.findFirstOrThrow();

        const res = await saveCustomer({ id: existing.id, customerName: "Juan Editado", phone: "999888" });
        expect(res).toMatchObject({ success: true });

        const row = await prisma.customer.findUniqueOrThrow({ where: { id: existing.id } });
        expect(row.customerName).toBe("Juan Editado");
        expect(row.phone).toBe("999888");
        expect(await prisma.customer.count()).toBe(1);
    });

    it("rejects invalid data with field errors", async () => {
        loginAs("ADMIN");
        const res = await saveCustomer({ customerName: "ab", phone: "" });
        expect(res.success).toBe(false);
        expect(res.fieldErrors).toBeDefined();
        expect(await prisma.customer.count()).toBe(1);
    });

    it("getAllCustomers returns rows with a session and nothing without one", async () => {
        loginAs("ADMIN");
        const rows = await getAllCustomers();
        expect(rows.length).toBe(1);

        logout();
        expect(await getAllCustomers()).toEqual([]);
    });

    it("creates a customer without a phone number", async () => {
        loginAs("ADMIN");
        const res = await saveCustomer({ customerName: "Cliente Sin Telefono", phone: "" });
        expect(res).toMatchObject({ success: true });

        const row = await prisma.customer.findFirstOrThrow({ where: { customerName: "Cliente Sin Telefono" } });
        expect(row.phone).toBeNull();
    });

    it("persists, trims, updates, clears, preserves, validates, and searches customer alias", async () => {
        loginAs("ADMIN");

        // Create with outer whitespace -> trimmed
        const createdRes = await saveCustomer({
            customerName: "Cliente Con Alias",
            alias: "  El Güero #1  ",
            phone: "5552223333",
        });
        expect(createdRes).toMatchObject({ success: true });
        const created = await prisma.customer.findFirstOrThrow({ where: { customerName: "Cliente Con Alias" } });
        expect(created.alias).toBe("El Güero #1");

        // Search by alias works in both default and name-sorted CRM pages
        const byAliasDefault = await getCustomerPage({ search: "Güero" });
        expect(byAliasDefault.rows.map((r) => r.id)).toContain(created.id);
        expect(byAliasDefault.rows.find((r) => r.id === created.id)?.alias).toBe("El Güero #1");

        const byAliasSorted = await getCustomerPage({ search: "güero", sort: "customerName" });
        expect(byAliasSorted.rows.map((r) => r.id)).toContain(created.id);

        // Wildcard characters in alias search are escaped
        const wildcardSearch = await getCustomerPage({ search: "%" });
        expect(wildcardSearch.rows).toHaveLength(0);

        // Omitting alias on update preserves existing alias
        const preserveRes = await saveCustomer({ id: created.id, customerName: "Cliente Con Alias" });
        expect(preserveRes).toMatchObject({ success: true });
        expect((await prisma.customer.findUniqueOrThrow({ where: { id: created.id } })).alias).toBe("El Güero #1");

        // Exact 30-character boundary (with outer whitespace trimmed first) succeeds
        const maxAlias = "A".repeat(30);
        const boundaryRes = await saveCustomer({ id: created.id, customerName: "Cliente Con Alias", alias: ` ${maxAlias} ` });
        expect(boundaryRes).toMatchObject({ success: true });
        expect((await prisma.customer.findUniqueOrThrow({ where: { id: created.id } })).alias).toBe(maxAlias);

        // 31-character alias is rejected with fieldErrors.alias
        const tooLongRes = await saveCustomer({ id: created.id, customerName: "Cliente Con Alias", alias: "A".repeat(31) });
        expect(tooLongRes.success).toBe(false);
        expect(tooLongRes.fieldErrors?.alias).toBeDefined();
        expect((await prisma.customer.findUniqueOrThrow({ where: { id: created.id } })).alias).toBe(maxAlias);

        // Whitespace-only or empty string clears alias to null
        const clearRes = await saveCustomer({ id: created.id, customerName: "Cliente Con Alias", alias: "   " });
        expect(clearRes).toMatchObject({ success: true });
        expect((await prisma.customer.findUniqueOrThrow({ where: { id: created.id } })).alias).toBeNull();
    });

    it("renders TablePagination controls with page bounds and navigation", () => {
        let currentPage = 0;
        const mockTable: any = {
            getState: () => ({
                pagination: { pageIndex: currentPage, pageSize: 10 },
            }),
            getPageCount: () => 2,
            getRowCount: () => 15,
            getCanPreviousPage: () => currentPage > 0,
            getCanNextPage: () => currentPage < 1,
            previousPage: () => { currentPage--; },
            nextPage: () => { currentPage++; },
        };

        const htmlPage1 = renderToStaticMarkup(
            React.createElement(TablePagination, { table: mockTable })
        );
        expect(htmlPage1).toContain("Mostrando 1–10 de 15 · Página 1 de 2");
        expect(htmlPage1).toContain("Anterior");
        expect(htmlPage1).toContain("Siguiente");
        expect(htmlPage1).toContain("disabled");

        // advance to page 2
        mockTable.nextPage();
        const htmlPage2 = renderToStaticMarkup(
            React.createElement(TablePagination, { table: mockTable })
        );
        expect(htmlPage2).toContain("Mostrando 11–15 de 15 · Página 2 de 2");
    });
});
