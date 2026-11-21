BEGIN;

ALTER TABLE "sales" ADD COLUMN "ticketAccountId" UUID;

WITH accounts AS (
    SELECT sale."jornadaId", sale."source_type", gen_random_uuid() AS account_id
    FROM "sales" AS sale
    JOIN "jornada" AS shift ON shift."id" = sale."jornadaId"
    WHERE shift."status" = 'OPEN'
      AND sale."status" = 'UNPAID'
      AND sale."source_type" ~ '^VL-[1-9][0-9]*$'
    GROUP BY sale."jornadaId", sale."source_type"
)
UPDATE "sales" AS sale
SET "ticketAccountId" = accounts.account_id
FROM accounts
WHERE sale."jornadaId" = accounts."jornadaId"
  AND sale."source_type" = accounts."source_type"
  AND sale."status" = 'UNPAID'
  AND sale."ticketAccountId" IS NULL;

COMMIT;
