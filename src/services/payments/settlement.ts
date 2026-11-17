import type { Prisma, PrismaClient } from "@prisma/client";
import { Decimal, toDecimal } from "../../lib/decimal";
import { AppError } from "../../middleware/errorHandler";

type TxClient = Prisma.TransactionClient | PrismaClient;

export function paymentStatusFor(total: Decimal, settled: Decimal): "PAID" | "PARTIALLY_PAID" | "UNPAID" {
  if (settled.lessThanOrEqualTo(0)) return total.isZero() ? "PAID" : "UNPAID";
  return settled.greaterThanOrEqualTo(total) ? "PAID" : "PARTIALLY_PAID";
}

/**
 * Amount already settled on a document: active payment allocations, plus (for invoices and
 * purchase bills) the part of active credit/debit notes set off against it, plus (for those
 * notes) their own set-off amount.
 */
export async function settledAmount(tx: TxClient, documentId: string): Promise<Decimal> {
  const doc = await tx.saleInvoice.findUniqueOrThrow({ where: { id: documentId } });
  const allocations = await tx.paymentAllocation.aggregate({
    where: { documentId, voucher: { status: "ACTIVE" } },
    _sum: { amount: true },
  });
  let settled = toDecimal(allocations._sum.amount);

  if (doc.docType === "CREDIT_NOTE" || doc.docType === "DEBIT_NOTE") {
    settled = settled.plus(toDecimal(doc.adjustedAmount));
  } else {
    const returns = await tx.saleInvoice.aggregate({
      where: { originalDocId: documentId, status: "ACTIVE" },
      _sum: { adjustedAmount: true },
    });
    settled = settled.plus(toDecimal(returns._sum.adjustedAmount));
  }
  return settled;
}

/**
 * Recomputes receivedAmount / balance / paymentStatus from the records that settle the document.
 * Called inside every transaction that changes a document's total or what is allocated to it, so
 * the stored figures can never drift from the underlying payments.
 */
export async function refreshSettlement(tx: TxClient, documentId: string): Promise<void> {
  const doc = await tx.saleInvoice.findUniqueOrThrow({ where: { id: documentId } });
  if (doc.docType === "ESTIMATE") return;

  const total = toDecimal(doc.total);
  const settled = await settledAmount(tx, documentId);
  if (settled.greaterThan(total)) {
    throw new AppError(
      `${doc.invoiceNo}: payments and adjustments (₹${settled.toFixed(2)}) would exceed its total (₹${total.toFixed(2)}). Cancel a payment or credit/debit note first.`,
      422
    );
  }

  await tx.saleInvoice.update({
    where: { id: documentId },
    data: {
      receivedAmount: settled.toFixed(2),
      balance: total.minus(settled).toFixed(2),
      paymentStatus: paymentStatusFor(total, settled),
    },
  });
}
