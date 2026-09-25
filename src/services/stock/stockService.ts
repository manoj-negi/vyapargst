import type { Prisma, PrismaClient } from "@prisma/client";
import { Decimal, toDecimal } from "../../lib/decimal";
import { AppError } from "../../middleware/errorHandler";

type TxClient = Prisma.TransactionClient | PrismaClient;

export interface StockDeductionItem {
  productId: string;
  quantity: Decimal.Value;
}

/**
 * Deducts sold quantity from each product's stock and writes a StockTransaction audit row,
 * inside the given transaction. Honors the business's negative-stock policy: PREVENT throws
 * (rolling back the whole invoice save), ALLOW_WITH_WARNING proceeds and lets the resulting
 * stock go negative.
 */
export async function deductStockForSale(
  tx: TxClient,
  items: StockDeductionItem[],
  referenceInvoiceId: string,
  negativeStockPolicy: "PREVENT" | "ALLOW_WITH_WARNING"
): Promise<void> {
  for (const item of items) {
    if (!item.productId) continue;

    const product = await tx.product.findUnique({ where: { id: item.productId } });
    if (!product || product.isService) continue;

    const qty = toDecimal(item.quantity);
    const resultingStock = toDecimal(product.currentStock).minus(qty);

    if (resultingStock.lessThan(0) && negativeStockPolicy === "PREVENT") {
      throw new AppError(
        `Insufficient stock for "${product.name}". Available: ${product.currentStock}, requested: ${qty.toString()}.`,
        422
      );
    }

    await tx.product.update({
      where: { id: product.id },
      data: { currentStock: resultingStock.toNumber() },
    });

    await tx.stockTransaction.create({
      data: {
        productId: product.id,
        type: "SALE",
        quantity: qty.negated().toNumber(),
        resultingStock: resultingStock.toNumber(),
        referenceInvoiceId,
      },
    });
  }
}

/** Reverses stock deduction when an invoice is cancelled. */
export async function restoreStockForCancelledSale(
  tx: TxClient,
  invoiceId: string
): Promise<void> {
  const items = await tx.saleInvoiceItem.findMany({ where: { invoiceId } });

  for (const item of items) {
    if (!item.productId) continue;
    const product = await tx.product.findUnique({ where: { id: item.productId } });
    if (!product || product.isService) continue;

    const resultingStock = toDecimal(product.currentStock).plus(toDecimal(item.quantity));

    await tx.product.update({
      where: { id: product.id },
      data: { currentStock: resultingStock.toNumber() },
    });

    await tx.stockTransaction.create({
      data: {
        productId: product.id,
        type: "ADJUSTMENT",
        quantity: toDecimal(item.quantity).toNumber(),
        resultingStock: resultingStock.toNumber(),
        referenceInvoiceId: invoiceId,
        note: "Restored from cancelled invoice",
      },
    });
  }
}
