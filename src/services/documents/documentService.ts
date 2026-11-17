import { Prisma } from "@prisma/client";
import type { Business, BusinessSettings, Customer, DocType, PaymentType, SaleInvoice } from "@prisma/client";
import { cleanDivisionValue, sameDivisionValue } from "../../lib/division";
import { prisma } from "../../lib/prisma";
import { Decimal, toDecimal } from "../../lib/decimal";
import { AppError } from "../../middleware/errorHandler";
import { calculateInvoiceTotals, calculateLineItem, isIntraState } from "../gst/gstEngine";
import type { DiscountType, LineItemResult, PriceType, RoundOffMode } from "../gst/gstEngine";
import { allocateNumber } from "../invoice/numbering";
import { applyStockMovement, assertStockNotNegative, reverseDocumentStock } from "../stock/stockService";
import { refreshSettlement, settledAmount } from "../payments/settlement";
import { createVoucherInTx } from "../payments/paymentService";
import { writeAudit } from "../audit/audit";
import { docConfig } from "./docTypes";
import { unitCostFor } from "../profit/profitService";

type TxClient = Prisma.TransactionClient;

export type BusinessWithSettings = Business & { settings: BusinessSettings | null };

export interface ActionContext {
  business: BusinessWithSettings;
  userId?: string | null;
}

export interface DocumentLineInput {
  productId?: string | null;
  productName: string;
  hsn?: string | null;
  unit?: string | null;
  quantity: number | string;
  unitPrice: number | string;
  priceType: PriceType;
  discountValue: number | string;
  discountType: DiscountType;
  gstRate: number | string;
}

export interface DocumentInput {
  partyId: string;
  date?: Date;
  dueDate?: Date | null;
  items: DocumentLineInput[];
  invoiceDiscountValue?: number | string;
  invoiceDiscountType?: DiscountType;
  manualRoundOff?: number | null;
  chargesLabel?: string | null;
  chargesAmount?: number | string;
  chargesTaxRate?: number | string;
  partyInvoiceNo?: string | null;
  partyInvoiceDate?: Date | null;
  /** Customer's section and department this document is for (sale side only) */
  section?: string | null;
  department?: string | null;
  /**
   * department is an older combined "Section / Department" value that is still unclassified.
   * true keeps it so, false saves section and department as given; when left out, an existing
   * unclassified value stays unclassified as long as it was sent back unchanged.
   */
  legacySectionDepartment?: boolean;
  notes?: string | null;
  /** Estimate being converted (sale invoices only) */
  convertedFromId?: string | null;
  /** Invoice/bill being returned against (credit/debit notes only) */
  originalDocId?: string | null;
  /** Set the note's total off against the original document's balance (default true) */
  adjustAgainstOriginal?: boolean;
  /** Payment received/paid together with a new document */
  paidNowAmount?: number | string;
  paidNowMode?: PaymentType;
  paidNowReference?: string | null;
  clientToken?: string | null;
}

const DEFAULT_SETTINGS = {
  invoicePrefix: "INV-",
  estimatePrefix: "EST-",
  creditNotePrefix: "CN-",
  purchasePrefix: "PB-",
  debitNotePrefix: "DN-",
  invoiceStartNumber: 1,
  financialYearFormat: false,
  roundOffMode: "AUTOMATIC" as RoundOffMode,
  negativeStockPolicy: "ALLOW_WITH_WARNING" as const,
};

export function effectiveSettings(business: BusinessWithSettings) {
  return { ...DEFAULT_SETTINGS, ...(business.settings ?? {}) };
}

export function businessSnapshot(business: Business): Prisma.InputJsonValue {
  return {
    name: business.name,
    tradeName: business.tradeName,
    gstin: business.gstin,
    pan: business.pan,
    phone: business.phone,
    email: business.email,
    address: business.address,
    city: business.city,
    state: business.state,
    pincode: business.pincode,
    country: business.country,
    logoPath: business.logoPath,
    signaturePath: business.signaturePath,
    bankName: business.bankName,
    bankAccountNo: business.bankAccountNo,
    bankIfsc: business.bankIfsc,
    bankAccountHolder: business.bankAccountHolder,
    upiId: business.upiId,
    upiName: business.upiName,
  };
}

export function partySnapshot(party: Customer): Prisma.InputJsonValue {
  return {
    name: party.name,
    phone: party.phone,
    email: party.email,
    gstin: party.gstin,
    pan: party.pan,
    billingAddress: party.billingAddress,
    shippingAddress: party.shippingAddress,
    state: party.state,
    pincode: party.pincode,
    customerType: party.customerType,
    department: party.department,
    section: party.section,
  };
}

/** Section / department to save; an unclassified older value is kept unless the user classified it. */
function resolveDivision(input: DocumentInput, existing: SaleInvoice | null) {
  const section = cleanDivisionValue(input.section);
  const department = cleanDivisionValue(input.department);
  const keepLegacy =
    input.legacySectionDepartment ??
    (!!existing?.legacySectionDepartment && !section && sameDivisionValue(department ?? existing.department, existing.department));
  if (keepLegacy) {
    const text = department ?? (existing?.legacySectionDepartment ? existing.department : null);
    return { section, department: text, legacySectionDepartment: !!text };
  }
  return { section, department, legacySectionDepartment: false };
}

function money(value: Decimal.Value): string {
  return toDecimal(value).toFixed(2);
}

function withRangeErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RangeError) throw new AppError(err.message, 422);
    throw err;
  }
}

interface EnrichedLine extends DocumentLineInput {
  productId: string | null;
  priceType: PriceType;
}

/**
 * Fixes each line's GST rate, HSN and price type. Catalog items take them from the product master
 * (never from the browser); lines already on the document being edited, or on the original
 * invoice a return is raised against, keep the values they were issued with.
 */
async function enrichLines(
  tx: TxClient,
  businessId: string,
  docType: DocType,
  items: DocumentLineInput[],
  snapshotLines: { productId: string | null; taxRate: Prisma.Decimal; hsn: string | null; priceType: PriceType | null }[]
): Promise<EnrichedLine[]> {
  const isPurchaseSide = docConfig(docType).side === "PURCHASE";
  return Promise.all(
    items.map(async (item) => {
      if (!item.productId) return { ...item, productId: null };
      const product = await tx.product.findFirst({
        where: { id: item.productId, businessId },
        include: { tax: true },
      });
      if (!product) throw new AppError(`Item "${item.productName}" was not found`, 422);

      const issued = snapshotLines.find((l) => l.productId === product.id);
      const masterPriceType = isPurchaseSide ? product.purchasePriceType : product.priceType;
      return {
        ...item,
        productId: product.id,
        hsn: issued ? issued.hsn : product.hsnCode || item.hsn || null,
        gstRate: issued ? issued.taxRate.toString() : product.tax ? product.tax.rate.toString() : "0",
        priceType: issued?.priceType ?? masterPriceType,
      };
    })
  );
}

export interface ComputedDocument {
  lines: EnrichedLine[];
  lineResults: LineItemResult[];
  totals: ReturnType<typeof calculateInvoiceTotals>;
  intra: boolean;
}

export function computeDocument(
  business: BusinessWithSettings,
  partyState: string,
  lines: EnrichedLine[],
  input: Pick<DocumentInput, "invoiceDiscountValue" | "invoiceDiscountType" | "manualRoundOff" | "chargesAmount" | "chargesTaxRate">
): ComputedDocument {
  const settings = effectiveSettings(business);
  const intra = isIntraState(business.state, partyState);
  return withRangeErrors(() => {
    const lineResults = lines.map((item) =>
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
    const manual = input.manualRoundOff !== undefined && input.manualRoundOff !== null && !Number.isNaN(input.manualRoundOff);
    const totals = calculateInvoiceTotals({
      lines: lineResults,
      invoiceDiscount: { value: input.invoiceDiscountValue ?? 0, type: input.invoiceDiscountType ?? "PERCENTAGE" },
      charges: { amount: input.chargesAmount ?? 0, gstRate: input.chargesTaxRate ?? 0 },
      isIntraState: intra,
      roundOffMode: manual ? "MANUAL" : settings.roundOffMode,
      manualRoundOff: manual ? (input.manualRoundOff as number) : undefined,
    });
    return { lines, lineResults, totals, intra };
  });
}

function validateInput(input: DocumentInput) {
  if (!input.items.length) throw new AppError("Add at least one item", 422);
  for (const item of input.items) {
    if (!item.productName.trim()) throw new AppError("Every line needs an item name", 422);
    if (!toDecimal(item.quantity).greaterThan(0)) throw new AppError(`Quantity for "${item.productName}" must be more than 0`, 422);
    if (toDecimal(item.unitPrice).lessThan(0)) throw new AppError(`Price for "${item.productName}" cannot be negative`, 422);
    if (toDecimal(item.discountValue).lessThan(0)) throw new AppError(`Discount for "${item.productName}" cannot be negative`, 422);
  }
  if (toDecimal(input.chargesAmount ?? 0).lessThan(0)) throw new AppError("Charges cannot be negative", 422);
  if (toDecimal(input.paidNowAmount ?? 0).lessThan(0)) throw new AppError("Amount paid cannot be negative", 422);
}

/** Checks a credit/debit note's returned quantities against what the original document still has unreturned. */
async function validateReturnQuantities(
  tx: TxClient,
  original: SaleInvoice & { items: { productId: string | null; productName: string; quantity: Prisma.Decimal }[] },
  lines: EnrichedLine[],
  excludeNoteId: string | null
) {
  const priorReturns = await tx.saleInvoiceItem.findMany({
    where: {
      invoice: { originalDocId: original.id, status: "ACTIVE", ...(excludeNoteId ? { id: { not: excludeNoteId } } : {}) },
    },
  });
  const key = (l: { productId: string | null; productName: string }) => l.productId ?? `name:${l.productName.trim().toLowerCase()}`;
  const remaining = new Map<string, Decimal>();
  for (const item of original.items) remaining.set(key(item), (remaining.get(key(item)) ?? new Decimal(0)).plus(toDecimal(item.quantity)));
  for (const item of priorReturns) remaining.set(key(item), (remaining.get(key(item)) ?? new Decimal(0)).minus(toDecimal(item.quantity)));

  const requested = new Map<string, Decimal>();
  for (const line of lines) requested.set(key(line), (requested.get(key(line)) ?? new Decimal(0)).plus(toDecimal(line.quantity)));

  for (const line of lines) {
    const left = remaining.get(key(line));
    if (left === undefined) throw new AppError(`"${line.productName}" is not on ${original.invoiceNo}`, 422);
    if (requested.get(key(line))!.greaterThan(left)) {
      throw new AppError(`Only ${left.toString()} of "${line.productName}" from ${original.invoiceNo} can still be returned`, 422);
    }
  }
}

/**
 * Cost basis saved with each sale line (for the owner's estimated profit). A line already on the
 * invoice being edited keeps the cost it was saved with, including "none" on invoices saved before
 * costs were recorded, so editing never back-fills a historical cost; new lines take today's cost.
 */
async function lineCosts(
  tx: TxClient,
  business: BusinessWithSettings,
  lines: EnrichedLine[],
  existingItems: { productId: string | null; unit: string | null; unitCost: Prisma.Decimal | null; costBasis: string | null }[]
): Promise<{ unitCost: string | null; costBasis: string | null }[]> {
  const ids = Array.from(new Set(lines.map((l) => l.productId).filter((id): id is string => !!id)));
  const products = await tx.product.findMany({
    where: { businessId: business.id, id: { in: ids } },
    include: { tax: true, unit: true, secondaryUnit: true },
  });
  return lines.map((line) => {
    const prior = line.productId ? existingItems.find((e) => e.productId === line.productId && (e.unit || "") === (line.unit || "")) : undefined;
    if (prior) return { unitCost: prior.unitCost ? prior.unitCost.toString() : null, costBasis: prior.costBasis };
    const c = unitCostFor(products.find((p) => p.id === line.productId) ?? null, line.unit, business.gstRegistered);
    return { unitCost: c.unitCost ? c.unitCost.toFixed(4) : null, costBasis: c.basis };
  });
}

function lineCreateData(lines: EnrichedLine[], results: LineItemResult[], costs: { unitCost: string | null; costBasis: string | null }[] | null = null) {
  return lines.map((item, i) => ({
    ...(costs ? costs[i] : {}),
    productId: item.productId || null,
    productName: item.productName.trim(),
    hsn: item.hsn || null,
    unit: item.unit || null,
    quantity: toDecimal(item.quantity).toFixed(2),
    rate: money(item.unitPrice),
    discount: money(item.discountValue),
    discountType: item.discountType,
    taxRate: toDecimal(item.gstRate).toFixed(2),
    priceType: item.priceType,
    taxableAmount: money(results[i].taxableValue),
    cgst: money(results[i].cgst),
    sgst: money(results[i].sgst),
    igst: money(results[i].igst),
    finalAmount: money(results[i].total),
  }));
}

async function applyDocumentStock(
  tx: TxClient,
  doc: SaleInvoice,
  lines: EnrichedLine[],
  policy: "PREVENT" | "ALLOW_WITH_WARNING"
): Promise<string[]> {
  const config = docConfig(doc.docType);
  if (config.stockSign === 0 || !config.stockType) return [];
  const touched: string[] = [];
  for (const line of lines) {
    if (!line.productId) continue;
    const qty = toDecimal(line.quantity).times(config.stockSign);
    const recorded = await applyStockMovement(
      tx,
      { productId: line.productId, quantity: qty, type: config.stockType, referenceInvoiceId: doc.id, date: doc.invoiceDate },
      policy
    );
    if (recorded) touched.push(line.productId);
  }
  return touched;
}

/** Applies a credit/debit note's set-off against its original document. */
async function applyReturnAdjustment(tx: TxClient, note: SaleInvoice, adjust: boolean) {
  if (!note.originalDocId) return;
  let adjusted = new Decimal(0);
  if (adjust) {
    // What the original still owes, ignoring this note's own earlier set-off.
    await tx.saleInvoice.update({ where: { id: note.id }, data: { adjustedAmount: "0" } });
    const original = await tx.saleInvoice.findUniqueOrThrow({ where: { id: note.originalDocId } });
    const outstanding = toDecimal(original.total).minus(await settledAmount(tx, original.id));
    adjusted = Decimal.max(0, Decimal.min(toDecimal(note.total), outstanding));
  }
  await tx.saleInvoice.update({ where: { id: note.id }, data: { adjustedAmount: adjusted.toFixed(2) } });
  await refreshSettlement(tx, note.originalDocId);
}

/**
 * Creates (existingId omitted) or edits a trade document atomically: numbering, line snapshots,
 * stock movements, set-off against the original document, payment taken now, settlement figures
 * and the audit row either all commit or none do.
 */
export async function saveDocument(
  ctx: ActionContext,
  docType: DocType,
  input: DocumentInput,
  existingId?: string,
  /** Run inside the caller's transaction (e.g. an AI bill import that also creates products) */
  outerTx?: TxClient
): Promise<{ document: SaleInvoice; duplicate: boolean }> {
  const config = docConfig(docType);
  const business = ctx.business;
  const settings = effectiveSettings(business);
  validateInput(input);
  const inTx = <T,>(fn: (tx: TxClient) => Promise<T>): Promise<T> => (outerTx ? fn(outerTx) : prisma.$transaction(fn, { timeout: 30000 }));

  if (!existingId && input.clientToken) {
    const already = await prisma.saleInvoice.findUnique({ where: { clientToken: input.clientToken } });
    if (already) return { document: already, duplicate: true };
  }

  try {
    const document = await inTx(
      async (tx) => {
        const party = await tx.customer.findFirst({ where: { id: input.partyId, businessId: business.id } });
        if (!party) throw new AppError(`Please select a valid ${config.partyLabel.toLowerCase()}`, 422);

        const existing = existingId
          ? await tx.saleInvoice.findFirst({ where: { id: existingId, businessId: business.id, docType }, include: { items: true } })
          : null;
        if (existingId && !existing) throw new AppError(`${config.label} not found`, 404);
        if (existing?.status === "CANCELLED") throw new AppError(`A cancelled ${config.label.toLowerCase()} cannot be edited`, 400);

        // Original document for returns, estimate for conversions
        let original: Prisma.SaleInvoiceGetPayload<{ include: { items: true } }> | null = null;
        const originalDocId = config.returnOf ? input.originalDocId || existing?.originalDocId || null : null;
        if (config.returnOf && originalDocId) {
          original = await tx.saleInvoice.findFirst({
            where: { id: originalDocId, businessId: business.id, docType: config.returnOf },
            include: { items: true },
          });
          if (!original) throw new AppError(`Original ${docConfig(config.returnOf).label.toLowerCase()} not found`, 422);
          if (original.status === "CANCELLED") throw new AppError(`${original.invoiceNo} is cancelled`, 422);
          if (original.customerId !== party.id) throw new AppError(`${original.invoiceNo} belongs to a different party`, 422);
        }

        let convertedFromId: string | null = null;
        if (docType === "SALE_INVOICE" && input.convertedFromId && !existing) {
          const estimate = await tx.saleInvoice.findFirst({
            where: { id: input.convertedFromId, businessId: business.id, docType: "ESTIMATE", status: "ACTIVE" },
          });
          if (!estimate) throw new AppError("Estimate not found or cancelled", 422);
          convertedFromId = estimate.id;
        }

        const snapshotLines = [...(existing?.items ?? []), ...(original?.items ?? [])];
        const lines = await enrichLines(tx, business.id, docType, input.items, snapshotLines);
        const costs = docType === "SALE_INVOICE" ? await lineCosts(tx, business, lines, existing?.items ?? []) : null;
        if (original) await validateReturnQuantities(tx, original, lines, existing?.id ?? null);

        const computed = computeDocument(business, party.state, lines, input);
        const { totals } = computed;
        const date = input.date ?? existing?.invoiceDate ?? new Date();

        const header = {
          customerId: party.id,
          invoiceDate: date,
          dueDate: input.dueDate ?? null,
          placeOfSupply: config.side === "SALE" ? party.state : business.state,
          taxType: computed.intra ? ("INTRA_STATE" as const) : ("INTER_STATE" as const),
          subtotal: money(totals.subtotal),
          discount: money(totals.discount),
          invoiceDiscountValue: money(input.invoiceDiscountValue ?? 0),
          invoiceDiscountType: input.invoiceDiscountType ?? "PERCENTAGE",
          chargesLabel: toDecimal(input.chargesAmount ?? 0).greaterThan(0) ? input.chargesLabel?.trim() || "Delivery Charges" : null,
          chargesAmount: money(totals.charges),
          chargesTaxRate: toDecimal(input.chargesTaxRate ?? 0).toFixed(2),
          taxableAmount: money(totals.taxableAmount),
          cgst: money(totals.cgst),
          sgst: money(totals.sgst),
          igst: money(totals.igst),
          cess: money(totals.cess),
          roundOff: money(totals.roundOff),
          total: money(totals.total),
          partyInvoiceNo: config.side === "PURCHASE" ? input.partyInvoiceNo?.trim() || null : null,
          partyInvoiceDate: config.side === "PURCHASE" ? input.partyInvoiceDate ?? null : null,
          ...(config.side === "SALE" ? resolveDivision(input, existing) : { section: null, department: null, legacySectionDepartment: false }),
          notes: input.notes?.trim() || null,
          partySnapshot: partySnapshot(party),
          originalDocId: original?.id ?? null,
        };

        let doc: SaleInvoice;
        let touched: string[] = [];
        if (existing) {
          touched = await reverseDocumentStock(tx, existing.id, `Reversed for edit of ${existing.invoiceNo}`);
          await tx.saleInvoiceItem.deleteMany({ where: { invoiceId: existing.id } });
          doc = await tx.saleInvoice.update({
            where: { id: existing.id },
            data: { ...header, items: { create: lineCreateData(lines, computed.lineResults, costs) } },
          });
        } else {
          const prefix = settings[config.prefixSetting];
          const invoiceNo = await allocateNumber(
            tx,
            business.id,
            prefix,
            { financialYearFormat: settings.financialYearFormat, invoiceStartNumber: docType === "SALE_INVOICE" ? settings.invoiceStartNumber : 1 },
            date
          );
          doc = await tx.saleInvoice.create({
            data: {
              ...header,
              businessId: business.id,
              docType,
              invoiceNo,
              convertedFromId,
              terms: config.side === "SALE" ? business.invoiceTerms : null,
              businessSnapshot: businessSnapshot(business),
              clientToken: input.clientToken || null,
              receivedAmount: "0",
              balance: money(totals.total),
              paymentStatus: "UNPAID",
              items: { create: lineCreateData(lines, computed.lineResults, costs) },
            },
          });
        }

        touched.push(...(await applyDocumentStock(tx, doc, lines, settings.negativeStockPolicy)));
        await assertStockNotNegative(tx, touched, settings.negativeStockPolicy);

        if (original) await applyReturnAdjustment(tx, doc, input.adjustAgainstOriginal ?? true);

        await refreshSettlement(tx, doc.id);

        const paidNow = toDecimal(input.paidNowAmount ?? 0);
        if (!existing && paidNow.greaterThan(0) && config.settlementDirection) {
          await createVoucherInTx(tx, ctx, {
            direction: config.settlementDirection,
            partyId: party.id,
            date,
            amount: paidNow,
            mode: input.paidNowMode ?? "CASH",
            reference: input.paidNowReference ?? null,
            note: `With ${config.label.toLowerCase()} ${doc.invoiceNo}`,
            allocations: [{ documentId: doc.id, amount: paidNow }],
          });
        }

        await writeAudit(tx, {
          businessId: business.id,
          userId: ctx.userId,
          entity: docType,
          entityId: doc.id,
          action: existing ? "UPDATE" : "CREATE",
          detail: existing
            ? {
                invoiceNo: doc.invoiceNo,
                previousTotal: existing.total.toString(),
                newTotal: doc.total.toString(),
                ...(existing.department !== doc.department || existing.section !== doc.section || existing.legacySectionDepartment !== doc.legacySectionDepartment
                  ? {
                      previousSection: existing.section,
                      previousDepartment: existing.department,
                      previousUnclassified: existing.legacySectionDepartment,
                      newSection: doc.section,
                      newDepartment: doc.department,
                      newUnclassified: doc.legacySectionDepartment,
                    }
                  : {}),
              }
            : { invoiceNo: doc.invoiceNo, total: doc.total.toString() },
        });

        return tx.saleInvoice.findUniqueOrThrow({ where: { id: doc.id } });
      }
    );
    return { document, duplicate: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const target = String(err.meta?.target ?? "");
      if (target.includes("clientToken") && input.clientToken) {
        const already = await prisma.saleInvoice.findUnique({ where: { clientToken: input.clientToken } });
        if (already) return { document: already, duplicate: true };
      }
      if (target.includes("convertedFromId")) {
        throw new AppError("This estimate has already been converted to an invoice", 409);
      }
    }
    throw err;
  }
}

/**
 * Cancels a document: reverses its stock movements, releases its set-off, keeps the row (and its
 * number) with an audit entry. Documents with live payments or returns must have those cancelled first.
 */
export async function cancelDocument(ctx: ActionContext, docType: DocType, id: string, reason: string): Promise<SaleInvoice> {
  const config = docConfig(docType);
  const settings = effectiveSettings(ctx.business);

  return prisma.$transaction(
    async (tx) => {
      const doc = await tx.saleInvoice.findFirst({ where: { id, businessId: ctx.business.id, docType } });
      if (!doc) throw new AppError(`${config.label} not found`, 404);
      if (doc.status === "CANCELLED") throw new AppError(`${doc.invoiceNo} is already cancelled`, 409);

      const payments = await tx.paymentAllocation.count({ where: { documentId: doc.id, voucher: { status: "ACTIVE" } } });
      if (payments > 0) {
        throw new AppError(`${doc.invoiceNo} has payments recorded against it. Cancel those payments first.`, 409);
      }
      const returns = await tx.saleInvoice.count({ where: { originalDocId: doc.id, status: "ACTIVE" } });
      if (returns > 0) {
        throw new AppError(`${doc.invoiceNo} has active credit/debit notes against it. Cancel those first.`, 409);
      }

      // Guard against a concurrent cancel: only one transaction can flip ACTIVE -> CANCELLED.
      const flipped = await tx.saleInvoice.updateMany({
        where: { id: doc.id, status: "ACTIVE" },
        data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason.trim() || null },
      });
      if (flipped.count === 0) throw new AppError(`${doc.invoiceNo} is already cancelled`, 409);

      const touched = await reverseDocumentStock(tx, doc.id, `Reversed on cancelling ${doc.invoiceNo}`);
      await assertStockNotNegative(tx, touched, settings.negativeStockPolicy);

      if (doc.originalDocId) await refreshSettlement(tx, doc.originalDocId);

      await writeAudit(tx, {
        businessId: ctx.business.id,
        userId: ctx.userId,
        entity: docType,
        entityId: doc.id,
        action: "CANCEL",
        detail: { invoiceNo: doc.invoiceNo, total: doc.total.toString(), reason: reason.trim() },
      });
      return tx.saleInvoice.findUniqueOrThrow({ where: { id: doc.id } });
    },
    { timeout: 30000 }
  );
}
