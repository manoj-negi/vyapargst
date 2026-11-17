import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import mammoth from "mammoth";
import { UnsupportedFileError, type DetectedType } from "./fileTypes";

const run = promisify(execFile);

/**
 * Deterministic reading of supplier documents. Everything here runs locally and never executes
 * document content: no macros, no spreadsheet formulas (only cached results are read; a formula
 * without one is flagged), no external links, no embedded scripts. What it produces:
 *   - tables (spreadsheet sheets, Word/ODT/RTF/PowerPoint tables) as rows of cell text
 *   - plain text (paragraphs, slide text)
 *   - PDFs (with their embedded text, when they have any) and images, for the vision step
 */

export const LIMITS = { fileBytes: 15 * 1024 * 1024, totalBytes: 40 * 1024 * 1024, files: 10, pdfPages: 50, images: 20, rows: 2000, columns: 60 };

export type SourcePart =
  | { type: "pdf"; fileId: string; data: Buffer; pageCount: number; text: string; scanned: boolean }
  | { type: "image"; fileId: string; data: Buffer; mime: "image/jpeg" | "image/png" | "image/webp"; source: string }
  | { type: "table"; fileId: string; source: string; rows: string[][]; hidden?: boolean }
  | { type: "text"; fileId: string; source: string; text: string };

export interface ReadResult {
  parts: SourcePart[];
  warnings: string[];
  pageCount: number | null;
}

// pdfjs-dist ships as ES modules only; Node 22 can require() them from this CommonJS build
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadPdfjs = () => require("pdfjs-dist/legacy/build/pdf.mjs");

export async function readDocument(file: { id: string; data: Buffer; name: string; type: DetectedType; rotation?: number }): Promise<ReadResult> {
  const { id, data, name, type } = file;
  const warnings: string[] = [];
  switch (type.kind) {
    case "pdf":
      return readPdf(id, data, name);
    case "jpeg":
    case "png":
    case "webp":
    case "tiff":
    case "heic":
      return { parts: await readImage(id, data, name, type.kind, file.rotation ?? 0, warnings), warnings, pageCount: null };
    case "xlsx":
    case "xls":
    case "ods":
      return { parts: readWorkbook(id, XLSX.read(data, workbookOptions()), warnings), warnings, pageCount: null };
    case "csv":
    case "tsv":
      return {
        parts: readWorkbook(id, XLSX.read(data.toString("utf8"), { ...workbookOptions(), type: "string", FS: type.kind === "tsv" ? "\t" : undefined } as XLSX.ParsingOptions), warnings),
        warnings,
        pageCount: null,
      };
    case "docx":
      return readDocx(id, data, warnings);
    case "odt":
      return readOdt(id, data, warnings);
    case "pptx":
      return readPptx(id, data, warnings);
    case "rtf":
      return { parts: rtfParts(id, data.toString("latin1")), warnings, pageCount: null };
    case "txt":
      return { parts: [{ type: "text", fileId: id, source: name, text: data.toString("utf8") }], warnings, pageCount: null };
    case "doc":
    case "ppt": {
      const converted = await convertWithLibreOffice(data, name, type.kind === "doc" ? "docx" : "pptx");
      warnings.push(`${name} was converted from the older ${type.kind.toUpperCase()} format with LibreOffice before reading.`);
      return type.kind === "doc" ? readDocx(id, converted, warnings) : readPptx(id, converted, warnings);
    }
  }
}

function workbookOptions(): XLSX.ParsingOptions {
  // Formulas are not evaluated; macros and external links are never loaded
  return { type: "buffer", cellFormula: true, cellNF: true, cellText: true, cellDates: false, bookVBA: false, WTF: false, dense: false };
}

// ---------- PDF ----------
async function readPdf(fileId: string, data: Buffer, name: string): Promise<ReadResult> {
  const pdfjs = loadPdfjs();
  let doc: any;
  let task: any;
  try {
    task = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    doc = await task.promise;
  } catch (err: any) {
    if (err?.name === "PasswordException") throw new UnsupportedFileError(`"${name}" is password-protected. Save an unprotected copy of the PDF and upload that.`);
    throw new UnsupportedFileError(`"${name}" could not be read as a PDF (it may be damaged).`);
  }
  const pageCount = doc.numPages as number;
  if (pageCount > LIMITS.pdfPages) throw new UnsupportedFileError(`"${name}" has ${pageCount} pages; the limit is ${LIMITS.pdfPages} pages per PDF.`);
  const pages: string[] = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Keep line breaks where the PDF has them
    let line = "";
    const lines: string[] = [];
    for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
      if (typeof item.str !== "string") continue;
      line += item.str;
      if (item.hasEOL) { lines.push(line); line = ""; } else line += " ";
    }
    if (line.trim()) lines.push(line);
    pages.push(lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n"));
  }
  await task.destroy();
  const text = pages.map((t, i) => `--- page ${i + 1} ---\n${t}`).join("\n");
  const chars = pages.reduce((n, t) => n + t.length, 0);
  // Little or no embedded text: a scan or photo saved as PDF; the vision step reads the page images
  const scanned = chars / pageCount < 40;
  return { parts: [{ type: "pdf", fileId, data, pageCount, text, scanned }], warnings: scanned ? [`${name} has no readable text layer (scanned), so its pages are read from the images.`] : [], pageCount };
}

// ---------- Images ----------
async function readImage(fileId: string, data: Buffer, name: string, kind: string, rotation: number, warnings: string[]): Promise<SourcePart[]> {
  let input = data;
  if (kind === "heic") input = await heicToJpeg(data, name);
  const meta = await sharp(input, { failOn: "none" }).metadata().catch(() => null);
  if (!meta || !meta.width) throw new UnsupportedFileError(`"${name}" could not be opened as an image (it may be damaged).`);
  const pages = kind === "tiff" ? Math.min(meta.pages || 1, 10) : 1;
  if (kind === "tiff" && (meta.pages || 1) > 10) warnings.push(`${name} has ${meta.pages} pages; only the first 10 are read.`);
  const out: SourcePart[] = [];
  for (let page = 0; page < pages; page++) {
    // Camera orientation first, then the user's rotation; resized so the text stays sharp but the upload stays small
    const jpeg = await sharp(input, { failOn: "none", page })
      .rotate()
      .rotate(((rotation % 360) + 360) % 360)
      .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    out.push({ type: "image", fileId, data: jpeg, mime: "image/jpeg", source: pages > 1 ? `${name} page ${page + 1}` : name });
  }
  return out;
}

async function heicToJpeg(data: Buffer, name: string): Promise<Buffer> {
  try {
    return await sharp(data).jpeg().toBuffer();
  } catch {
    // The prebuilt image library cannot decode HEIC (HEVC); macOS can, with its own `sips` tool
    if (process.platform !== "darwin") {
      throw new UnsupportedFileError(`"${name}" is a HEIC/HEIF photo, which this server cannot convert. On the phone choose "Most Compatible" (JPEG) in camera settings, or export the photo as JPG.`);
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "heic-"));
    try {
      const src = path.join(dir, "in.heic");
      const dst = path.join(dir, "out.jpg");
      await fs.writeFile(src, data);
      await run("sips", ["-s", "format", "jpeg", src, "--out", dst], { timeout: 30000 });
      return await fs.readFile(dst);
    } catch {
      throw new UnsupportedFileError(`"${name}" could not be converted from HEIC. Export the photo as JPG and upload that.`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

// ---------- Spreadsheets ----------
function readWorkbook(fileId: string, wb: XLSX.WorkBook, warnings: string[]): SourcePart[] {
  const parts: SourcePart[] = [];
  wb.SheetNames.forEach((sheetName, index) => {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws["!ref"]) return;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const lastRow = Math.min(range.e.r, range.s.r + LIMITS.rows - 1);
    const lastCol = Math.min(range.e.c, range.s.c + LIMITS.columns - 1);
    if (range.e.r > lastRow) warnings.push(`Sheet "${sheetName}": only the first ${LIMITS.rows} rows are read.`);
    const rows: string[][] = [];
    const unresolved: string[] = [];
    for (let r = range.s.r; r <= lastRow; r++) {
      const row: string[] = [];
      for (let c = range.s.c; c <= lastCol; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
        if (!cell) { row.push(""); continue; }
        if (cell.f && (cell.v === undefined || cell.v === null || cell.v === "")) {
          unresolved.push(XLSX.utils.encode_cell({ r, c }));
          row.push("");
          continue;
        }
        row.push(String(cell.w ?? cell.v ?? "").trim());
      }
      rows.push(row);
    }
    // Merged cells (often headers): repeat the value across the merged range
    for (const m of ws["!merges"] || []) {
      const value = rows[m.s.r - range.s.r]?.[m.s.c - range.s.c] ?? "";
      for (let r = m.s.r; r <= Math.min(m.e.r, lastRow); r++) for (let c = m.s.c; c <= Math.min(m.e.c, lastCol); c++) {
        if (rows[r - range.s.r] && !rows[r - range.s.r][c - range.s.c]) rows[r - range.s.r][c - range.s.c] = value;
      }
    }
    if (unresolved.length) warnings.push(`Sheet "${sheetName}": ${unresolved.length} formula cell(s) have no saved result (${unresolved.slice(0, 5).join(", ")}${unresolved.length > 5 ? "…" : ""}). Formulas are not calculated here; check those values.`);
    const hidden = !!wb.Workbook?.Sheets?.[index]?.Hidden;
    const trimmed = trimEmpty(rows);
    if (trimmed.length) parts.push({ type: "table", fileId, source: `Sheet "${sheetName}"`, rows: trimmed, hidden });
  });
  if (!parts.length) warnings.push("The workbook has no data.");
  return parts;
}

function trimEmpty(rows: string[][]): string[][] {
  const kept = rows.filter((r) => r.some((c) => c));
  const width = Math.max(0, ...kept.map((r) => r.reduce((w, c, i) => (c ? i + 1 : w), 0)));
  return kept.map((r) => r.slice(0, width));
}

// ---------- Word (DOCX) ----------
async function readDocx(fileId: string, data: Buffer, warnings: string[]): Promise<ReadResult> {
  const images: SourcePart[] = [];
  let html: string;
  try {
    const out = await mammoth.convertToHtml(
      { buffer: data },
      {
        convertImage: mammoth.images.imgElement(async (image: any) => {
          if (images.length < 6 && /^image\/(png|jpeg|jpg|webp)$/.test(image.contentType)) {
            const buf = Buffer.from(await image.read("base64"), "base64");
            images.push({ type: "image", fileId, data: await sharp(buf).jpeg({ quality: 88 }).toBuffer(), mime: "image/jpeg", source: `Picture ${images.length + 1} in the document` });
          }
          return { src: "" };
        }),
      }
    );
    html = out.value;
  } catch {
    throw new UnsupportedFileError("The Word document could not be read (it may be damaged or password-protected).");
  }
  const tables = htmlTables(html);
  const text = htmlText(html.replace(/<table[\s\S]*?<\/table>/gi, "\n"));
  const parts: SourcePart[] = tables.map((rows, i) => ({ type: "table", fileId, source: `Table ${i + 1}`, rows }));
  if (text.trim()) parts.push({ type: "text", fileId, source: "Document text", text });
  parts.push(...images);
  if (images.length) warnings.push(`${images.length} picture(s) in the document are read with the vision step.`);
  return { parts, warnings, pageCount: null };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(e[1] === "x" ? 2 : 1), e[1] === "x" ? 16 : 10)) : ENTITIES[e.toLowerCase()] ?? m))
    .replace(/\s+/g, " ")
    .trim();
}
function htmlTables(html: string): string[][][] {
  return Array.from(html.matchAll(/<table[\s\S]*?<\/table>/gi)).map((t) =>
    Array.from(t[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)).map((tr) => Array.from(tr[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)).map((td) => decode(td[1])))
  ).filter((rows) => rows.length);
}
function htmlText(html: string): string {
  return html.split(/<\/(?:p|h\d|li)>/i).map(decode).filter(Boolean).join("\n");
}

// ---------- OpenDocument text (ODT) ----------
async function readOdt(fileId: string, data: Buffer, warnings: string[]): Promise<ReadResult> {
  const zip = await JSZip.loadAsync(data);
  const xml = (await zip.file("content.xml")?.async("string")) ?? "";
  const cellText = (cell: string) => Array.from(cell.matchAll(/<text:(?:p|h)[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g)).map((m) => decode(m[1])).join(" ");
  const tables = Array.from(xml.matchAll(/<table:table [\s\S]*?<\/table:table>/g)).map((t) =>
    Array.from(t[0].matchAll(/<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g)).map((row) =>
      Array.from(row[1].matchAll(/<table:table-cell([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)).flatMap((c) => {
        const repeat = Math.min(Number(/table:number-columns-repeated="(\d+)"/.exec(c[1])?.[1] ?? 1), 50);
        return Array(repeat).fill(cellText(c[2] ?? ""));
      })
    )
  ).map(trimEmpty).filter((rows) => rows.length);
  const text = Array.from(xml.replace(/<table:table [\s\S]*?<\/table:table>/g, "").matchAll(/<text:(?:p|h)[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g)).map((m) => decode(m[1])).filter(Boolean).join("\n");
  const parts: SourcePart[] = tables.map((rows, i) => ({ type: "table", fileId, source: `Table ${i + 1}`, rows }));
  if (text) parts.push({ type: "text", fileId, source: "Document text", text });
  parts.push(...(await zipImages(zip, /^Pictures\//, fileId, warnings)));
  return { parts, warnings, pageCount: null };
}

// ---------- PowerPoint (PPTX) ----------
async function readPptx(fileId: string, data: Buffer, warnings: string[]): Promise<ReadResult> {
  const zip = await JSZip.loadAsync(data);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/g)!.pop()) - Number(b.match(/\d+/g)!.pop()));
  const parts: SourcePart[] = [];
  const runs = (x: string) => Array.from(x.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)).map((m) => decode(m[1])).join(" ");
  for (const [i, f] of slides.entries()) {
    const xml = await zip.file(f)!.async("string");
    Array.from(xml.matchAll(/<a:tbl>[\s\S]*?<\/a:tbl>/g)).forEach((t, n) => {
      const rows = Array.from(t[0].matchAll(/<a:tr[\s\S]*?<\/a:tr>/g)).map((tr) => Array.from(tr[0].matchAll(/<a:tc[\s\S]*?<\/a:tc>/g)).map((tc) => runs(tc[0])));
      if (rows.length) parts.push({ type: "table", fileId, source: `Slide ${i + 1} table ${n + 1}`, rows: trimEmpty(rows) });
    });
    const text = Array.from(xml.replace(/<a:tbl>[\s\S]*?<\/a:tbl>/g, "").matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)).map((p) => runs(p[1])).filter(Boolean).join("\n");
    if (text) parts.push({ type: "text", fileId, source: `Slide ${i + 1}`, text });
  }
  parts.push(...(await zipImages(zip, /^ppt\/media\//, fileId, warnings)));
  if (!slides.length) warnings.push("The presentation has no slides.");
  return { parts, warnings, pageCount: slides.length || null };
}

async function zipImages(zip: JSZip, folder: RegExp, fileId: string, warnings: string[]): Promise<SourcePart[]> {
  const names = Object.keys(zip.files).filter((f) => folder.test(f) && /\.(png|jpe?g|webp)$/i.test(f)).slice(0, 6);
  const out: SourcePart[] = [];
  for (const n of names) {
    const buf = await zip.file(n)!.async("nodebuffer");
    const meta = await sharp(buf).metadata().catch(() => null);
    if (!meta || (meta.width ?? 0) < 300) continue; // icons and logos are not bill content
    out.push({ type: "image", fileId, data: await sharp(buf).jpeg({ quality: 88 }).toBuffer(), mime: "image/jpeg", source: `Embedded picture ${out.length + 1}` });
  }
  if (out.length) warnings.push(`${out.length} embedded picture(s) are read with the vision step.`);
  return out;
}

// ---------- RTF ----------
export function rtfToText(rtf: string): string {
  let s = rtf.replace(/\{\\\*[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, ""); // destinations like {\*\generator …}
  s = s.replace(/\{\\(fonttbl|colortbl|stylesheet|info|pict)[\s\S]*?\}\s*(?=[\\{}]|$)/g, "");
  s = s
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
    .replace(/\\(par|line)\b ?/g, "\n")
    .replace(/\\row\b ?/g, "\n")
    .replace(/\\(cell|tab)\b ?/g, "\t")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/\\([{}\\])/g, "$1")
    .replace(/[{}]/g, "");
  return s.split("\n").map((l) => l.replace(/[ ]+/g, " ").trim()).filter((l) => l.replace(/\t/g, "").trim()).join("\n");
}
function rtfParts(fileId: string, rtf: string): SourcePart[] {
  const text = rtfToText(rtf);
  const lines = text.split("\n");
  const tableRows = lines.filter((l) => l.includes("\t")).map((l) => l.split("\t").map((c) => c.trim()));
  const parts: SourcePart[] = [];
  if (tableRows.length >= 2) parts.push({ type: "table", fileId, source: "Table", rows: trimEmpty(tableRows) });
  parts.push({ type: "text", fileId, source: "Document text", text: lines.filter((l) => !l.includes("\t")).join("\n") });
  return parts;
}

// ---------- Legacy DOC / PPT via LibreOffice ----------
async function findSoffice(): Promise<string | null> {
  const candidates = [process.env.SOFFICE_PATH, "/Applications/LibreOffice.app/Contents/MacOS/soffice", "/usr/bin/soffice", "/usr/local/bin/soffice", "/opt/homebrew/bin/soffice"].filter(Boolean) as string[];
  for (const c of candidates) if (await fs.access(c).then(() => true, () => false)) return c;
  return null;
}
export async function libreOfficeAvailable(): Promise<boolean> {
  return !!(await findSoffice());
}
async function convertWithLibreOffice(data: Buffer, name: string, to: "docx" | "pptx"): Promise<Buffer> {
  const soffice = await findSoffice();
  if (!soffice) {
    throw new UnsupportedFileError(
      `"${name}" is an older ${to === "docx" ? "Word (.doc)" : "PowerPoint (.ppt)"} file. Reading it needs LibreOffice, which is not installed on the server. Save it as ${to.toUpperCase()} or PDF and upload that, or install LibreOffice (set SOFFICE_PATH if it is not in the usual place).`
    );
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "convert-"));
  try {
    const src = path.join(dir, `in.${to === "docx" ? "doc" : "ppt"}`);
    await fs.writeFile(src, data);
    // Headless conversion only; macros are disabled in LibreOffice's headless mode by default
    await run(soffice, ["--headless", "--norestore", "--convert-to", to, "--outdir", dir, src], { timeout: 90000 });
    return await fs.readFile(path.join(dir, `in.${to}`));
  } catch {
    throw new UnsupportedFileError(`"${name}" could not be converted. Save it as ${to.toUpperCase()} or PDF and upload that.`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
