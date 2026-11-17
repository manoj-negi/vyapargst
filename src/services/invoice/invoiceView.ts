import { divisionLines } from "../../lib/division";
import type { DocType, SaleInvoice, SaleInvoiceItem } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Decimal, toDecimal, round2 } from "../../lib/decimal";
import { amountInWords } from "../../lib/currency";
import { AppError } from "../../middleware/errorHandler";
import { stateWithCode } from "../../lib/indianStates";
import { docConfig } from "../documents/docTypes";

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

type TaxHeader = Pick<SaleInvoice, "subtotal" | "discount" | "taxType" | "chargesAmount" | "chargesTaxRate" | "chargesLabel">;
type TaxLine = Pick<SaleInvoiceItem, "hsn" | "taxRate" | "taxableAmount" | "cgst" | "sgst" | "igst">;

export interface AdjustedTaxLine {
  hsn: string | null;
  taxRate: Decimal;
  taxable: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  isCharge: boolean;
}

/**
 * A document's taxable value and tax per line as they make up the header totals. Line values are
 * stored before the invoice-level discount, which gstEngine.calculateInvoiceTotals spreads over
 * the lines proportionally; this repeats that step, and adds delivery/other charges as a line.
 */
export function adjustedTaxLines(invoice: TaxHeader, items: TaxLine[]): AdjustedTaxLine[] {
  const subtotal = toDecimal(invoice.subtotal);
  const discount = toDecimal(invoice.discount);
  const ratio = subtotal.isZero() ? new Decimal(1) : subtotal.minus(discount).dividedBy(subtotal);
  const intra = invoice.taxType === "INTRA_STATE";
  const split = (taxable: Decimal, rate: Decimal) => {
    const gst = taxable.times(rate).dividedBy(100);
    const half = round2(gst.dividedBy(2));
    return intra ? { cgst: half, sgst: half, igst: new Decimal(0) } : { cgst: new Decimal(0), sgst: new Decimal(0), igst: round2(gst) };
  };

  const lines: AdjustedTaxLine[] = items.map((item) => {
    const rate = toDecimal(item.taxRate);
    if (discount.isZero()) {
      return { hsn: item.hsn, taxRate: rate, taxable: toDecimal(item.taxableAmount), cgst: toDecimal(item.cgst), sgst: toDecimal(item.sgst), igst: toDecimal(item.igst), isCharge: false };
    }
    const taxable = round2(toDecimal(item.taxableAmount).times(ratio));
    return { hsn: item.hsn, taxRate: rate, taxable, ...split(taxable, rate), isCharge: false };
  });

  const charges = toDecimal(invoice.chargesAmount);
  if (charges.greaterThan(0)) {
    const rate = toDecimal(invoice.chargesTaxRate);
    lines.push({ hsn: invoice.chargesLabel || "Charges", taxRate: rate, taxable: charges, ...split(charges, rate), isCharge: true });
  }
  return lines;
}

/**
 * Builds the shared data needed to render both the on-screen preview and the downloaded PDF from
 * the exact same source, so the two never drift. Everything comes from what was stored when the
 * document was issued: line snapshots, and business/party snapshots (older invoices without
 * snapshots fall back to the live records, as they always did).
 */
export async function buildInvoiceViewModel(invoiceId: string, businessId: string, docType: DocType = "SALE_INVOICE") {
  const invoice = await prisma.saleInvoice.findFirst({
    where: { id: invoiceId, businessId, docType },
    include: {
      customer: true,
      business: true,
      items: true,
      payments: { orderBy: { date: "desc" } },
      allocations: { include: { voucher: true }, orderBy: { voucher: { date: "asc" } } },
      returns: { where: { status: "ACTIVE" }, orderBy: { invoiceDate: "asc" } },
      originalDoc: { select: { id: true, invoiceNo: true, invoiceDate: true, docType: true } },
      convertedFrom: { select: { id: true, invoiceNo: true } },
      convertedTo: { select: { id: true, invoiceNo: true, status: true } },
      // The supplier's own document, when the purchase came from an import (shown on screen only)
      importedFrom: { select: { id: true, files: { select: { id: true, originalName: true }, orderBy: { position: "asc" } } } },
    },
  });

  if (!invoice) throw new AppError(`${docConfig(docType).label} not found`, 404);

  const business = { ...invoice.business, ...((invoice.businessSnapshot as Record<string, unknown> | null) ?? {}) };
  const customer = { ...invoice.customer, ...((invoice.partySnapshot as Record<string, unknown> | null) ?? {}) };

  const adjusted = adjustedTaxLines(invoice, invoice.items);
  const charges = toDecimal(invoice.chargesAmount);

  const groupsByRate = new Map<string, TaxGroupView>();
  const groupsByHsn = new Map<string, HsnTaxGroupView>();
  for (const a of adjusted) {
    const rate = Number(a.taxRate);
    const rateGroup = groupsByRate.get(String(rate)) ?? { taxRate: rate, taxableAmount: 0, cgst: 0, sgst: 0, igst: 0 };
    rateGroup.taxableAmount += a.taxable.toNumber();
    rateGroup.cgst += a.cgst.toNumber();
    rateGroup.sgst += a.sgst.toNumber();
    rateGroup.igst += a.igst.toNumber();
    groupsByRate.set(String(rate), rateGroup);

    // Tax summary printed on the invoice is per HSN (split further by rate if one HSN was sold at two rates).
    const hsn = a.hsn || "-";
    const key = `${hsn}|${rate}`;
    const group = groupsByHsn.get(key) ?? { hsn, taxRate: rate, taxableAmount: 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0 };
    group.taxableAmount += a.taxable.toNumber();
    group.cgst += a.cgst.toNumber();
    group.sgst += a.sgst.toNumber();
    group.igst += a.igst.toNumber();
    group.totalTax += a.cgst.plus(a.sgst).plus(a.igst).toNumber();
    groupsByHsn.set(key, group);
  }

  const taxGroups = Array.from(groupsByRate.values()).sort((a, b) => a.taxRate - b.taxRate);
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
    config: docConfig(invoice.docType),
    business,
    customer,
    items: invoice.items,
    taxGroups,
    hsnTaxGroups,
    itemTotals: {
      quantity: itemTotals.quantity.toNumber(),
      gst: itemTotals.gst.toNumber(),
      amount: itemTotals.amount.toNumber(),
    },
    chargesTax: charges.greaterThan(0) ? round2(charges.times(toDecimal(invoice.chargesTaxRate)).dividedBy(100)).toNumber() : 0,
    division: divisionLines(invoice),
    // Stamp & signature from the current business settings (Business Profile), on sale documents only
    stamp:
      invoice.business.signatureOnInvoices && invoice.business.signaturePath && docConfig(invoice.docType).side === "SALE"
        ? { src: invoice.business.signaturePath, widthMm: invoice.business.signatureWidthMm, hidesHeading: invoice.business.signatureHidesHeading }
        : null,
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
