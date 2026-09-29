import { prisma } from "../../lib/prisma";

/**
 * Copies the standard HSN dataset (rows with businessId null) into a business's own HSN Master,
 * so the business can edit, disable or delete them without affecting anyone else.
 * Codes the business already has are left untouched.
 */
export async function copyStandardHsn(businessId: string) {
  const [standard, existing] = await Promise.all([
    prisma.hSNMaster.findMany({ where: { businessId: null } }),
    prisma.hSNMaster.findMany({ where: { businessId }, select: { hsnCode: true } }),
  ]);
  const existingCodes = new Set(existing.map((h) => h.hsnCode));

  await prisma.hSNMaster.createMany({
    data: standard
      .filter((h) => !existingCodes.has(h.hsnCode))
      .map(({ id: _id, businessId: _businessId, ...rest }) => ({ ...rest, businessId })),
  });
}
