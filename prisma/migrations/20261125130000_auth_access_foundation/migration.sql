ALTER TABLE "users"
  ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "pinLookupHash" VARCHAR(64);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "users" WHERE "role" IS NULL OR "role" NOT IN ('ADMIN', 'SUPERVISOR', 'STAFF')) THEN
    RAISE EXCEPTION 'Invalid or null user roles exist; resolve them explicitly before applying auth foundation';
  END IF;
END $$;

CREATE UNIQUE INDEX "users_pinLookupHash_key" ON "users"("pinLookupHash");
-- Existing duplicate or malformed administrator data intentionally blocks migration;
-- operators must resolve it explicitly rather than selecting an owner automatically.
CREATE UNIQUE INDEX "users_single_admin_idx" ON "users" (("role")) WHERE "role" = 'ADMIN';

CREATE TABLE "installationState" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "initializedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "installationState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "installationState_singleton_check" CHECK ("id" = 1)
);
INSERT INTO "installationState" ("id", "initializedAt", "updatedAt")
SELECT 1,
  CASE WHEN EXISTS (SELECT 1 FROM "users")
          OR EXISTS (SELECT 1 FROM "sales")
          OR EXISTS (SELECT 1 FROM "products")
          OR EXISTS (SELECT 1 FROM "customer")
          OR EXISTS (SELECT 1 FROM "setting")
          OR EXISTS (SELECT 1 FROM "jornada")
          OR EXISTS (SELECT 1 FROM "supplies")
          OR EXISTS (SELECT 1 FROM "recipes")
          OR EXISTS (SELECT 1 FROM "salary")
          OR EXISTS (SELECT 1 FROM "debtors")
          OR EXISTS (SELECT 1 FROM "sale_items")
          OR EXISTS (SELECT 1 FROM "sale_item_consumptions")
          OR EXISTS (SELECT 1 FROM "savings_movement")
          OR EXISTS (SELECT 1 FROM "savings_goal")
          OR EXISTS (SELECT 1 FROM "goal_contribution")
       THEN CURRENT_TIMESTAMP ELSE NULL END,
  CURRENT_TIMESTAMP;

CREATE TABLE "rolePermission" (
  "id" SERIAL NOT NULL,
  "role" VARCHAR(40) NOT NULL,
  "capability" VARCHAR(80) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "rolePermission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "rolePermission_role_capability_key" ON "rolePermission"("role", "capability");
CREATE INDEX "rolePermission_role_idx" ON "rolePermission"("role");

CREATE TYPE "TerminalType" AS ENUM ('FIXED', 'MOBILE');
CREATE TYPE "TerminalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

CREATE TABLE "terminal" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" VARCHAR(80) NOT NULL,
  "type" "TerminalType" NOT NULL,
  "tokenHash" VARCHAR(64) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "credentialVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "terminal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "terminal_tokenHash_key" ON "terminal"("tokenHash");

CREATE TABLE "terminalRequest" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "browserTokenHash" VARCHAR(64) NOT NULL,
  "status" "TerminalRequestStatus" NOT NULL DEFAULT 'PENDING',
  "terminalId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "terminalRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "terminalRequest_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "terminal"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "terminalRequest_status_expiresAt_idx" ON "terminalRequest"("status", "expiresAt");
CREATE INDEX "terminalRequest_browserTokenHash_createdAt_idx" ON "terminalRequest"("browserTokenHash", "createdAt");

CREATE TABLE "terminalSession" (
  "terminalId" UUID NOT NULL,
  "sessionId" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "terminalSession_pkey" PRIMARY KEY ("terminalId", "sessionId"),
  CONSTRAINT "terminalSession_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "terminalSession_sessionId_idx" ON "terminalSession"("sessionId");

CREATE TABLE "securityAudit" (
  "id" SERIAL NOT NULL,
  "actorId" INTEGER,
  "action" VARCHAR(80) NOT NULL,
  "subjectId" VARCHAR(80),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "securityAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "securityAudit_createdAt_idx" ON "securityAudit"("createdAt");
CREATE INDEX "securityAudit_actorId_createdAt_idx" ON "securityAudit"("actorId", "createdAt");

CREATE TABLE "authRateLimit" (
  "key" VARCHAR(160) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "windowEnds" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "authRateLimit_pkey" PRIMARY KEY ("key")
);
