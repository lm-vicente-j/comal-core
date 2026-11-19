import { describe, it, expect, beforeAll, vi } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { GetAllUsers, saveUser } from "@/lib/actions/users";

describe("users actions", () => {
    beforeAll(async () => {
        await resetDb();
        await seedBase();
    });

    it("rejects saveUser without an ADMIN session", async () => {
        logout();
        expect(await saveUser({ name: "Carlos Ramirez Diaz", role: "ADMIN", password: "secret123" }))
            .toMatchObject({ success: false, error: "UNAUTHORIZED" });

        loginAs("STAFF");
        expect(await saveUser({ name: "Carlos Ramirez Diaz", role: "ADMIN", password: "secret123" }))
            .toMatchObject({ success: false, error: "UNAUTHORIZED" });

        expect(await prisma.users.count()).toBe(1); // only the seeded admin
    });

    it("creates an ADMIN user with a hashed password and generated username", async () => {
        loginAs("ADMIN");
        const res = await saveUser({
            name: "Carlos Ramirez Diaz",
            role: "ADMIN",
            password: "secret123",
            email: "carlos@test.local",
            active: true,
        });
        expect(res).toMatchObject({ success: true });

        const row = await prisma.users.findFirstOrThrow({ where: { email: "carlos@test.local" } });
        expect(row.role).toBe("ADMIN");
        expect(row.username).toBeTruthy();
        expect(row.password).not.toBe("secret123");
        expect(await bcrypt.compare("secret123", row.password!)).toBe(true);
        expect(row.pin).toBeNull();
    });

    it("creates a STAFF user with a hashed pin", async () => {
        loginAs("ADMIN");
        const res = await saveUser({
            name: "Maria Lopez Garcia",
            role: "STAFF",
            pin: "4321",
            password: "",
            active: true,
        });
        expect(res).toMatchObject({ success: true });

        const row = await prisma.users.findFirstOrThrow({ where: { name: "Maria Lopez Garcia" } });
        expect(row.role).toBe("STAFF");
        expect(row.pin).not.toBe("4321");
        expect(await bcrypt.compare("4321", row.pin!)).toBe(true);
        expect(row.password).toBeNull();
    });

    it("updates an existing user's name without touching credentials", async () => {
        loginAs("ADMIN");
        const before = await prisma.users.findFirstOrThrow({ where: { email: "carlos@test.local" } });

        const res = await saveUser({ id: before.id, name: "Carlos Editado Diaz", role: "ADMIN", password: "" });
        expect(res).toMatchObject({ success: true });

        const after = await prisma.users.findUniqueOrThrow({ where: { id: before.id } });
        expect(after.name).toBe("Carlos Editado Diaz");
        expect(after.password).toBe(before.password);
    });

    it("re-hashes the credential when a new one is provided on update", async () => {
        loginAs("ADMIN");
        const before = await prisma.users.findFirstOrThrow({ where: { email: "carlos@test.local" } });

        const res = await saveUser({ id: before.id, name: before.name!, role: "ADMIN", password: "otropass9" });
        expect(res).toMatchObject({ success: true });

        const after = await prisma.users.findUniqueOrThrow({ where: { id: before.id } });
        expect(after.password).not.toBe(before.password);
        expect(await bcrypt.compare("otropass9", after.password!)).toBe(true);
    });

    it("GetAllUsers returns rows with a session and nothing without one", async () => {
        loginAs("ADMIN");
        const rows = await GetAllUsers();
        expect(rows.length).toBe(3);

        logout();
        expect(await GetAllUsers()).toEqual([]);
    });

    it("GetAllUsers flags stored credentials without exposing the hashes", async () => {
        loginAs("ADMIN");
        const rows = await GetAllUsers();

        const admin = rows.find(u => u.email === "carlos@test.local")!;
        expect(admin.hasPassword).toBe(true);
        expect(admin).not.toHaveProperty("password");
        expect(admin).not.toHaveProperty("pin");

        const staff = rows.find(u => u.name === "Maria Lopez Garcia")!;
        expect(staff.hasPin).toBe(true);
    });

    it("generates an email for ADMIN users created without one", async () => {
        loginAs("ADMIN");
        const res = await saveUser({ name: "Pedro Gomez Luna", role: "ADMIN", password: "clave123", active: true });
        expect(res).toMatchObject({ success: true });

        const row = await prisma.users.findFirstOrThrow({ where: { name: "Pedro Gomez Luna" } });
        expect(row.email).toBe(`${row.username!.toLowerCase()}@demo.com`);
    });

    it("keeps the stored pin when a STAFF user is updated with a blank pin", async () => {
        loginAs("ADMIN");
        const before = await prisma.users.findFirstOrThrow({ where: { name: "Maria Lopez Garcia" } });

        const res = await saveUser({ id: before.id, name: "Maria Editada Garcia", role: "STAFF", pin: null, password: null });
        expect(res).toMatchObject({ success: true });

        const after = await prisma.users.findUniqueOrThrow({ where: { id: before.id } });
        expect(after.name).toBe("Maria Editada Garcia");
        expect(after.pin).toBe(before.pin);
    });

    it("rejects creating a STAFF user with a 3-digit PIN", async () => {
        loginAs("ADMIN");
        const res = await saveUser({
            name: "Lucas Diaz Mora",
            role: "STAFF",
            pin: "123",
            active: true,
        });
        expect(res.success).toBe(false);
        expect(res.fieldErrors?.pin).toBeDefined();
    });

    it("requires a new credential when changing roles and preserves usable email on promotion", async () => {
        loginAs("ADMIN");
        // Create staff user without email
        const staffRes = await saveUser({
            name: "Fernanda Rios Nava",
            role: "STAFF",
            pin: "9876",
            active: true,
        });
        expect(staffRes).toMatchObject({ success: true });
        const staffUser = await prisma.users.findFirstOrThrow({ where: { name: "Fernanda Rios Nava" } });
        expect(staffUser.email).toBeNull();
        expect(staffUser.pin).not.toBeNull();

        // Attempt promoting to ADMIN without providing a password: must fail
        const failPromo = await saveUser({
            id: staffUser.id,
            name: staffUser.name,
            role: "ADMIN",
            password: "",
        });
        expect(failPromo.success).toBe(false);
        expect(failPromo.fieldErrors?.password).toBeDefined();

        // Promote to ADMIN with valid password: must clear PIN and save usable email
        const successPromo = await saveUser({
            id: staffUser.id,
            name: staffUser.name,
            role: "ADMIN",
            password: "adminpass123",
        });
        expect(successPromo).toMatchObject({ success: true });

        const promotedUser = await prisma.users.findUniqueOrThrow({ where: { id: staffUser.id } });
        expect(promotedUser.role).toBe("ADMIN");
        expect(promotedUser.pin).toBeNull();
        expect(promotedUser.password).not.toBeNull();
        expect(promotedUser.email).toBe(`${staffUser.username!.toLowerCase()}@demo.com`);
    });

    it("rejects invalid roles other than ADMIN or STAFF", async () => {
        loginAs("ADMIN");
        const res = await saveUser({
            name: "Gerente Prueba Lopez",
            role: "MANAGER" as any,
            password: "password123",
            active: true,
        });
        expect(res.success).toBe(false);
        expect(res.fieldErrors?.role).toBeDefined();
    });

    it("rejects short or whitespace passwords when updating ADMIN", async () => {
        loginAs("ADMIN");
        const createRes = await saveUser({
            name: "Admin Seguridad Diaz",
            role: "ADMIN",
            password: "initialpass123",
            active: true,
        });
        expect(createRes).toMatchObject({ success: true });
        const user = await prisma.users.findFirstOrThrow({ where: { name: "Admin Seguridad Diaz" } });

        const updateRes = await saveUser({
            id: user.id,
            name: user.name,
            role: "ADMIN",
            password: " 12 ",
        });
        expect(updateRes.success).toBe(false);
        expect(updateRes.fieldErrors?.password).toBeDefined();

        const updateSpacesRes = await saveUser({
            id: user.id,
            name: user.name,
            role: "ADMIN",
            password: "    ",
        });
        expect(updateSpacesRes.success).toBe(false);
    });

    it("rejects invalid email formats and names exceeding 50 characters", async () => {
        loginAs("ADMIN");
        const resEmail = await saveUser({
            name: "Valido Prueba Lopez",
            role: "ADMIN",
            email: "correo-invalido",
            password: "validpass123",
            active: true,
        });
        expect(resEmail.success).toBe(false);
        expect(resEmail.fieldErrors?.email).toBeDefined();

        const resLongName = await saveUser({
            name: "A".repeat(55),
            role: "STAFF",
            pin: "1234",
            active: true,
        });
        expect(resLongName.success).toBe(false);
        expect(resLongName.fieldErrors?.name).toBeDefined();
    });

    it("rejects id: 0 instead of silently creating a new user", async () => {
        loginAs("ADMIN");
        const res = await saveUser({
            id: 0,
            name: "Carlos Cero Perez",
            role: "STAFF",
            pin: "1234",
            active: true,
        });
        expect(res.success).toBe(false);
        expect(res.fieldErrors?.id).toBeDefined();
    });

    it("persists email when creating a STAFF user and generates username when demoting ADMIN to STAFF", async () => {
        loginAs("ADMIN");
        // 1. Persist email on STAFF create
        const staffRes = await saveUser({
            name: "Elena Diaz Ramos",
            role: "STAFF",
            pin: "4321",
            email: "elena.diaz@example.com",
            active: true,
        });
        expect(staffRes).toMatchObject({ success: true });
        const createdStaff = await prisma.users.findFirstOrThrow({ where: { name: "Elena Diaz Ramos" } });
        expect(createdStaff.email).toBe("elena.diaz@example.com");

        // 2. Demoting ADMIN without username generates username for STAFF login
        const adminWithoutUsername = await prisma.users.create({
            data: {
                name: "Admin Sin Username Lopez",
                role: "ADMIN",
                active: true,
                email: "adminsinuser@example.com",
                password: "hashedpassword",
                username: null,
            }
        });

        const demoteRes = await saveUser({
            id: adminWithoutUsername.id,
            role: "STAFF",
            pin: "5555",
        });
        expect(demoteRes).toMatchObject({ success: true });
        const demotedStaff = await prisma.users.findUniqueOrThrow({ where: { id: adminWithoutUsername.id } });
        expect(demotedStaff.role).toBe("STAFF");
        expect(demotedStaff.pin).not.toBeNull();
        expect(demotedStaff.username).toBeTruthy();
    });

    it("requires surnames and rejects single-word user names", async () => {
        loginAs("ADMIN");
        // Single-word name like "Pedro" must be rejected
        const resSingle = await saveUser({
            name: "Pedro",
            role: "STAFF",
            pin: "1234",
            active: true,
        });
        expect(resSingle.success).toBe(false);
        expect(resSingle.fieldErrors?.name).toBeDefined();

        // Name with surname must be accepted
        const resFull = await saveUser({
            name: "Pedro Alvarez",
            role: "STAFF",
            pin: "1234",
            active: true,
        });
        expect(resFull).toMatchObject({ success: true });
        const created = await prisma.users.findFirstOrThrow({ where: { name: "Pedro Alvarez" } });
        expect(created.username).toBeTruthy();
    });
});
