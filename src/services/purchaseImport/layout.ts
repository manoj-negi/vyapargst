import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A page as lines of positioned words — the common input of the local bill parser, built either
 * from a PDF's text layer (exact) or from OCR (Tesseract word boxes, with confidence).
 */
export interface Token {
  text: string;
  x: number; // left edge, in points (PDF) or pixels scaled to ~points (OCR)
  w: number;
  conf?: number; // OCR confidence 0–100
}
export interface Line {
  y: number;
  page: number;
  tokens: Token[];
}
export interface LayoutDoc {
  lines: Line[];
  width: number;
  source: "pdf-text" | "ocr";
  lowConfidence?: string[];
}

/** Lines as text with column spacing kept (about 4.5 points per character), for display and the local model */
export function layoutText(doc: LayoutDoc): string {
  let page = 0;
  return doc.lines
    .map((l) => {
      let out = l.page !== page ? `--- page ${(page = l.page)} ---\n` : "";
      let line = "";
      for (const t of l.tokens) {
        const col = Math.round(t.x / 4.5);
        if (line.length < col) line += " ".repeat(col - line.length);
        else if (line.length) line += " ";
        line += t.text;
      }
      return out + line;
    })
    .join("\n");
}

type PlacedToken = Token & { y: number; page: number; h: number; lineId?: string };

function groupLines(tokens: PlacedToken[]): Line[] {
  tokens.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const lines: (Line & { id?: string })[] = [];
  for (const t of tokens) {
    const tol = Math.max(2.5, t.h * 0.45);
    // OCR: Tesseract's own line ids follow a slightly tilted photo; y alone would split such rows
    let line = t.lineId ? lines.find((l) => l.id === t.lineId) : lines.find((l) => l.page === t.page && Math.abs(l.y - t.y) <= tol);
    if (!line) { line = { y: t.y, page: t.page, tokens: [], id: t.lineId }; lines.push(line); }
    line.tokens.push({ text: t.text, x: t.x, w: t.w, conf: t.conf });
  }
  for (const l of lines) delete l.id;
  lines.sort((a, b) => a.page - b.page || a.y - b.y);
  for (const l of lines) l.tokens.sort((a, b) => a.x - b.x);
  return lines;
}

// ---------- PDF text layer ----------
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadPdfjs = () => require("pdfjs-dist/legacy/build/pdf.mjs");

export async function pdfLayout(data: Buffer): Promise<LayoutDoc> {
  const pdfjs = loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const tokens: (Token & { y: number; page: number; h: number })[] = [];
  let width = 595;
  for (let p = 1; p <= Math.min(doc.numPages, 50); p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    width = vp.width;
    const content = await page.getTextContent();
    for (const it of content.items as { str?: string; transform: number[]; width: number; height: number }[]) {
      if (typeof it.str !== "string" || !it.str.trim()) continue;
      // One token per word (x estimated from the run's width), so "10 Pcs" gives a number and a unit
      const parts = it.str.split(/(\s+)/);
      const perChar = it.str.length ? it.width / it.str.length : 0;
      let offset = 0;
      for (const part of parts) {
        if (part.trim()) tokens.push({ text: part.trim(), x: it.transform[4] + offset * perChar, w: part.trim().length * perChar, y: vp.height - it.transform[5], page: p, h: Math.abs(it.transform[3]) || it.height || 8 });
        offset += part.length;
      }
    }
  }
  await task.destroy();
  return { lines: groupLines(tokens), width, source: "pdf-text" };
}

// ---------- OCR (Tesseract) ----------
export async function findTool(name: string, extra: string[] = []): Promise<string | null> {
  for (const p of [process.env[`${name.toUpperCase()}_PATH`], `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`, ...extra].filter(Boolean) as string[]) {
    if (await fs.access(p).then(() => true, () => false)) return p;
  }
  return null;
}

export async function tesseractInfo(): Promise<{ path: string | null; version: string | null; languages: string[] }> {
  const bin = await findTool("tesseract");
  if (!bin) return { path: null, version: null, languages: [] };
  try {
    const v = await run(bin, ["--version"], { timeout: 10000 });
    const langs = await run(bin, ["--list-langs"], { timeout: 10000 });
    return { path: bin, version: (v.stdout || v.stderr).split("\n")[0].replace("tesseract ", "").trim(), languages: langs.stdout.split("\n").slice(1).map((s) => s.trim()).filter(Boolean) };
  } catch {
    return { path: bin, version: null, languages: [] };
  }
}

export class OcrUnavailableError extends Error {}

/** OCR of one image (PNG/JPEG buffer) into positioned lines; scale converts pixels to ~PDF points */
export async function ocrImage(image: Buffer, page: number, dpi = 300): Promise<LayoutDoc> {
  const info = await tesseractInfo();
  if (!info.path) throw new OcrUnavailableError("Tesseract OCR is not installed. Install it with: brew install tesseract");
  const langs = info.languages.includes("hin") && process.env.OCR_LANGS?.includes("hin") ? "eng+hin" : "eng";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-"));
  try {
    const img = path.join(dir, "page.png");
    await fs.writeFile(img, image);
    // psm 6 = a uniform block of text (keeps table rows together); tsv = words with boxes and confidence
    const { stdout } = await run(info.path, [img, "stdout", "-l", langs, "--psm", "6", "--dpi", String(dpi), "tsv"], { timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    // Coordinates are scaled so the page is 595 points wide (A4), whatever the photo's resolution
    const pageRow = stdout.split("\n").find((r) => r.startsWith("1\t"))?.split("\t");
    const pagePx = pageRow ? Number(pageRow[8]) : 0;
    const scale = pagePx > 0 ? 595 / pagePx : 72 / dpi;
    const tokens: PlacedToken[] = [];
    const low: string[] = [];
    for (const row of stdout.split("\n").slice(1)) {
      const c = row.split("\t");
      if (c.length < 12 || c[0] !== "5") continue; // level 5 = word
      const text = c[11]?.trim();
      const conf = Number(c[10]);
      if (!text) continue;
      const [left, top, width, height] = [Number(c[6]), Number(c[7]), Number(c[8]), Number(c[9])];
      const lineId = `${page}-${c[2]}-${c[3]}-${c[4]}`;
      for (const piece of cleanOcrWord(text, left * scale, width * scale)) tokens.push({ ...piece, y: (top + height) * scale, page, h: height * scale, conf, lineId });
      if (conf >= 0 && conf < 60 && /\d/.test(text)) low.push(text);
    }
    return { lines: groupLines(tokens), width: 595, source: "ocr", lowConfidence: low.slice(0, 50) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * OCR reads table rules and stray marks as characters stuck to words ("1)Index", "93.22]", "4Pcs").
 * Strips them and splits serial numbers and units from their neighbours; x positions are shared out
 * by character count.
 */
export function cleanOcrWord(raw: string, x: number, w: number): Token[] {
  if (/^[|[\]{}!_~—–]+$/.test(raw)) return []; // a table rule on its own
  const s = raw.replace(/^[|\[\]{}!()\/_~—–-]+(?=\S)/, (m) => (/^\(/.test(m) ? m : "")).replace(/(?<=\S)[|\[\]{}!_~—–]+$/, "").replace(/(?<=\d)[)\/]+$/, "");
  if (!s) return [];
  const per = w / Math.max(1, raw.length);
  const parts: string[] = [];
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{1,3})[)|\/\].]([A-Za-z].*)$/))) parts.push(m[1], m[2]); // "1)Index" → "1" "Index"
  else if ((m = s.match(/^(\d+(?:\.\d+)?)(pcs|pc|nos|pkt|box|kg|kgs|ltr|mtr|set|doz|ream|roll)$/i))) parts.push(m[1], m[2]); // "4Pcs"
  else if ((m = s.match(/^(\d[\d,]*\.\d{2})[|\/\]}]([A-Za-z]+)$/))) parts.push(m[1], m[2]); // "55.08|Pcs"
  else parts.push(s);
  let cx = x + Math.max(0, raw.indexOf(parts[0][0])) * per;
  return parts.map((p) => {
    const tok = { text: p, x: cx, w: p.length * per };
    cx += (p.length + 1) * per;
    return tok;
  });
}

/** Renders PDF pages to PNG for OCR (poppler's pdftoppm; macOS sips as a one-page fallback) */
export async function renderPdfPages(data: Buffer, maxPages = 10): Promise<Buffer[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdfpages-"));
  try {
    const src = path.join(dir, "in.pdf");
    await fs.writeFile(src, data);
    const pdftoppm = await findTool("pdftoppm");
    if (pdftoppm) {
      await run(pdftoppm, ["-r", "300", "-png", "-l", String(maxPages), src, path.join(dir, "p")], { timeout: 180000 });
      const files = (await fs.readdir(dir)).filter((f) => /^p-\d+\.png$/.test(f)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
      return Promise.all(files.map((f) => fs.readFile(path.join(dir, f))));
    }
    if (process.platform === "darwin") {
      const out = path.join(dir, "p.png");
      await run("sips", ["-s", "format", "png", "-s", "dpiWidth", "300", "-s", "dpiHeight", "300", src, "--out", out], { timeout: 60000 });
      return [await fs.readFile(out)];
    }
    throw new OcrUnavailableError("Rendering scanned PDF pages needs poppler. Install it with: brew install poppler");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
