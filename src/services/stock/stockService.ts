import type { Prisma, PrismaClient, StockTransactionType } from "@prisma/client";
import { Decimal, toDecimal } from "../../lib/decimal";
import { AppError } from "../../middleware/errorHandler";

type TxClient = Prisma.TransactionClient | PrismaClient;

export type NegativeStockPolicy = "PREVENT" | "ALLOW_WITH_WARNING";

export interface StockMovementInput {
  productId: string;
  /** Signed: negative removes stock, positive adds it */
  quantity: Decimal.Value;
  type: StockTransactionType;
  referenceInvoiceId?: string | null;
  note?: string | null;
  date?: Date;
}

/**
 * Applies one stock movement and writes its StockTransaction row. The stock update is an atomic
 * increment, so concurrent saves cannot overwrite each other's changes. Services are skipped.
 * Returns false when nothing was recorded (service item or unknown product).
 *
 * Invariant kept by every caller: Product.currentStock = openingStock + sum(StockTransaction.quantity
 * of non-OPENING rows).
 */
export async function applyStockMovement(
  tx: TxClient,
  movement: StockMovementInput,
  negativeStockPolicy: NegativeStockPolicy
): Promise<boolean> {
  const qty = toDecimal(movement.quantity);
  if (qty.isZero()) return false;

  const product = await tx.product.findUnique({ where: { id: movement.productId } });
  if (!product || product.isService) return false;

  const updated = await tx.product.update({
    where: { id: product.id },
    data: { currentStock: { increment: qty.toFixed(2) } },
  });
  const resultingStock = toDecimal(updated.currentStock);

  if (qty.lessThan(0) && resultingStock.lessThan(0) && negativeStockPolicy === "PREVENT") {
    throw new AppError(
      `Insufficient stock for "${product.name}". Available: ${resultingStock.minus(qty).toString()}, required: ${qty.negated().toString()}.`,
      422
    );
  }

  await tx.stockTransaction.create({
    data: {
      productId: product.id,
      type: movement.type,
      quantity: qty.toFixed(2),
      resultingStock: resultingStock.toFixed(2),
      referenceInvoiceId: movement.referenceInvoiceId ?? null,
      note: movement.note ?? null,
      ...(movement.date ? { date: movement.date } : {}),
    },
  });
  return true;
}

/**
 * Undoes every stock movement recorded against a document so far, using the recorded movements
 * themselves (not the current line items). Works for documents saved by older versions of the app
 * too, whose edits wrote "restored" ADJUSTMENT rows.
 */
export async function reverseDocumentStock(
  tx: TxClient,
  documentId: string,
  note: string
): Promise<string[]> {
  const net = await tx.stockTransaction.groupBy({
    by: ["productId"],
    where: { referenceInvoiceId: documentId },
    _sum: { quantity: true },
  });

  for (const row of net) {
    const netQty = toDecimal(row._sum.quantity);
    if (netQty.isZero()) continue;
    // An edit may pass through a temporary negative (reverse, then re-apply), so the policy is
    // checked on the final stock by assertStockNotNegative instead of on each reversal row.
    await applyStockMovement(
      tx,
      { productId: row.productId, quantity: netQty.negated(), type: "REVERSAL", referenceInvoiceId: documentId, note },
      "ALLOW_WITH_WARNING"
    );
  }
  return net.map((row) => row.productId);
}

/** Under the PREVENT policy, rejects the whole transaction if any of these items ended up below zero. */
export async function assertStockNotNegative(
  tx: TxClient,
  productIds: string[],
  negativeStockPolicy: NegativeStockPolicy
): Promise<void> {
  if (negativeStockPolicy !== "PREVENT" || productIds.length === 0) return;
  const negative = await tx.product.findMany({
    where: { id: { in: [...new Set(productIds)] }, isService: false, currentStock: { lt: 0 } },
    select: { name: true, currentStock: true },
  });
  if (negative.length > 0) {
    const list = negative.map((p) => `"${p.name}" (${p.currentStock.toString()})`).join(", ");
    throw new AppError(`This change would leave negative stock for ${list}.`, 422);
  }
}

/** Manual stock adjustment with a mandatory reason. */
export async function adjustStock(
  tx: TxClient,
  productId: string,
  quantity: Decimal.Value,
  reason: string,
  date: Date,
  negativeStockPolicy: NegativeStockPolicy
): Promise<void> {
  if (!reason.trim()) throw new AppError("A reason is required for a stock adjustment", 422);
  await applyStockMovement(
    tx,
    { productId, quantity, type: "ADJUSTMENT", note: reason.trim(), date },
    negativeStockPolicy
  );
}
