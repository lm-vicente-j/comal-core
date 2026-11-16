-- Cash cut rework: payment methods on every money movement and full debt
-- history (jornada and time of creation and collection).
--
-- The new NOT NULL columns have no backfill: apply this on an empty or freshly
-- reseeded database. Existing rows in bill, salary or debtors make it fail.

-- sales.payment_method: varchar -> PaymentMethod enum. The cast is strict: a
-- value other than CASH/TRANSFER aborts the migration instead of becoming NULL.
ALTER TABLE "sales"
    ALTER COLUMN "payment_method" TYPE "PaymentMethod"
    USING ("payment_method"::"PaymentMethod");

-- bill and salary: how each payment was made. A salary also records the jornada
-- it was paid in so it takes part in that jornada's cut.
ALTER TABLE "bill" ADD COLUMN "payment_method" "PaymentMethod" NOT NULL;

ALTER TABLE "salary"
    ADD COLUMN "jornadaId" INTEGER NOT NULL,
    ADD COLUMN "payment_method" "PaymentMethod" NOT NULL;

-- jornada: expected transfers of the shift, saved at close.
ALTER TABLE "jornada" ADD COLUMN "expectedTransferAmount" DECIMAL;

-- debtors: paidAt gains a time of day, and each debt records the jornada where
-- it was granted and, once collected, the jornada and employee that took the money.
ALTER TABLE "debtors"
    ALTER COLUMN "paidAt" SET DATA TYPE TIMESTAMP(6),
    ADD COLUMN "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "createdJornadaId" INTEGER NOT NULL,
    ADD COLUMN "paidJornadaId" INTEGER,
    ADD COLUMN "collectedBy" INTEGER;

CREATE INDEX "debtors_createdJornadaId_idx" ON "debtors"("createdJornadaId");
CREATE INDEX "debtors_paidJornadaId_idx" ON "debtors"("paidJornadaId");
CREATE INDEX "salary_jornadaId_idx" ON "salary"("jornadaId");

ALTER TABLE "debtors" ADD CONSTRAINT "debtors_createdJornadaId_fkey" FOREIGN KEY ("createdJornadaId") REFERENCES "jornada"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "debtors" ADD CONSTRAINT "debtors_paidJornadaId_fkey" FOREIGN KEY ("paidJornadaId") REFERENCES "jornada"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "debtors" ADD CONSTRAINT "debtors_collectedBy_fkey" FOREIGN KEY ("collectedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "salary" ADD CONSTRAINT "salary_jornadaId_fkey" FOREIGN KEY ("jornadaId") REFERENCES "jornada"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
