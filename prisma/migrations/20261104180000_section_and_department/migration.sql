-- Additive: Section and Department become separate optional fields on sale documents.
-- Existing values in "department" were entered (or backfilled) under the combined label
-- "Section / Department", so they are flagged as unclassified instead of being guessed.
-- The text itself is not changed; it is classified later from recorded evidence
-- (npm run classify:sections) or by the user when editing the invoice.
ALTER TABLE "SaleInvoice" ADD COLUMN "section" TEXT;
ALTER TABLE "SaleInvoice" ADD COLUMN "legacySectionDepartment" BOOLEAN NOT NULL DEFAULT false;
UPDATE "SaleInvoice" SET "legacySectionDepartment" = true WHERE "department" IS NOT NULL;

CREATE INDEX "SaleInvoice_businessId_customerId_section_idx" ON "SaleInvoice"("businessId", "customerId", "section");
-- Previous-discount lookups go from the item to its saved invoice lines
CREATE INDEX "SaleInvoiceItem_productId_idx" ON "SaleInvoiceItem"("productId");
