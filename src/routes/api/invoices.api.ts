import { Router } from "express";
import { z } from "zod";
import { requireBusiness } from "../../middleware/auth";
import { calculateInvoiceTotals, calculateLineItem, isIntraState } from "../../services/gst/gstEngine";

export const invoicesApiRouter = Router();

invoicesApiRouter.use(requireBusiness);

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
  const lines = validItems.map((item) =>
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

  const totals = calculateInvoiceTotals({
    lines,
    invoiceDiscount: data.invoiceDiscount,
    roundOffMode: data.manualRoundOff !== undefined && !isNaN(data.manualRoundOff) ? "MANUAL" : (business.settings?.roundOffMode || "AUTOMATIC"),
    manualRoundOff: data.manualRoundOff,
  });

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
