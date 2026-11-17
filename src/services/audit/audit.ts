import type { Prisma, PrismaClient } from "@prisma/client";

type TxClient = Prisma.TransactionClient | PrismaClient;

/** Appends an audit trail row inside the same transaction as the change it describes. */
export async function writeAudit(
  tx: TxClient,
  entry: { businessId: string; userId?: string | null; entity: string; entityId: string; action: string; detail?: Prisma.InputJsonValue }
): Promise<void> {
  await tx.auditLog.create({
    data: {
      businessId: entry.businessId,
      userId: entry.userId ?? null,
      entity: entry.entity,
      entityId: entry.entityId,
      action: entry.action,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    },
  });
}
