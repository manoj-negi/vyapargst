/**
 * Section and Department of a sale document.
 *
 * They are separate optional fields. Documents saved before the split kept one value under the
 * combined label "Section / Department" in the department column, flagged with
 * legacySectionDepartment; until that value is classified it is neither a section nor a
 * department, and is shown as it was typed, without a label.
 */
export interface DivisionSource {
  section?: string | null;
  department?: string | null;
  legacySectionDepartment?: boolean | null;
}

export interface Division {
  section: string | null;
  department: string | null;
  /** Older combined value not classified yet (original text) */
  unclassified: string | null;
}

/** Trims, collapses inner spaces and caps at 80 characters; blank becomes null. */
export function cleanDivisionValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().replace(/\s+/g, " ").slice(0, 80) || null;
}

export function divisionOf(doc: DivisionSource): Division {
  const legacy = !!doc.legacySectionDepartment;
  return {
    section: cleanDivisionValue(doc.section),
    department: legacy ? null : cleanDivisionValue(doc.department),
    unclassified: legacy ? cleanDivisionValue(doc.department) : null,
  };
}

/** Labelled lines for display: only the fields that are filled. */
export function divisionLines(doc: DivisionSource): { label: string | null; value: string }[] {
  const d = divisionOf(doc);
  const lines: { label: string | null; value: string }[] = [];
  if (d.section) lines.push({ label: "Section", value: d.section });
  if (d.department) lines.push({ label: "Department", value: d.department });
  if (d.unclassified) lines.push({ label: null, value: d.unclassified });
  return lines;
}

/** One-line summary for lists and subtitles, e.g. "Section: GA · Department: Accounts". */
export function divisionText(doc: DivisionSource): string {
  return divisionLines(doc)
    .map((l) => (l.label ? `${l.label}: ${l.value}` : l.value))
    .join(" · ");
}

export function sameDivisionValue(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = cleanDivisionValue(a);
  const y = cleanDivisionValue(b);
  return !!x && !!y && x.toLowerCase() === y.toLowerCase();
}
