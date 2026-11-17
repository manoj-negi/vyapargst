-- Additive: stamp & signature settings for the invoice signatory box. Existing data is unchanged.
-- signaturePath stays the image that is printed; the original upload and the transparent version
-- are kept separately so the user can switch between them.
ALTER TABLE "Business" ADD COLUMN "signatureOriginalPath" TEXT;
ALTER TABLE "Business" ADD COLUMN "signatureCleanPath" TEXT;
ALTER TABLE "Business" ADD COLUMN "signatureUseClean" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Business" ADD COLUMN "signatureWidthMm" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "Business" ADD COLUMN "signatureOnInvoices" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Business" ADD COLUMN "signatureHidesHeading" BOOLEAN NOT NULL DEFAULT true;
-- A signature uploaded before this change kept printing, so keep it switched on
UPDATE "Business" SET "signatureOnInvoices" = true, "signatureOriginalPath" = "signaturePath", "signatureUseClean" = false, "signatureHidesHeading" = false WHERE "signaturePath" IS NOT NULL;
