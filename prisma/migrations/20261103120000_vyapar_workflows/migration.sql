-- Additive migration: new columns are nullable or defaulted, no existing rows are modified or removed.

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('SALE_INVOICE', 'ESTIMATE', 'CREDIT_NOTE', 'PURCHASE_BILL', 'DEBIT_NOTE');

-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('CUSTOMER', 'SUPPLIER', 'BOTH');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('IN', 'OUT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockTransactionType" ADD VALUE 'SALE_RETURN';
ALTER TYPE "StockTransactionType" ADD VALUE 'PURCHASE_RETURN';
ALTER TYPE "StockTransactionType" ADD VALUE 'REVERSAL';

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "invoiceTerms" TEXT,
ADD COLUMN     "signaturePath" TEXT,
ADD COLUMN     "upiId" TEXT,
ADD COLUMN     "upiName" TEXT;

-- AlterTable
ALTER TABLE "BusinessSettings" ADD COLUMN     "creditNotePrefix" TEXT NOT NULL DEFAULT 'CN-',
ADD COLUMN     "debitNotePrefix" TEXT NOT NULL DEFAULT 'DN-',
ADD COLUMN     "estimatePrefix" TEXT NOT NULL DEFAULT 'EST-',
ADD COLUMN     "expensePrefix" TEXT NOT NULL DEFAULT 'EXP-',
ADD COLUMN     "paymentInPrefix" TEXT NOT NULL DEFAULT 'PI-',
ADD COLUMN     "paymentOutPrefix" TEXT NOT NULL DEFAULT 'PO-',
ADD COLUMN     "purchasePrefix" TEXT NOT NULL DEFAULT 'PB-';

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "openingBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "openingBalanceDate" TIMESTAMP(3),
ADD COLUMN     "partyType" "PartyType" NOT NULL DEFAULT 'CUSTOMER';

-- AlterTable
ALTER TABLE "SaleInvoice" ADD COLUMN     "adjustedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "businessSnapshot" JSONB,
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "chargesAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "chargesLabel" TEXT,
ADD COLUMN     "chargesTaxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "clientToken" TEXT,
ADD COLUMN     "convertedFromId" TEXT,
ADD COLUMN     "docType" "DocType" NOT NULL DEFAULT 'SALE_INVOICE',
ADD COLUMN     "invoiceDiscountType" "DiscountType",
ADD COLUMN     "invoiceDiscountValue" DECIMAL(12,2),
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "originalDocId" TEXT,
ADD COLUMN     "partyInvoiceDate" TIMESTAMP(3),
ADD COLUMN     "partyInvoiceNo" TEXT,
ADD COLUMN     "partySnapshot" JSONB,
ADD COLUMN     "terms" TEXT;

-- AlterTable
ALTER TABLE "SaleInvoiceItem" ADD COLUMN     "priceType" "PriceType";

-- CreateTable
CREATE TABLE "PaymentVoucher" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "partyId" TEXT,
    "direction" "PaymentDirection" NOT NULL,
    "voucherNo" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" DECIMAL(12,2) NOT NULL,
    "mode" "PaymentType" NOT NULL DEFAULT 'CASH',
    "reference" TEXT,
    "note" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ACTIVE',
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "clientToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentVoucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "expenseNo" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "mode" "PaymentType" NOT NULL DEFAULT 'CASH',
    "paidTo" TEXT,
    "note" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ACTIVE',
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "clientToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentVoucher_clientToken_key" ON "PaymentVoucher"("clientToken");

-- CreateIndex
CREATE INDEX "PaymentVoucher_businessId_date_idx" ON "PaymentVoucher"("businessId", "date");

-- CreateIndex
CREATE INDEX "PaymentVoucher_partyId_idx" ON "PaymentVoucher"("partyId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentVoucher_businessId_direction_voucherNo_key" ON "PaymentVoucher"("businessId", "direction", "voucherNo");

-- CreateIndex
CREATE INDEX "PaymentAllocation_documentId_idx" ON "PaymentAllocation"("documentId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_voucherId_idx" ON "PaymentAllocation"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_businessId_name_key" ON "ExpenseCategory"("businessId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_clientToken_key" ON "Expense"("clientToken");

-- CreateIndex
CREATE INDEX "Expense_businessId_date_idx" ON "Expense"("businessId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_businessId_expenseNo_key" ON "Expense"("businessId", "expenseNo");

-- CreateIndex
CREATE INDEX "AuditLog_businessId_entity_entityId_idx" ON "AuditLog"("businessId", "entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "SaleInvoice_convertedFromId_key" ON "SaleInvoice"("convertedFromId");

-- CreateIndex
CREATE UNIQUE INDEX "SaleInvoice_clientToken_key" ON "SaleInvoice"("clientToken");

-- CreateIndex
CREATE INDEX "SaleInvoice_businessId_docType_invoiceDate_idx" ON "SaleInvoice"("businessId", "docType", "invoiceDate");

-- CreateIndex
CREATE UNIQUE INDEX "SaleInvoice_businessId_docType_invoiceNo_key" ON "SaleInvoice"("businessId", "docType", "invoiceNo");

-- Invoice numbers are now unique per document type (every existing row is a SALE_INVOICE, so this only relaxes the rule)
DROP INDEX "SaleInvoice_businessId_invoiceNo_key";

-- AddForeignKey
ALTER TABLE "SaleInvoice" ADD CONSTRAINT "SaleInvoice_convertedFromId_fkey" FOREIGN KEY ("convertedFromId") REFERENCES "SaleInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleInvoice" ADD CONSTRAINT "SaleInvoice_originalDocId_fkey" FOREIGN KEY ("originalDocId") REFERENCES "SaleInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentVoucher" ADD CONSTRAINT "PaymentVoucher_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentVoucher" ADD CONSTRAINT "PaymentVoucher_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "PaymentVoucher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SaleInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Copy legacy per-invoice payments into payment vouchers + allocations (receivedAmount on the
-- invoices already includes them, so balances are unchanged).
INSERT INTO "PaymentVoucher" ("id", "businessId", "partyId", "direction", "voucherNo", "date", "amount", "mode", "note", "status", "createdAt")
SELECT 'legacy-' || p."id", i."businessId", i."customerId", 'IN',
       'PI-OLD-' || LPAD((ROW_NUMBER() OVER (PARTITION BY i."businessId" ORDER BY p."date", p."id"))::text, 4, '0'),
       p."date", p."amount", p."type", 'Migrated from invoice ' || i."invoiceNo", 'ACTIVE', p."date"
FROM "Payment" p JOIN "SaleInvoice" i ON i."id" = p."invoiceId";

INSERT INTO "PaymentAllocation" ("id", "voucherId", "documentId", "amount")
SELECT 'legacy-' || p."id", 'legacy-' || p."id", p."invoiceId", p."amount" FROM "Payment" p;

-- Any received amount on an invoice not backed by a payment row gets a voucher for the difference,
-- so every rupee in receivedAmount is traceable and recomputing balances never changes it.
INSERT INTO "PaymentVoucher" ("id", "businessId", "partyId", "direction", "voucherNo", "date", "amount", "mode", "note", "status", "createdAt")
SELECT 'unrecorded-' || i."id", i."businessId", i."customerId", 'IN',
       'PI-OLD-U' || LPAD((ROW_NUMBER() OVER (PARTITION BY i."businessId" ORDER BY i."invoiceDate", i."id"))::text, 4, '0'),
       i."invoiceDate", i."receivedAmount" - COALESCE(paid.sum, 0), 'CASH',
       'Received on invoice ' || i."invoiceNo" || ' (no payment record existed)', 'ACTIVE', i."invoiceDate"
FROM "SaleInvoice" i
LEFT JOIN (SELECT "invoiceId", SUM("amount") AS sum FROM "Payment" GROUP BY "invoiceId") paid ON paid."invoiceId" = i."id"
WHERE i."receivedAmount" > COALESCE(paid.sum, 0);

INSERT INTO "PaymentAllocation" ("id", "voucherId", "documentId", "amount")
SELECT 'unrecorded-' || i."id", 'unrecorded-' || i."id", i."id", i."receivedAmount" - COALESCE(paid.sum, 0)
FROM "SaleInvoice" i
LEFT JOIN (SELECT "invoiceId", SUM("amount") AS sum FROM "Payment" GROUP BY "invoiceId") paid ON paid."invoiceId" = i."id"
WHERE i."receivedAmount" > COALESCE(paid.sum, 0);
