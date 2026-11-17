import { z } from "zod/v4";

/**
 * What an extractor may return for a supplier document. Every value is nullable: a value that is
 * not printed on the document stays null (never guessed), and fields the reader is unsure of are
 * listed in uncertain_fields. Validated strictly before anything is shown or saved.
 */
const num = z.number().nullable();
const str = z.string().nullable();

export const ExtractedItemSchema = z.object({
  description: z.string(),
  supplier_item_code: str,
  barcode: str,
  hsn_sac: str,
  quantity: num,
  free_quantity: num,
  unit: str,
  pack_size: str.describe("Pack size exactly as printed, e.g. '1 BOX = 12 PCS' or '500 ml'; null if not printed"),
  rate: num.describe("Rate per unit as printed"),
  rate_includes_tax: z.boolean().nullable().describe("true if the printed rate already includes GST, false if before GST, null if unclear"),
  discount_percent: num,
  discount_amount: num,
  gst_rate: num,
  cgst_amount: num,
  sgst_amount: num,
  igst_amount: num,
  taxable_amount: num,
  line_total: num,
  uncertain_fields: z.array(z.string()).describe("Names of fields in this item that were hard to read or ambiguous"),
});

export const ExtractedBillSchema = z.object({
  document_kind: z.enum(["invoice", "catalog", "quotation", "price_list", "other"]),
  supplier: z.object({ name: str, address: str, gstin: str, phone: str, email: str }),
  invoice_number: str,
  invoice_date: str.describe("YYYY-MM-DD"),
  due_date: str.describe("YYYY-MM-DD, only if a due date is printed"),
  payment_terms: str.describe("Payment terms or bank details text as printed; this does not mean the bill is paid"),
  amount_paid_stated: num.describe("Only if the document explicitly states an amount already paid"),
  items: z.array(ExtractedItemSchema),
  invoice_discount_amount: num,
  delivery_charges: num,
  other_charges: num,
  charges_gst_rate: num,
  round_off: num,
  taxable_total: num,
  cgst_total: num,
  sgst_total: num,
  igst_total: num,
  grand_total: num,
  uncertain_fields: z.array(z.string()),
  review_notes: z.array(z.string()).describe("Short notes for the person reviewing, e.g. unreadable rows or a cut-off page"),
});
export type ExtractedBill = z.infer<typeof ExtractedBillSchema>;
export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;

// ---------- Editable review draft (saved as-is; nothing is applied until confirmation) ----------
const n = z.number().finite().nullable();
export const DraftRowSchema = z.object({
  id: z.string().min(1).max(40),
  description: z.string().max(300),
  supplierCode: z.string().max(80).nullable(),
  barcode: z.string().max(80).nullable(),
  hsn: z.string().max(12).nullable(),
  quantity: n,
  freeQuantity: n,
  unit: z.string().max(30).nullable(),
  packNote: z.string().max(120).nullable(),
  /** Base units of the matched item per bill unit (e.g. 12 when the bill is in boxes of 12 pieces) */
  unitFactor: n,
  rate: n,
  rateIncludesTax: z.boolean(),
  discountPercent: n,
  discountAmount: n,
  gstRate: n,
  extractedLineTotal: n,
  uncertain: z.array(z.string().max(40)).max(30),
  action: z.enum(["match", "create", "skip"]),
  productId: z.string().max(40).nullable(),
  /** The user ticked that a suggested (not yet remembered) match is right */
  matchConfirmed: z.boolean(),
  newProduct: z
    .object({ name: z.string().max(200), unitName: z.string().max(30), hsn: z.string().max(12).nullable(), gstRate: n, salePrice: n })
    .nullable(),
  /** null = default (increase → update, decrease → keep) */
  updatePrice: z.boolean().nullable(),
  /** Prepared as a new item automatically (no match when read); becomes a remembered/code match if one applies later */
  autoNew: z.boolean().optional(),
});
export type DraftRow = z.infer<typeof DraftRowSchema>;

export const DraftSchema = z.object({
  documentKind: z.enum(["invoice", "catalog", "quotation", "price_list", "other"]),
  supplierId: z.string().max(40).nullable(),
  supplier: z.object({
    name: z.string().max(150),
    address: z.string().max(500).nullable(),
    gstin: z.string().max(15).nullable(),
    phone: z.string().max(20).nullable(),
    email: z.string().max(120).nullable(),
    state: z.string().max(60).nullable(),
  }),
  invoiceNo: z.string().max(40).nullable(),
  invoiceDate: z.string().max(10).nullable(),
  dueDate: z.string().max(10).nullable(),
  paymentTerms: z.string().max(500).nullable(),
  invoiceDiscountAmount: n,
  chargesAmount: n,
  chargesGstRate: n,
  chargesLabel: z.string().max(60).nullable(),
  roundOff: n,
  extractedTotals: z.object({ taxable: n, tax: n, grand: n }),
  uncertain: z.array(z.string().max(40)).max(40),
  notes: z.array(z.string().max(300)).max(30),
  rows: z.array(DraftRowSchema).max(500),
  acknowledged: z.object({ totalsMismatch: z.boolean(), duplicateBill: z.boolean() }),
  /** Spreadsheet/table source chosen for the rows, when rows were read from a table */
  tableSource: z
    .object({ partIndex: z.number().int(), headerRow: z.number().int(), columns: z.record(z.string(), z.number().int().nullable()) })
    .nullable(),
});
export type Draft = z.infer<typeof DraftSchema>;
