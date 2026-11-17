import type { DraftRow } from "./schema";

/**
 * Deterministic reading of an item table (spreadsheet sheet, Word/ODT/PowerPoint table): find the
 * header row, map columns by their headings, and turn each data row into a draft row. Used directly
 * when the table is clear; otherwise the user picks the sheet, header row and columns.
 */
export const FIELDS = ["description", "code", "hsn", "quantity", "free", "unit", "rate", "discountPercent", "discountAmount", "gstRate", "amount"] as const;
export type Field = (typeof FIELDS)[number];
export type ColumnMap = Partial<Record<Field, number | null>>;

export const FIELD_LABELS: Record<Field, string> = {
  description: "Item / description",
  code: "Item code",
  hsn: "HSN/SAC",
  quantity: "Quantity",
  free: "Free quantity",
  unit: "Unit",
  rate: "Rate",
  discountPercent: "Discount %",
  discountAmount: "Discount ₹",
  gstRate: "GST %",
  amount: "Amount",
};

const SYNONYMS: Record<Field, RegExp> = {
  description: /^(item|items|item name|description|particulars|product|product name|name|goods|description of goods|item description|material)$/,
  code: /^(code|item code|sku|part no|part number|article|article no|product code|barcode|ean)$/,
  hsn: /^(hsn|sac|hsn\/sac|hsn code|hsn\/sac code)$/,
  quantity: /^(qty|quantity|qnty|nos|billed qty|qty\.)$/,
  free: /^(free|free qty|scheme|scheme qty|bonus)$/,
  unit: /^(unit|uom|per|units)$/,
  rate: /^(rate|price|unit price|rate per unit|price\/unit|unit rate|cost|purchase rate)$/,
  discountPercent: /^(disc %|disc%|discount %|discount%|disc|discount|disc\.)$/,
  discountAmount: /^(disc amt|discount amount|disc amount|disc ₹|discount ₹|disc\. amt)$/,
  gstRate: /^(gst|gst %|gst%|gst rate|tax %|tax|igst %|igst|tax rate)$/,
  amount: /^(amount|total|value|line total|net amount|taxable value|taxable|net)$/,
};

// "Rate (₹)" → "rate", "Qty." → "qty"
const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[₹:]/g, "").replace(/\s+/g, " ").trim().replace(/\.$/, "");

export function detectHeader(rows: string[][]): { headerRow: number; columns: ColumnMap; confident: boolean } {
  let best = { headerRow: 0, columns: {} as ColumnMap, score: 0 };
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const columns: ColumnMap = {};
    let score = 0;
    rows[r].forEach((cell, c) => {
      const h = norm(cell);
      if (!h) return;
      for (const f of FIELDS) {
        if (columns[f] === undefined && SYNONYMS[f].test(h)) { columns[f] = c; score++; break; }
      }
    });
    if (score > best.score) best = { headerRow: r, columns, score };
  }
  const c = best.columns;
  const confident = c.description !== undefined && c.quantity !== undefined && (c.rate !== undefined || c.amount !== undefined);
  return { headerRow: best.headerRow, columns: best.columns, confident };
}

/** "₹1,23,456.50", "12%", "(5.00)", "1.5 kg" → number; blank or text → null */
export function parseNumber(v: string | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s);
  const m = s.replace(/[,\s]/g, "").match(/\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

let seq = 0;
export const newRowId = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

export function blankRow(over: Partial<DraftRow> = {}): DraftRow {
  return {
    id: newRowId(),
    description: "",
    supplierCode: null,
    barcode: null,
    hsn: null,
    quantity: null,
    freeQuantity: null,
    unit: null,
    packNote: null,
    unitFactor: null,
    rate: null,
    rateIncludesTax: false,
    discountPercent: null,
    discountAmount: null,
    gstRate: null,
    extractedLineTotal: null,
    uncertain: [],
    action: "match",
    productId: null,
    matchConfirmed: false,
    newProduct: null,
    updatePrice: null,
    ...over,
  };
}

const TOTAL_LINE = /^(sub ?total|total|grand total|net total|round ?off|cgst|sgst|igst|gst|taxable|discount|freight|delivery|amount in words)/i;

/** Data rows below the header become draft rows; totals and blank lines are skipped. */
export function rowsFromTable(rows: string[][], headerRow: number, columns: ColumnMap): DraftRow[] {
  const at = (row: string[], f: Field) => (columns[f] === undefined || columns[f] === null ? "" : (row[columns[f] as number] ?? "").trim());
  const out: DraftRow[] = [];
  for (const row of rows.slice(headerRow + 1)) {
    const description = at(row, "description");
    if (!description || TOTAL_LINE.test(description)) continue;
    const quantity = parseNumber(at(row, "quantity"));
    const rate = parseNumber(at(row, "rate"));
    const amount = parseNumber(at(row, "amount"));
    if (quantity === null && rate === null && amount === null) continue; // a section heading, not an item
    const uncertain: string[] = [];
    if (quantity === null) uncertain.push("quantity");
    if (rate === null) uncertain.push("rate");
    out.push(
      blankRow({
        description,
        supplierCode: at(row, "code") || null,
        hsn: at(row, "hsn").replace(/\D/g, "") || null,
        quantity,
        freeQuantity: parseNumber(at(row, "free")),
        unit: at(row, "unit") || null,
        rate: rate ?? (amount !== null && quantity ? Math.round((amount / quantity) * 100) / 100 : null),
        discountPercent: parseNumber(at(row, "discountPercent")),
        discountAmount: parseNumber(at(row, "discountAmount")),
        gstRate: parseNumber(at(row, "gstRate")),
        extractedLineTotal: amount,
        uncertain: rate === null && amount !== null ? [...uncertain.filter((u) => u !== "rate"), "rate (worked out from amount ÷ quantity)"] : uncertain,
      })
    );
  }
  return out;
}

/** Catalogues, price lists and quotations are product lists, not purchases */
export function guessDocumentKind(text: string): "invoice" | "catalog" | "quotation" | "price_list" | "other" {
  const t = text.toLowerCase();
  if (/\b(tax invoice|invoice no|bill no|invoice number|purchase bill)\b/.test(t)) return "invoice";
  if (/\bquotation\b|\bquote no\b/.test(t)) return "quotation";
  if (/\bprice ?list\b|\brate ?list\b/.test(t)) return "price_list";
  if (/\bcatalog(ue)?\b/.test(t)) return "catalog";
  return "invoice";
}
