import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import sharp from "sharp";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { detectFileType, UnsupportedFileError } from "./fileTypes";
import { readDocument, rtfToText, type SourcePart } from "./readers";
import { detectHeader, parseNumber, rowsFromTable } from "./tableMapper";
import { matchRow } from "./review";
import { blankRow } from "./tableMapper";

// ---------- Fixtures built in code (no real supplier documents) ----------
const ITEMS = [
  ["Sr", "Description", "HSN", "Qty", "Unit", "Rate (₹)", "Disc %", "GST %", "Amount"],
  ["1", "A4 Copier Paper 75 GSM", "48025690", "10", "Ream", "250.00", "5", "12", "2375.00"],
  ["2", "Gel Pen Blue 0.5mm", "96081019", "2", "Box", "120", "", "18", "240.00"],
];

function minimalPdf(text: string | null): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
  ];
  const content = text ? `BT /F1 12 Tf 50 780 Td (${text}) Tj ET` : "0 0 m 10 10 l S";
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

async function docx(): Promise<Buffer> {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  z.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const cell = (t: string) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  const rows = ITEMS.map((r) => `<w:tr>${r.map(cell).join("")}</w:tr>`).join("");
  z.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>TAX INVOICE No. ABC/123</w:t></w:r></w:p><w:tbl>${rows}</w:tbl></w:body></w:document>`);
  return z.generateAsync({ type: "nodebuffer" });
}

async function pptx(): Promise<Buffer> {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`);
  z.file("ppt/presentation.xml", `<?xml version="1.0"?><p:presentation xmlns:p="p"/>`);
  const tc = (t: string) => `<a:tc><a:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></a:txBody></a:tc>`;
  z.file("ppt/slides/slide1.xml", `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Quotation for stationery</a:t></a:r></a:p><a:tbl>${ITEMS.map((r) => `<a:tr>${r.map(tc).join("")}</a:tr>`).join("")}</a:tbl></p:sld>`);
  return z.generateAsync({ type: "nodebuffer" });
}

async function odt(): Promise<Buffer> {
  const z = new JSZip();
  z.file("mimetype", "application/vnd.oasis.opendocument.text");
  const cell = (t: string) => `<table:table-cell><text:p>${t}</text:p></table:table-cell>`;
  z.file("content.xml", `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x"><office:body><office:text><text:p>Invoice 77</text:p><table:table table:name="T1">${ITEMS.map((r) => `<table:table-row>${r.map(cell).join("")}</table:table-row>`).join("")}</table:table></office:text></office:body></office:document-content>`);
  return z.generateAsync({ type: "nodebuffer" });
}

function workbook(bookType: XLSX.BookType): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([["SUPPLIER BILL", "", "", "", "", "", "", "", ""], ...ITEMS]);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
  // A formula without a saved result must be flagged, never calculated
  ws["I4"] = { t: "n", f: "D4*F4" } as XLSX.CellObject;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Bill");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["notes"], ["thank you"]]), "Notes");
  return XLSX.write(wb, { type: "buffer", bookType }) as Buffer;
}

function ole(streams: Record<string, Buffer>): Buffer {
  const cfb = XLSX.CFB.utils.cfb_new();
  for (const [name, data] of Object.entries(streams)) XLSX.CFB.utils.cfb_add(cfb, `/${name}`, data);
  return Buffer.from(XLSX.CFB.write(cfb, { type: "buffer" }) as Uint8Array);
}

async function read(buf: Buffer, name: string) {
  const type = await detectFileType(buf, name);
  return { type, res: await readDocument({ id: "f1", data: buf, name, type }) };
}
const tables = (parts: SourcePart[]) => parts.filter((p): p is Extract<SourcePart, { type: "table" }> => p.type === "table");

describe("file types are detected from content", () => {
  it("recognises each format, even when renamed", async () => {
    const jpg = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const cases: [Buffer, string, string][] = [
      [minimalPdf("x"), "bill.dat", "pdf"],
      [jpg, "photo.png", "jpeg"],
      [await sharp(jpg).png().toBuffer(), "a.png", "png"],
      [await sharp(jpg).webp().toBuffer(), "a.webp", "webp"],
      [await sharp(jpg).tiff().toBuffer(), "a.tif", "tiff"],
      [workbook("xlsx"), "bill.xlsx", "xlsx"],
      [workbook("biff8"), "bill.xls", "xls"],
      [workbook("ods"), "bill.ods", "ods"],
      [Buffer.from(ITEMS.map((r) => r.join(",")).join("\n")), "bill.csv", "csv"],
      [Buffer.from(ITEMS.map((r) => r.join("\t")).join("\n")), "bill.txt", "tsv"],
      [await docx(), "bill.docx", "docx"],
      [await odt(), "bill.odt", "odt"],
      [await pptx(), "bill.pptx", "pptx"],
      [Buffer.from("{\\rtf1\\ansi Invoice\\par}"), "bill.rtf", "rtf"],
      [Buffer.from("Invoice from ABC Traders\nThank you"), "bill.txt", "txt"],
      [ole({ WordDocument: Buffer.alloc(512) }), "old.doc", "doc"],
      [ole({ "PowerPoint Document": Buffer.alloc(512) }), "old.ppt", "ppt"],
      [Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)]), "IMG.HEIC", "heic"],
    ];
    for (const [buf, name, kind] of cases) expect((await detectFileType(buf, name)).kind, name).toBe(kind);
  });

  it("refuses unknown, damaged and password-protected files with a clear reason", async () => {
    await expect(detectFileType(Buffer.from([0, 1, 2, 3, 0, 255, 0, 9]), "x.bin")).rejects.toThrow(/not a supported file type/);
    await expect(detectFileType(ole({ EncryptionInfo: Buffer.alloc(64), EncryptedPackage: Buffer.alloc(64) }), "secret.xlsx")).rejects.toThrow(/password-protected/);
    const zip = await new JSZip().file("readme.txt", "hi").generateAsync({ type: "nodebuffer" });
    await expect(detectFileType(zip, "files.zip")).rejects.toThrow(/not a supported document/);
    const damaged = Buffer.from("%PDF-1.4\nthis is not really a pdf");
    await expect(readDocument({ id: "f", data: damaged, name: "bad.pdf", type: await detectFileType(damaged, "bad.pdf") })).rejects.toBeInstanceOf(UnsupportedFileError);
  });
});

describe("documents are read deterministically", () => {
  it("spreadsheets: every sheet, merged headers filled, formulas flagged not calculated", async () => {
    for (const kind of ["xlsx", "xls", "ods"] as const) {
      const { res } = await read(workbook(kind === "xls" ? "biff8" : kind), `bill.${kind}`);
      const t = tables(res.parts);
      expect(t.map((x) => x.source), kind).toEqual(['Sheet "Bill"', 'Sheet "Notes"']);
      expect(t[0].rows[0].slice(0, 4), kind).toEqual(["SUPPLIER BILL", "SUPPLIER BILL", "SUPPLIER BILL", "SUPPLIER BILL"]);
      if (kind === "xlsx") expect(res.warnings.join(" "), kind).toMatch(/formula cell\(s\) have no saved result \(I4\)/);
    }
  });

  it("CSV, TSV, Word, ODT, PowerPoint and RTF tables become the same rows", async () => {
    const sources: [Buffer, string][] = [
      [Buffer.from(ITEMS.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n")), "bill.csv"],
      [Buffer.from(ITEMS.map((r) => r.join("\t")).join("\n")), "bill.tsv"],
      [await docx(), "bill.docx"],
      [await odt(), "bill.odt"],
      [await pptx(), "bill.pptx"],
      [Buffer.from(`{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}Tax invoice\\par ${ITEMS.map((r) => r.map((c) => c.replace("₹", "\\u8377?")).join("\\cell ") + "\\cell\\row").join(" ")}}`), "bill.rtf"],
    ];
    for (const [buf, name] of sources) {
      const { res } = await read(buf, name);
      const t = tables(res.parts).find((x) => detectHeader(x.rows).confident);
      expect(t, name).toBeTruthy();
      const h = detectHeader(t!.rows);
      const rows = rowsFromTable(t!.rows, h.headerRow, h.columns);
      expect(rows.map((r) => [r.description, r.quantity, r.unit, r.rate, r.discountPercent, r.gstRate, r.extractedLineTotal]), name).toEqual([
        ["A4 Copier Paper 75 GSM", 10, "Ream", 250, 5, 12, 2375],
        ["Gel Pen Blue 0.5mm", 2, "Box", 120, null, 18, 240],
      ]);
    }
    expect(rtfToText("{\\rtf1 Total \\'a3 5\\par}")).toBe("Total £ 5");
  });

  it("PDFs: embedded text is read; a page without text is treated as a scan", async () => {
    const text = (await read(minimalPdf("TAX INVOICE No 42 ABC Traders Dehradun Total 1180.00 GST 180.00"), "bill.pdf")).res;
    const p = text.parts[0] as Extract<SourcePart, { type: "pdf" }>;
    expect([p.pageCount, p.scanned, /TAX INVOICE No 42/.test(p.text)]).toEqual([1, false, true]);
    const scan = (await read(minimalPdf(null), "scan.pdf")).res;
    expect((scan.parts[0] as Extract<SourcePart, { type: "pdf" }>).scanned).toBe(true);
    expect(scan.warnings.join(" ")).toMatch(/scanned/);
  });

  it("images: rotation applied, TIFF pages read; HEIC converted on macOS", async () => {
    const png = await sharp({ create: { width: 600, height: 300, channels: 3, background: "#ddd" } }).png().toBuffer();
    const img = (await readDocument({ id: "f", data: png, name: "p.png", type: await detectFileType(png, "p.png"), rotation: 90 })).parts[0] as Extract<SourcePart, { type: "image" }>;
    const meta = await sharp(img.data).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 300, 600]);
    const tiff = await sharp(png).tiff().toBuffer();
    expect((await read(tiff, "scan.tiff")).res.parts).toHaveLength(1);
    if (process.platform === "darwin") {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heic-test-"));
      fs.writeFileSync(path.join(dir, "a.jpg"), await sharp(png).jpeg().toBuffer());
      execFileSync("sips", ["-s", "format", "heic", path.join(dir, "a.jpg"), "--out", path.join(dir, "a.heic")], { stdio: "ignore" });
      const heic = fs.readFileSync(path.join(dir, "a.heic"));
      const out = (await read(heic, "IMG.HEIC")).res.parts[0] as Extract<SourcePart, { type: "image" }>;
      expect((await sharp(out.data).metadata()).format).toBe("jpeg");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacy DOC/PPT need LibreOffice and say so when it is missing", async () => {
    const doc = ole({ WordDocument: Buffer.alloc(512) });
    const attempt = readDocument({ id: "f", data: doc, name: "old.doc", type: await detectFileType(doc, "old.doc") });
    if (!fs.existsSync("/Applications/LibreOffice.app") && !process.env.SOFFICE_PATH) await expect(attempt).rejects.toThrow(/needs LibreOffice/);
    else await attempt.catch(() => {});
  });
});

describe("table reading", () => {
  it("parses Indian number formats", () => {
    expect([parseNumber("₹1,23,456.50"), parseNumber("12%"), parseNumber("(5.00)"), parseNumber("-"), parseNumber("")]).toEqual([123456.5, 12, -5, null, null]);
  });
  it("skips totals and headings, works out a missing rate from amount ÷ quantity and flags it", () => {
    const rows = [["Item", "Qty", "Amount"], ["Stapler", "4", "400"], ["Office supplies", "", ""], ["Total", "", "400"]];
    const h = detectHeader(rows);
    const out = rowsFromTable(rows, h.headerRow, h.columns);
    expect(out.map((r) => [r.description, r.rate])).toEqual([["Stapler", 100]]);
    expect(out[0].uncertain.join(" ")).toMatch(/worked out from amount/);
  });
});

describe("product matching", () => {
  const product = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, name, itemCode: null, barcode: null, unit: { name: "Pieces", shortName: "PCS" }, secondaryUnit: null, conversionRate: null, tax: null, ...over }) as never;
  const products = [product("p1", "A4 Copier Paper 75 GSM"), product("p2", "A4 Copier Paper 70 GSM"), product("p3", "Gel Pen Blue", { itemCode: "GP-01" })];

  it("never merges by name alone: same name is a suggestion to confirm; other sizes are kept apart", () => {
    const m = matchRow(blankRow({ description: "A4 copier paper 75gsm" }), products, []);
    expect([m.productId, m.status]).toEqual(["p1", "suggested"]);
    expect(m.differentSize.map((x) => x.id)).toEqual(["p2"]);
    expect(matchRow(blankRow({ description: "A4 Copier Paper 80 GSM" }), products, [])).toMatchObject({ productId: null, status: "unmatched" });
  });
  it("uses the supplier's code and remembered mappings first", () => {
    expect(matchRow(blankRow({ description: "Blue gel pen (new)", supplierCode: "gp-01" }), products, [])).toMatchObject({ productId: "p3", status: "code" });
    const maps = [{ matchKey: "code:x99", productId: "p2", billUnit: "Box", unitFactor: new Prisma.Decimal(10) }];
    expect(matchRow(blankRow({ description: "Anything", supplierCode: "X-99", unit: "box" }), products, maps)).toMatchObject({ productId: "p2", status: "remembered", unitFactor: 10 });
  });
});
