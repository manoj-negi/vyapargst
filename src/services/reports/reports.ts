import { divisionOf } from "../../lib/division";
import type { DocType, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Decimal, toDecimal } from "../../lib/decimal";
import { DOC_TYPES } from "../documents/docTypes";
import { adjustedTaxLines } from "../invoice/invoiceView";
import { partyBalances } from "../parties/ledger";

export type Cell = string | number | null;

export interface Report {
  title: string;
  columns: string[];
  rows: Cell[][];
  /** Rows rendered bold after the data (totals) */
  footer?: Cell[][];
  note?: string;
  /** Shows the From/To date filter */
  dated: boolean;
}

export interface ReportFilters {
  from?: Date;
  to?: Date;
  productId?: string;
}

const m = (v: Decimal.Value) => toDecimal(v).toFixed(2);
const d = (v: Date) => v.toISOString().slice(0, 10);

function dateWhere(f: ReportFilters, field = "invoiceDate") {
  if (!f.from && !f.to) return {};
  return { [field]: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } };
}

/** Sales or purchase register: documents with their tax split; returns count negative. */
async function register(businessId: string, f: ReportFilters, main: DocType, ret: DocType, title: string): Promise<Report> {
  const docs = await prisma.saleInvoice.findMany({
    where: { businessId, docType: { in: [main, ret] }, status: "ACTIVE", ...dateWhere(f) },
    include: { customer: true },
    orderBy: [{ invoiceDate: "asc" }, { invoiceNo: "asc" }],
  });
  const sum = { taxable: new Decimal(0), cgst: new Decimal(0), sgst: new Decimal(0), igst: new Decimal(0), cess: new Decimal(0), total: new Decimal(0), balance: new Decimal(0) };
  const rows = docs.map((doc) => {
    const sign = doc.docType === ret ? -1 : 1;
    const div = divisionOf(doc);
    const party = (doc.partySnapshot as { name?: string; gstin?: string } | null) ?? doc.customer;
    const vals = [doc.taxableAmount, doc.cgst, doc.sgst, doc.igst, doc.cess, doc.total, doc.balance].map((v) => toDecimal(v).times(sign));
    sum.taxable = sum.taxable.plus(vals[0]);
    sum.cgst = sum.cgst.plus(vals[1]);
    sum.sgst = sum.sgst.plus(vals[2]);
    sum.igst = sum.igst.plus(vals[3]);
    sum.cess = sum.cess.plus(vals[4]);
    sum.total = sum.total.plus(vals[5]);
    sum.balance = sum.balance.plus(vals[6]);
    return [d(doc.invoiceDate), doc.invoiceNo, doc.partyInvoiceNo, DOC_TYPES[doc.docType].label, party.name ?? "", div.section ?? "", div.department ?? "", div.unclassified ?? "", party.gstin ?? "", ...vals.map(m)];
  });
  return {
    title,
    dated: true,
    // Sales show section and department; purchases show the supplier's bill number instead.
    // "Unclassified" holds older combined values not yet classified (dropped when there are none).
    columns: ["Date", "Number", "Party Bill No", "Type", "Party", "Section", "Department", "Unclassified", "GSTIN", "Taxable ₹", "CGST ₹", "SGST ₹", "IGST ₹", "Cess ₹", "Total ₹", "Balance ₹"],
    rows: rows.map((r) => (main === "SALE_INVOICE" ? [...r.slice(0, 2), ...r.slice(3)] : [...r.slice(0, 5), ...r.slice(8)])),
    footer: [["", "Total", "", "", "", "", "", "", m(sum.taxable), m(sum.cgst), m(sum.sgst), m(sum.igst), m(sum.cess), m(sum.total), m(sum.balance)]],
    note: "Cancelled documents excluded. Credit/debit notes are shown as negative amounts.",
  };
}

export async function salesReport(businessId: string, f: ReportFilters) {
  const r = await register(businessId, f, "SALE_INVOICE", "CREDIT_NOTE", "Sales Register");
  r.columns = r.columns.filter((c) => c !== "Party Bill No");
  const unclassified = r.columns.indexOf("Unclassified");
  if (!r.rows.some((row) => row[unclassified])) {
    r.columns.splice(unclassified, 1);
    r.rows = r.rows.map((row) => row.filter((_, i) => i !== unclassified));
    r.footer = r.footer?.map((row) => row.filter((_, i) => i !== unclassified));
  }
  return r;
}

export async function purchaseReport(businessId: string, f: ReportFilters) {
  const r = await register(businessId, f, "PURCHASE_BILL", "DEBIT_NOTE", "Purchase Register");
  r.columns = r.columns.filter((c) => !["Section", "Department", "Unclassified"].includes(c));
  r.footer = r.footer?.map((row) => [row[0], row[1], ...row.slice(4)]);
  return r;
}

export async function expenseReport(businessId: string, f: ReportFilters): Promise<Report> {
  const expenses = await prisma.expense.findMany({
    where: { businessId, status: "ACTIVE", ...dateWhere(f, "date") },
    include: { category: true },
    orderBy: [{ date: "asc" }, { expenseNo: "asc" }],
  });
  const byCategory = new Map<string, Decimal>();
  let total = new Decimal(0);
  const rows = expenses.map((e) => {
    byCategory.set(e.category.name, (byCategory.get(e.category.name) ?? new Decimal(0)).plus(toDecimal(e.amount)));
    total = total.plus(toDecimal(e.amount));
    return [d(e.date), e.expenseNo, e.category.name, e.paidTo, e.mode.replace("_", " "), e.note, m(e.amount)] as Cell[];
  });
  return {
    title: "Expense Report",
    dated: true,
    columns: ["Date", "Number", "Category", "Paid To", "Mode", "Note", "Amount ₹"],
    rows,
    footer: [
      ...[...byCategory.entries()].sort().map(([name, amt]) => ["", "", `Total — ${name}`, "", "", "", m(amt)] as Cell[]),
      ["", "", "Total", "", "", "", m(total)],
    ],
  };
}

export async function stockSummaryReport(businessId: string): Promise<Report> {
  const products = await prisma.product.findMany({
    where: { businessId, isActive: true, isService: false },
    include: { unit: true, category: true },
    orderBy: { name: "asc" },
  });
  let value = new Decimal(0);
  const rows = products.map((p) => {
    const stock = toDecimal(p.currentStock);
    const price = toDecimal(p.purchasePrice ?? 0);
    const lineValue = stock.greaterThan(0) ? stock.times(price) : new Decimal(0);
    value = value.plus(lineValue);
    const status = stock.lessThanOrEqualTo(0) ? "Out of stock" : stock.lessThanOrEqualTo(toDecimal(p.minStock)) ? "Low" : "";
    return [p.name, p.itemCode, p.category?.name ?? "", p.unit?.shortName ?? "", stock.toString(), toDecimal(p.minStock).toString(), m(price), m(lineValue), status] as Cell[];
  });
  return {
    title: "Stock Summary",
    dated: false,
    columns: ["Item", "Code", "Category", "Unit", "Stock Qty", "Low-stock At Qty", "Purchase Price ₹", "Stock Value ₹", "Status"],
    rows,
    footer: [["Total", "", "", "", "", "", "", m(value), ""]],
    note: "Stock value = current stock × the item's current purchase price (not FIFO/weighted cost). Negative stock is valued at 0.",
  };
}

const MOVEMENT_LABELS: Record<string, string> = {
  OPENING: "Opening",
  SALE: "Sale",
  PURCHASE: "Purchase",
  ADJUSTMENT: "Adjustment",
  SALE_RETURN: "Sale Return",
  PURCHASE_RETURN: "Purchase Return",
  REVERSAL: "Reversal (edit/cancel)",
};

export async function stockMovementReport(businessId: string, f: ReportFilters): Promise<Report> {
  const where: Prisma.StockTransactionWhereInput = {
    product: { businessId },
    ...(f.productId ? { productId: f.productId } : {}),
    ...dateWhere(f, "date"),
  };
  const moves = await prisma.stockTransaction.findMany({
    where,
    include: { product: { include: { unit: true } }, referenceInvoice: { select: { invoiceNo: true } } },
    orderBy: [{ date: "asc" }],
    take: 5000,
  });
  return {
    title: "Stock Movement",
    dated: true,
    columns: ["Date", "Item", "Type", "Reference", "Qty In", "Qty Out", "Stock After", "Note"],
    rows: moves.map((mv) => {
      const q = toDecimal(mv.quantity);
      return [
        d(mv.date),
        mv.product.name,
        MOVEMENT_LABELS[mv.type] ?? mv.type,
        mv.referenceInvoice?.invoiceNo ?? "",
        q.greaterThan(0) ? q.toString() : "",
        q.lessThan(0) ? q.negated().toString() : "",
        toDecimal(mv.resultingStock).toString(),
        mv.note,
      ] as Cell[];
    }),
    note: moves.length === 5000 ? "Showing the first 5000 movements; narrow the dates or pick an item." : "Opening stock is shown on the Stock Summary, not as a movement.",
  };
}

async function balancesReport(businessId: string, side: "receivable" | "payable"): Promise<Report> {
  const [parties, balances] = await Promise.all([
    prisma.customer.findMany({ where: { businessId }, orderBy: { name: "asc" } }),
    partyBalances(businessId),
  ]);
  let total = new Decimal(0);
  const rows: Cell[][] = [];
  for (const p of parties) {
    const bal = balances.get(p.id) ?? new Decimal(0);
    const amount = side === "receivable" ? bal : bal.negated();
    if (!amount.greaterThan(0)) continue;
    total = total.plus(amount);
    rows.push([p.name, p.phone, p.gstin, m(amount)]);
  }
  return {
    title: side === "receivable" ? "Receivables (To Receive)" : "Payables (To Pay)",
    dated: false,
    columns: ["Party", "Phone", "GSTIN", side === "receivable" ? "To Receive ₹" : "To Pay ₹"],
    rows,
    footer: [["Total", "", "", m(total)]],
    note: "Net balance per party: opening balance + invoices + debit notes + payments out − credit notes − purchase bills − payments in.",
  };
}

export const receivablesReport = (businessId: string) => balancesReport(businessId, "receivable");
export const payablesReport = (businessId: string) => balancesReport(businessId, "payable");

/**
 * Rate-wise GST summary for outward (sales − credit notes) and inward (purchases − debit notes)
 * supplies, plus HSN-wise outward summary. For reconciling before filing — not a GSTR return.
 */
export async function gstSummaryReport(businessId: string, f: ReportFilters): Promise<Report> {
  const docs = await prisma.saleInvoice.findMany({
    where: { businessId, status: "ACTIVE", docType: { in: ["SALE_INVOICE", "CREDIT_NOTE", "PURCHASE_BILL", "DEBIT_NOTE"] }, ...dateWhere(f) },
    include: { items: true },
  });

  type Bucket = { taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal };
  const zero = (): Bucket => ({ taxable: new Decimal(0), cgst: new Decimal(0), sgst: new Decimal(0), igst: new Decimal(0) });
  const byRate = new Map<string, Bucket>();
  const byHsn = new Map<string, Bucket & { qty: Decimal }>();
  const cess = { OUT: new Decimal(0), IN: new Decimal(0) };

  for (const doc of docs) {
    const flow = DOC_TYPES[doc.docType].side === "SALE" ? "OUT" : "IN";
    const sign = doc.docType === "CREDIT_NOTE" || doc.docType === "DEBIT_NOTE" ? -1 : 1;
    cess[flow] = cess[flow].plus(toDecimal(doc.cess).times(sign));
    const lines = adjustedTaxLines(doc, doc.items);
    lines.forEach((line, i) => {
      const key = `${flow}|${line.taxRate.toFixed(2)}`;
      const b = byRate.get(key) ?? zero();
      b.taxable = b.taxable.plus(line.taxable.times(sign));
      b.cgst = b.cgst.plus(line.cgst.times(sign));
      b.sgst = b.sgst.plus(line.sgst.times(sign));
      b.igst = b.igst.plus(line.igst.times(sign));
      byRate.set(key, b);
      if (flow === "OUT") {
        const hkey = `${line.hsn || "-"}|${line.taxRate.toFixed(2)}`;
        const h = byHsn.get(hkey) ?? { ...zero(), qty: new Decimal(0) };
        h.taxable = h.taxable.plus(line.taxable.times(sign));
        h.cgst = h.cgst.plus(line.cgst.times(sign));
        h.sgst = h.sgst.plus(line.sgst.times(sign));
        h.igst = h.igst.plus(line.igst.times(sign));
        if (!line.isCharge) h.qty = h.qty.plus(toDecimal(doc.items[i].quantity).times(sign));
        byHsn.set(hkey, h);
      }
    });
  }

  const rows: Cell[][] = [];
  const totals = { OUT: zero(), IN: zero() };
  for (const flow of ["OUT", "IN"] as const) {
    const keys = [...byRate.keys()].filter((k) => k.startsWith(`${flow}|`)).sort((a, b) => Number(a.split("|")[1]) - Number(b.split("|")[1]));
    for (const key of keys) {
      const b = byRate.get(key)!;
      const t = totals[flow];
      t.taxable = t.taxable.plus(b.taxable);
      t.cgst = t.cgst.plus(b.cgst);
      t.sgst = t.sgst.plus(b.sgst);
      t.igst = t.igst.plus(b.igst);
      rows.push([flow === "OUT" ? "Outward (sales − credit notes)" : "Inward (purchases − debit notes)", `${Number(key.split("|")[1])}%`, "", m(b.taxable), m(b.cgst), m(b.sgst), m(b.igst), m(b.cgst.plus(b.sgst).plus(b.igst))]);
    }
    const t = totals[flow];
    rows.push([flow === "OUT" ? "Total outward" : "Total inward", "", "", m(t.taxable), m(t.cgst), m(t.sgst), m(t.igst), m(t.cgst.plus(t.sgst).plus(t.igst))]);
    if (!cess[flow].isZero()) rows.push([flow === "OUT" ? "Cess on outward" : "Cess on inward", "", "", "", "", "", "", m(cess[flow])]);
  }

  const hsnRows = [...byHsn.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, h]) => {
      const [hsn, rate] = key.split("|");
      return [`HSN ${hsn}`, `${Number(rate)}%`, h.qty.toString(), m(h.taxable), m(h.cgst), m(h.sgst), m(h.igst), m(h.cgst.plus(h.sgst).plus(h.igst))] as Cell[];
    });

  const outTax = totals.OUT.cgst.plus(totals.OUT.sgst).plus(totals.OUT.igst);
  const inTax = totals.IN.cgst.plus(totals.IN.sgst).plus(totals.IN.igst);
  return {
    title: "GST Summary",
    dated: true,
    columns: ["Section", "Rate", "Qty", "Taxable ₹", "CGST ₹", "SGST ₹", "IGST ₹", "Total Tax ₹"],
    rows: [...rows, ["HSN-wise outward summary", "", "", "", "", "", "", ""], ...hsnRows],
    footer: [["Output tax − input tax on purchase bills", "", "", "", "", "", "", m(outTax.minus(inTax))]],
    note:
      "For checking your figures before filing. This app does not file GST returns or generate e-invoices/e-way bills. " +
      "Input tax shown is from purchase bills entered here; actual eligible ITC depends on GSTR-2B and eligibility rules. Dates follow the document date.",
  };
}

/** Money in and out by payment mode: payments in/out and expenses. Invoices without payment do not appear. */
export async function cashBankReport(businessId: string, f: ReportFilters): Promise<Report> {
  const [vouchers, expenses] = await Promise.all([
    prisma.paymentVoucher.findMany({ where: { businessId, status: "ACTIVE", ...dateWhere(f, "date") }, include: { party: true } }),
    prisma.expense.findMany({ where: { businessId, status: "ACTIVE", ...dateWhere(f, "date") }, include: { category: true } }),
  ]);
  type Entry = { date: Date; mode: string; kind: string; number: string; party: string; inAmt: Decimal; outAmt: Decimal };
  const entries: Entry[] = [
    ...vouchers.map((v) => ({
      date: v.date,
      mode: v.mode,
      kind: v.direction === "IN" ? "Payment In" : "Payment Out",
      number: v.voucherNo,
      party: v.party?.name ?? "",
      inAmt: v.direction === "IN" ? toDecimal(v.amount) : new Decimal(0),
      outAmt: v.direction === "OUT" ? toDecimal(v.amount) : new Decimal(0),
    })),
    ...expenses.map((e) => ({ date: e.date, mode: e.mode, kind: `Expense — ${e.category.name}`, number: e.expenseNo, party: e.paidTo ?? "", inAmt: new Decimal(0), outAmt: toDecimal(e.amount) })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  const byMode = new Map<string, { inAmt: Decimal; outAmt: Decimal }>();
  for (const e of entries) {
    const b = byMode.get(e.mode) ?? { inAmt: new Decimal(0), outAmt: new Decimal(0) };
    b.inAmt = b.inAmt.plus(e.inAmt);
    b.outAmt = b.outAmt.plus(e.outAmt);
    byMode.set(e.mode, b);
  }
  return {
    title: "Cash & Bank Book",
    dated: true,
    columns: ["Date", "Mode", "Type", "Number", "Party / Paid To", "In ₹", "Out ₹"],
    rows: entries.map((e) => [d(e.date), e.mode.replace("_", " "), e.kind, e.number, e.party, e.inAmt.isZero() ? "" : m(e.inAmt), e.outAmt.isZero() ? "" : m(e.outAmt)]),
    footer: [...byMode.entries()].map(([mode, b]) => ["", mode.replace("_", " "), `Net ${m(b.inAmt.minus(b.outAmt))}`, "", "", m(b.inAmt), m(b.outAmt)] as Cell[]),
    note: "Movements in the period only (no opening cash/bank balance is tracked). Sales and purchases appear here only when a payment is recorded, so nothing is counted twice.",
  };
}

export const REPORTS = {
  sales: { label: "Sales Register", run: salesReport },
  purchases: { label: "Purchase Register", run: purchaseReport },
  expenses: { label: "Expenses", run: expenseReport },
  "stock-summary": { label: "Stock Summary", run: (b: string) => stockSummaryReport(b) },
  "stock-movement": { label: "Stock Movement", run: stockMovementReport },
  receivables: { label: "Receivables", run: (b: string) => receivablesReport(b) },
  payables: { label: "Payables", run: (b: string) => payablesReport(b) },
  "gst-summary": { label: "GST Summary", run: gstSummaryReport },
  "cash-bank": { label: "Cash & Bank Book", run: cashBankReport },
} as const;

export type ReportKey = keyof typeof REPORTS;
