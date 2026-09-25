import { prisma } from "../../lib/prisma";
import { toDecimal } from "../../lib/decimal";
import { amountInWords } from "../../lib/currency";
import { AppError } from "../../middleware/errorHandler";

export interface TaxGroupView {
  taxRate: number;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
}

/**
 * Builds the shared data needed to render both the on-screen Invoice Preview and the
 * downloaded PDF from the exact same source, so the two never drift. Tax groups are derived
 * from the SaleInvoiceItem snapshots (not recomputed from live Product/Tax data), preserving
 * the historical invoice exactly as issued even if prices or GST rates change later.
 */
export async function buildInvoiceViewModel(invoiceId: string, businessId: string) {
  const invoice = await prisma.saleInvoice.findFirst({
    where: { id: invoiceId, businessId },
    include: {
      customer: true,
      business: true,
      items: true,
      payments: { orderBy: { date: "desc" } },
    },
  });

  if (!invoice) throw new AppError("Invoice not found", 404);

  const groupsByRate = new Map<string, TaxGroupView>();
  for (const item of invoice.items) {
    const key = item.taxRate.toString();
    const existing = groupsByRate.get(key);
    const taxable = toDecimal(item.taxableAmount).toNumber();
    const cgst = toDecimal(item.cgst).toNumber();
    const sgst = toDecimal(item.sgst).toNumber();
    const igst = toDecimal(item.igst).toNumber();

    if (existing) {
      existing.taxableAmount += taxable;
      existing.cgst += cgst;
      existing.sgst += sgst;
      existing.igst += igst;
    } else {
      groupsByRate.set(key, { taxRate: Number(item.taxRate), taxableAmount: taxable, cgst, sgst, igst });
    }
  }

  const taxGroups = Array.from(groupsByRate.values()).sort((a, b) => a.taxRate - b.taxRate);

  return {
    invoice,
    business: invoice.business,
    customer: invoice.customer,
    items: invoice.items,
    taxGroups,
    amountInWords: amountInWords(toDecimal(invoice.total).toNumber()),
  };
}
