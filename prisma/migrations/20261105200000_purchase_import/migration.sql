-- Additive: AI purchase-bill import (drafts, their documents, remembered supplier item matches,
-- purchase-price history). New tables only; existing tables and rows are unchanged.

-- CreateTable
CREATE TABLE "PurchaseImport" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "documentKind" TEXT,
    "extractor" TEXT,
    "sourceData" JSONB,
    "extracted" JSONB,
    "draft" JSONB,
    "error" TEXT,
    "purchaseId" TEXT,
    "createdById" TEXT,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseImportFile" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "detectedType" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "pageCount" INTEGER,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseImportFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierItemMap" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "supplierCode" TEXT,
    "description" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "billUnit" TEXT,
    "unitFactor" DECIMAL(12,4) NOT NULL DEFAULT 1,
    "lastImportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierItemMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPriceHistory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "field" TEXT NOT NULL DEFAULT 'purchasePrice',
    "oldValue" DECIMAL(12,2),
    "oldPriceType" "PriceType",
    "newValue" DECIMAL(12,2) NOT NULL,
    "newPriceType" "PriceType" NOT NULL,
    "sourceDocId" TEXT,
    "sourceImportId" TEXT,
    "note" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseImport_purchaseId_key" ON "PurchaseImport"("purchaseId");

-- CreateIndex
CREATE INDEX "PurchaseImport_businessId_status_createdAt_idx" ON "PurchaseImport"("businessId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PurchaseImportFile_sha256_idx" ON "PurchaseImportFile"("sha256");

-- CreateIndex
CREATE INDEX "PurchaseImportFile_importId_idx" ON "PurchaseImportFile"("importId");

-- CreateIndex
CREATE INDEX "SupplierItemMap_productId_idx" ON "SupplierItemMap"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierItemMap_businessId_supplierId_matchKey_key" ON "SupplierItemMap"("businessId", "supplierId", "matchKey");

-- CreateIndex
CREATE INDEX "ProductPriceHistory_productId_createdAt_idx" ON "ProductPriceHistory"("productId", "createdAt");

-- AddForeignKey
ALTER TABLE "PurchaseImport" ADD CONSTRAINT "PurchaseImport_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseImport" ADD CONSTRAINT "PurchaseImport_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "SaleInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseImportFile" ADD CONSTRAINT "PurchaseImportFile_importId_fkey" FOREIGN KEY ("importId") REFERENCES "PurchaseImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierItemMap" ADD CONSTRAINT "SupplierItemMap_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierItemMap" ADD CONSTRAINT "SupplierItemMap_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierItemMap" ADD CONSTRAINT "SupplierItemMap_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPriceHistory" ADD CONSTRAINT "ProductPriceHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

