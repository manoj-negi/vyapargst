-- Give every existing business its own editable copy of the standard HSN dataset
-- (rows with businessId NULL), skipping codes the business already has.
INSERT INTO "HSNMaster" ("id", "businessId", "hsnCode", "description", "chapter", "heading", "subHeading", "keywords", "gstRate", "effectiveFrom", "effectiveTo", "isActive")
SELECT gen_random_uuid()::text, b."id", s."hsnCode", s."description", s."chapter", s."heading", s."subHeading", s."keywords", s."gstRate", s."effectiveFrom", s."effectiveTo", s."isActive"
FROM "HSNMaster" s
CROSS JOIN "Business" b
WHERE s."businessId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "HSNMaster" h WHERE h."businessId" = b."id" AND h."hsnCode" = s."hsnCode");
