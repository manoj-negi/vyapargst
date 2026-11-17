import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { computeProfit, unitCostFor, type CostProduct, type ProfitLineInput } from "./profitService";

const D = (v: number | string) => new Prisma.Decimal(v);
const product = (over: Partial<CostProduct> = {}): CostProduct => ({
  id: "p1",
  isService: false,
  purchasePrice: D(100),
  purchasePriceType: "EXCLUSIVE",
  tax: { rate: D(18) },
  unit: { name: "Box", shortName: "BOX" },
  secondaryUnit: null,
  conversionRate: null,
  ...over,
});
const line = (over: Partial<ProfitLineInput> = {}): ProfitLineInput => ({
  productId: "p1",
  productName: "Paper",
  unit: "Box",
  quantity: 1,
  unitPrice: 200,
  priceType: "EXCLUSIVE",
  discountValue: 0,
  discountType: "PERCENTAGE",
  gstRate: 18,
  ...over,
});
function run(lines: ProfitLineInput[], products: CostProduct[], over: Partial<Parameters<typeof computeProfit>[0]> = {}) {
  return computeProfit({
    businessState: "Uttarakhand",
    partyState: "Uttarakhand",
    gstRegistered: true,
    lines,
    products: new Map(products.map((p) => [p.id, p])),
    invoiceDiscount: { value: 0, type: "PERCENTAGE" },
    charges: { amount: 0, gstRate: 0 },
    roundOffMode: "AUTOMATIC",
    ...over,
  });
}

describe("estimated gross profit", () => {
  it("uses net sales excluding GST after line discounts, minus cost", () => {
    const r = run([line({ quantity: 10, unitPrice: 280, discountValue: 3 })], [product({ purchasePrice: D(200) })]);
    // 10 × 280 = 2800, −3% = 2716 excl. GST; cost 10 × 200 = 2000
    expect([r.netSales, r.cost, r.grossProfit, r.marginPercent, r.complete]).toEqual(["2716.00", "2000.00", "716.00", "26.4", true]);
    const fixed = run([line({ quantity: 2, unitPrice: 100, discountValue: 30, discountType: "FIXED" })], [product({ purchasePrice: D(50) })]);
    expect([fixed.netSales, fixed.grossProfit]).toEqual(["170.00", "70.00"]);
  });

  it("takes GST out of tax-inclusive sale and purchase prices", () => {
    const r = run([line({ unitPrice: 118, priceType: "INCLUSIVE" })], [product({ purchasePrice: D(59), purchasePriceType: "INCLUSIVE" })]);
    expect([r.netSales, r.cost, r.grossProfit]).toEqual(["100.00", "50.00", "50.00"]);
    // An unregistered business cannot recover purchase GST, so it is part of cost
    expect(run([line({ unitPrice: 118, priceType: "INCLUSIVE" })], [product({ purchasePrice: D(59), purchasePriceType: "INCLUSIVE" })], { gstRegistered: false }).cost).toBe("59.00");
  });

  it("spreads the invoice discount over lines like the invoice totals do", () => {
    const r = run(
      [line({ unitPrice: 300 }), line({ productId: "p2", productName: "Pen", unit: "Pcs", unitPrice: 100 })],
      [product({ purchasePrice: D(200) }), product({ id: "p2", purchasePrice: D(60), unit: { name: "Pieces", shortName: "Pcs" } })],
      { invoiceDiscount: { value: 40, type: "FIXED" } }
    );
    // subtotal 400, −40 → ratio 0.9: lines 270 and 90
    expect(r.lines.map((l) => l.netSales)).toEqual(["270.00", "90.00"]);
    expect([r.netSales, r.cost, r.grossProfit]).toEqual(["360.00", "260.00", "100.00"]);
  });

  it("converts the cost per base unit to the unit sold", () => {
    const p = product({ purchasePrice: D(120), secondaryUnit: { name: "Pieces", shortName: "PCS" }, conversionRate: D(12) });
    expect(unitCostFor(p, "Box", true).unitCost?.toFixed(2)).toBe("120.00");
    expect(unitCostFor(p, "PCS", true).unitCost?.toFixed(2)).toBe("10.00");
    expect(unitCostFor(p, "Kg", true)).toMatchObject({ unitCost: null, basis: "missing" });
    const r = run([line({ unit: "Pieces", quantity: 6, unitPrice: 15 })], [p]);
    expect([r.netSales, r.cost, r.grossProfit]).toEqual(["90.00", "60.00", "30.00"]);
  });

  it("never counts a missing cost as zero and marks the estimate incomplete", () => {
    const r = run(
      [line({ unitPrice: 300 }), line({ productId: "p2", productName: "No cost", unitPrice: 100 }), line({ productId: null, productName: "Typed item", unitPrice: 50 })],
      [product({ purchasePrice: D(200) }), product({ id: "p2", purchasePrice: D(0) })]
    );
    expect(r.complete).toBe(false);
    expect(r.missingCount).toBe(2);
    expect(r.lines.slice(1).map((l) => [l.cost, l.profit, l.costSource])).toEqual([[null, null, "missing"], [null, null, "missing"]]);
    // Profit and margin cover the costed line only
    expect([r.netSales, r.costedNetSales, r.grossProfit, r.marginPercent]).toEqual(["450.00", "300.00", "100.00", "33.3"]);
    expect(unitCostFor(product({ purchasePrice: null }), "Box", true).note).toMatch(/No purchase price/);
  });

  it("shows losses and avoids dividing by zero", () => {
    const loss = run([line({ unitPrice: 80 })], [product({ purchasePrice: D(100) })]);
    expect([loss.grossProfit, loss.marginPercent]).toEqual(["-20.00", "-25.0"]);
    const free = run([line({ unitPrice: 0 })], [product({ purchasePrice: D(100) })]);
    expect([free.netSales, free.grossProfit, free.marginPercent]).toEqual(["0.00", "-100.00", null]);
  });

  it("keeps charges and round-off out of item profit and prefers the cost saved with the invoice", () => {
    const r = run([line({ unitPrice: 199.5, savedCost: { unitCost: "150", basis: "purchase-price" } })], [product({ purchasePrice: D(999) })], {
      charges: { amount: 50, gstRate: 18 },
    });
    expect([r.netSales, r.cost, r.grossProfit, r.charges, r.usesCurrentCosts]).toEqual(["199.50", "150.00", "49.50", "50.00", false]);
    expect(r.lines[0].costSource).toBe("saved");
    expect(Number(r.roundOff)).not.toBe(0);
  });
});
