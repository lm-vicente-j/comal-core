import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { getSalesHistory } from "@/lib/actions/sales";
import { getAllDebtors, payAccount, getDebtorHistory, toDebt } from "@/lib/actions/debts";
import { SaleStatus } from "@/app/generated/prisma/enums";

describe("Adversarial Findings Reproduction Tests (Must Fail Against Current Code)", () => {
    let adminId: number;
    let staffId: number;
    let customerId: number;
    let productId: number;
    let openJornadaId: number;

    beforeAll(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        openJornadaId = jornada.id;

        const staff = await prisma.users.create({
            data: {
                name: "Staff User",
                email: "staff@test.local",
                role: "STAFF",
                active: true,
                password: "hashed_staff_password_123",
                pin: "5678",
            },
        });
        staffId = staff.id;

        // Give admin sensitive credentials to test leak
        await prisma.users.update({
            where: { id: adminId },
            data: {
                password: "$2a$12$e8YkYx4w...super_secret_admin_hash",
                pin: "9999",
            },
        });

        const product = await prisma.products.create({
            data: { name: "Tacos Adversarial", price: 50 },
        });
        productId = product.id;

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Adversarial", phone: "555-0000", currentBalance: 0 },
        });
        customerId = customer.id;
    });

    /**
     * FALLO 1 (Crítico): Fuga de credenciales (password / pin) en getSalesHistory
     * Cuando un usuario con rol STAFF consulta el historial de ventas, el objeto de usuario
     * asociado a la venta NO debe exponer campos confidenciales (password hash, pin).
     */
    it("FALLO 1: getSalesHistory should redact password and pin hashes for STAFF users", async () => {
        // Create a sale placed by admin
        const sale = await prisma.sales.create({
            data: {
                status: "PAID",
                payment_method: "CASH",
                total: 50,
                placedBy: adminId,
                customerID: customerId,
                jornadaId: openJornadaId,
            },
        });

        loginAs("STAFF", staffId);
        const history = await getSalesHistory();

        expect(history.length).toBeGreaterThan(0);
        const foundSale = history.find((s) => s.id === sale.id);
        expect(foundSale).toBeDefined();

        // DEBE FALLAR: Actualmente users: true expone password y pin al frontend de STAFF
        expect((foundSale?.users as any)?.password).toBeUndefined();
        expect((foundSale?.users as any)?.pin).toBeUndefined();
    });

    /**
     * FALLO 2 (Alta): Excepción no capturada en getAllDebtors por entradas fuera de rango
     * Parámetros inválidos como page: 0 o search excesivo deben ser manejados defensivamente
     * sin lanzar una excepción ZodError no capturada (HTTP 500 / rejection).
     */
    it("FALLO 2: getAllDebtors should safely handle out-of-range pagination options without throwing unhandled ZodError", async () => {
        loginAs("ADMIN", adminId);

        // DEBE FALLAR: PaginationOptionsSchema.parse(options) lanza ZodError en lugar de manejarlo de forma segura
        await expect(getAllDebtors({ page: 0 } as any)).resolves.not.toThrow();
        await expect(getAllDebtors({ pageSize: 100 } as any)).resolves.not.toThrow();
        await expect(getAllDebtors({ search: "x".repeat(105) } as any)).resolves.not.toThrow();
    });

    /**
     * FALLO 3 (Media): Paginación fuera de rango / páginas vacías en getAllDebtors
     * Cuando se solicita una página superior al total de páginas disponibles (p. ej. page 2 de 1),
     * el backend debe ajustar la página a totalPages y retornar los registros existentes en lugar de items vacíos.
     */
    it("FALLO 3: getAllDebtors should clamp page to totalPages when page exceeds available range", async () => {
        loginAs("ADMIN", adminId);

        // Crear una deuda activa para el cliente usando toDebt
        const sale = await prisma.sales.create({
            data: {
                status: "UNPAID",
                payment_method: "CASH",
                total: 100,
                placedBy: adminId,
                customerID: customerId,
                jornadaId: openJornadaId,
            },
        });
        await toDebt(customerId, [{ id: sale.id, total: 100 } as any]);

        // Solo hay 1 deudor activo, por lo que totalPages = 1
        const result = await getAllDebtors({ page: 2, pageSize: 10 });

        // DEBE FALLAR: Actualmente retorna page: 2 e items: [] dejando al usuario varado en una página vacía
        expect(result.page).toBeLessThanOrEqual(result.totalPages);
        expect(result.items.length).toBeGreaterThan(0);
    });

    /**
     * FALLO 4 (Alta): Condición de carrera en pagos concurrentes en payAccount
     * Si dos peticiones leen las ventas en DEBT concurrentemente antes de que la transacción
     * actualice el estado a PAID, ambas ejecutan decrement sin validación atómica ni bloqueo,
     * dejando el saldo del cliente en negativo.
     */
    it("FALLO 4: payAccount should prevent race condition and double decrement on concurrent payments", async () => {
        loginAs("ADMIN", adminId);

        // Crear cliente con deuda exacta de 200
        const testCustomer = await prisma.customer.create({
            data: {
                customerName: "Cliente Concurrente",
                phone: "111-222",
                currentBalance: 0,
            },
        });

        const debtSale = await prisma.sales.create({
            data: {
                status: "UNPAID",
                payment_method: "CASH",
                total: 200,
                placedBy: adminId,
                customerID: testCustomer.id,
                jornadaId: openJornadaId,
            },
        });
        await toDebt(testCustomer.id, [{ id: debtSale.id, total: 200 } as any]);

        // Simular concurrencia interceptando temporalmente findMany para que ambas peticiones
        // lean el estado DEBT antes de que se complete la primera transacción
        const originalFindMany = prisma.sales.findMany;
        let readCount = 0;
        vi.spyOn(prisma.sales, "findMany").mockImplementation(async (args: any) => {
            const res = await originalFindMany.call(prisma.sales, args);
            // Simular un pequeño retraso de red concurrente de 50ms en la lectura de ventas
            if (args?.where?.status === "DEBT") {
                readCount++;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return res;
        });

        try {
            await Promise.all([
                payAccount(testCustomer.id, [{ id: debtSale.id } as any], "CASH"),
                payAccount(testCustomer.id, [{ id: debtSale.id } as any], "CASH"),
            ]);

            const customerAfter = await prisma.customer.findUniqueOrThrow({
                where: { id: testCustomer.id },
            });

            // DEBE FALLAR: Ambas transacciones leen DEBT en paralelo y decrementan 200 cada una,
            // dejando el saldo en -200 (violación de integridad financiera)
            expect(Number(customerAfter.currentBalance)).toBeGreaterThanOrEqual(0);
            expect(Number(customerAfter.currentBalance)).toBe(0);
        } finally {
            vi.restoreAllMocks();
        }
    });

    /**
     * FALLO 5 (Baja/Media): Inconsistencia de firma de retorno en getDebtorHistory
     * getDebtorHistory debe respetar el envoltorio estándar { success: true, data: ... }
     * o { success: false, error: ... } de las demás server actions.
     */
    it("FALLO 5: getDebtorHistory should return a standard response envelope with success and data", async () => {
        loginAs("ADMIN", adminId);

        const result = await getDebtorHistory(99999);

        // DEBE FALLAR: Actualmente retorna null o el modelo crudo de Prisma en lugar de { success: true, data: ... }
        expect(result).toHaveProperty("success");
    });
});
