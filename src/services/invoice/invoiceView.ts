import { prisma } from "../../lib/prisma";
import { toDecimal } from "../../lib/decimal";
import { amountInWords } from "../../lib/currency";
import { AppError } from "../../middleware/errorHandler";
import { stateWithCode } from "../../lib/indianStates";

export interface HsnTaxGroupView {
  hsn: string;
  taxRate: number;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalTax: number;
}

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

  // Tax summary printed on the invoice is per HSN (split further by rate if one HSN was sold at two rates).
  const groupsByHsn = new Map<string, HsnTaxGroupView>();
  for (const item of invoice.items) {
    const hsn = item.hsn || "-";
    const key = `${hsn}|${item.taxRate.toString()}`;
    const cgst = toDecimal(item.cgst).toNumber();
    const sgst = toDecimal(item.sgst).toNumber();
    const igst = toDecimal(item.igst).toNumber();
    const taxable = toDecimal(item.taxableAmount).toNumber();
    const group = groupsByHsn.get(key) ?? { hsn, taxRate: Number(item.taxRate), taxableAmount: 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0 };
    group.taxableAmount += taxable;
    group.cgst += cgst;
    group.sgst += sgst;
    group.igst += igst;
    group.totalTax += cgst + sgst + igst;
    groupsByHsn.set(key, group);
  }
  const hsnTaxGroups = Array.from(groupsByHsn.values());

  const itemTotals = invoice.items.reduce(
    (t, item) => ({
      quantity: t.quantity.plus(toDecimal(item.quantity)),
      gst: t.gst.plus(toDecimal(item.cgst)).plus(toDecimal(item.sgst)).plus(toDecimal(item.igst)),
      amount: t.amount.plus(toDecimal(item.finalAmount)),
    }),
    { quantity: toDecimal(0), gst: toDecimal(0), amount: toDecimal(0) }
  );

  return {
    invoice,
    business: invoice.business,
    customer: invoice.customer,
    items: invoice.items,
    taxGroups,
    hsnTaxGroups,
    itemTotals: {
      quantity: itemTotals.quantity.toNumber(),
      gst: itemTotals.gst.toNumber(),
      amount: itemTotals.amount.toNumber(),
    },
    hasLineDiscount: invoice.items.some((item) => toDecimal(item.discount).greaterThan(0)),
    amountInWords: amountInWords(toDecimal(invoice.total).toNumber()),
    stateWithCode,
    formatMoney: (value: Parameters<typeof toDecimal>[0]) =>
      toDecimal(value).toNumber().toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    formatDate: (value: Date) => {
      const d = new Date(value);
      return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
    },
  };
}
