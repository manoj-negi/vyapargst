-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "conversionRate" DECIMAL(12,4),
ADD COLUMN     "imagePath" TEXT,
ADD COLUMN     "minWholesaleQty" DECIMAL(12,2),
ADD COLUMN     "openingStockDate" TIMESTAMP(3),
ADD COLUMN     "openingStockPrice" DECIMAL(12,2),
ADD COLUMN     "purchasePriceType" "PriceType" NOT NULL DEFAULT 'EXCLUSIVE',
ADD COLUMN     "secondaryUnitId" TEXT,
ADD COLUMN     "stockLocation" TEXT,
ADD COLUMN     "wholesalePrice" DECIMAL(12,2),
ADD COLUMN     "wholesalePriceType" "PriceType" NOT NULL DEFAULT 'EXCLUSIVE';

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_secondaryUnitId_fkey" FOREIGN KEY ("secondaryUnitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

