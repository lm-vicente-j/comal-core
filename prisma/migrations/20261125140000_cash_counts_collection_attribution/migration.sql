ALTER TABLE "sales"
  ADD COLUMN "paidAt" TIMESTAMP(6),
  ADD COLUMN "paidJornadaId" INTEGER,
  ADD COLUMN "collectedBy" INTEGER;

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_paidJornadaId_fkey" FOREIGN KEY ("paidJornadaId") REFERENCES "jornada"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "sales_collectedBy_fkey" FOREIGN KEY ("collectedBy") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX "sales_paidJornadaId_idx" ON "sales"("paidJornadaId");

CREATE TYPE "CashCountType" AS ENUM ('OPENING', 'INTERIM', 'CLOSING');
CREATE TABLE "cash_count" (
  "id" SERIAL NOT NULL,
  "jornadaId" INTEGER NOT NULL,
  "type" "CashCountType" NOT NULL,
  "operatorId" INTEGER NOT NULL,
  "cutoffAt" TIMESTAMP(6) NOT NULL,
  "denominations" JSONB NOT NULL,
  "note" VARCHAR(1000),
  "recountOfId" INTEGER,
  "requestId" UUID NOT NULL,
  "payloadHash" VARCHAR(64) NOT NULL,
  "countedAmountCents" BIGINT NOT NULL,
  "expectedAmountCents" BIGINT NOT NULL,
  "differenceCents" BIGINT NOT NULL,
  "toleranceCents" BIGINT NOT NULL,
  "cashSummary" JSONB NOT NULL,
  CONSTRAINT "cash_count_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cash_count_jornadaId_fkey" FOREIGN KEY ("jornadaId") REFERENCES "jornada"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "cash_count_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "cash_count_recountOfId_fkey" FOREIGN KEY ("recountOfId") REFERENCES "cash_count"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "cash_count_requestId_key" ON "cash_count"("requestId");
CREATE INDEX "cash_count_jornadaId_cutoffAt_idx" ON "cash_count"("jornadaId", "cutoffAt");
CREATE INDEX "cash_count_operatorId_cutoffAt_idx" ON "cash_count"("operatorId", "cutoffAt");
CREATE INDEX "cash_count_type_cutoffAt_idx" ON "cash_count"("type", "cutoffAt");

CREATE FUNCTION prevent_cash_count_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CASH_COUNT_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER "CASH_COUNT_IMMUTABLE"
  BEFORE UPDATE OR DELETE ON "cash_count"
  FOR EACH ROW EXECUTE FUNCTION prevent_cash_count_mutation();
