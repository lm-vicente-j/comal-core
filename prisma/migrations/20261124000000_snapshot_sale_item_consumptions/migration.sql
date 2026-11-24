BEGIN;

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN "consumptionRecorded" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "sale_item_consumptions" (
    "saleItemID" INTEGER NOT NULL,
    "supplyID" INTEGER NOT NULL,
    "quantityUsedMilliunits" BIGINT NOT NULL,

    CONSTRAINT "sale_item_consumptions_pkey" PRIMARY KEY ("saleItemID","supplyID")
);

-- CreateIndex
CREATE INDEX "sale_item_consumptions_supplyID_idx" ON "sale_item_consumptions"("supplyID");

-- AddForeignKey
ALTER TABLE "sale_item_consumptions" ADD CONSTRAINT "sale_item_consumptions_saleItemID_fkey" FOREIGN KEY ("saleItemID") REFERENCES "sale_items"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sale_item_consumptions" ADD CONSTRAINT "sale_item_consumptions_supplyID_fkey" FOREIGN KEY ("supplyID") REFERENCES "supplies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT;
