import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Prisma, PurchaseImport } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import type { ActionContext } from "../documents/documentService";
import { detectFileType, UnsupportedFileError, type DetectedType } from "./fileTypes";
import { LIMITS, readDocument, type SourcePart } from "./readers";
import { getBillExtractor } from "./extractor";
import { DraftSchema, type Draft, type DraftRow, type ExtractedBill } from "./schema";
import { blankRow, detectHeader, guessDocumentKind, rowsFromTable, type ColumnMap } from "./tableMapper";
import sharp from "sharp";
import { layoutText, ocrImage, pdfLayout, renderPdfPages, type LayoutDoc } from "./layout";
import { parseBillLayout } from "./ruleParser";
import { extractWithLocalModel, LOCAL_MODEL, localStatus } from "./localAi";
import { findSupplier, matchRow, stateFromGstin } from "./review";

/** Supplier documents live here: inside public/uploads so backups include them, but never served publicly (see app.ts) */
export const DOCS_DIR = path.join(__dirname, "../../../public/uploads/purchase-docs");

export interface UploadedFile {
  path: string;
  originalname: string;
  size: number;
}

/** Stores the uploaded files and creates one import (all files = one bill) or one per file. Nothing else changes. */
export async function createImports(ctx: ActionContext, files: UploadedFile[], grouping: "one" | "separate"): Promise<string[]> {
  if (!files.length) throw new AppError("Choose at least one file.", 422);
  if (files.length > LIMITS.files) throw new AppError(`Upload at most ${LIMITS.files} files at a time.`, 422);
  if (files.reduce((n, f) => n + f.size, 0) > LIMITS.totalBytes) throw new AppError(`The files together are larger than ${LIMITS.totalBytes / 1024 / 1024} MB.`, 422);
  await fs.mkdir(DOCS_DIR, { recursive: true });
  const prepared: { file: UploadedFile; type: DetectedType; sha256: string; data: Buffer }[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const data = await fs.readFile(file.path);
    if (data.length > LIMITS.fileBytes) { problems.push(`"${file.originalname}" is larger than ${LIMITS.fileBytes / 1024 / 1024} MB.`); continue; }
    try {
      prepared.push({ file, type: await detectFileType(data, file.originalname), sha256: crypto.createHash("sha256").update(data).digest("hex"), data });
    } catch (err) {
      if (err instanceof UnsupportedFileError) problems.push(err.message);
      else throw err;
    }
  }
  await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
  // Nothing is skipped silently: one unsupported file stops the upload with the reason
  if (problems.length) throw new AppError(problems.join(" "), 422);

  const groups = grouping === "one" ? [prepared] : prepared.map((p) => [p]);
  const ids: string[] = [];
  for (const group of groups) {
    const imp = await prisma.purchaseImport.create({ data: { businessId: ctx.business.id, createdById: ctx.userId ?? null, status: "UPLOADED" } });
    for (const [position, p] of group.entries()) {
      const storedName = `${imp.id}-${position}${extFor(p.type)}`;
      await fs.writeFile(path.join(DOCS_DIR, storedName), p.data);
      await prisma.purchaseImportFile.create({
        data: { importId: imp.id, storedName, originalName: p.file.originalname.slice(0, 200), detectedType: p.type.kind, mimeType: p.type.mime, size: p.data.length, sha256: p.sha256, position },
      });
    }
    ids.push(imp.id);
  }
  return ids;
}

function extFor(t: DetectedType): string {
  return `.${t.kind === "jpeg" ? "jpg" : t.kind}`;
}

export async function getImport(businessId: string, id: string) {
  const imp = await prisma.purchaseImport.findFirst({ where: { id, businessId }, include: { files: { orderBy: { position: "asc" } }, purchase: { select: { id: true, invoiceNo: true, status: true } } } });
  if (!imp) throw new AppError("Import not found", 404);
  return imp;
}

/**
 * Reads the files and prepares the draft, locally by default:
 *   1. spreadsheet / document tables with clear headers → rows directly
 *   2. PDF text layer → page layout; scanned PDFs and photos → Tesseract OCR → page layout
 *   3. the local bill parser reads supplier, invoice, items, taxes and totals from the layout
 *   4. if that is incomplete or does not add up, the optional local model (Ollama) is asked, and
 *      only values that appear in the document are kept
 *   5. Anthropic Claude only when AI_IMPORT_PROVIDER=anthropic is set explicitly
 * A re-read keeps the user's edits. Nothing outside this import changes.
 */
export async function extractImport(ctx: ActionContext, id: string): Promise<PurchaseImport> {
  const imp = await getImport(ctx.business.id, id);
  if (["POSTING", "POSTED", "DISCARDED"].includes(imp.status)) throw new AppError("This import is already finished.", 409);
  await prisma.purchaseImport.update({ where: { id }, data: { status: "EXTRACTING", error: null } });
  const provider = (process.env.AI_IMPORT_PROVIDER || "local").toLowerCase();
  const steps: ReadStep[] = [];

  const parts: SourcePart[] = [];
  const warnings: string[] = [];
  try {
    for (const f of imp.files) {
      const data = await fs.readFile(path.join(DOCS_DIR, f.storedName));
      const res = await readDocument({ id: f.id, data, name: f.originalName, type: { kind: f.detectedType as DetectedType["kind"], mime: f.mimeType, label: f.detectedType }, rotation: f.rotation });
      parts.push(...res.parts);
      warnings.push(...res.warnings);
      if (res.pageCount && res.pageCount !== f.pageCount) await prisma.purchaseImportFile.update({ where: { id: f.id }, data: { pageCount: res.pageCount } });
    }
    steps.push({ step: "Open files", status: "ok", detail: `${imp.files.length} file(s): ${parts.map((p) => p.type).join(", ")}` });
  } catch (err) {
    const message = err instanceof UnsupportedFileError ? err.message : "A file could not be read. Check that it opens on your computer, then retry.";
    return prisma.purchaseImport.update({ where: { id }, data: { status: "FAILED", error: message } });
  }

  // Page layouts: PDF text layer, OCR for scans/photos, plain text from documents
  const layouts: LayoutDoc[] = [];
  let ocrProblem: string | null = null;
  for (const [i, p] of parts.entries()) {
    try {
      if (p.type === "pdf" && !p.scanned) {
        layouts.push(await pdfLayout(p.data));
        steps.push({ step: "Read PDF text", status: "ok", detail: `${p.pageCount} page(s), text layer read directly (no OCR needed)` });
      } else if (p.type === "pdf") {
        const pages = await renderPdfPages(p.data);
        for (const [n, img] of pages.entries()) layouts.push(await ocrImage(img, n + 1));
        steps.push({ step: "OCR scanned PDF", status: "ok", detail: `${pages.length} page(s) read with Tesseract` });
      } else if (p.type === "image") {
        layouts.push(await ocrImage(await toPng(p.data), i + 1));
        steps.push({ step: "OCR image", status: "ok", detail: `${p.source} read with Tesseract` });
      } else if (p.type === "text") {
        layouts.push(textLayout(p.text));
      }
    } catch (err) {
      ocrProblem = err instanceof Error ? err.message : "OCR failed.";
      steps.push({ step: p.type === "pdf" ? "OCR scanned PDF" : "OCR image", status: "failed", detail: ocrProblem });
    }
  }
  const layout = mergeLayouts(layouts);
  const layoutTxt = layout.lines.length ? layoutText(layout) : "";
  const sourceText = [layoutTxt, ...parts.filter((p) => p.type === "table").map((t) => (t as { rows: string[][] }).rows.map((r) => r.join("\t")).join("\n"))].join("\n");

  // 1–3. Tables and the local bill parser
  const own = { gstin: ctx.business.gstin, name: ctx.business.name };
  const parsed = layout.lines.length ? parseBillLayout(layout, own) : null;
  const tables = parts.map((p, i) => ({ p, i })).filter((x) => x.p.type === "table") as { p: Extract<SourcePart, { type: "table" }>; i: number }[];
  const bestTable = tables.map((t) => ({ t, h: detectHeader(t.p.rows) })).find((x) => x.h.confident);
  let machine: Draft | null = null;
  let extractor = "local";
  if (bestTable) {
    const rows = rowsFromTable(bestTable.t.p.rows, bestTable.h.headerRow, bestTable.h.columns);
    if (rows.length) {
      machine = emptyDraft(guessDocumentKind(sourceText), rows, { partIndex: bestTable.t.i, headerRow: bestTable.h.headerRow, columns: bestTable.h.columns as Record<string, number | null> });
      if (parsed) machine = withHeader(machine, draftFromExtracted(parsed.bill));
      extractor = "table";
      steps.push({ step: "Read table", status: "ok", detail: `${rows.length} item row(s) from ${bestTable.t.p.source}` });
    }
  }
  if (!machine && parsed) {
    const r = parsed.report;
    steps.push({ step: "Local bill parser", status: r.rowsFound ? "ok" : "failed", detail: r.rowsFound ? `${r.rowsFound} item row(s); ${r.reconciled ? "item amounts add up to the bill" : "item amounts do not add up — check the lines"}` : r.notes[0] || "No item rows found" });
    if (r.rowsFound) machine = draftFromExtracted(parsed.bill);
  }

  // 4. Optional local model when the parser could not finish the job
  const needsHelp = !machine || machine.rows.length === 0 || (parsed && !parsed.report.reconciled && extractor !== "table") || (parsed && (!parsed.report.header.supplier || !parsed.report.header.invoiceNo));
  if (provider === "local" && needsHelp && layoutTxt) {
    const st = await localStatus();
    if (!st.ollama.ok) steps.push({ step: "Local AI (Ollama)", status: "unavailable", detail: st.ollama.problem || "Not available" });
    else {
      try {
        const ai = await extractWithLocalModel(sourceText, own);
        const aiDraft = draftFromExtracted(ai);
        const aiSum = ai.items.reduce((s, it) => s + (it.taxable_amount ?? 0), 0);
        const target = ai.taxable_total ?? parsed?.bill.taxable_total ?? null;
        const aiAddsUp = target !== null && ai.items.length > 0 && Math.abs(aiSum - target) <= 1;
        if (!machine || machine.rows.length === 0 || (aiAddsUp && !parsed?.report.reconciled)) {
          machine = machine ? withHeader({ ...aiDraft }, machine) : aiDraft;
          extractor = `local-ai:${LOCAL_MODEL}`;
          steps.push({ step: "Local AI (Ollama)", status: "ok", detail: `${LOCAL_MODEL}: ${ai.items.length} item row(s)${aiAddsUp ? ", amounts add up" : ", amounts not confirmed — check every line"}` });
        } else {
          machine = withHeader(machine, aiDraft);
          steps.push({ step: "Local AI (Ollama)", status: "ok", detail: `${LOCAL_MODEL}: used only to fill missing header details` });
        }
      } catch (err) {
        steps.push({ step: "Local AI (Ollama)", status: "failed", detail: err instanceof Error ? err.message : "Failed" });
      }
    }
  }

  // 5. Claude, only when chosen explicitly
  if (provider === "anthropic" && (!machine || !machine.rows.length)) {
    const claude = getBillExtractor();
    if (!claude) steps.push({ step: "Claude API", status: "unavailable", detail: "AI_IMPORT_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set" });
    else {
      try {
        const ex = await claude.extract(parts);
        machine = draftFromExtracted(ex);
        extractor = claude.id;
        steps.push({ step: "Claude API", status: "ok", detail: `${ex.items.length} item row(s)` });
      } catch (err) {
        steps.push({ step: "Claude API", status: "failed", detail: err instanceof Error ? err.message : "Failed" });
      }
    }
  }

  const rows = machine?.rows.length ?? 0;
  const report = { steps, ok: rows > 0, rows, provider };
  const base = machine ?? (parsed ? withHeader(emptyDraft("invoice", [], null), draftFromExtracted(parsed.bill)) : emptyDraft(guessDocumentKind(sourceText), [], null));
  const next = await prefill(ctx, base);
  // A re-read keeps what the user changed since the last reading
  const prevMachine = (imp.sourceData as { machineDraft?: Draft } | null)?.machineDraft ?? null;
  const prevDraft = imp.draft ? DraftSchema.safeParse(imp.draft) : null;
  const draft = prevDraft?.success ? mergeKeepingEdits(prevDraft.data, prevMachine, next) : next;
  const sourceData = { ...summariseParts(parts, warnings), report, machineDraft: next, layoutText: layoutTxt.slice(0, 30000) };
  // Nothing readable and a needed tool missing → setup; otherwise a draft (possibly with no rows, said so plainly)
  const status = rows === 0 && ocrProblem ? "NEEDS_SETUP" : "DRAFT";
  return prisma.purchaseImport.update({
    where: { id },
    data: {
      status,
      extractor: rows ? extractor : null,
      sourceData: sourceData as unknown as Prisma.InputJsonValue,
      draft: draft as unknown as Prisma.InputJsonValue,
      documentKind: draft.documentKind,
      error: rows ? null : ocrProblem ? `Could not read the scan/photo: ${ocrProblem}` : "No item lines could be read automatically. The details that were found are filled in; add the item lines below, or try a clearer copy of the bill.",
    },
  });
}

interface ReadStep {
  step: string;
  status: "ok" | "failed" | "unavailable" | "skipped";
  detail: string;
}

async function toPng(jpeg: Buffer): Promise<Buffer> {
  return sharp(jpeg).png().toBuffer();
}

/** Plain text (Word paragraphs, TXT) as a layout: one line per text line, characters ≈ 4.5 pt */
function textLayout(text: string): LayoutDoc {
  const lines = text.split(/\r?\n/).map((line, i) => {
    const tokens: { text: string; x: number; w: number }[] = [];
    for (const m of line.matchAll(/\S+/g)) tokens.push({ text: m[0], x: (m.index ?? 0) * 4.5, w: m[0].length * 4.5 });
    return { y: i * 12, page: 1, tokens };
  }).filter((l) => l.tokens.length);
  return { lines, width: 595, source: "pdf-text" };
}

function mergeLayouts(docs: LayoutDoc[]): LayoutDoc {
  let pageOffset = 0;
  const lines: LayoutDoc["lines"] = [];
  for (const d of docs) {
    const maxPage = Math.max(0, ...d.lines.map((l) => l.page));
    for (const l of d.lines) lines.push({ ...l, page: l.page + pageOffset });
    pageOffset += maxPage;
  }
  return { lines, width: docs[0]?.width ?? 595, source: docs.some((d) => d.source === "ocr") ? "ocr" : "pdf-text", lowConfidence: docs.flatMap((d) => d.lowConfidence ?? []) };
}

/** Header details from `from` fill whatever `into` does not have */
function withHeader(into: Draft, from: Draft): Draft {
  const pick = <T>(a: T | null, b: T | null) => (a === null || a === "" ? b : a);
  return {
    ...into,
    supplier: { name: pick(into.supplier.name, from.supplier.name) ?? "", address: pick(into.supplier.address, from.supplier.address), gstin: pick(into.supplier.gstin, from.supplier.gstin), phone: pick(into.supplier.phone, from.supplier.phone), email: pick(into.supplier.email, from.supplier.email), state: pick(into.supplier.state, from.supplier.state) },
    invoiceNo: pick(into.invoiceNo, from.invoiceNo),
    invoiceDate: pick(into.invoiceDate, from.invoiceDate),
    dueDate: pick(into.dueDate, from.dueDate),
    invoiceDiscountAmount: pick(into.invoiceDiscountAmount, from.invoiceDiscountAmount),
    chargesAmount: pick(into.chargesAmount, from.chargesAmount),
    roundOff: pick(into.roundOff, from.roundOff),
    extractedTotals: { taxable: pick(into.extractedTotals.taxable, from.extractedTotals.taxable), tax: pick(into.extractedTotals.tax, from.extractedTotals.tax), grand: pick(into.extractedTotals.grand, from.extractedTotals.grand) },
    notes: [...into.notes, ...from.notes.filter((n) => !into.notes.includes(n))].slice(0, 30),
  };
}

/** On a re-read: fields and rows the user changed stay; untouched ones take the new reading */
export function mergeKeepingEdits(prev: Draft, prevMachine: Draft | null, next: Draft): Draft {
  if (!prevMachine) {
    // Nothing was read before (e.g. rows typed in while the reader was unavailable): keep what the user
    // entered and add every newly read line; never drop read lines in favour of a partial manual list
    if (!prev.rows.length && !prev.supplier.name && !prev.invoiceNo) return next;
    const typed = new Set(prev.rows.map(rowKey));
    const added = next.rows.filter((r) => !typed.has(rowKey(r)));
    const out = withHeader({ ...prev, supplierId: prev.supplierId ?? next.supplierId, rows: [...prev.rows, ...added] }, next);
    if (prev.rows.length && added.length) out.notes = [`${prev.rows.length} line(s) you entered earlier were kept above the ${added.length} line(s) read from the document — delete any duplicates.`, ...out.notes].slice(0, 30);
    return out;
  }
  const changed = (a: unknown, b: unknown) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
  const out: Draft = { ...next };
  const header = ["documentKind", "supplierId", "invoiceNo", "invoiceDate", "dueDate", "paymentTerms", "invoiceDiscountAmount", "chargesAmount", "chargesGstRate", "chargesLabel", "roundOff", "acknowledged", "tableSource"] as const;
  for (const k of header) if (changed(prev[k], prevMachine[k])) (out as Record<string, unknown>)[k] = prev[k];
  out.supplier = { ...next.supplier };
  for (const k of Object.keys(prev.supplier) as (keyof Draft["supplier"])[]) if (changed(prev.supplier[k], prevMachine.supplier[k])) (out.supplier as Record<string, unknown>)[k] = prev.supplier[k];
  out.extractedTotals = { ...next.extractedTotals };
  for (const k of Object.keys(prev.extractedTotals) as (keyof Draft["extractedTotals"])[]) if (changed(prev.extractedTotals[k], prevMachine.extractedTotals[k])) out.extractedTotals[k] = prev.extractedTotals[k];
  // Rows the user edited or added are kept; rows they deleted stay deleted; the rest are re-read
  const machineById = new Map(prevMachine.rows.map((r) => [r.id, r]));
  const prevIds = new Set(prev.rows.map((r) => r.id));
  const deleted = prevMachine.rows.filter((r) => !prevIds.has(r.id)).map((r) => rowKey(r));
  const kept = prev.rows.filter((r) => !machineById.has(r.id) || changed(r, machineById.get(r.id)));
  const keptKeys = new Set(kept.map(rowKey));
  out.rows = [...kept, ...next.rows.filter((r) => !keptKeys.has(rowKey(r)) && !deleted.includes(rowKey(r)) && !kept.some((k) => machineById.has(k.id) && rowKey(machineById.get(k.id)!) === rowKey(r)))];
  return out;
}
const rowKey = (r: DraftRow) => `${r.description.toLowerCase().replace(/\s+/g, " ").trim()}|${r.quantity ?? ""}|${r.rate ?? ""}`;

/** What the files contained, for the review screen (no binary data, text capped) */
function summariseParts(parts: SourcePart[], warnings: string[]) {
  return {
    warnings,
    parts: parts.map((p) =>
      p.type === "table"
        ? { type: "table", fileId: p.fileId, source: p.source, hidden: !!p.hidden, rows: p.rows.slice(0, 400).map((r) => r.slice(0, 40)) }
        : p.type === "text"
          ? { type: "text", fileId: p.fileId, source: p.source, text: p.text.slice(0, 20000) }
          : p.type === "pdf"
            ? { type: "pdf", fileId: p.fileId, pageCount: p.pageCount, scanned: p.scanned, text: p.text.slice(0, 20000) }
            : { type: "image", fileId: p.fileId, source: p.source }
    ),
  };
}

export function emptyDraft(kind: Draft["documentKind"], rows: DraftRow[], tableSource: Draft["tableSource"]): Draft {
  return {
    documentKind: kind,
    supplierId: null,
    supplier: { name: "", address: null, gstin: null, phone: null, email: null, state: null },
    invoiceNo: null,
    invoiceDate: null,
    dueDate: null,
    paymentTerms: null,
    invoiceDiscountAmount: null,
    chargesAmount: null,
    chargesGstRate: null,
    chargesLabel: null,
    roundOff: null,
    extractedTotals: { taxable: null, tax: null, grand: null },
    uncertain: [],
    notes: [],
    rows,
    acknowledged: { totalsMismatch: false, duplicateBill: false },
    tableSource,
  };
}

export function draftFromExtracted(x: ExtractedBill): Draft {
  const sum = (...v: (number | null)[]) => (v.every((n) => n === null) ? null : v.reduce<number>((s, n) => s + (n ?? 0), 0));
  const rows = x.items.map((it) =>
    blankRow({
      description: it.description.slice(0, 300),
      supplierCode: it.supplier_item_code,
      barcode: it.barcode,
      hsn: it.hsn_sac ? it.hsn_sac.replace(/\D/g, "").slice(0, 8) || null : null,
      quantity: it.quantity,
      freeQuantity: it.free_quantity,
      unit: it.unit,
      packNote: it.pack_size,
      rate: it.rate,
      rateIncludesTax: it.rate_includes_tax === true,
      discountPercent: it.discount_percent,
      discountAmount: it.discount_amount,
      gstRate: it.gst_rate,
      extractedLineTotal: it.line_total,
      uncertain: [...it.uncertain_fields, ...(it.rate_includes_tax === null ? ["whether the rate includes tax"] : [])].slice(0, 30),
    })
  );
  return {
    ...emptyDraft(x.document_kind, rows, null),
    supplier: { name: x.supplier.name ?? "", address: x.supplier.address, gstin: x.supplier.gstin?.toUpperCase().replace(/\s/g, "") ?? null, phone: x.supplier.phone, email: x.supplier.email, state: stateFromGstin(x.supplier.gstin) },
    invoiceNo: x.invoice_number,
    invoiceDate: /^\d{4}-\d{2}-\d{2}$/.test(x.invoice_date ?? "") ? x.invoice_date : null,
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(x.due_date ?? "") ? x.due_date : null,
    paymentTerms: x.payment_terms,
    invoiceDiscountAmount: x.invoice_discount_amount,
    chargesAmount: sum(x.delivery_charges, x.other_charges),
    chargesGstRate: x.charges_gst_rate,
    chargesLabel: x.delivery_charges ? "Delivery charges" : x.other_charges ? "Other charges" : null,
    roundOff: x.round_off,
    extractedTotals: { taxable: x.taxable_total, tax: sum(x.cgst_total, x.sgst_total, x.igst_total), grand: x.grand_total },
    uncertain: x.uncertain_fields.slice(0, 40),
    notes: x.review_notes.slice(0, 30),
  };
}

/** Picks the supplier (GSTIN, then exact name) and pre-matches rows: remembered/code matches are set, name matches are suggestions to confirm */
async function prefill(ctx: ActionContext, draft: Draft): Promise<Draft> {
  const found = await findSupplier(ctx.business.id, draft.supplier);
  const supplierId = found.match?.id ?? null;
  const [products, maps] = await Promise.all([
    prisma.product.findMany({ where: { businessId: ctx.business.id, isActive: true }, include: { tax: true, unit: true, secondaryUnit: true } }),
    supplierId ? prisma.supplierItemMap.findMany({ where: { businessId: ctx.business.id, supplierId } }) : Promise.resolve([]),
  ]);
  const rows = draft.rows.map((row) => {
    const m = matchRow(row, products, maps);
    // No matching item at all → prepared as a new item (created only on confirmation; can be changed to a match)
    const unmatched = m.status === "unmatched" && row.action === "match";
    return {
      ...row,
      action: unmatched ? ("create" as const) : row.action,
      autoNew: unmatched,
      productId: m.productId,
      matchConfirmed: m.status === "remembered" || m.status === "code",
      unitFactor: row.unitFactor ?? m.unitFactor,
      newProduct: { name: row.description, unitName: row.unit || "Pieces", hsn: row.hsn, gstRate: row.gstRate, salePrice: null },
    };
  });
  return { ...draft, supplierId, rows };
}

export async function saveDraft(ctx: ActionContext, id: string, input: unknown): Promise<Draft> {
  const imp = await getImport(ctx.business.id, id);
  if (!["DRAFT", "NEEDS_SETUP", "FAILED"].includes(imp.status)) throw new AppError("This import can no longer be changed.", 409);
  const parsed = DraftSchema.safeParse(input);
  if (!parsed.success) throw new AppError("The draft could not be saved: some values are not valid.", 422);
  await prisma.purchaseImport.update({ where: { id }, data: { draft: parsed.data as unknown as Prisma.InputJsonValue, status: imp.status === "FAILED" ? "DRAFT" : imp.status } });
  return parsed.data;
}

/** Re-reads rows from a chosen table with the header row and column mapping the user picked */
export async function remapTable(ctx: ActionContext, id: string, partIndex: number, headerRow: number, columns: ColumnMap, current: Draft): Promise<Draft> {
  const imp = await getImport(ctx.business.id, id);
  const parts = ((imp.sourceData as { parts?: { type: string; rows?: string[][] }[] } | null)?.parts ?? []);
  const table = parts[partIndex];
  if (!table || table.type !== "table" || !table.rows) throw new AppError("That table is not part of this import.", 422);
  const rows = rowsFromTable(table.rows, headerRow, columns);
  return prefill(ctx, { ...current, rows, tableSource: { partIndex, headerRow, columns: columns as Record<string, number | null> } });
}

export async function setRotation(businessId: string, importId: string, fileId: string, rotation: number) {
  await getImport(businessId, importId);
  await prisma.purchaseImportFile.updateMany({ where: { id: fileId, importId }, data: { rotation: ((Math.round(rotation / 90) * 90) % 360 + 360) % 360 } });
}

export async function discardImport(businessId: string, id: string) {
  const imp = await getImport(businessId, id);
  if (["POSTING", "POSTED"].includes(imp.status)) throw new AppError("A confirmed import cannot be discarded; cancel the purchase bill instead.", 409);
  // The record and files are kept (history, backups); it just leaves the list
  await prisma.purchaseImport.update({ where: { id }, data: { status: "DISCARDED" } });
}
