ALTER TABLE "cash_count"
  ADD COLUMN "outgoingOperatorName" VARCHAR(50),
  ADD COLUMN "incomingOperatorId" INTEGER,
  ADD COLUMN "incomingOperatorName" VARCHAR(50),
  ADD CONSTRAINT "cash_count_incomingOperatorId_fkey" FOREIGN KEY ("incomingOperatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "cash_count_handover_participants_check" CHECK (
    ("type" = 'HANDOVER' AND "incomingOperatorId" IS NOT NULL AND "incomingOperatorId" <> "operatorId" AND "recountOfId" IS NULL)
    OR ("type" <> 'HANDOVER' AND "incomingOperatorId" IS NULL AND "incomingOperatorName" IS NULL AND "outgoingOperatorName" IS NULL)
  );
