import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Decimal, round2, toDecimal } from "../../lib/decimal";
import { AppError } from "../../middleware/errorHandler";
import { calculateInvoiceTotals, calculateLineItem, isIntraState } from "../gst/gstEngine";
import { saveDocument, type ActionContext, type DocumentLineInput } from "../documents/documentService";
import { writeAudit } from "../audit/audit";
import { DraftSchema } from "./schema";
import { mapKey, reviewDraft, stateFromGstin } from "./review";

/**
 * "Confirm & Save Purchase": everything the import changes, in one transaction — the supplier (if
 * new), new items, approved default purchase-price changes (with history), remembered supplier item
 * matches, and the purchase bill itself (stock in, supplier balance) through the normal purchase
 * service. A lock on the import row makes repeated clicks, retries and parallel requests post once.
 * Catalogues, price lists and quotations only create the new items (no purchase, no stock).
 */
export async function confirmImport(ctx: ActionContext, importId: string, input: unknown): Promise<{ purchaseId: string | null; createdProducts: number; already: boolean }> {
  const business = ctx.business;
  const parsed = DraftSchema.safeParse(input);
  if (!parsed.success) throw new AppError("Some values in the review are not valid.", 422);
  const draft = parsed.data;
  const existing = await prisma.purchaseImport.findFirst({ where: { id: importId, businessId: business.id } });
  if (!existing) throw new AppError("Import not found", 404);
  if (existing.status === "POSTED") return { purchaseId: existing.purchaseId, createdProducts: 0, already: true };

  const review = await reviewDraft(business, importId, draft);
  if (review.blockers.length) throw new AppError(`Please resolve before saving: ${review.blockers.slice(0, 3).join(" ")}${review.blockers.length > 3 ? ` (+${review.blockers.length - 3} more)` : ""}`, 422);
  const isPurchase = draft.documentKind === "invoice";

  return prisma.$transaction(
    async (tx) => {
      // Only one confirmation can take the import from DRAFT to POSTING
      const lock = await tx.purchaseImport.updateMany({ where: { id: importId, businessId: business.id, status: { in: ["DRAFT", "NEEDS_SETUP"] } }, data: { status: "POSTING", draft: draft as unknown as Prisma.InputJsonValue } });
      if (lock.count !== 1) {
        const now = await tx.purchaseImport.findUnique({ where: { id: importId } });
        if (now?.status === "POSTED") return { purchaseId: now.purchaseId, createdProducts: 0, already: true };
        throw new AppError("This import is already being saved.", 409);
      }

      // Supplier
      let supplierId = draft.supplierId;
      // Never a second party with the same GSTIN: an existing one is used
      if (!supplierId && draft.supplier.gstin) {
        const same = await tx.customer.findFirst({ where: { businessId: business.id, gstin: draft.supplier.gstin.toUpperCase() } });
        if (same) supplierId = same.id;
      }
      if (supplierId) {
        const s = await tx.customer.findFirst({ where: { id: supplierId, businessId: business.id } });
        if (!s) throw new AppError("The chosen supplier no longer exists.", 422);
        if (s.partyType === "CUSTOMER") await tx.customer.update({ where: { id: s.id }, data: { partyType: "BOTH" } });
      } else if (draft.supplier.name.trim()) {
        const created = await tx.customer.create({
          data: {
            businessId: business.id,
            name: draft.supplier.name.trim(),
            partyType: "SUPPLIER",
            customerType: draft.supplier.gstin ? "REGISTERED" : "UNREGISTERED",
            gstin: draft.supplier.gstin || null,
            billingAddress: draft.supplier.address || null,
            phone: draft.supplier.phone?.replace(/[^\d+]/g, "").slice(0, 15) || null,
            email: draft.supplier.email || null,
            state: draft.supplier.state || stateFromGstin(draft.supplier.gstin) || business.state,
          },
        });
        supplierId = created.id;
      }

      // New items (no stock yet: stock comes in only through the purchase lines)
      const taxes = await tx.taxMaster.findMany({ where: { businessId: business.id, isActive: true } });
      const productFor = new Map<string, string>();
      let createdProducts = 0;
      for (const row of draft.rows) {
        if (row.action === "skip") continue;
        if (row.action === "match") { productFor.set(row.id, review.rows.find((r) => r.id === row.id)!.product!.id); continue; }
        const np = row.newProduct!;
        const gst = np.gstRate ?? row.gstRate ?? 0;
        const tax = taxes.find((t) => toDecimal(t.rate).equals(gst));
        if (gst > 0 && !tax) throw new AppError(`There is no ${gst}% GST rate in Tax Rates for "${np.name}". Add it under Settings → Tax Rates, then confirm again.`, 422);
        const unit = await tx.unit.upsert({
          where: { businessId_name: { businessId: business.id, name: np.unitName.trim() } },
          create: { businessId: business.id, name: np.unitName.trim(), shortName: np.unitName.trim().slice(0, 8).toUpperCase() },
          update: {},
        });
        const rv = review.rows.find((r) => r.id === row.id)!;
        const factor = rv.unitFactor ?? 1;
        const baseRate = row.rate !== null ? round2(new Decimal(row.rate).dividedBy(factor)) : null;
        const product = await tx.product.create({
          data: {
            businessId: business.id,
            name: np.name.trim(),
            hsnCode: np.hsn || row.hsn || null,
            unitId: unit.id,
            taxId: tax?.id ?? null,
            barcode: row.barcode || null,
            salePrice: toDecimal(np.salePrice ?? 0).toFixed(2),
            priceType: "EXCLUSIVE",
            purchasePrice: baseRate ? baseRate.toFixed(2) : null,
            purchasePriceType: row.rateIncludesTax ? "INCLUSIVE" : "EXCLUSIVE",
            openingStock: "0",
            currentStock: "0",
          },
        });
        if (baseRate) {
          await tx.productPriceHistory.create({ data: { businessId: business.id, productId: product.id, oldValue: null, newValue: baseRate.toFixed(2), newPriceType: product.purchasePriceType, sourceImportId: importId, note: "Created from an imported supplier document", userId: ctx.userId ?? null } });
        }
        productFor.set(row.id, product.id);
        createdProducts++;
      }

      // Approved changes to existing items' default purchase price (the bill rate itself is always on the purchase)
      for (const rv of review.rows) {
        if (!rv.cost?.update || !rv.product || rv.cost.next === null) continue;
        const p = await tx.product.findUniqueOrThrow({ where: { id: rv.product.id }, include: { tax: true } });
        const g = toDecimal(p.tax?.rate ?? 0).dividedBy(100);
        // rv.cost.next is per base unit on the business's cost basis; store it in the item's own price basis
        const exGst = business.gstRegistered ? new Decimal(rv.cost.next) : new Decimal(rv.cost.next).dividedBy(g.plus(1));
        const value = round2(p.purchasePriceType === "INCLUSIVE" ? exGst.times(g.plus(1)) : exGst);
        if (p.purchasePrice && toDecimal(p.purchasePrice).equals(value)) continue;
        await tx.product.update({ where: { id: p.id }, data: { purchasePrice: value.toFixed(2) } });
        await tx.productPriceHistory.create({
          data: { businessId: business.id, productId: p.id, oldValue: p.purchasePrice, oldPriceType: p.purchasePriceType, newValue: value.toFixed(2), newPriceType: p.purchasePriceType, sourceImportId: importId, note: `From supplier bill ${draft.invoiceNo ?? ""}`.trim(), userId: ctx.userId ?? null },
        });
      }

      // Remember confirmed supplier item → product matches (and the unit conversion) for the next bill
      if (supplierId) {
        for (const row of draft.rows) {
          const productId = productFor.get(row.id);
          if (!productId) continue;
          const rv = review.rows.find((r) => r.id === row.id)!;
          const key = mapKey(row);
          await tx.supplierItemMap.upsert({
            where: { businessId_supplierId_matchKey: { businessId: business.id, supplierId, matchKey: key } },
            create: { businessId: business.id, supplierId, matchKey: key, supplierCode: row.supplierCode, description: row.description.slice(0, 300), productId, billUnit: row.unit, unitFactor: toDecimal(rv.unitFactor ?? 1).toFixed(4), lastImportId: importId },
            update: { productId, billUnit: row.unit, unitFactor: toDecimal(rv.unitFactor ?? 1).toFixed(4), description: row.description.slice(0, 300), lastImportId: importId },
          });
        }
      }

      let purchaseId: string | null = null;
      if (isPurchase) {
        const products = await tx.product.findMany({ where: { id: { in: Array.from(productFor.values()) } }, include: { tax: true, unit: true } });
        const lines: DocumentLineInput[] = [];
        for (const row of draft.rows) {
          if (row.action === "skip") continue;
          const p = products.find((x) => x.id === productFor.get(row.id))!;
          const rv = review.rows.find((r) => r.id === row.id)!;
          const factor = new Decimal(rv.unitFactor ?? 1);
          const g = toDecimal(p.tax?.rate ?? 0).dividedBy(100);
          // The bill rate, per base unit and in the item's price basis (the purchase applies the item's GST rate)
          let rate = new Decimal(row.rate!).dividedBy(factor);
          const billIncl = row.rateIncludesTax;
          const itemIncl = p.purchasePriceType === "INCLUSIVE";
          if (billIncl && !itemIncl) rate = rate.dividedBy(g.plus(1));
          if (!billIncl && itemIncl) rate = rate.times(g.plus(1));
          const common = { productId: p.id, productName: p.name, hsn: row.hsn || p.hsnCode, unit: p.unit?.name ?? row.unit, priceType: p.purchasePriceType, gstRate: toDecimal(p.tax?.rate ?? 0).toNumber() };
          lines.push({
            ...common,
            quantity: round2(factor.times(row.quantity!)).toNumber(),
            unitPrice: round2(rate).toNumber(),
            discountValue: row.discountPercent || row.discountAmount || 0,
            discountType: row.discountPercent ? "PERCENTAGE" : "FIXED",
          });
          if (row.freeQuantity) lines.push({ ...common, productName: `${p.name} (free)`, quantity: round2(factor.times(row.freeQuantity)).toNumber(), unitPrice: 0, discountValue: 0, discountType: "PERCENTAGE" });
        }

        // Rates are stored to the paisa; when converting units or tax basis changes the sum by a few
        // paise, round-off brings the payable back to the bill's total (or the reviewed total)
        const intra = isIntraState(business.state, (await tx.customer.findUniqueOrThrow({ where: { id: supplierId! } })).state);
        const t = calculateInvoiceTotals({
          lines: lines.map((l) => calculateLineItem({ quantity: l.quantity, unitPrice: l.unitPrice, priceType: l.priceType, discountValue: l.discountValue, discountType: l.discountType, gstRate: l.gstRate, isIntraState: intra })),
          invoiceDiscount: { value: draft.invoiceDiscountAmount || 0, type: "FIXED" },
          charges: { amount: draft.chargesAmount || 0, gstRate: draft.chargesGstRate || 0 },
          isIntraState: intra,
          roundOffMode: "DISABLED",
        });
        const target = draft.extractedTotals.grand !== null && !review.totals.mismatch ? draft.extractedTotals.grand : review.totals.total;
        const manualRoundOff = round2(new Decimal(target).minus(t.total)).toNumber();

        const { document } = await saveDocument(
          ctx,
          "PURCHASE_BILL",
          {
            partyId: supplierId!,
            date: draft.invoiceDate ? new Date(`${draft.invoiceDate}T00:00:00`) : new Date(),
            dueDate: draft.dueDate ? new Date(`${draft.dueDate}T00:00:00`) : null,
            items: lines,
            invoiceDiscountValue: draft.invoiceDiscountAmount || 0,
            invoiceDiscountType: "FIXED",
            chargesAmount: draft.chargesAmount || 0,
            chargesTaxRate: draft.chargesGstRate || 0,
            chargesLabel: draft.chargesLabel,
            manualRoundOff,
            partyInvoiceNo: draft.invoiceNo,
            partyInvoiceDate: draft.invoiceDate ? new Date(`${draft.invoiceDate}T00:00:00`) : null,
            notes: `Imported from the supplier's document (import ${importId.slice(0, 8)}).`,
            paidNowAmount: 0,
            clientToken: `import-${importId}`,
          },
          undefined,
          tx
        );
        purchaseId = document.id;
      }

      await tx.purchaseImport.update({ where: { id: importId }, data: { status: "POSTED", purchaseId, postedAt: new Date(), documentKind: draft.documentKind } });
      await writeAudit(tx, {
        businessId: business.id,
        userId: ctx.userId,
        entity: "PURCHASE_IMPORT",
        entityId: importId,
        action: "CONFIRM",
        detail: { purchaseId, createdProducts, priceUpdates: review.summary.priceChanges.length, supplier: draft.supplier.name, invoiceNo: draft.invoiceNo },
      });
      return { purchaseId, createdProducts, already: false };
    },
    { timeout: 60000 }
  );
}
