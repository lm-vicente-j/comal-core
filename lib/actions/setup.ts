"use server";

import { TextEncoder } from "node:util";
import bcrypt from "bcryptjs";
import { z } from "zod";
import prisma from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { actionFail, actionOk, type ActionResult } from "@/lib/action-result";
import { constantTimeEqual } from "@/lib/auth-crypto";

const ownerSchema = z.object({
  name: z.string().trim().min(2).max(50),
  email: z.string().trim().email().max(150),
  password: z.string().min(12),
  confirmPassword: z.string().min(12),
  installSecret: z.string().min(1),
});

function installationSecret(): string | null {
  const secret = process.env.INSTALLATION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

async function migrationsComplete(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<Array<{ ready: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM "_prisma_migrations"
        WHERE "migration_name" = '20261125130000_auth_access_foundation'
          AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
      ) AND NOT EXISTS (
        SELECT 1 FROM "_prisma_migrations"
        WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL
      ) AS ready`;
    return rows[0]?.ready === true;
  } catch {
    return false;
  }
}

async function hasBusinessData(db: typeof prisma | Prisma.TransactionClient = prisma): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ populated: boolean }>>`
    SELECT (
      EXISTS (SELECT 1 FROM "users") OR EXISTS (SELECT 1 FROM "sales") OR
      EXISTS (SELECT 1 FROM "products") OR EXISTS (SELECT 1 FROM "customer") OR
      EXISTS (SELECT 1 FROM "setting") OR EXISTS (SELECT 1 FROM "jornada") OR
      EXISTS (SELECT 1 FROM "supplies") OR EXISTS (SELECT 1 FROM "recipes") OR
      EXISTS (SELECT 1 FROM "salary") OR EXISTS (SELECT 1 FROM "debtors") OR
      EXISTS (SELECT 1 FROM "bill") OR EXISTS (SELECT 1 FROM "sale_items") OR
      EXISTS (SELECT 1 FROM "sale_item_consumptions") OR EXISTS (SELECT 1 FROM "savings_movement") OR
      EXISTS (SELECT 1 FROM "savings_goal") OR EXISTS (SELECT 1 FROM "goal_contribution")
    ) AS populated`;
  return rows[0]?.populated === true;
}

export async function getSetupStatus(): Promise<{ available: boolean }> {
  try {
    const [state, users, migrationReady] = await Promise.all([
      prisma.installationState.findUnique({ where: { id: 1 } }),
      prisma.users.count(),
      migrationsComplete(),
    ]);
    return { available: Boolean(installationSecret() && migrationReady && state && !state.initializedAt && users === 0 && !(await hasBusinessData())) };
  } catch {
    return { available: false };
  }
}

export async function createInitialOwner(formData: FormData): Promise<ActionResult> {
  if (!formData || typeof formData.get !== "function") return actionFail("INVALID_INPUT");
  const parsed = ownerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
    installSecret: formData.get("installSecret"),
  });
  if (!parsed.success) return actionFail("INVALID_INPUT", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
  const data = parsed.data;
  const expectedSecret = installationSecret();
  if (!expectedSecret || !constantTimeEqual(data.installSecret, expectedSecret)) return actionFail("INVALID_INSTALLATION_SECRET");
  if (data.password !== data.confirmPassword) return actionFail("PASSWORDS_DO_NOT_MATCH", { fieldErrors: { confirmPassword: ["Passwords do not match"] } });
  if (new TextEncoder().encode(data.password).byteLength > 72) return actionFail("PASSWORD_TOO_LONG", { fieldErrors: { password: ["Password must be at most 72 bytes"] } });

  const email = data.email.toLowerCase();
  const password = await bcrypt.hash(data.password, 12);
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(742910284611)`;
      const marker = await tx.installationState.findUnique({ where: { id: 1 } });
      if (!marker || marker.initializedAt) return false;
      const migrationRows = await tx.$queryRaw<Array<{ ready: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM "_prisma_migrations"
          WHERE "migration_name" = '20261125130000_auth_access_foundation'
            AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
        ) AND NOT EXISTS (
          SELECT 1 FROM "_prisma_migrations"
          WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL
        ) AS ready`;
      if (migrationRows[0]?.ready !== true || await tx.users.count() !== 0 || await hasBusinessData(tx)) return false;
      await tx.users.create({
        data: { name: data.name, email, password, role: "ADMIN", active: true, credentialVersion: 1 },
      });
      await tx.installationState.update({ where: { id: 1 }, data: { initializedAt: new Date() } });
      await tx.securityAudit.create({ data: { action: "INITIAL_OWNER_CREATED", subjectId: email } });
      return true;
    }, { isolationLevel: "Serializable" });
    return result ? actionOk() : actionFail("SETUP_UNAVAILABLE");
  } catch (error) {
    console.error("Initial owner creation failed", error);
    return actionFail("SETUP_UNAVAILABLE");
  }
}
