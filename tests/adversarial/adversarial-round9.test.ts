import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("../helpers/database");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { loginAs, resetDb, seedBase } from "../helpers/database";
import { saveCustomer } from "@/lib/actions/customers";
import { createSale } from "@/lib/actions/sales";

describe("Adversarial Round 9 Reproduction Tests", () => {
    let adminId: number;

    beforeAll(async () => {
        await resetDb();
        const { admin } = await seedBase();
        adminId = admin.id;
    });

    it("saveCustomer must reject alias longer than 30 characters with fieldErrors", async () => {
        loginAs("ADMIN", adminId);

        const res = await saveCustomer({
            customerName: "Cliente Valido",
            alias: "A".repeat(35),
        });

        // MUST FAIL without .max(30)
        expect(res.success).toBe(false);
        expect(res.fieldErrors?.alias).toBeDefined();
    });

    it("saveCustomer must reject customerName longer than 100 characters with fieldErrors", async () => {
        loginAs("ADMIN", adminId);

        const res = await saveCustomer({
            customerName: "A".repeat(105),
        });

        // MUST FAIL without .max(100)
        expect(res.success).toBe(false);
        expect(res.fieldErrors?.customerName).toBeDefined();
    });

    it("createSale must reject source_type longer than 30 characters with fieldErrors", async () => {
        loginAs("ADMIN", adminId);

        const res = await createSale(
            [{ productID: 1, quantity: 1 }],
            "PAID",
            "A".repeat(35),
            -1,
            "CASH"
        );

        // MUST FAIL without .max(30)
        expect(res.success).toBe(false);
        expect(res).toMatchObject({ fieldErrors: { source_type: expect.any(Array) } });
    });
});
