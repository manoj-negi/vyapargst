-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('REGISTERED', 'UNREGISTERED', 'CONSUMER');

-- CreateEnum
CREATE TYPE "PriceType" AS ENUM ('INCLUSIVE', 'EXCLUSIVE');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED');

-- CreateEnum
CREATE TYPE "TaxType" AS ENUM ('INTRA_STATE', 'INTER_STATE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PAID', 'PARTIALLY_PAID', 'UNPAID');

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('CASH', 'UPI', 'BANK_TRANSFER', 'CARD', 'CREDIT', 'OTHER');

-- CreateEnum
CREATE TYPE "RoundOffMode" AS ENUM ('AUTOMATIC', 'MANUAL', 'DISABLED');

-- CreateEnum
CREATE TYPE "NegativeStockPolicy" AS ENUM ('PREVENT', 'ALLOW_WITH_WARNING');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockTransactionType" AS ENUM ('OPENING', 'SALE', 'PURCHASE', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tradeName" TEXT,
    "logoPath" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "businessType" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT NOT NULL,
    "pincode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'India',
    "gstRegistered" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessSettings" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "invoicePrefix" TEXT NOT NULL DEFAULT 'INV-',
    "invoiceStartNumber" INTEGER NOT NULL DEFAULT 1,
    "financialYearFormat" BOOLEAN NOT NULL DEFAULT false,
    "roundOffMode" "RoundOffMode" NOT NULL DEFAULT 'AUTOMATIC',
    "negativeStockPolicy" "NegativeStockPolicy" NOT NULL DEFAULT 'ALLOW_WITH_WARNING',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "billingAddress" TEXT,
    "shippingAddress" TEXT,
    "state" TEXT NOT NULL,
    "pincode" TEXT,
    "customerType" "CustomerType" NOT NULL DEFAULT 'CONSUMER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "itemCode" TEXT,
    "barcode" TEXT,
    "isService" BOOLEAN NOT NULL DEFAULT false,
    "hsnCode" TEXT,
    "categoryId" TEXT,
    "unitId" TEXT,
    "salePrice" DECIMAL(12,2) NOT NULL,
    "purchasePrice" DECIMAL(12,2),
    "priceType" "PriceType" NOT NULL DEFAULT 'EXCLUSIVE',
    "taxId" TEXT,
    "defaultDiscount" DECIMAL(12,2),
    "defaultDiscountType" "DiscountType" NOT NULL DEFAULT 'PERCENTAGE',
    "openingStock" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "minStock" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currentStock" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HSNMaster" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "hsnCode" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "chapter" TEXT,
    "heading" TEXT,
    "subHeading" TEXT,
    "keywords" TEXT,
    "gstRate" DECIMAL(5,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "HSNMaster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxMaster" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxType" TEXT NOT NULL DEFAULT 'GST',
    "rate" DECIMAL(5,2) NOT NULL,
    "cgstRate" DECIMAL(5,2) NOT NULL,
    "sgstRate" DECIMAL(5,2) NOT NULL,
    "igstRate" DECIMAL(5,2) NOT NULL,
    "cessRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),

    CONSTRAINT "TaxMaster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceSequence" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL DEFAULT '',
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleInvoice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "placeOfSupply" TEXT NOT NULL,
    "taxType" "TaxType" NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxableAmount" DECIMAL(12,2) NOT NULL,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cess" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "receivedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaleInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleInvoiceItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "hsn" TEXT,
    "unit" TEXT,
    "quantity" DECIMAL(12,2) NOT NULL,
    "rate" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discountType" "DiscountType" NOT NULL DEFAULT 'PERCENTAGE',
    "taxRate" DECIMAL(5,2) NOT NULL,
    "taxableAmount" DECIMAL(12,2) NOT NULL,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "finalAmount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "SaleInvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "type" "PaymentType" NOT NULL DEFAULT 'CASH',
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransaction" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "StockTransactionType" NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "resultingStock" DECIMAL(12,2) NOT NULL,
    "referenceInvoiceId" TEXT,
    "note" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessSettings_businessId_key" ON "BusinessSettings"("businessId");

-- CreateIndex
CREATE INDEX "Customer_businessId_name_idx" ON "Customer"("businessId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_businessId_name_key" ON "Category"("businessId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_businessId_name_key" ON "Unit"("businessId", "name");

-- CreateIndex
CREATE INDEX "Product_businessId_name_idx" ON "Product"("businessId", "name");

-- CreateIndex
CREATE INDEX "Product_businessId_itemCode_idx" ON "Product"("businessId", "itemCode");

-- CreateIndex
CREATE INDEX "Product_businessId_hsnCode_idx" ON "Product"("businessId", "hsnCode");

-- CreateIndex
CREATE INDEX "HSNMaster_hsnCode_idx" ON "HSNMaster"("hsnCode");

-- CreateIndex
CREATE INDEX "HSNMaster_description_idx" ON "HSNMaster"("description");

-- CreateIndex
CREATE INDEX "HSNMaster_keywords_idx" ON "HSNMaster"("keywords");

-- CreateIndex
CREATE UNIQUE INDEX "TaxMaster_businessId_rate_key" ON "TaxMaster"("businessId", "rate");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceSequence_businessId_prefix_financialYear_key" ON "InvoiceSequence"("businessId", "prefix", "financialYear");

-- CreateIndex
CREATE INDEX "SaleInvoice_businessId_invoiceDate_idx" ON "SaleInvoice"("businessId", "invoiceDate");

-- CreateIndex
CREATE INDEX "SaleInvoice_businessId_paymentStatus_idx" ON "SaleInvoice"("businessId", "paymentStatus");

-- CreateIndex
CREATE UNIQUE INDEX "SaleInvoice_businessId_invoiceNo_key" ON "SaleInvoice"("businessId", "invoiceNo");

-- CreateIndex
CREATE INDEX "SaleInvoiceItem_invoiceId_idx" ON "SaleInvoiceItem"("invoiceId");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

-- CreateIndex
CREATE INDEX "StockTransaction_productId_date_idx" ON "StockTransaction"("productId", "date");

-- AddForeignKey
ALTER TABLE "Business" ADD CONSTRAINT "Business_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessSettings" ADD CONSTRAINT "BusinessSettings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_taxId_fkey" FOREIGN KEY ("taxId") REFERENCES "TaxMaster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HSNMaster" ADD CONSTRAINT "HSNMaster_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxMaster" ADD CONSTRAINT "TaxMaster_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceSequence" ADD CONSTRAINT "InvoiceSequence_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleInvoice" ADD CONSTRAINT "SaleInvoice_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleInvoice" ADD CONSTRAINT "SaleInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleInvoiceItem" ADD CONSTRAINT "SaleInvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SaleInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleInvoiceItem" ADD CONSTRAINT "SaleInvoiceItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SaleInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_referenceInvoiceId_fkey" FOREIGN KEY ("referenceInvoiceId") REFERENCES "SaleInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
