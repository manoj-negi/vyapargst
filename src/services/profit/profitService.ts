import type { Prisma } from "@prisma/client";
import { Decimal, round2, toDecimal } from "../../lib/decimal";
import { calculateInvoiceTotals, calculateLineItem, isIntraState, type DiscountType, type PriceType } from "../gst/gstEngine";

/**
 * Estimated gross profit of a sale invoice, for the owner's private panel on the invoice form.
 *
 * Net sales per line are the GST-exclusive amounts the invoice itself uses: the line's taxable value
 * after its own discount, times the share left after the invoice-level discount (calculateInvoiceTotals
 * spreads that discount over the lines in proportion to their value, and the same ratio is used here).
 *
 * Cost: the app keeps no inventory costing (stock movements carry no cost), so the cost is the item's
 * saved purchase price, labelled as an estimate. GST on purchases is input tax credit for a
 * GST-registered business and is left out of cost; an unregistered business cannot recover it, so it is
 * included. Prices entered "with tax" are converted accordingly. A missing or ₹0 purchase price on a
 * product is "Cost missing", never zero: that line is left out of profit and margin (both then cover
 * the costed lines only) and the estimate is marked incomplete.
 *
 * Delivery/other charges and round-off are not part of item profit; they are reported separately.
 */

export interface CostProduct {
  id: string;
  isService: boolean;
  purchasePrice: Prisma.Decimal | null;
  purchasePriceType: PriceType;
  tax: { rate: Prisma.Decimal } | null;
  unit: { name: string; shortName: string } | null;
  secondaryUnit: { name: string; shortName: string } | null;
  conversionRate: Prisma.Decimal | null;
}

export type CostResult = { unitCost: Decimal; basis: "purchase-price"; note: string } | { unitCost: null; basis: "missing"; note: string };

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Cost of one unit in the line's unit, excluding recoverable purchase GST. */
export function unitCostFor(product: CostProduct | null, lineUnit: string | null | undefined, gstRegistered: boolean): CostResult {
  if (!product) return { unitCost: null, basis: "missing", note: "Not a saved item, so it has no purchase price" };
  const price = product.purchasePrice === null ? null : toDecimal(product.purchasePrice);
  if (price === null || (price.isZero() && !product.isService)) {
    return { unitCost: null, basis: "missing", note: price === null ? "No purchase price saved for this item" : "Purchase price is saved as ₹0" };
  }
  const rate = toDecimal(product.tax?.rate ?? 0).dividedBy(100);
  // Purchase price per base unit, excluding GST
  const exGst = product.purchasePriceType === "INCLUSIVE" ? price.dividedBy(rate.plus(1)) : price;
  // GST paid on purchases is recoverable (input credit) only for a GST-registered business
  let baseCost = gstRegistered ? exGst : exGst.times(rate.plus(1));
  let note = `Item's saved purchase price${product.purchasePriceType === "INCLUSIVE" ? " (with tax)" : ""}, ${gstRegistered ? "excluding" : "including"} GST`;

  // Units: 1 base unit = conversionRate secondary units (e.g. 1 BOX = 12 PIECES)
  const unit = lineUnit?.trim();
  const isBase = !unit || !product.unit || same(unit, product.unit.name) || same(unit, product.unit.shortName);
  if (!isBase) {
    const sec = product.secondaryUnit;
    if (sec && (same(unit, sec.name) || same(unit, sec.shortName)) && product.conversionRate && toDecimal(product.conversionRate).greaterThan(0)) {
      baseCost = baseCost.dividedBy(toDecimal(product.conversionRate));
      note += `, converted from per ${product.unit!.name} to per ${sec.name}`;
    } else {
      return { unitCost: null, basis: "missing", note: `Sold in "${unit}", which is not one of the item's units, so the cost per unit is unknown` };
    }
  }
  return { unitCost: baseCost, basis: "purchase-price", note };
}

export interface ProfitLineInput {
  productId: string | null;
  productName: string;
  unit: string | null;
  quantity: Decimal.Value;
  unitPrice: Decimal.Value;
  priceType: PriceType;
  discountValue: Decimal.Value;
  discountType: DiscountType;
  gstRate: Decimal.Value;
  /** Cost saved with the invoice (when editing); used instead of today's purchase price */
  savedCost?: { unitCost: Decimal.Value | null; basis: string | null } | null;
}

export interface ProfitLine {
  productName: string;
  quantity: string;
  unit: string | null;
  netSales: string;
  cost: string | null;
  profit: string | null;
  costSource: "saved" | "current" | "missing";
  note: string;
}

export interface ProfitResult {
  netSales: string;
  cost: string;
  grossProfit: string;
  /** Net sales of the lines whose cost is known (profit and margin cover only these) */
  costedNetSales: string;
  /** null when costed net sales are zero */
  marginPercent: string | null;
  complete: boolean;
  missingCount: number;
  usesCurrentCosts: boolean;
  lines: ProfitLine[];
  /** Kept out of item profit; shown for context */
  charges: string;
  roundOff: string;
}

export function computeProfit(opts: {
  businessState: string;
  partyState: string;
  gstRegistered: boolean;
  lines: ProfitLineInput[];
  products: Map<string, CostProduct>;
  invoiceDiscount: { value: Decimal.Value; type: DiscountType };
  charges: { amount: Decimal.Value; gstRate: Decimal.Value };
  roundOffMode: "AUTOMATIC" | "MANUAL" | "DISABLED";
  manualRoundOff?: number;
}): ProfitResult {
  const intra = opts.partyState ? isIntraState(opts.businessState, opts.partyState) : true;
  const results = opts.lines.map((l) =>
    calculateLineItem({ quantity: l.quantity, unitPrice: l.unitPrice, priceType: l.priceType, discountValue: l.discountValue, discountType: l.discountType, gstRate: l.gstRate, isIntraState: intra })
  );
  // The same totals the invoice shows, so the discount allocation matches exactly
  const totals = calculateInvoiceTotals({
    lines: results,
    invoiceDiscount: opts.invoiceDiscount,
    charges: opts.charges,
    isIntraState: intra,
    roundOffMode: opts.roundOffMode,
    manualRoundOff: opts.manualRoundOff,
  });
  const subtotal = results.reduce((s, r) => s.plus(r.taxableValue), new Decimal(0));
  const ratio = subtotal.isZero() ? new Decimal(1) : subtotal.minus(totals.discount).dividedBy(subtotal);

  let netSales = new Decimal(0);
  let cost = new Decimal(0);
  let profitKnown = new Decimal(0);
  let netKnown = new Decimal(0);
  let missing = 0;
  let usesCurrent = false;
  const lines: ProfitLine[] = opts.lines.map((l, i) => {
    const lineNet = round2(results[i].taxableValue.times(ratio));
    netSales = netSales.plus(lineNet);
    let unitCost: Decimal | null;
    let source: ProfitLine["costSource"];
    let note: string;
    if (l.savedCost && l.savedCost.basis) {
      unitCost = l.savedCost.unitCost === null ? null : toDecimal(l.savedCost.unitCost);
      source = unitCost === null ? "missing" : "saved";
      note = unitCost === null ? "No cost was available when this invoice was saved" : "Cost saved with this invoice";
    } else {
      const c = unitCostFor(l.productId ? opts.products.get(l.productId) ?? null : null, l.unit, opts.gstRegistered);
      unitCost = c.unitCost;
      source = c.unitCost === null ? "missing" : "current";
      note = c.note;
      if (c.unitCost !== null) usesCurrent = true;
    }
    if (unitCost === null) {
      missing++;
      return { productName: l.productName, quantity: toDecimal(l.quantity).toString(), unit: l.unit, netSales: lineNet.toFixed(2), cost: null, profit: null, costSource: "missing", note };
    }
    const lineCost = round2(unitCost.times(toDecimal(l.quantity)));
    cost = cost.plus(lineCost);
    profitKnown = profitKnown.plus(lineNet.minus(lineCost));
    netKnown = netKnown.plus(lineNet);
    return {
      productName: l.productName,
      quantity: toDecimal(l.quantity).toString(),
      unit: l.unit,
      netSales: lineNet.toFixed(2),
      cost: lineCost.toFixed(2),
      profit: lineNet.minus(lineCost).toFixed(2),
      costSource: source,
      note,
    };
  });

  // A line without a cost is left out of profit (not counted as free), so the estimate is incomplete
  return {
    netSales: netSales.toFixed(2),
    costedNetSales: netKnown.toFixed(2),
    cost: cost.toFixed(2),
    grossProfit: profitKnown.toFixed(2),
    marginPercent: netKnown.isZero() ? null : profitKnown.dividedBy(netKnown).times(100).toFixed(1),
    complete: missing === 0,
    missingCount: missing,
    usesCurrentCosts: usesCurrent,
    lines,
    charges: totals.charges.toFixed(2),
    roundOff: totals.roundOff.toFixed(2),
  };
}
