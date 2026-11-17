/* eslint-disable no-console */
/**
 * Classifies older "Section / Department" values on sale documents (legacySectionDepartment = true)
 * as a Section or a Department, only where the records show which field the text came from:
 *   - the party snapshot saved with the document has the text in exactly one of section / department, or
 *   - the text was filled by the department backfill (AuditLog BACKFILL_DEPARTMENT, source
 *     "customer record"), is unchanged since, and the customer record, also unchanged since then,
 *     has it in exactly one of section / department.
 * Everything else stays unclassified, kept as typed, for the user to classify when editing.
 * The text itself is never changed; it only moves to the matching field.
 *
 *   npm run classify:sections            preview only
 *   npm run classify:sections -- --apply back up the database, then save (one transaction, one audit row each)
 * Undo: for AuditLog rows with action CLASSIFY_SECTION_DEPARTMENT, set department = detail.original,
 * section = NULL, legacySectionDepartment = true on that entityId.
 */
import { prisma } from "../lib/prisma";
import { sameDivisionValue } from "../lib/division";
import { createBackup, verifyBackup } from "../services/backup/backup";

type Field = "section" | "department";
interface DivisionRecord {
  section?: string | null;
  department?: string | null;
}

/** Which one field of the record holds the text, when it is exactly one. */
function fieldHolding(record: DivisionRecord | null | undefined, text: string): Field | null {
  if (!record) return null;
  const inSection = sameDivisionValue(record.section, text);
  const inDepartment = sameDivisionValue(record.department, text);
  const otherSection = !!record.section?.trim() && !inSection;
  const otherDepartment = !!record.department?.trim() && !inDepartment;
  if (inSection && !inDepartment && !otherDepartment) return "section";
  if (inDepartment && !inSection && !otherSection) return "department";
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const docs = await prisma.saleInvoice.findMany({
    where: { legacySectionDepartment: true, department: { not: null } },
    include: { customer: true },
    orderBy: [{ businessId: "asc" }, { docType: "asc" }, { invoiceNo: "asc" }],
  });
  const backfills = await prisma.auditLog.findMany({
    where: { action: "BACKFILL_DEPARTMENT", entityId: { in: docs.map((d) => d.id) } },
    orderBy: { createdAt: "desc" },
  });

  const plan = docs.map((doc) => {
    const text = doc.department as string;
    const fromSnapshot = fieldHolding(doc.partySnapshot as DivisionRecord | null, text);
    if (fromSnapshot) return { doc, text, field: fromSnapshot, evidence: "party snapshot saved with the document" };

    const audit = backfills.find((a) => a.entityId === doc.id);
    const detail = (audit?.detail ?? {}) as { department?: string; source?: string };
    if (audit && detail.source === "customer record" && detail.department === text && doc.customer.updatedAt < audit.createdAt) {
      const field = fieldHolding(doc.customer, text);
      if (field) return { doc, text, field, evidence: `backfilled from the customer record's ${field} on ${audit.createdAt.toISOString()} (record unchanged since)` };
    }
    return { doc, text, field: null as Field | null, evidence: "no record of which field it came from" };
  });

  for (const p of plan) {
    console.log(`${p.doc.invoiceNo.padEnd(12)} ${p.text.padEnd(22)} → ${(p.field ?? "unclassified").padEnd(12)} ${p.evidence}`);
  }
  const changes = plan.filter((p) => p.field);
  console.log(`\n${changes.length} of ${plan.length} unclassified values can be classified from the records; ${plan.length - changes.length} stay unclassified.`);
  if (!apply || changes.length === 0) {
    if (!apply) console.log("Preview only. Run with --apply to back up and save.");
    return;
  }

  const { dir } = await createBackup("before-classify-sections");
  await verifyBackup(dir);
  console.log(`Backup written and verified: ${dir}`);

  let saved = 0;
  await prisma.$transaction(async (tx) => {
    for (const c of changes) {
      // Guard: only if still unclassified with the same text (nothing changed it since the preview)
      const updated = await tx.saleInvoice.updateMany({
        where: { id: c.doc.id, legacySectionDepartment: true, department: c.text, ...(c.field === "section" ? { section: null } : {}) },
        data: c.field === "section" ? { section: c.text, department: null, legacySectionDepartment: false } : { legacySectionDepartment: false },
      });
      if (updated.count === 1) {
        saved++;
        await tx.auditLog.create({
          data: {
            businessId: c.doc.businessId,
            entity: c.doc.docType,
            entityId: c.doc.id,
            action: "CLASSIFY_SECTION_DEPARTMENT",
            detail: { invoiceNo: c.doc.invoiceNo, original: c.text, classifiedAs: c.field, evidence: c.evidence },
          },
        });
      }
    }
  });
  console.log(`Classified ${saved} values.`);
}

main()
  .catch((err) => {
    console.error(`Classification FAILED (nothing was saved): ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
