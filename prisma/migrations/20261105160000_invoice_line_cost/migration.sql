-- Additive: the cost basis used for a sale line when it was saved, so later purchase-price changes do
-- not silently change that invoice's estimated profit. Existing lines stay NULL (no historical cost is
-- invented); the profit panel labels those as estimated from current costs.
ALTER TABLE "SaleInvoiceItem" ADD COLUMN "unitCost" DECIMAL(12,4);
ALTER TABLE "SaleInvoiceItem" ADD COLUMN "costBasis" TEXT;
