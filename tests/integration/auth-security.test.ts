import { describe, it, expect, beforeEach, vi } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { authorizeCredentials } from "@/lib/auth-credentials";
import {
    resetAllLockouts,
    readAccountAttempts,
    MAX_FAILED_ATTEMPTS,
} from "@/lib/auth-lockout";
import { GetAllUsers, searchUsers } from "@/lib/actions/users";
import { getSalesHistory } from "@/lib/actions/sales";
import { loginAs, logout, resetDb, seedBase } from "./helpers";

describe("Issue #19: Close PIN login gaps, limit login attempts, and protect user directory", () => {
    let adminId: number;
    let staffId: number;
    let openJornadaId: number;

    beforeEach(async () => {
        await resetDb();
        resetAllLockouts();

        const base = await seedBase();
        adminId = base.admin.id;
        openJornadaId = base.jornada.id;

        // Create an ADMIN user that has both a password and a PIN
        await prisma.users.update({
            where: { id: adminId },
            data: {
                username: "adminuser",
                password: await bcrypt.hash("adminpass123", 10),
                pin: await bcrypt.hash("1234", 10),
                role: "ADMIN",
                active: true,
            },
        });

        // Create a STAFF user with a PIN
        const staff = await prisma.users.create({
            data: {
                name: "Staff Usuario Lopez",
                username: "staffuser",
                email: "staff@test.local",
                pin: await bcrypt.hash("5678", 10),
                password: await bcrypt.hash("staffpass123", 10),
                role: "STAFF",
                active: true,
            },
        });
        staffId = staff.id;
    });

    describe("1. Role enforcement in Credentials Provider", () => {
        it("rejects ADMIN users attempting to log in via STAFF PIN provider", async () => {
            // Even though admin has PIN 1234, role is ADMIN, so STAFF provider must reject
            const result = await authorizeCredentials({
                role: "STAFF",
                username: "adminuser",
                pin: "1234",
            });

            expect(result).toBeNull();
        });

        it("allows legitimate STAFF users to log in with valid PIN", async () => {
            const result = await authorizeCredentials({
                role: "STAFF",
                username: "staffuser",
                pin: "5678",
            });

            expect(result).not.toBeNull();
            expect(result?.role).toBe("STAFF");
            expect(result?.name).toBe("Staff Usuario Lopez");
        });

        it("accepts an existing STAFF username containing punctuation", async () => {
            await prisma.users.update({ where: { id: staffId }, data: { username: "@legacy-staff" } });
            expect(await authorizeCredentials({ role: "STAFF", username: "@legacy-staff", pin: "5678" }))
                .toMatchObject({ id: String(staffId), role: "STAFF" });
        });

        it("rejects STAFF users attempting to log in via ADMIN password provider", async () => {
            // Even though staff has a password, role is STAFF, so ADMIN provider must reject
            const result = await authorizeCredentials({
                role: "ADMIN",
                email: "staff@test.local",
                password: "staffpass123",
            });

            expect(result).toBeNull();
        });

        it("allows legitimate ADMIN users to log in with valid password", async () => {
            const result = await authorizeCredentials({
                role: "ADMIN",
                email: "admin@test.local",
                password: "adminpass123",
            });

            expect(result).not.toBeNull();
            expect(result?.role).toBe("ADMIN");
        });

        it("preserves an existing ADMIN password that includes surrounding spaces", async () => {
            const password = "  legacy password  ";
            await prisma.users.update({
                where: { id: adminId },
                data: { password: await bcrypt.hash(password, 10) },
            });
            expect(await authorizeCredentials({ role: "ADMIN", email: "admin@test.local", password }))
                .toMatchObject({ id: String(adminId), role: "ADMIN" });
        });
    });

    describe("2. Failed attempts and Lockout mechanism", () => {
        it("locks out an account after 5 consecutive failed attempts", async () => {
            expect(await readAccountAttempts(staffId)).toBeNull();

            for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
                const res = await authorizeCredentials({
                    role: "STAFF",
                    username: "staffuser",
                    pin: "0000", // wrong PIN
                });
                expect(res).toBeNull();
                expect(await readAccountAttempts(staffId)).toMatchObject({ attempts: i, lockedUntil: null });
            }

            // 5th failed attempt triggers lockout
            const fifthRes = await authorizeCredentials({
                role: "STAFF",
                username: "staffuser",
                pin: "0000",
            });
            expect(fifthRes).toBeNull();
            expect((await readAccountAttempts(staffId))?.lockedUntil).toBeGreaterThan(Date.now());

            // Attempt with CORRECT PIN while locked out is immediately rejected
            const lockedRes = await authorizeCredentials({
                role: "STAFF",
                username: "staffuser",
                pin: "5678",
            });
            expect(lockedRes).toBeNull();
        });

        it("resets failed attempt counter upon successful login", async () => {
            // 3 failed attempts
            for (let i = 0; i < 3; i++) {
                await authorizeCredentials({
                    role: "STAFF",
                    username: "staffuser",
                    pin: "0000",
                });
            }
            expect(await readAccountAttempts(staffId)).toMatchObject({ attempts: 3, lockedUntil: null });

            // Successful login clears counter
            const successRes = await authorizeCredentials({
                role: "STAFF",
                username: "staffuser",
                pin: "5678",
            });
            expect(successRes).not.toBeNull();
            expect(await readAccountAttempts(staffId)).toBeNull();
        });
    });

    describe("3. User directory protection against STAFF queries", () => {
        it("GetAllUsers returns empty array for STAFF but returns full list for ADMIN", async () => {
            loginAs("STAFF", staffId);
            const staffResult = await GetAllUsers();
            expect(staffResult).toEqual([]);

            loginAs("ADMIN", adminId);
            const adminResult = await GetAllUsers();
            expect(adminResult.length).toBeGreaterThan(0);
        });

        it("searchUsers returns empty array for STAFF but returns matches for ADMIN", async () => {
            loginAs("STAFF", staffId);
            const staffResult = await searchUsers("Staff");
            expect(staffResult).toEqual([]);

            loginAs("ADMIN", adminId);
            const adminResult = await searchUsers("Staff");
            expect(adminResult.length).toBeGreaterThan(0);
            expect(adminResult[0].name).toContain("Staff");
        });

        it("getSalesHistory redacts user directory fields (email, username, role, registeredAt, active) for STAFF", async () => {
            // Create a sale placed by admin
            const sale = await prisma.sales.create({
                data: {
                    status: "PAID",
                    payment_method: "CASH",
                    totalCents: 10000,
                    placedBy: adminId,
                    jornadaId: openJornadaId,
                },
            });

            // STAFF query
            loginAs("STAFF", staffId);
            const staffHistory = await getSalesHistory();
            const staffSale = staffHistory.find((s) => s.id === sale.id);
            expect(staffSale).toBeDefined();
            expect(staffSale?.users).toBeDefined();
            expect(staffSale?.users?.id).toBe(adminId);
            expect(staffSale?.users?.name).toBeTruthy();
            // Directory / confidential fields must be undefined for STAFF
            expect((staffSale?.users as any)?.email).toBeUndefined();
            expect((staffSale?.users as any)?.username).toBeUndefined();
            expect((staffSale?.users as any)?.role).toBeUndefined();
            expect((staffSale?.users as any)?.registeredAt).toBeUndefined();
            expect((staffSale?.users as any)?.active).toBeUndefined();

            // ADMIN query
            loginAs("ADMIN", adminId);
            const adminHistory = await getSalesHistory();
            const adminSale = adminHistory.find((s) => s.id === sale.id);
            expect(adminSale).toBeDefined();
            expect(adminSale?.users?.id).toBe(adminId);
            expect(adminSale?.users).toMatchObject({ email: expect.any(String), role: "ADMIN" });
        });
    });
});
