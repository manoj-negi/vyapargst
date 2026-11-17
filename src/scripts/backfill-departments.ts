/* eslint-disable no-console */
/**
 * Fills SaleInvoice.department for sale documents that have none, from the section / department
 * the document was issued with: the party snapshot when present, otherwise the customer record
 * (older invoices printed their section from there). Only documents with neither a section nor a
 * department are filled; totals, payments, stock and customer records are not touched.
 * The value is saved as an unclassified older "Section / Department" value (legacySectionDepartment);
 * `npm run classify:sections` then classifies it where the records show which field it came from.
 *
 *   npm run backfill:departments            preview only
 *   npm run backfill:departments -- --apply write the changes (one transaction, one audit row each)
 * Undo: set department back to NULL for the entityIds in AuditLog rows with action BACKFILL_DEPARTMENT.
 */
import { prisma } from "../lib/prisma";

function sectionOf(src: { section?: string | null; department?: string | null } | null | undefined): string | null {
  if (!src) return null;
  const parts = [src.section, src.department].map((v) => v?.trim()).filter((v): v is string => !!v);
  const unique = parts.filter((v, i) => parts.findIndex((p) => p.toLowerCase() === v.toLowerCase()) === i);
  return unique.length ? unique.join(" / ").slice(0, 80) : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const docs = await prisma.saleInvoice.findMany({
    where: { section: null, department: null, docType: { in: ["SALE_INVOICE", "ESTIMATE", "CREDIT_NOTE"] } },
    include: { customer: true },
    orderBy: [{ businessId: "asc" }, { invoiceNo: "asc" }],
  });

  const changes = docs
    .map((d) => {
      const snapshot = d.partySnapshot as { section?: string | null; department?: string | null } | null;
      const fromSnapshot = sectionOf(snapshot);
      return { doc: d, value: fromSnapshot ?? sectionOf(d.customer), source: fromSnapshot ? "snapshot" : "customer record" };
    })
    .filter((c) => c.value);

  for (const c of changes) console.log(`${c.doc.invoiceNo.padEnd(14)} ${c.doc.customer.name.padEnd(34)} → ${c.value}  (${c.source})`);
  console.log(`\n${changes.length} of ${docs.length} documents without a department can be filled.`);
  if (!apply) {
    console.log("Preview only. Run with --apply to save.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const c of changes) {
      // Guard: only fill if still empty (nothing set it since the preview)
      const updated = await tx.saleInvoice.updateMany({ where: { id: c.doc.id, section: null, department: null }, data: { department: c.value, legacySectionDepartment: true } });
      if (updated.count === 1) {
        await tx.auditLog.create({
          data: { businessId: c.doc.businessId, entity: c.doc.docType, entityId: c.doc.id, action: "BACKFILL_DEPARTMENT", detail: { invoiceNo: c.doc.invoiceNo, department: c.value, source: c.source } },
        });
      }
    }
  });
  console.log(`Saved ${changes.length} departments.`);
}

main()
  .catch((err) => {
    console.error(`Backfill FAILED (nothing was saved): ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
