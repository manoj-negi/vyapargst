-- Additive: optional per-document Section / Department. Existing rows get NULL; nothing else changes.
ALTER TABLE "SaleInvoice" ADD COLUMN "department" TEXT;

CREATE INDEX "SaleInvoice_businessId_customerId_department_idx" ON "SaleInvoice"("businessId", "customerId", "department");
