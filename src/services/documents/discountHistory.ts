import type { DiscountType } from "@prisma/client";
import { cleanDivisionValue, divisionOf, sameDivisionValue } from "../../lib/division";
import { prisma } from "../../lib/prisma";

export interface PreviousDiscountQuery {
  customerId: string;
  productIds: string[];
  section?: string | null;
  department?: string | null;
  /** The invoice being edited, so it does not count as its own history */
  excludeInvoiceId?: string | null;
}

export interface PreviousDiscount {
  productId: string;
  /** As saved on the line: a percentage, or a ₹ amount off the line for FIXED */
  discountValue: string;
  discountType: DiscountType;
  invoiceId: string;
  invoiceNo: string;
  invoiceDate: Date;
  section: string | null;
  department: string | null;
  unclassified: string | null;
  /** "division": same party and the same section / department; "party": same party, any section / department */
  match: "division" | "party";
}

/**
 * The discount last given to this customer for each item, read from saved sale invoices
 * (active only: no estimates, returns or cancelled invoices). When a section and/or department
 * is given, an invoice for the same section / department wins; otherwise, or when there is none,
 * the customer's most recent invoice for the item is used. Most recent means latest invoice date,
 * then latest saved, then highest number; within one invoice the first line for the item counts.
 */
export async function previousDiscounts(businessId: string, query: PreviousDiscountQuery): Promise<Record<string, PreviousDiscount>> {
  const productIds = Array.from(new Set(query.productIds.filter(Boolean))).slice(0, 200);
  if (!query.customerId || productIds.length === 0) return {};

  const lines = await prisma.saleInvoiceItem.findMany({
    where: {
      productId: { in: productIds },
      invoice: {
        businessId,
        customerId: query.customerId,
        docType: "SALE_INVOICE",
        status: "ACTIVE",
        ...(query.excludeInvoiceId ? { id: { not: query.excludeInvoiceId } } : {}),
      },
    },
    select: {
      id: true,
      productId: true,
      discount: true,
      discountType: true,
      invoice: { select: { id: true, invoiceNo: true, invoiceDate: true, createdAt: true, section: true, department: true, legacySectionDepartment: true } },
    },
    orderBy: [{ invoice: { invoiceDate: "desc" } }, { invoice: { createdAt: "desc" } }, { invoice: { invoiceNo: "desc" } }, { id: "asc" }],
  });

  const wantSection = cleanDivisionValue(query.section);
  const wantDepartment = cleanDivisionValue(query.department);
  const scoped = !!(wantSection || wantDepartment);
  const inDivision = (inv: (typeof lines)[number]["invoice"]) => {
    const d = divisionOf(inv);
    // An older unclassified value counts for whichever of the two it matches
    const sectionOk = !wantSection || sameDivisionValue(d.section, wantSection) || sameDivisionValue(d.unclassified, wantSection);
    const departmentOk = !wantDepartment || sameDivisionValue(d.department, wantDepartment) || sameDivisionValue(d.unclassified, wantDepartment);
    return sectionOk && departmentOk;
  };

  const byDivision = new Map<string, (typeof lines)[number]>();
  const byParty = new Map<string, (typeof lines)[number]>();
  for (const line of lines) {
    const pid = line.productId as string;
    if (!byParty.has(pid)) byParty.set(pid, line);
    if (scoped && !byDivision.has(pid) && inDivision(line.invoice)) byDivision.set(pid, line);
  }

  const result: Record<string, PreviousDiscount> = {};
  for (const pid of productIds) {
    const line = byDivision.get(pid) ?? byParty.get(pid);
    if (!line) continue;
    const d = divisionOf(line.invoice);
    result[pid] = {
      productId: pid,
      discountValue: line.discount.toFixed(2),
      discountType: line.discountType,
      invoiceId: line.invoice.id,
      invoiceNo: line.invoice.invoiceNo,
      invoiceDate: line.invoice.invoiceDate,
      section: d.section,
      department: d.department,
      unclassified: d.unclassified,
      match: byDivision.has(pid) ? "division" : "party",
    };
  }
  return result;
}
