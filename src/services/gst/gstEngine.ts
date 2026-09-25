import { Decimal, toDecimal, round2 } from "../../lib/decimal";

export type PriceType = "INCLUSIVE" | "EXCLUSIVE";
export type DiscountType = "PERCENTAGE" | "FIXED";
export type RoundOffMode = "AUTOMATIC" | "MANUAL" | "DISABLED";

export interface LineItemInput {
  quantity: Decimal.Value;
  unitPrice: Decimal.Value;
  priceType: PriceType;
  discountValue: Decimal.Value;
  discountType: DiscountType;
  gstRate: Decimal.Value;
  cessRate?: Decimal.Value;
  isIntraState: boolean;
}

export interface LineItemResult {
  grossAmount: Decimal;
  discountAmount: Decimal;
  taxableValue: Decimal;
  gstRate: Decimal;
  cessRate: Decimal;
  isIntraState: boolean;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  cess: Decimal;
  total: Decimal;
}

/**
 * Calculates a single invoice line's taxable value and GST split.
 *
 * For INCLUSIVE pricing, GST is backed out of the given price (never added again):
 *   taxable = amountAfterDiscount / (1 + rate/100)
 * For EXCLUSIVE pricing, GST is added on top of the discounted price:
 *   taxable = amountAfterDiscount ; gst = taxable * rate/100
 */
export function calculateLineItem(input: LineItemInput): LineItemResult {
  const quantity = toDecimal(input.quantity);
  const unitPrice = toDecimal(input.unitPrice);
  const gstRate = toDecimal(input.gstRate);
  const cessRate = toDecimal(input.cessRate ?? 0);

  const grossAmount = quantity.times(unitPrice);

  const discountAmount =
    input.discountType === "PERCENTAGE"
      ? grossAmount.times(toDecimal(input.discountValue)).dividedBy(100)
      : toDecimal(input.discountValue);

  const amountAfterDiscount = grossAmount.minus(discountAmount);

  let taxableValue: Decimal;
  if (input.priceType === "INCLUSIVE") {
    taxableValue = amountAfterDiscount.dividedBy(gstRate.dividedBy(100).plus(1));
  } else {
    taxableValue = amountAfterDiscount;
  }

  const { cgst, sgst, igst } = splitGst(taxableValue, gstRate, input.isIntraState);
  const cess = round2(taxableValue.times(cessRate).dividedBy(100));

  // For inclusive pricing the total is already known (the entered price) — derive it directly
  // rather than re-summing individually-rounded parts, which would introduce paisa-level drift.
  const total =
    input.priceType === "INCLUSIVE"
      ? round2(amountAfterDiscount)
      : round2(taxableValue.plus(cgst).plus(sgst).plus(igst).plus(cess));

  return {
    grossAmount: round2(grossAmount),
    discountAmount: round2(discountAmount),
    taxableValue: round2(taxableValue),
    gstRate,
    cessRate,
    isIntraState: input.isIntraState,
    cgst,
    sgst,
    igst,
    cess,
    total,
  };
}

function splitGst(
  taxableValue: Decimal,
  gstRate: Decimal,
  isIntraState: boolean
): { cgst: Decimal; sgst: Decimal; igst: Decimal } {
  const gstAmount = taxableValue.times(gstRate).dividedBy(100);
  if (isIntraState) {
    const half = round2(gstAmount.dividedBy(2));
    return { cgst: half, sgst: half, igst: new Decimal(0) };
  }
  return { cgst: new Decimal(0), sgst: new Decimal(0), igst: round2(gstAmount) };
}

export interface InvoiceDiscountInput {
  value: Decimal.Value;
  type: DiscountType;
}

export interface InvoiceTotalsInput {
  lines: LineItemResult[];
  invoiceDiscount?: InvoiceDiscountInput | null;
  roundOffMode: RoundOffMode;
  manualRoundOff?: Decimal.Value;
}

export interface TaxRateGroup {
  gstRate: Decimal;
  isIntraState: boolean;
  taxableAmount: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  cess: Decimal;
}

export interface InvoiceTotalsResult {
  subtotal: Decimal;
  discount: Decimal;
  taxableAmount: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  cess: Decimal;
  roundOff: Decimal;
  total: Decimal;
  taxGroups: TaxRateGroup[];
}

/**
 * Combines line results into invoice-level totals. An invoice-level discount is applied
 * proportionally across lines (by their share of the pre-discount subtotal) so GST for each
 * line's rate is recalculated on the reduced taxable base, matching the spec's worked example
 * (Subtotal 15000, Discount 500 -> Taxable 14500, CGST/SGST computed on 14500).
 */
export function calculateInvoiceTotals(input: InvoiceTotalsInput): InvoiceTotalsResult {
  const subtotal = input.lines.reduce((sum, l) => sum.plus(l.taxableValue), new Decimal(0));

  const invoiceDiscountAmount = input.invoiceDiscount
    ? input.invoiceDiscount.type === "PERCENTAGE"
      ? subtotal.times(toDecimal(input.invoiceDiscount.value)).dividedBy(100)
      : toDecimal(input.invoiceDiscount.value)
    : new Decimal(0);

  const ratio = subtotal.isZero()
    ? new Decimal(1)
    : subtotal.minus(invoiceDiscountAmount).dividedBy(subtotal);

  const groupsByRate = new Map<string, TaxRateGroup>();

  for (const line of input.lines) {
    const adjustedTaxable = round2(line.taxableValue.times(ratio));
    const { cgst, sgst, igst } = splitGst(adjustedTaxable, line.gstRate, line.isIntraState);
    const cess = round2(adjustedTaxable.times(line.cessRate).dividedBy(100));

    const key = `${line.gstRate.toString()}|${line.isIntraState}`;
    const existing = groupsByRate.get(key);

    if (existing) {
      existing.taxableAmount = existing.taxableAmount.plus(adjustedTaxable);
      existing.cgst = existing.cgst.plus(cgst);
      existing.sgst = existing.sgst.plus(sgst);
      existing.igst = existing.igst.plus(igst);
      existing.cess = existing.cess.plus(cess);
    } else {
      groupsByRate.set(key, {
        gstRate: line.gstRate,
        isIntraState: line.isIntraState,
        taxableAmount: adjustedTaxable,
        cgst,
        sgst,
        igst,
        cess,
      });
    }
  }

  const taxGroups = Array.from(groupsByRate.values()).sort((a, b) =>
    a.gstRate.comparedTo(b.gstRate)
  );

  const taxableAmount = taxGroups.reduce((s, g) => s.plus(g.taxableAmount), new Decimal(0));
  const cgst = taxGroups.reduce((s, g) => s.plus(g.cgst), new Decimal(0));
  const sgst = taxGroups.reduce((s, g) => s.plus(g.sgst), new Decimal(0));
  const igst = taxGroups.reduce((s, g) => s.plus(g.igst), new Decimal(0));
  const cess = taxGroups.reduce((s, g) => s.plus(g.cess), new Decimal(0));

  const totalBeforeRounding = taxableAmount.plus(cgst).plus(sgst).plus(igst).plus(cess);

  let roundOff = new Decimal(0);
  let total = round2(totalBeforeRounding);

  if (input.roundOffMode === "AUTOMATIC") {
    const rounded = totalBeforeRounding.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    roundOff = round2(rounded.minus(totalBeforeRounding));
    total = rounded;
  } else if (input.roundOffMode === "MANUAL") {
    roundOff = round2(input.manualRoundOff ?? 0);
    total = round2(totalBeforeRounding.plus(roundOff));
  }

  return {
    subtotal: round2(subtotal),
    discount: round2(invoiceDiscountAmount),
    taxableAmount: round2(taxableAmount),
    cgst: round2(cgst),
    sgst: round2(sgst),
    igst: round2(igst),
    cess: round2(cess),
    roundOff,
    total,
    taxGroups,
  };
}

/** Determines whether a sale is intra-state (CGST+SGST) or inter-state (IGST) based on states. */
export function isIntraState(businessState: string, customerState: string): boolean {
  return businessState.trim().toLowerCase() === customerState.trim().toLowerCase();
}
