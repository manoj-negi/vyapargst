import { Router } from "express";
import { z } from "zod";
import { requireBusiness } from "../../middleware/auth";
import { calculateInvoiceTotals, calculateLineItem, isIntraState } from "../../services/gst/gstEngine";
import { previousDiscounts } from "../../services/documents/discountHistory";
import { viewHelpers } from "../../lib/viewHelpers";
import { prisma } from "../../lib/prisma";
import { canViewProfit } from "../../lib/permissions";
import { computeProfit } from "../../services/profit/profitService";

export const invoicesApiRouter = Router();

invoicesApiRouter.use("/api", requireBusiness);

const calcItemSchema = z.object({
  quantity: z.coerce.number().min(0),
  unitPrice: z.coerce.number().min(0),
  priceType: z.enum(["INCLUSIVE", "EXCLUSIVE"]),
  discountValue: z.coerce.number().min(0),
  discountType: z.enum(["PERCENTAGE", "FIXED"]),
  gstRate: z.coerce.number().min(0).max(100),
});

const calcSchema = z.object({
  customerState: z.string().optional().default(""),
  items: z.array(calcItemSchema),
  invoiceDiscount: z
    .object({ value: z.coerce.number().min(0).default(0), type: z.enum(["PERCENTAGE", "FIXED"]).default("PERCENTAGE") })
    .optional(),
  manualRoundOff: z.coerce.number().optional(),
  charges: z.object({ amount: z.coerce.number().min(0).default(0), gstRate: z.coerce.number().min(0).max(100).default(0) }).optional(),
});

/**
 * Server-authoritative live preview used by the Sale Invoice form as the user types. Nothing
 * here is persisted — the actual save (POST /invoices) recomputes everything again from the
 * live Product/Tax Master before writing to the database.
 */
invoicesApiRouter.post("/api/invoices/calculate", (req, res) => {
  const business = res.locals.business;
  const parsed = calcSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.errors.map((e) => e.message).join("; ") });
  }

  const data = parsed.data;
  const intra = data.customerState ? isIntraState(business.state, data.customerState) : true;

  const validItems = data.items.filter((i) => i.quantity > 0);
  let lines;
  let totals;
  try {
  lines = validItems.map((item) =>
    calculateLineItem({
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      priceType: item.priceType,
      discountValue: item.discountValue,
      discountType: item.discountType,
      gstRate: item.gstRate,
      isIntraState: intra,
    })
  );

  totals = calculateInvoiceTotals({
    lines,
    invoiceDiscount: data.invoiceDiscount,
    charges: data.charges,
    isIntraState: intra,
    roundOffMode: data.manualRoundOff !== undefined && !isNaN(data.manualRoundOff) ? "MANUAL" : (business.settings?.roundOffMode || "AUTOMATIC"),
    manualRoundOff: data.manualRoundOff,
  });
  } catch (err) {
    if (err instanceof RangeError) return res.status(422).json({ error: err.message });
    throw err;
  }

  res.json({
    isIntraState: intra,
    lines: lines.map((l) => ({
      taxableValue: l.taxableValue.toNumber(),
      cgst: l.cgst.toNumber(),
      sgst: l.sgst.toNumber(),
      igst: l.igst.toNumber(),
      total: l.total.toNumber(),
    })),
    totals: {
      subtotal: totals.subtotal.toNumber(),
      discount: totals.discount.toNumber(),
      charges: totals.charges.toNumber(),
      chargesTax: totals.chargesTax.toNumber(),
      taxableAmount: totals.taxableAmount.toNumber(),
      cgst: totals.cgst.toNumber(),
      sgst: totals.sgst.toNumber(),
      igst: totals.igst.toNumber(),
      cess: totals.cess.toNumber(),
      roundOff: totals.roundOff.toNumber(),
      total: totals.total.toNumber(),
      taxGroups: totals.taxGroups.map((g) => ({
        gstRate: g.gstRate.toNumber(),
        taxableAmount: g.taxableAmount.toNumber(),
        cgst: g.cgst.toNumber(),
        sgst: g.sgst.toNumber(),
        igst: g.igst.toNumber(),
      })),
    },
  });
});

const previousDiscountSchema = z.object({
  customerId: z.string().trim().min(1),
  productIds: z.string().trim().min(1),
  section: z.string().trim().max(80).optional(),
  department: z.string().trim().max(80).optional(),
  excludeId: z.string().trim().optional(),
});

/**
 * Discounts last given to a customer for the given items (comma-separated productIds), from saved
 * sale invoices, for prefilling a new invoice. Read-only.
 */
invoicesApiRouter.get("/api/invoices/previous-discounts", async (req, res) => {
  const business = res.locals.business;
  const parsed = previousDiscountSchema.safeParse(req.query);
  if (!parsed.success) return res.status(422).json({ error: "customerId and productIds are required" });
  const q = parsed.data;
  const found = await previousDiscounts(business.id, {
    customerId: q.customerId,
    productIds: q.productIds.split(","),
    section: q.section,
    department: q.department,
    excludeInvoiceId: q.excludeId || null,
  });
  const discounts = Object.fromEntries(
    Object.entries(found).map(([pid, d]) => [pid, { ...d, invoiceDate: d.invoiceDate.toISOString(), invoiceDateLabel: viewHelpers.fdate(d.invoiceDate) }])
  );
  res.json({ discounts });
});

const profitSchema = calcSchema.extend({
  items: z.array(
    calcItemSchema.extend({
      productId: z.string().trim().nullish(),
      productName: z.string().trim().default(""),
      unit: z.string().trim().nullish(),
    })
  ).max(500),
  invoiceId: z.string().trim().optional(),
});

/**
 * Estimated gross profit for the invoice being entered (private panel on the sale invoice form).
 * Owner only, checked here; nothing is saved. Costs saved with an existing invoice take precedence
 * over today's purchase prices.
 */
invoicesApiRouter.post("/api/invoices/profit", async (req, res) => {
  if (!canViewProfit(req, res)) return res.status(403).json({ error: "Only the business owner can see profit." });
  const business = res.locals.business;
  const parsed = profitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: parsed.error.errors.map((e) => e.message).join("; ") });
  const data = parsed.data;
  const items = data.items.filter((i) => i.quantity > 0);

  const ids = Array.from(new Set(items.map((i) => i.productId).filter((id): id is string => !!id)));
  const [products, saved] = await Promise.all([
    prisma.product.findMany({ where: { businessId: business.id, id: { in: ids } }, include: { tax: true, unit: true, secondaryUnit: true } }),
    data.invoiceId
      ? prisma.saleInvoiceItem.findMany({
          where: { invoice: { id: data.invoiceId, businessId: business.id, docType: "SALE_INVOICE" } },
          select: { productId: true, unit: true, unitCost: true, costBasis: true },
        })
      : Promise.resolve([]),
  ]);
  try {
    const result = computeProfit({
      businessState: business.state,
      partyState: data.customerState,
      gstRegistered: business.gstRegistered,
      products: new Map(products.map((p) => [p.id, p])),
      lines: items.map((i) => {
        const prior = i.productId ? saved.find((s) => s.productId === i.productId && (s.unit || "") === (i.unit || "")) : undefined;
        return {
          productId: i.productId || null,
          productName: i.productName,
          unit: i.unit || null,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          priceType: i.priceType,
          discountValue: i.discountValue,
          discountType: i.discountType,
          gstRate: i.gstRate,
          savedCost: prior && prior.costBasis ? { unitCost: prior.unitCost, basis: prior.costBasis } : null,
        };
      }),
      invoiceDiscount: { value: data.invoiceDiscount?.value ?? 0, type: data.invoiceDiscount?.type ?? "PERCENTAGE" },
      charges: { amount: data.charges?.amount ?? 0, gstRate: data.charges?.gstRate ?? 0 },
      roundOffMode: data.manualRoundOff !== undefined && !isNaN(data.manualRoundOff) ? "MANUAL" : business.settings?.roundOffMode || "AUTOMATIC",
      manualRoundOff: data.manualRoundOff,
    });
    res.set("Cache-Control", "no-store").json({ ...result, editingOlderInvoice: !!data.invoiceId && saved.length > 0 && saved.every((s) => !s.costBasis) });
  } catch (err) {
    if (err instanceof RangeError) return res.status(422).json({ error: err.message });
    throw err;
  }
});
