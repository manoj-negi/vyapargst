import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Decimal, round2, toDecimal } from "../../lib/decimal";
import { GST_STATE_CODES, INDIAN_STATES } from "../../lib/indianStates";
import { calculateInvoiceTotals, calculateLineItem, isIntraState, type LineItemResult } from "../gst/gstEngine";
import { unitCostFor } from "../profit/profitService";
import type { Draft, DraftRow } from "./schema";

/**
 * Review of an import draft, recomputed on every change and again at confirmation. Nothing here
 * writes to the database. Totals come from the app's own GST engine (never from AI arithmetic) and
 * are reconciled with the totals printed on the bill.
 */

export const TOTAL_TOLERANCE = 1.0; // ₹ difference allowed for rounding between printed and calculated totals
export const LINE_TOLERANCE = 0.5;

type ProductRow = Prisma.ProductGetPayload<{ include: { tax: true; unit: true; secondaryUnit: true } }>;

// ---------- Text normalisation for matching ----------
const SIZE = /(\d+(?:\.\d+)?)\s*(ml|ltrs?|litres?|l|gsm|gms?|g|kgs?|mm|cm|mtrs?|m|ply|pcs|pc|nos|pkt|sheets?|inch|in)\b/gi;
const UNIT_ALIASES: Record<string, string> = { pcs: "pcs", pc: "pcs", piece: "pcs", pieces: "pcs", nos: "pcs", no: "pcs", unit: "pcs", units: "pcs", box: "box", bx: "box", boxes: "box", pkt: "pack", packet: "pack", packets: "pack", pack: "pack", packs: "pack", kg: "kg", kgs: "kg", g: "g", gm: "g", gms: "g", ltr: "l", l: "l", litre: "l", litres: "l", ml: "ml", ream: "ream", reams: "ream", doz: "dozen", dozen: "dozen", set: "set", sets: "set", roll: "roll", rolls: "roll", bottle: "bottle", btl: "bottle" };
export const normUnit = (u: string | null | undefined) => {
  const k = (u || "").toLowerCase().replace(/[^a-z]/g, "");
  return UNIT_ALIASES[k] ?? k;
};
export const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
export const normCode = (s: string | null | undefined) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function sizeTokens(s: string): string[] {
  const t = s.toLowerCase();
  return Array.from(t.matchAll(SIZE)).map((m) => `${Number(m[1])}${normUnit(m[2]) || m[2]}`).sort();
}
const STOP = new Set(["the", "and", "for", "with", "of", "new", "item", "pcs", "nos"]);
function words(s: string): Set<string> {
  return new Set(normName(s.toLowerCase().replace(SIZE, " ")).split(" ").filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+(\.\d+)?$/.test(w)));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
export function mapKey(row: { supplierCode: string | null; description: string }): string {
  const code = normCode(row.supplierCode);
  return code ? `code:${code}` : `name:${normName(row.description)}`;
}

// ---------- Supplier ----------
export function stateFromGstin(gstin: string | null | undefined): string | null {
  const code = (gstin || "").trim().slice(0, 2);
  const hit = (Object.entries(GST_STATE_CODES) as [string, string][]).find(([, c]) => c === code);
  return hit ? hit[0] : null;
}

export async function findSupplier(businessId: string, supplier: Draft["supplier"]) {
  const parties = await prisma.customer.findMany({ where: { businessId, isActive: true, partyType: { in: ["SUPPLIER", "BOTH"] } } });
  const gstin = (supplier.gstin || "").trim().toUpperCase();
  if (gstin) {
    const byGstin = parties.find((p) => (p.gstin || "").toUpperCase() === gstin);
    if (byGstin) return { match: byGstin, how: "GSTIN" as const, suggestions: [] };
  }
  const name = normName(supplier.name || "");
  const exact = name ? parties.filter((p) => normName(p.name) === name) : [];
  if (exact.length === 1) return { match: exact[0], how: "name" as const, suggestions: [] };
  const w = words(supplier.name || "");
  const suggestions = parties
    .map((p) => ({ p, score: jaccard(w, words(p.name)) }))
    .filter((x) => x.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.p);
  return { match: null, how: null, suggestions: exact.length > 1 ? exact : suggestions };
}

// ---------- Products ----------
export interface MatchResult {
  productId: string | null;
  status: "remembered" | "code" | "suggested" | "unmatched";
  reason: string;
  unitFactor: number | null;
  suggestions: { id: string; name: string; reason: string }[];
  differentSize: { id: string; name: string; reason: string }[];
}

/** Matches a bill line to an item: remembered supplier mapping, then code/barcode, then name evidence (suggested only). */
export function matchRow(row: DraftRow, products: ProductRow[], maps: { matchKey: string; productId: string; billUnit: string | null; unitFactor: Prisma.Decimal }[]): MatchResult {
  const remembered = maps.find((m) => m.matchKey === mapKey(row)) ?? (row.supplierCode ? maps.find((m) => m.matchKey === `name:${normName(row.description)}`) : undefined);
  const live = (id: string) => products.find((p) => p.id === id);
  if (remembered && live(remembered.productId)) {
    const sameUnit = normUnit(remembered.billUnit) === normUnit(row.unit);
    return { productId: remembered.productId, status: "remembered", reason: "Confirmed on an earlier bill from this supplier", unitFactor: sameUnit ? toDecimal(remembered.unitFactor).toNumber() : null, suggestions: [], differentSize: [] };
  }
  const code = normCode(row.supplierCode) || normCode(row.barcode);
  if (code) {
    const byCode = products.filter((p) => normCode(p.barcode) === code || normCode(p.itemCode) === code);
    if (byCode.length === 1) return { productId: byCode[0].id, status: "code", reason: "Same item code / barcode", unitFactor: null, suggestions: [], differentSize: [] };
  }
  const rowWords = words(row.description);
  const rowSizes = sizeTokens(row.description).join("|");
  const scored = products
    .map((p) => ({ p, score: jaccard(rowWords, words(p.name)), sameSize: sizeTokens(p.name).join("|") === rowSizes }))
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  const suggestions = scored.filter((x) => x.sameSize).slice(0, 4).map((x) => ({ id: x.p.id, name: x.p.name, reason: x.score === 1 ? "Same name" : `Similar name (${Math.round(x.score * 100)}%)` }));
  const differentSize = scored.filter((x) => !x.sameSize).slice(0, 3).map((x) => ({ id: x.p.id, name: x.p.name, reason: "Similar name but a different size/variant" }));
  // Names alone never decide a match: the best one is pre-selected only as a suggestion to confirm
  const top = scored.find((x) => x.sameSize && x.score === 1);
  return { productId: top ? top.p.id : null, status: top ? "suggested" : "unmatched", reason: top ? "Same name — please confirm" : suggestions.length ? "Possible matches below" : "No matching item", unitFactor: null, suggestions, differentSize };
}

/** Base units of the item per bill unit, when known for certain */
export function knownUnitFactor(product: ProductRow, billUnit: string | null): number | null {
  const u = normUnit(billUnit);
  if (!u || u === normUnit(product.unit?.name) || u === normUnit(product.unit?.shortName)) return 1;
  const sec = product.secondaryUnit;
  if (sec && (u === normUnit(sec.name) || u === normUnit(sec.shortName)) && product.conversionRate && toDecimal(product.conversionRate).greaterThan(0)) {
    return new Decimal(1).dividedBy(toDecimal(product.conversionRate)).toNumber(); // 1 base = N secondary
  }
  return null;
}

// ---------- Full review ----------
export interface RowReview {
  id: string;
  status: MatchResult["status"] | "create" | "skip";
  matchReason: string;
  product: { id: string; name: string; unit: string | null; secondaryUnit: string | null; conversionRate: number | null; currentStock: number; gstRate: number; purchasePrice: number | null; purchasePriceType: string } | null;
  suggestions: MatchResult["suggestions"];
  differentSize: MatchResult["differentSize"];
  unitFactor: number | null;
  needsConversion: boolean;
  baseUnit: string | null;
  baseQuantity: number | null;
  taxable: number | null;
  total: number | null;
  lineMismatch: number | null;
  cost: { previous: number | null; next: number | null; change: number | null; percent: number | null; direction: "up" | "down" | "same" | null; update: boolean; lastPurchase: { ref: string; date: string; rate: number; unit: string | null } | null } | null;
  gstMismatch: { bill: number; item: number } | null;
  flags: string[];
  blockers: string[];
}

export interface Review {
  supplier: { id: string | null; how: string | null; name: string | null; suggestions: { id: string; name: string; gstin: string | null }[] };
  intra: boolean;
  rows: RowReview[];
  totals: { subtotal: number; discount: number; charges: number; taxable: number; tax: number; roundOff: number; total: number; printedTotal: number | null; difference: number | null; mismatch: boolean };
  duplicates: { bills: { id: string; ref: string; date: string; total: number }[]; files: { importId: string; name: string; status: string }[] };
  summary: { stockItems: { name: string; quantity: number; unit: string | null }[]; newItems: string[]; priceChanges: { name: string; from: number | null; to: number; percent: number | null }[]; billTotal: number; outstanding: number };
  blockers: string[];
  warnings: string[];
  isPurchase: boolean;
}

export async function reviewDraft(business: { id: string; state: string; gstRegistered: boolean }, importId: string, draft: Draft): Promise<Review> {
  const isPurchase = draft.documentKind === "invoice";
  const [products, supplierFind] = await Promise.all([
    prisma.product.findMany({ where: { businessId: business.id, isActive: true }, include: { tax: true, unit: true, secondaryUnit: true } }),
    draft.supplierId ? Promise.resolve(null) : findSupplier(business.id, draft.supplier),
  ]);
  const supplier = draft.supplierId ? await prisma.customer.findFirst({ where: { id: draft.supplierId, businessId: business.id } }) : null;
  const supplierId = supplier?.id ?? null;
  const maps = supplierId ? await prisma.supplierItemMap.findMany({ where: { businessId: business.id, supplierId } }) : [];
  const partyState = supplier?.state || draft.supplier.state || stateFromGstin(draft.supplier.gstin) || business.state;
  const intra = isIntraState(business.state, partyState);

  // Lines prepared as new items automatically take a remembered or exact-code match once one applies
  // (e.g. the supplier was chosen after reading); lines the user set to "create" stay as they are
  for (const row of draft.rows) {
    if (row.action !== "create" || !row.autoNew) continue;
    const m = matchRow(row, products, maps);
    if (m.productId && (m.status === "remembered" || m.status === "code")) Object.assign(row, { action: "match", productId: m.productId, matchConfirmed: true, autoNew: false });
  }

  const blockers: string[] = [];
  const warnings: string[] = [];
  const rowsIn = draft.rows.filter((r) => r.action !== "skip");
  if (!rowsIn.length) blockers.push("Add at least one item row (or un-skip one).");
  if (isPurchase && !supplierId && !draft.supplier.name.trim()) blockers.push("Choose the supplier, or enter its name to create it.");
  if (isPurchase && !draft.invoiceDate) blockers.push("Enter the supplier's invoice date.");
  if (isPurchase && !draft.invoiceNo) warnings.push("No supplier invoice number: duplicate bills cannot be detected without it.");
  if (!supplierId && draft.supplier.name.trim() && supplierFind?.suggestions.length) warnings.push("A similar supplier already exists; pick it instead of creating a new one if it is the same business.");

  // Lines the purchase would contain (in each item's base unit), for the engine
  const engineLines: { rowId: string; result: LineItemResult }[] = [];
  const reviews: RowReview[] = [];
  for (const row of draft.rows) {
    const flags: string[] = [];
    const rowBlockers: string[] = [];
    if (row.uncertain.length) flags.push(`Check: ${row.uncertain.join(", ")}`);
    if (row.action === "skip") {
      reviews.push({ id: row.id, status: "skip", matchReason: "Skipped", product: null, suggestions: [], differentSize: [], unitFactor: null, needsConversion: false, baseUnit: null, baseQuantity: null, taxable: null, total: null, lineMismatch: null, cost: null, gstMismatch: null, flags, blockers: [] });
      continue;
    }
    const m = matchRow(row, products, maps);
    let product: ProductRow | null = null;
    let status: RowReview["status"];
    let matchReason: string;
    if (row.action === "create") {
      status = "create";
      matchReason = "New item will be created";
      const np = row.newProduct;
      if (!np || !np.name.trim()) rowBlockers.push("Enter the new item's name.");
      if (!np || !np.unitName.trim()) rowBlockers.push("Enter the new item's unit.");
      const dupe = products.find((p) => normName(p.name) === normName(np?.name || row.description));
      // Bills often print the same short name for different variants (e.g. five "Ex-Note Book" at different rates)
      const sameNew = draft.rows.filter((r) => r.action === "create" && normName(r.newProduct?.name || r.description) === normName(np?.name || row.description));
      if (sameNew.length > 1) rowBlockers.push(`${sameNew.length} new items would be named "${(np?.name || row.description).trim()}": give each a distinct name (e.g. add its size or pages), or skip the extra lines.`);
      if (dupe) flags.push(`An item named "${dupe.name}" already exists; match it instead of creating a duplicate if it is the same product.`);
    } else {
      // A remembered supplier mapping or an exact code applies even when the line has no item yet
      // (e.g. the supplier was chosen after reading)
      const effectiveId = row.productId ?? (m.status === "remembered" || m.status === "code" ? m.productId : null);
      product = effectiveId ? products.find((p) => p.id === effectiveId) ?? null : null;
      if (!product) {
        status = "unmatched";
        matchReason = m.reason;
        rowBlockers.push("Match this line to an item, create a new item, or skip it.");
      } else if (m.productId === product.id && (m.status === "remembered" || m.status === "code")) {
        status = m.status;
        matchReason = m.reason;
      } else {
        status = "suggested";
        matchReason = m.productId === product.id ? m.reason : "Chosen by you";
        if (!row.matchConfirmed && m.productId === product.id) rowBlockers.push("Confirm the suggested item (or choose another).");
      }
    }
    const qty = row.quantity;
    if (qty === null || !(qty > 0)) rowBlockers.push("Enter a quantity above 0.");
    if (row.rate === null || row.rate < 0) rowBlockers.push("Enter the rate.");
    if (row.discountPercent && row.discountAmount) flags.push("Both a discount % and a discount ₹ are present; the % is used.");

    // Units: base units per bill unit
    let unitFactor: number | null = null;
    let baseUnit: string | null = null;
    if (product) {
      baseUnit = product.unit?.name ?? null;
      unitFactor = row.unitFactor ?? (m.productId === product.id ? m.unitFactor : null) ?? knownUnitFactor(product, row.unit);
    } else if (row.action === "create") {
      baseUnit = row.newProduct?.unitName || row.unit;
      unitFactor = row.unitFactor ?? 1;
    }
    const needsConversion = !!product && unitFactor === null;
    if (needsConversion) rowBlockers.push(`Enter how many ${baseUnit || "units"} are in 1 ${row.unit || "bill unit"}.`);

    const itemGst = product ? toDecimal(product.tax?.rate ?? 0).toNumber() : row.newProduct?.gstRate ?? row.gstRate ?? 0;
    const gstMismatch = product && row.gstRate !== null && Math.abs(row.gstRate - itemGst) > 0.001 ? { bill: row.gstRate, item: itemGst } : null;
    if (gstMismatch) flags.push(`The bill shows GST ${gstMismatch.bill}% but the item is set to ${gstMismatch.item}%; the purchase uses the item's rate. Correct the item first if the bill is right.`);

    let result: LineItemResult | null = null;
    let lineMismatch: number | null = null;
    if (qty && qty > 0 && row.rate !== null && row.rate >= 0) {
      try {
        result = calculateLineItem({
          quantity: qty,
          unitPrice: row.rate,
          priceType: row.rateIncludesTax ? "INCLUSIVE" : "EXCLUSIVE",
          discountValue: row.discountPercent || row.discountAmount || 0,
          discountType: row.discountPercent ? "PERCENTAGE" : "FIXED",
          gstRate: itemGst,
          isIntraState: intra,
        });
        engineLines.push({ rowId: row.id, result });
        if (row.extractedLineTotal !== null) {
          const diffs = [result.total, result.taxableValue].map((v) => Math.abs(v.toNumber() - (row.extractedLineTotal as number)));
          const d = Math.min(...diffs);
          if (d > LINE_TOLERANCE) {
            lineMismatch = round2(new Decimal(d)).toNumber();
            flags.push(`The printed line amount (₹${row.extractedLineTotal}) differs from the calculated one by ₹${lineMismatch.toFixed(2)}.`);
          }
        }
      } catch (err) {
        rowBlockers.push(err instanceof RangeError ? err.message : "This line cannot be calculated.");
      }
    }

    reviews.push({
      id: row.id,
      status,
      matchReason,
      product: product
        ? {
            id: product.id,
            name: product.name,
            unit: product.unit?.name ?? null,
            secondaryUnit: product.secondaryUnit?.name ?? null,
            conversionRate: product.conversionRate ? toDecimal(product.conversionRate).toNumber() : null,
            currentStock: toDecimal(product.currentStock).toNumber(),
            gstRate: itemGst,
            purchasePrice: product.purchasePrice ? toDecimal(product.purchasePrice).toNumber() : null,
            purchasePriceType: product.purchasePriceType,
          }
        : null,
      suggestions: m.suggestions,
      differentSize: m.differentSize,
      unitFactor,
      needsConversion,
      baseUnit,
      baseQuantity: qty && unitFactor ? round2(new Decimal(qty + (row.freeQuantity || 0)).times(unitFactor)).toNumber() : null,
      taxable: result ? result.taxableValue.toNumber() : null,
      total: result ? result.total.toNumber() : null,
      lineMismatch,
      cost: null,
      gstMismatch,
      flags,
      blockers: rowBlockers,
    });
    blockers.push(...rowBlockers.map((b) => `${row.description || "A line"}: ${b}`));
  }

  // Invoice totals from the engine
  let totals: Review["totals"];
  let ratio = new Decimal(1);
  try {
    const t = calculateInvoiceTotals({
      lines: engineLines.map((l) => l.result),
      invoiceDiscount: { value: draft.invoiceDiscountAmount || 0, type: "FIXED" },
      charges: { amount: draft.chargesAmount || 0, gstRate: draft.chargesGstRate || 0 },
      isIntraState: intra,
      roundOffMode: draft.roundOff !== null ? "MANUAL" : "AUTOMATIC",
      manualRoundOff: draft.roundOff ?? undefined,
    });
    const subtotal = t.subtotal;
    ratio = subtotal.isZero() ? new Decimal(1) : subtotal.minus(t.discount).dividedBy(subtotal);
    const printed = draft.extractedTotals.grand;
    const difference = printed !== null ? round2(t.total.minus(printed)).toNumber() : null;
    totals = {
      subtotal: subtotal.toNumber(),
      discount: t.discount.toNumber(),
      charges: t.charges.toNumber(),
      taxable: t.taxableAmount.toNumber(),
      tax: t.cgst.plus(t.sgst).plus(t.igst).plus(t.cess).toNumber(),
      roundOff: t.roundOff.toNumber(),
      total: t.total.toNumber(),
      printedTotal: printed,
      difference,
      mismatch: difference !== null && Math.abs(difference) > TOTAL_TOLERANCE,
    };
  } catch (err) {
    blockers.push(err instanceof RangeError ? err.message : "The totals cannot be calculated.");
    totals = { subtotal: 0, discount: 0, charges: 0, taxable: 0, tax: 0, roundOff: 0, total: 0, printedTotal: draft.extractedTotals.grand, difference: null, mismatch: false };
  }
  if (isPurchase && totals.mismatch && !draft.acknowledged.totalsMismatch) {
    blockers.push(`The calculated total (₹${totals.total.toFixed(2)}) differs from the bill's total (₹${(totals.printedTotal ?? 0).toFixed(2)}) by ₹${Math.abs(totals.difference ?? 0).toFixed(2)}. Correct the lines, or tick that you have checked the difference.`);
  }
  if (isPurchase && totals.printedTotal === null) warnings.push("The bill's grand total was not read, so the totals could not be cross-checked.");

  // Cost changes per line (equivalent units, same tax basis as the item's saved cost)
  const lastPurchases = await prisma.saleInvoiceItem.findMany({
    where: { productId: { in: reviews.map((r) => r.product?.id).filter((id): id is string => !!id) }, invoice: { businessId: business.id, docType: "PURCHASE_BILL", status: "ACTIVE" } },
    select: { productId: true, rate: true, unit: true, invoice: { select: { invoiceNo: true, partyInvoiceNo: true, invoiceDate: true } } },
    orderBy: [{ invoice: { invoiceDate: "desc" } }, { invoice: { createdAt: "desc" } }],
  });
  const priceChanges: Review["summary"]["priceChanges"] = [];
  for (const rv of reviews) {
    const row = draft.rows.find((r) => r.id === rv.id)!;
    const line = engineLines.find((l) => l.rowId === rv.id);
    if (!line || !rv.unitFactor || !row.quantity) continue;
    const baseQty = new Decimal(row.quantity + (row.freeQuantity || 0)).times(rv.unitFactor);
    if (baseQty.isZero()) continue;
    const netTaxable = line.result.taxableValue.times(ratio);
    const gst = toDecimal(rv.product?.gstRate ?? 0).dividedBy(100);
    // Cost per base unit after discounts; GST is input credit (excluded) for a registered business
    const exPerBase = netTaxable.dividedBy(baseQty);
    const next = round2(business.gstRegistered ? exPerBase : exPerBase.times(gst.plus(1))).toNumber();
    if (rv.status === "create") continue;
    const p = products.find((x) => x.id === rv.product!.id)!;
    const prevCost = unitCostFor(p, p.unit?.name ?? null, business.gstRegistered).unitCost;
    const previous = prevCost ? round2(prevCost).toNumber() : null;
    const change = previous !== null ? round2(new Decimal(next).minus(previous)).toNumber() : null;
    const direction = change === null ? null : change > 0.004 ? "up" : change < -0.004 ? "down" : "same";
    const update = row.updatePrice ?? (direction === "up" || previous === null);
    const lp = lastPurchases.find((x) => x.productId === p.id);
    rv.cost = {
      previous,
      next,
      change,
      percent: previous ? round2(new Decimal(change!).dividedBy(previous).times(100)).toNumber() : null,
      direction,
      update: direction === "same" ? false : update,
      lastPurchase: lp ? { ref: lp.invoice.partyInvoiceNo || lp.invoice.invoiceNo, date: lp.invoice.invoiceDate.toISOString().slice(0, 10), rate: toDecimal(lp.rate).toNumber(), unit: lp.unit } : null,
    };
    if (rv.cost.update && direction !== "same") priceChanges.push({ name: p.name, from: previous, to: next, percent: rv.cost.percent });
  }

  // Duplicates: same supplier + invoice number (any case/spacing), or same supplier, date and total; same file uploaded before
  const dupBills: Review["duplicates"]["bills"] = [];
  // A supplier found by exact GSTIN counts even before it is chosen in the form
  const dupSupplierId = supplierId ?? (supplierFind?.how === "GSTIN" ? supplierFind.match?.id ?? null : null);
  if (isPurchase && dupSupplierId) {
    const bills = await prisma.saleInvoice.findMany({
      where: { businessId: business.id, docType: "PURCHASE_BILL", status: "ACTIVE", customerId: dupSupplierId },
      select: { id: true, invoiceNo: true, partyInvoiceNo: true, partyInvoiceDate: true, invoiceDate: true, total: true },
    });
    const ref = normCode(draft.invoiceNo);
    for (const b of bills) {
      const sameRef = ref && normCode(b.partyInvoiceNo) === ref;
      // Bill dates are stored as local midnight: compare calendar days in local time, not UTC
      const billDay = (b.partyInvoiceDate ?? b.invoiceDate).toLocaleDateString("en-CA");
      const sameMoney = draft.invoiceDate && billDay === draft.invoiceDate && Math.abs(toDecimal(b.total).toNumber() - totals.total) <= TOTAL_TOLERANCE;
      if (sameRef || sameMoney) dupBills.push({ id: b.id, ref: b.partyInvoiceNo ? `${b.partyInvoiceNo} (${b.invoiceNo})` : b.invoiceNo, date: billDay, total: toDecimal(b.total).toNumber() });
    }
    if (dupBills.length && !draft.acknowledged.duplicateBill) blockers.push("This bill may already be entered (see the warning above). Open the existing bill to check, or tick that this is a different bill.");
  }
  const myFiles = await prisma.purchaseImportFile.findMany({ where: { importId }, select: { sha256: true } });
  const sameFiles = myFiles.length
    ? await prisma.purchaseImportFile.findMany({
        where: { sha256: { in: myFiles.map((f) => f.sha256) }, importId: { not: importId }, import: { businessId: business.id, status: { not: "DISCARDED" } } },
        select: { importId: true, originalName: true, import: { select: { status: true } } },
      })
    : [];
  // The very same file already confirmed as a purchase: must be acknowledged like a duplicate bill
  if (isPurchase && sameFiles.some((f) => f.import.status === "POSTED") && !draft.acknowledged.duplicateBill && !dupBills.length) blockers.push("This same file was already confirmed as a purchase. Open that import to check, or tick that this is a different bill.");

  const stockItems = isPurchase
    ? reviews.filter((r) => r.status !== "skip" && r.baseQuantity).map((r) => ({ name: r.product?.name ?? draft.rows.find((x) => x.id === r.id)!.newProduct?.name ?? "", quantity: r.baseQuantity!, unit: r.baseUnit }))
    : [];
  const newItems = reviews.filter((r) => r.status === "create").map((r) => draft.rows.find((x) => x.id === r.id)!.newProduct?.name || "");

  return {
    supplier: {
      id: supplierId ?? supplierFind?.match?.id ?? null,
      how: supplierId ? "chosen" : supplierFind?.how ?? null,
      name: supplier?.name ?? supplierFind?.match?.name ?? null,
      suggestions: (supplierFind?.suggestions ?? []).map((s) => ({ id: s.id, name: s.name, gstin: s.gstin })),
    },
    intra,
    rows: reviews,
    totals,
    duplicates: { bills: dupBills, files: sameFiles.map((f) => ({ importId: f.importId, name: f.originalName, status: f.import.status })) },
    summary: { stockItems, newItems, priceChanges, billTotal: totals.total, outstanding: totals.total },
    blockers,
    warnings: [...warnings, ...(sameFiles.length ? ["The same file was uploaded in another import."] : [])],
    isPurchase,
  };
}

export const STATES = INDIAN_STATES;
