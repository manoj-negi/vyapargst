import * as XLSX from "xlsx";
import JSZip from "jszip";

/**
 * File type from the content itself (magic bytes, ZIP and OLE container entries), never from the
 * extension alone: a renamed file is read as what it really is, and an unknown one is refused.
 */
export type FileKind =
  | "pdf"
  | "jpeg"
  | "png"
  | "webp"
  | "heic"
  | "tiff"
  | "xlsx"
  | "xls"
  | "ods"
  | "csv"
  | "tsv"
  | "docx"
  | "doc"
  | "odt"
  | "rtf"
  | "txt"
  | "pptx"
  | "ppt";

export interface DetectedType {
  kind: FileKind;
  mime: string;
  label: string;
}

export class UnsupportedFileError extends Error {}

const LABELS: Record<FileKind, [string, string]> = {
  pdf: ["application/pdf", "PDF"],
  jpeg: ["image/jpeg", "JPEG image"],
  png: ["image/png", "PNG image"],
  webp: ["image/webp", "WEBP image"],
  heic: ["image/heic", "HEIC/HEIF image"],
  tiff: ["image/tiff", "TIFF image"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Excel workbook (XLSX)"],
  xls: ["application/vnd.ms-excel", "Excel 97-2003 workbook (XLS)"],
  ods: ["application/vnd.oasis.opendocument.spreadsheet", "OpenDocument spreadsheet (ODS)"],
  csv: ["text/csv", "CSV"],
  tsv: ["text/tab-separated-values", "TSV"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Word document (DOCX)"],
  doc: ["application/msword", "Word 97-2003 document (DOC)"],
  odt: ["application/vnd.oasis.opendocument.text", "OpenDocument text (ODT)"],
  rtf: ["application/rtf", "Rich Text (RTF)"],
  txt: ["text/plain", "Text"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "PowerPoint (PPTX)"],
  ppt: ["application/vnd.ms-powerpoint", "PowerPoint 97-2003 (PPT)"],
};

const result = (kind: FileKind): DetectedType => ({ kind, mime: LABELS[kind][0], label: LABELS[kind][1] });

export const SUPPORTED_SUMMARY =
  "PDF (text or scanned), JPG, PNG, WEBP, HEIC/HEIF, TIFF, Excel XLSX/XLS, CSV, TSV, ODS, Word DOCX/DOC, ODT, RTF, TXT, PowerPoint PPTX/PPT";

export async function detectFileType(buf: Buffer, originalName: string): Promise<DetectedType> {
  const head = buf.subarray(0, 16);
  const ascii = head.toString("latin1");
  if (ascii.startsWith("%PDF-")) return result("pdf");
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return result("jpeg");
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return result("png");
  if (ascii.startsWith("RIFF") && buf.subarray(8, 12).toString("latin1") === "WEBP") return result("webp");
  if (buf.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(buf.subarray(8, 12).toString("latin1"))) return result("heic");
  if (ascii.startsWith("II*\0") || ascii.startsWith("MM\0*")) return result("tiff");
  if (ascii.startsWith("{\\rtf")) return result("rtf");

  // ZIP containers: Office Open XML and OpenDocument
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buf);
    } catch {
      throw new UnsupportedFileError(`"${originalName}" looks like a ZIP file but could not be opened (it may be damaged).`);
    }
    const mimetype = zip.file("mimetype") ? (await zip.file("mimetype")!.async("string")).trim() : "";
    if (mimetype === LABELS.ods[0]) return result("ods");
    if (mimetype === LABELS.odt[0]) return result("odt");
    if (zip.file("xl/workbook.xml") || zip.file("xl/workbook.bin")) return result("xlsx");
    if (zip.file("word/document.xml")) return result("docx");
    if (zip.file("ppt/presentation.xml")) return result("pptx");
    throw new UnsupportedFileError(`"${originalName}" is a ZIP archive that is not a supported document. Upload the bill itself (PDF, image, Excel, Word…).`);
  }

  // OLE compound files: legacy Office, or password-protected (encrypted) Office Open XML
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    let names: string[] = [];
    try {
      names = XLSX.CFB.read(buf, { type: "buffer" }).FullPaths.map((p: string) => p.split("/").filter(Boolean).pop() || "");
    } catch {
      throw new UnsupportedFileError(`"${originalName}" could not be opened (the file may be damaged).`);
    }
    if (names.includes("EncryptionInfo") || names.includes("EncryptedPackage")) {
      throw new UnsupportedFileError(`"${originalName}" is password-protected. Open it, remove the password (or save an unprotected copy) and upload that.`);
    }
    if (names.includes("Workbook") || names.includes("Book")) return result("xls");
    if (names.includes("WordDocument")) return result("doc");
    if (names.includes("PowerPoint Document")) return result("ppt");
    throw new UnsupportedFileError(`"${originalName}" is an older Office file of a type that is not supported.`);
  }

  // Plain text: CSV / TSV / TXT (must be valid text, not binary)
  const sample = buf.subarray(0, 64 * 1024);
  if (!sample.includes(0) && isMostlyText(sample)) {
    const text = sample.toString("utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
    const tabs = lines.filter((l) => l.includes("\t")).length;
    const commas = lines.filter((l) => (l.match(/,/g) || []).length >= 2).length;
    const ext = originalName.toLowerCase().split(".").pop();
    if (lines.length >= 2 && tabs >= Math.ceil(lines.length * 0.6)) return result("tsv");
    if (lines.length >= 2 && (ext === "csv" || commas >= Math.ceil(lines.length * 0.6))) return result("csv");
    return result("txt");
  }
  throw new UnsupportedFileError(`"${originalName}" is not a supported file type. Supported: ${SUPPORTED_SUMMARY}.`);
}

function isMostlyText(buf: Buffer): boolean {
  let bad = 0;
  for (const b of buf) if (b < 9 || (b > 13 && b < 32)) bad++;
  return bad / Math.max(1, buf.length) < 0.01;
}
