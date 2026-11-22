BEGIN;

-- PostgreSQL ROUND(numeric) sends ties away from zero. Keep an even
-- truncated value when the discarded fraction is exactly half.
CREATE FUNCTION pg_temp.round_half_even(value numeric) RETURNS bigint
LANGUAGE SQL IMMUTABLE STRICT
AS $$
    SELECT CASE
        WHEN ABS(value - TRUNC(value)) = 0.5 AND MOD(TRUNC(value), 2) = 0
            THEN TRUNC(value)
        ELSE ROUND(value)
    END::bigint;
$$;

ALTER TABLE "bill"
    ALTER COLUMN "amount" TYPE BIGINT USING pg_temp.round_half_even("amount" * 100);
ALTER TABLE "bill" RENAME COLUMN "amount" TO "amountCents";

ALTER TABLE "customer"
    ALTER COLUMN "currentBalance" TYPE BIGINT USING pg_temp.round_half_even("currentBalance" * 100);
ALTER TABLE "customer" RENAME COLUMN "currentBalance" TO "currentBalanceCents";

ALTER TABLE "debtors"
    ALTER COLUMN "amount" TYPE BIGINT USING pg_temp.round_half_even("amount" * 100);
ALTER TABLE "debtors" RENAME COLUMN "amount" TO "amountCents";

ALTER TABLE "products"
    ALTER COLUMN "price" TYPE BIGINT USING pg_temp.round_half_even("price" * 100);
ALTER TABLE "products" RENAME COLUMN "price" TO "priceCents";

ALTER TABLE "recipes"
    ALTER COLUMN "quantityUsed" TYPE BIGINT USING pg_temp.round_half_even("quantityUsed" * 1000);
ALTER TABLE "recipes" RENAME COLUMN "quantityUsed" TO "quantityUsedMilliunits";

ALTER TABLE "salary"
    ALTER COLUMN "amount" TYPE BIGINT USING pg_temp.round_half_even("amount" * 100);
ALTER TABLE "salary" RENAME COLUMN "amount" TO "amountCents";

ALTER TABLE "sale_items"
    ALTER COLUMN "unitPrice" TYPE BIGINT USING pg_temp.round_half_even("unitPrice" * 100),
    ALTER COLUMN "subtotal" TYPE BIGINT USING pg_temp.round_half_even("subtotal" * 100);
ALTER TABLE "sale_items" RENAME COLUMN "unitPrice" TO "unitPriceCents";
ALTER TABLE "sale_items" RENAME COLUMN "subtotal" TO "subtotalCents";

ALTER TABLE "sales"
    ALTER COLUMN "total" TYPE BIGINT USING pg_temp.round_half_even("total" * 100);
ALTER TABLE "sales" RENAME COLUMN "total" TO "totalCents";

ALTER TABLE "supplies"
    ALTER COLUMN "currentStock" TYPE BIGINT USING pg_temp.round_half_even("currentStock" * 1000),
    ALTER COLUMN "unitCost" TYPE BIGINT USING pg_temp.round_half_even("unitCost" * 100);
ALTER TABLE "supplies" RENAME COLUMN "currentStock" TO "currentStockMilliunits";
ALTER TABLE "supplies" RENAME COLUMN "unitCost" TO "unitCostCents";

ALTER TABLE "jornada"
    ALTER COLUMN "openingAmount" TYPE BIGINT USING pg_temp.round_half_even("openingAmount" * 100),
    ALTER COLUMN "expectedClosingAmount" TYPE BIGINT USING pg_temp.round_half_even("expectedClosingAmount" * 100),
    ALTER COLUMN "actualClosingAmount" TYPE BIGINT USING pg_temp.round_half_even("actualClosingAmount" * 100),
    ALTER COLUMN "expectedTransferAmount" TYPE BIGINT USING pg_temp.round_half_even("expectedTransferAmount" * 100);
ALTER TABLE "jornada" RENAME COLUMN "openingAmount" TO "openingAmountCents";
ALTER TABLE "jornada" RENAME COLUMN "expectedClosingAmount" TO "expectedClosingAmountCents";
ALTER TABLE "jornada" RENAME COLUMN "actualClosingAmount" TO "actualClosingAmountCents";
ALTER TABLE "jornada" RENAME COLUMN "expectedTransferAmount" TO "expectedTransferAmountCents";

ALTER TABLE "savings_movement"
    ALTER COLUMN "amount" TYPE BIGINT USING pg_temp.round_half_even("amount" * 100);
ALTER TABLE "savings_movement" RENAME COLUMN "amount" TO "amountCents";

ALTER TABLE "savings_goal"
    ALTER COLUMN "targetAmount" TYPE BIGINT USING pg_temp.round_half_even("targetAmount" * 100);
ALTER TABLE "savings_goal" RENAME COLUMN "targetAmount" TO "targetAmountCents";

ALTER TABLE "goal_contribution"
    ALTER COLUMN "amount" TYPE BIGINT USING pg_temp.round_half_even("amount" * 100);
ALTER TABLE "goal_contribution" RENAME COLUMN "amount" TO "amountCents";

DROP FUNCTION pg_temp.round_half_even(numeric);

COMMIT;
