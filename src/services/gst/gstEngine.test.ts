import { describe, expect, it } from "vitest";
import { calculateInvoiceTotals, calculateLineItem, isIntraState } from "./gstEngine";

describe("calculateLineItem", () => {
  it("intra-state, exclusive pricing: 1000 @18% -> CGST 90 + SGST 90 = 1180", () => {
    const r = calculateLineItem({
      quantity: 1,
      unitPrice: 1000,
      priceType: "EXCLUSIVE",
      discountValue: 0,
      discountType: "FIXED",
      gstRate: 18,
      isIntraState: true,
    });
    expect(r.taxableValue.toNumber()).toBe(1000);
    expect(r.cgst.toNumber()).toBe(90);
    expect(r.sgst.toNumber()).toBe(90);
    expect(r.igst.toNumber()).toBe(0);
    expect(r.total.toNumber()).toBe(1180);
  });

  it("inter-state, exclusive pricing: 1000 @18% -> IGST 180 = 1180", () => {
    const r = calculateLineItem({
      quantity: 1,
      unitPrice: 1000,
      priceType: "EXCLUSIVE",
      discountValue: 0,
      discountType: "FIXED",
      gstRate: 18,
      isIntraState: false,
    });
    expect(r.igst.toNumber()).toBe(180);
    expect(r.cgst.toNumber()).toBe(0);
    expect(r.total.toNumber()).toBe(1180);
  });

  it("exclusive pricing: 320 @18% -> taxable 320, GST 57.60, total 377.60", () => {
    const r = calculateLineItem({
      quantity: 1,
      unitPrice: 320,
      priceType: "EXCLUSIVE",
      discountValue: 0,
      discountType: "FIXED",
      gstRate: 18,
      isIntraState: true,
    });
    expect(r.taxableValue.toNumber()).toBe(320);
    expect(r.cgst.toNumber()).toBe(28.8);
    expect(r.sgst.toNumber()).toBe(28.8);
    expect(r.total.toNumber()).toBe(377.6);
  });

  it("inclusive pricing: 320 incl 18% GST -> taxable 271.19, GST 48.81", () => {
    const r = calculateLineItem({
      quantity: 1,
      unitPrice: 320,
      priceType: "INCLUSIVE",
      discountValue: 0,
      discountType: "FIXED",
      gstRate: 18,
      isIntraState: true,
    });
    expect(r.taxableValue.toNumber()).toBeCloseTo(271.19, 2);
    expect(r.total.toNumber()).toBe(320);
  });

  it("percentage discount: 1000 @10% off -> taxable 900, GST computed on 900", () => {
    const r = calculateLineItem({
      quantity: 1,
      unitPrice: 1000,
      priceType: "EXCLUSIVE",
      discountValue: 10,
      discountType: "PERCENTAGE",
      gstRate: 18,
      isIntraState: true,
    });
    expect(r.discountAmount.toNumber()).toBe(100);
    expect(r.taxableValue.toNumber()).toBe(900);
    expect(r.cgst.toNumber()).toBe(81);
    expect(r.sgst.toNumber()).toBe(81);
  });

  it("fixed discount: 1000 - 100 -> taxable 900, GST after discount", () => {
    const r = calculateLineItem({
      quantity: 1,
      unitPrice: 1000,
      priceType: "EXCLUSIVE",
      discountValue: 100,
      discountType: "FIXED",
      gstRate: 18,
      isIntraState: true,
    });
    expect(r.taxableValue.toNumber()).toBe(900);
  });

  it("matches the A4 Copy Paper line example: 40 x 320 @10% disc, 18% GST", () => {
    const r = calculateLineItem({
      quantity: 40,
      unitPrice: 320,
      priceType: "EXCLUSIVE",
      discountValue: 10,
      discountType: "PERCENTAGE",
      gstRate: 18,
      isIntraState: true,
    });
    expect(r.grossAmount.toNumber()).toBe(12800);
    expect(r.discountAmount.toNumber()).toBe(1280);
    expect(r.taxableValue.toNumber()).toBe(11520);
    expect(r.cgst.toNumber()).toBe(1036.8);
    expect(r.sgst.toNumber()).toBe(1036.8);
    expect(r.total.toNumber()).toBe(13593.6);
  });
});

describe("calculateInvoiceTotals", () => {
  it("applies invoice-level discount proportionally: subtotal 15000, discount 500 -> taxable 14500", () => {
    const line = calculateLineItem({
      quantity: 1,
      unitPrice: 15000,
      priceType: "EXCLUSIVE",
      discountValue: 0,
      discountType: "FIXED",
      gstRate: 18,
      isIntraState: true,
    });

    const totals = calculateInvoiceTotals({
      lines: [line],
      invoiceDiscount: { value: 500, type: "FIXED" },
      roundOffMode: "DISABLED",
    });

    expect(totals.subtotal.toNumber()).toBe(15000);
    expect(totals.discount.toNumber()).toBe(500);
    expect(totals.taxableAmount.toNumber()).toBe(14500);
    expect(totals.cgst.toNumber()).toBe(1305);
    expect(totals.sgst.toNumber()).toBe(1305);
    expect(totals.total.toNumber()).toBe(17110);
  });

  it("groups multiple GST rates in the tax summary", () => {
    const l5 = calculateLineItem({
      quantity: 1,
      unitPrice: 1000,
      priceType: "EXCLUSIVE",
      discountValue: 0,
      discountType: "FIXED",
      gstRate: 5,
      isIntraState: true,
    });
    const l12 = calculateLineItem({
      quantity: 1,
      unitPrice: 2000,
      priceType: "EXCLUSIVE",
      discountValue: 0,
      discountType: "FIXED",
      gstRate: 12,
      isIntraState: true,
    });
    const l18 = calculateLineItem({
      quantity: 1,
      unitPrice: 5000,
      priceType: "EXCLUSIVE",
      discountValue: 0,
      discountType: "FIXED",
      gstRate: 18,
      isIntraState: true,
    });

    const totals = calculateInvoiceTotals({
      lines: [l5, l12, l18],
      roundOffMode: "DISABLED",
    });

    expect(totals.taxGroups).toHaveLength(3);
    const g5 = totals.taxGroups.find((g) => g.gstRate.toNumber() === 5)!;
    expect(g5.taxableAmount.toNumber()).toBe(1000);
    expect(g5.cgst.toNumber()).toBe(25);
    expect(g5.sgst.toNumber()).toBe(25);

    const g12 = totals.taxGroups.find((g) => g.gstRate.toNumber() === 12)!;
    expect(g12.cgst.toNumber()).toBe(120);
    expect(g12.sgst.toNumber()).toBe(120);

    const g18 = totals.taxGroups.find((g) => g.gstRate.toNumber() === 18)!;
    expect(g18.cgst.toNumber()).toBe(450);
    expect(g18.sgst.toNumber()).toBe(450);
  });

  it("automatic round-off rounds total to nearest rupee", () => {
    const line = calculateLineItem({
      quantity: 1,
      unitPrice: 320,
      priceType: "EXCLUSIVE",
      discountValue: 0,
      discountType: "FIXED",
      gstRate: 18,
      isIntraState: true,
    });
    const totals = calculateInvoiceTotals({ lines: [line], roundOffMode: "AUTOMATIC" });
    expect(totals.total.toNumber()).toBe(378);
    expect(totals.roundOff.toNumber()).toBeCloseTo(0.4, 2);
  });
});

describe("isIntraState", () => {
  it("is true when states match (case-insensitively)", () => {
    expect(isIntraState("Uttar Pradesh", "uttar pradesh")).toBe(true);
  });
  it("is false when states differ", () => {
    expect(isIntraState("Uttar Pradesh", "Maharashtra")).toBe(false);
  });
});
