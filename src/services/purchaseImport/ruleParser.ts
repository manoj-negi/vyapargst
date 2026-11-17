import type { ExtractedBill, ExtractedItem } from "./schema";
import type { LayoutDoc, Line, Token } from "./layout";

/**
 * Local, deterministic reading of a bill from its page layout (PDF text layer or OCR). It looks for
 * the usual parts of Indian GST invoices (seller block with GSTIN, "Invoice No." / "Dated", the item
 * table under a header row, tax lines, round-off, total). It never fills a value it did not find:
 * missing values stay null, and doubtful ones are listed as uncertain. Works for many layouts, not all;
 * the review screen is where the rest is corrected.
 */

const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
const MONEY = /^\(?[-−]?\s*₹?\s*\d{1,3}(?:,\d{2,3})*(?:\.\d{1,3})?\)?$|^\(?[-−]?₹?\d+(?:\.\d{1,3})?\)?$/;
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

export interface ParseReport {
  rowsFound: number;
  header: { supplier: boolean; gstin: boolean; invoiceNo: boolean; invoiceDate: boolean; total: boolean };
  itemsSum: number | null;
  subtotal: number | null;
  reconciled: boolean;
  notes: string[];
}

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** GSTIN check character (15th) from the first 14 */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}
const TO_DIGIT: Record<string, string> = { O: "0", D: "0", Q: "0", I: "1", L: "1", "|": "1", S: "5", B: "8", Z: "2", G: "6", T: "7" };
const TO_LETTER: Record<string, string> = { "0": "O", "1": "I", "5": "S", "8": "B", "2": "Z", "6": "G", "7": "T", "4": "A" };
/**
 * OCR often swaps O/0, I/1, S/5 in a GSTIN. Positions are fixed (2 digits, 5 letters, 4 digits, letter,
 * entity code, Z, check), so swaps are undone by position; the result is kept only if its check character
 * is right — never a guess.
 */
export function repairGstin(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^0-9A-Z|]/g, "");
  if (s.length !== 15) return null;
  const c = s.split("");
  for (const i of [0, 1, 7, 8, 9, 10]) c[i] = TO_DIGIT[c[i]] ?? c[i];
  for (const i of [2, 3, 4, 5, 6, 11]) c[i] = TO_LETTER[c[i]] ?? c[i];
  if (c[13] === "2") c[13] = "Z";
  if (c[12] === "|") c[12] = "1";
  const base = c.slice(0, 14).join("");
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z$/.test(base)) return null;
  const check = gstinCheckChar(base);
  const last = c[14] === "|" ? "1" : c[14];
  // The check character itself may be misread (0/O, 1/I…): accept it when it is one of those look-alikes
  const alike = [last, TO_DIGIT[last], TO_LETTER[last]].filter(Boolean);
  return alike.includes(check) ? base + check : null;
}

const text = (l: Line) => l.tokens.map((t) => t.text).join(" ");
const isNum = (s: string) => MONEY.test(s.replace(/\s/g, ""));
export function money(s: string | null | undefined): number | null {
  if (!s) return null;
  const neg = /^\(|^[-−]|\(-\)/.test(s.trim());
  const m = s.replace(/[,₹\s]/g, "").match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

export function parseDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  let d: number, m: number, y: number;
  let r = t.match(/^(\d{1,2})[-./ ](\d{1,2})[-./ ](\d{2,4})$/);
  if (r) { d = +r[1]; m = +r[2]; y = +r[3]; }
  else if ((r = t.match(/^(\d{1,2})[-./ ]?([A-Za-z]{3,9})[-./ ,]*'?(\d{2,4})$/))) { d = +r[1]; m = MONTHS[r[2].toLowerCase().slice(0, r[2].toLowerCase().startsWith("sept") ? 4 : 3)]; y = +r[3]; }
  else if ((r = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else return null;
  if (!m || m > 12 || d < 1 || d > 31) return null;
  if (y < 100) y += 2000;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Value for a label: after it on the same line, or in the line(s) below under the label */
function labelValue(doc: LayoutDoc, label: RegExp, valueTest: (s: string) => boolean, maxBelow = 2): string | null {
  for (let i = 0; i < doc.lines.length; i++) {
    const l = doc.lines[i];
    for (let k = 0; k < l.tokens.length; k++) {
      // Labels can span tokens ("Invoice" "No.")
      const joined = l.tokens.slice(k, k + 3).map((t) => t.text).join(" ");
      const m = joined.match(label);
      if (!m || m.index !== 0) continue;
      const labelTok = l.tokens[k];
      // Same line: rest of the joined text, or the next tokens after ":"
      const after = joined.slice(m[0].length).replace(/^\s*[:.\-#]?\s*/, "");
      const used = Math.ceil(m[0].split(" ").length);
      const restTokens = l.tokens.slice(k + used).map((t) => t.text).filter((s) => s !== ":");
      for (const cand of [after.split(/\s{2,}/)[0], restTokens[0], restTokens.slice(0, 2).join(" ")]) {
        if (cand && valueTest(cand.replace(/^[:\s]+/, ""))) return cand.replace(/^[:\s]+/, "").trim();
      }
      // Below: the token closest under the label's start
      for (let j = i + 1; j <= Math.min(i + maxBelow, doc.lines.length - 1); j++) {
        const below = doc.lines[j].tokens.filter((t) => Math.abs(t.x - labelTok.x) < 30);
        for (const b of below) if (valueTest(b.text)) return b.text;
        const pair = below.length ? doc.lines[j].tokens.slice(doc.lines[j].tokens.indexOf(below[0]), doc.lines[j].tokens.indexOf(below[0]) + 3).map((t) => t.text).join(" ") : "";
        if (pair && valueTest(pair)) return pair;
      }
    }
  }
  return null;
}

// ---------- Item table ----------
type Col = "sl" | "desc" | "hsn" | "qty" | "unit" | "rateIncl" | "rate" | "per" | "disc" | "gst" | "amount";
const HEAD: [Col, RegExp][] = [
  ["sl", /^(sl|s\.?\s?no|sr|sno|#)\.?$/i],
  ["desc", /^(description|particulars|item|items|goods|product|name)$/i],
  ["hsn", /^(hsn|sac|hsn\/sac[a-z]?|hsn\/\s?sac|hsn code)$/i],
  ["qty", /^(qty|quantity|qnty|nos)\.?$/i],
  ["unit", /^(unit|uom)$/i],
  ["rate", /^(rate|price|mrp)$/i],
  ["per", /^per$/i],
  ["disc", /^(disc|disc\.|discount|disc\.?%|dis%)$/i],
  ["gst", /^(gst|gst%|gst\s?%|tax%|igst%|tax|rate%)$/i],
  ["amount", /^(amount|amt|value|total|taxable)$/i],
];

interface Header { index: number; cols: { col: Col; x: number; end: number }[] }

function findHeader(doc: LayoutDoc): Header | null {
  let best: Header | null = null;
  let bestScore = 0;
  doc.lines.forEach((l, index) => {
    const cols: Header["cols"] = [];
    for (const t of l.tokens) {
      const word = t.text.replace(/[():[\]|]/g, "").trim();
      for (const [col, re] of HEAD) {
        if (re.test(word) && !cols.some((c) => c.col === col)) { cols.push({ col, x: t.x, end: t.x + t.w }); break; }
        // "Description of Goods" etc. come as one token
        if (col === "desc" && /^(description|particulars)/i.test(word) && !cols.some((c) => c.col === "desc")) { cols.push({ col, x: t.x, end: t.x + t.w }); break; }
      }
    }
    // A second "Rate" marked "Incl. of Tax" (next line) means the first rate includes tax
    const next = doc.lines[index + 1];
    if (next && /incl/i.test(text(next))) {
      const rates = l.tokens.filter((t) => /^(rate|price)$/i.test(t.text.trim()));
      if (rates.length >= 2) {
        const inclTok = next.tokens.find((t) => /incl/i.test(t.text));
        const incl = rates.reduce((a, b) => (Math.abs(a.x - (inclTok?.x ?? 0)) < Math.abs(b.x - (inclTok?.x ?? 0)) ? a : b));
        const other = rates.find((r) => r !== incl)!;
        const keep = cols.filter((c) => c.col !== "rate");
        cols.length = 0;
        cols.push(...keep, { col: "rateIncl", x: incl.x, end: incl.x + incl.w }, { col: "rate", x: other.x, end: other.x + other.w });
      }
    }
    // Some bills (or OCR) put the header words on two or three lines: take the missing columns from the
    // header-only lines just below
    let last = index;
    const coreScore = () => { const k = new Set(cols.map((c) => c.col)); return (k.has("desc") ? 2 : 0) + (k.has("qty") ? 1 : 0) + (k.has("rate") || k.has("rateIncl") ? 1 : 0) + (k.has("amount") ? 1 : 0); };
    if (cols.some((c) => c.col === "desc") && coreScore() < 4) {
      for (let j = index + 1; j <= index + 2 && j < doc.lines.length; j++) {
        const lj = doc.lines[j];
        if (lj.tokens.some((t) => isNum(t.text) && /\d{2,}/.test(t.text)) || /incl|\(/i.test(text(lj))) break;
        let added = false;
        for (const t of lj.tokens) {
          const word = t.text.replace(/[():[\]|]/g, "").trim();
          for (const [col, re] of HEAD) if (col !== "desc" && re.test(word) && !cols.some((c) => c.col === col)) { cols.push({ col, x: t.x, end: t.x + t.w }); added = true; break; }
        }
        if (added) last = j;
      }
    }
    const kinds = new Set(cols.map((c) => c.col));
    const score = (kinds.has("desc") ? 2 : 0) + (kinds.has("qty") ? 1 : 0) + (kinds.has("rate") || kinds.has("rateIncl") ? 1 : 0) + (kinds.has("amount") ? 1 : 0) + (kinds.has("hsn") ? 1 : 0);
    if (score >= 4 && score > bestScore) { bestScore = score; best = { index: last, cols: cols.sort((a, b) => a.x - b.x) }; }
  });
  return best;
}

/** Column of a token: the header column whose span is nearest its centre; numbers lean to right-aligned headers */
function colOf(h: Header, t: Token): Col {
  const c = t.x + t.w / 2;
  let best = h.cols[0];
  let dist = Infinity;
  for (const col of h.cols) {
    const centre = (col.x + col.end) / 2;
    // Numeric columns are usually right-aligned under their header
    const d = isNum(t.text) ? Math.min(Math.abs(c - centre), Math.abs(t.x + t.w - col.end)) : Math.abs(c - centre);
    if (d < dist) { dist = d; best = col; }
  }
  return best.col;
}

const END_OF_TABLE = /^(total|sub ?total|grand total|taxable|cgst|sgst|igst|central tax|state tax|integrated tax|round|less|add|amount chargeable|e\.?\s?&\s?o\.?e|hsn\/sac|output|freight|cartage|packing|discount)/i;
const UNIT_WORD = /^(pcs|pc|nos|no|pkt|pkts|packet|box|boxes|bx|kg|kgs|gm|gms|g|ltr|l|ml|mtr|m|set|sets|pair|doz|dozen|ream|reams|roll|rolls|bundle|bdl|ctn|carton|bag|bags|bottle|btl|unit|units|sqft|ft)$/i;

function parseItems(doc: LayoutDoc, h: Header, notes: string[]): { items: ExtractedItem[]; endIndex: number } {
  const items: ExtractedItem[] = [];
  const has = (c: Col) => h.cols.some((x) => x.col === c);
  const descCol = h.cols.find((c) => c.col === "desc");
  let i = h.index + 1;
  if (doc.lines[i] && /incl|no\.?$|^\(/i.test(text(doc.lines[i])) && !doc.lines[i].tokens.some((t) => isNum(t.text) && /\.\d{2}$/.test(t.text))) i++;
  for (; i < doc.lines.length; i++) {
    const l = doc.lines[i];
    const t = text(l);
    const nums = l.tokens.filter((x) => isNum(x.text));
    const words = l.tokens.filter((x) => !isNum(x.text));
    const firstWord = words[0]?.text ?? "";
    if (END_OF_TABLE.test(firstWord) || (END_OF_TABLE.test(t.trim()) && nums.length <= 2)) break;
    // A line with only an amount under the amount column, after items: the subtotal
    if (items.length && !words.length && nums.length === 1) break;
    if (!nums.length) {
      // Description continuation (wrapped item name) under the description column
      if (items.length && descCol && l.tokens[0] && Math.abs(l.tokens[0].x - descCol.x) < 60 && t.length < 80) items[items.length - 1].description += " " + t.trim();
      continue;
    }
    const cells: Partial<Record<Col, string[]>> = {};
    for (const tok of l.tokens) (cells[colOf(h, tok)] ??= []).push(tok.text);
    // Description = the words left of the first numeric column (HSN/Qty…), after the serial number
    const firstDataCol = h.cols.filter((c) => !["sl", "desc"].includes(c.col)).reduce((m, c) => Math.min(m, c.x), Infinity);
    const descTokens = l.tokens.filter((tok, k) => {
      if (k === 0 && /^\d{1,3}\.?$/.test(tok.text)) return false; // serial number
      return tok.x + tok.w <= firstDataCol + 2 && !(/^\d{4,8}$/.test(tok.text) && has("hsn"));
    });
    // OCR can leave a serial number with table-rule marks in front ("10|/ Ex-Note Book")
    const description = descTokens.map((x) => x.text).join(" ").replace(/\s+/g, " ").trim().replace(/^\d{1,3}\s*[|/)\].:]+\s*(?=[A-Za-z])/, "");
    const numbersIn = (c: Col) => (cells[c] ?? []).filter(isNum);
    const amountStr = numbersIn("amount").pop() ?? (nums.length ? nums[nums.length - 1].text : null);
    let hsn: string | null = (cells.hsn ?? []).find((x) => /^\d{4,8}$/.test(x)) ?? null;
    if (!hsn) hsn = l.tokens.find((x) => /^\d{4,8}$/.test(x.text) && x.text.length >= 6)?.text ?? null;
    // Quantity: the qty column (numbers right of the description, left of the rate)
    let qtyStr: string | null = numbersIn("qty")[0] ?? null;
    let unit: string | null = (cells.qty ?? []).find((x) => UNIT_WORD.test(x)) ?? (cells.unit ?? [])[0] ?? (cells.per ?? []).find((x) => UNIT_WORD.test(x)) ?? null;
    if (!unit) unit = l.tokens.find((x) => UNIT_WORD.test(x.text))?.text ?? null;
    const rateExcl = numbersIn("rate")[0] ?? null;
    const rateIncl = numbersIn("rateIncl")[0] ?? null;
    const disc = numbersIn("disc")[0] ?? null;
    const gst = numbersIn("gst")[0] ?? null;
    if (!description || !amountStr) continue;
    if (!qtyStr) {
      // Without a qty column: the first small number that is not HSN/amount/rate
      qtyStr = nums.map((x) => x.text).find((x) => x !== hsn && x !== amountStr && x !== rateExcl && x !== rateIncl && !/^\d{4,8}$/.test(x)) ?? null;
    }
    const uncertain: string[] = [];
    let quantity = money(qtyStr);
    if (quantity !== null && hsn && qtyStr === hsn) quantity = null; // an HSN code is never the quantity
    const amount = money(amountStr);
    let rate = money(rateExcl);
    let includesTax: boolean | null = rateExcl ? false : null;
    if (rate === null && rateIncl) { rate = money(rateIncl); includesTax = true; }
    // When qty × rate does not give the amount (columns misplaced, OCR, two unlabelled rates), look for the
    // two numbers on the line that do; only numbers printed on the line are used
    let discPct: number | null = money(disc);
    if (discPct !== null && (discPct >= 100 || discPct < 0)) discPct = null;
    const fitsWith = (q: number | null, r: number | null, d: number) => q !== null && r !== null && amount !== null && Math.abs(q * r * (1 - d / 100) - amount) <= Math.max(0.05, amount * 0.002);
    const fits = (q: number | null, r: number | null) => fitsWith(q, r, discPct ?? 0);
    if (amount !== null && !fits(quantity, rate)) {
      // Every printed number except the amount token itself (a rate can equal the amount when qty is 1)
      const amountTok = nums.filter((x) => x.text === amountStr).pop();
      const cand = nums.filter((x) => x !== amountTok).map((x) => x.text).filter((x) => x !== hsn && !/^\d{5,8}$/.test(x)).map((x) => money(x)).filter((n): n is number => n !== null && n > 0);
      let found: [number, number, number | null] | null = null;
      // A "discount" that makes nothing fit is usually another column read into it (OCR): also try without it
      for (const d of discPct ? [discPct, 0] : [0]) {
        for (const q of cand) for (const r of cand) if (!found && (q !== r || cand.filter((c) => c === q).length > 1) && fitsWith(q, r, d) && (Number.isInteger(q) || !Number.isInteger(r)) && d !== r) found = [q, r, d || null];
      }
      // OCR sometimes drops the decimal point ("25200" for 25.00): accept the same digits with the point back
      // only when they make the line add up exactly, and flag the rate
      if (!found && quantity !== null) {
        for (const x of nums.filter((t) => t !== amountTok && /^\d{3,7}$/.test(t.text) && t.text !== hsn)) {
          const r = Number(x.text) / 100;
          if (fitsWith(quantity, r, 0)) { found = [quantity, r, null]; uncertain.push("rate"); break; }
        }
      }
      if (found) {
        [quantity, rate, discPct] = found;
        includesTax = false;
      }
    }
    if (rate === null && quantity && amount) {
      const printed = nums.map((x) => money(x.text)).find((n) => n !== null && n !== amount && fits(quantity, n));
      if (printed != null) { rate = printed; includesTax = false; } else { rate = round2(amount / quantity); uncertain.push("rate"); }
    }
    if (quantity === null) uncertain.push("quantity");
    // Cross-check: qty × rate × (1 − disc) should give the amount (excl. tax rate)
    if (quantity && rate !== null && amount !== null && includesTax === false && !fits(quantity, rate)) {
      const calc = quantity * rate * (1 - (discPct ?? 0) / 100);
      if (Math.abs(calc - amount) > Math.max(1, amount * 0.01)) uncertain.push("amount");
    }
    const descGst = description.match(/@?\s*(\d{1,2}(?:\.\d+)?)\s*%/);
    const exempt = /\b(exempt|nil rated|nil)\b/i.test(description);
    items.push({
      description: description.replace(/\s*@?\s*\d{1,2}(?:\.\d+)?\s*%\s*/g, " ").replace(/\b(EXEMPT|exempt)\b/g, "").replace(/\s+/g, " ").trim() || description,
      supplier_item_code: null,
      barcode: null,
      hsn_sac: hsn,
      quantity,
      free_quantity: null,
      unit,
      pack_size: null,
      rate,
      rate_includes_tax: includesTax,
      discount_percent: discPct,
      discount_amount: null,
      gst_rate: gst !== null ? money(gst) : descGst ? Number(descGst[1]) : exempt ? 0 : null,
      cgst_amount: null,
      sgst_amount: null,
      igst_amount: null,
      taxable_amount: amount,
      line_total: amount,
      uncertain_fields: uncertain,
    });
  }
  if (!items.length) notes.push("An item table header was found, but no item lines under it could be read.");
  return { items, endIndex: i };
}

/** HSN summary ("HSN/SAC … Rate 9% … Rate 9%"): GST rate per HSN, used when lines do not show it */
function hsnRates(doc: LayoutDoc, from: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const l of doc.lines.slice(from)) {
    const hsn = l.tokens.find((t) => /^\d{4,8}$/.test(t.text))?.text;
    if (!hsn) continue;
    const pcts = l.tokens.map((t) => t.text.match(/^(\d{1,2}(?:\.\d+)?)%$/)?.[1]).filter(Boolean).map(Number);
    if (!pcts.length) continue;
    // CGST + SGST shown as two rates; IGST as one
    const rate = pcts.length >= 2 ? pcts[0] + pcts[1] : pcts[0];
    if (!map.has(hsn)) map.set(hsn, rate);
  }
  return map;
}

function lastNumber(l: Line): number | null {
  const n = l.tokens.filter((t) => isNum(t.text) || /^₹/.test(t.text));
  for (let k = n.length - 1; k >= 0; k--) {
    const v = money(n[k].text);
    if (v !== null) return v;
  }
  return null;
}

export function parseBillLayout(doc: LayoutDoc, own: { gstin: string | null; name: string }): { bill: ExtractedBill; report: ParseReport } {
  const notes: string[] = [];
  const all = doc.lines.map(text);
  const fullText = all.join("\n");
  const ownGstin = (own.gstin || "").toUpperCase();

  // Supplier: GSTIN that is not ours; name from "for <NAME>" (signature) or the top of the seller block
  const gstins = Array.from(new Set(fullText.toUpperCase().match(GSTIN) ?? []));
  // OCR: 15-character words after "GSTIN" that become valid GSTINs once look-alike characters are undone
  const repaired = new Map<string, string>(); // repaired → as printed
  if (doc.source === "ocr") {
    for (const l of doc.lines) l.tokens.forEach((t, k) => {
      // One word, or two words when OCR put a space inside the GSTIN
      for (const printed of [t.text, k + 1 < l.tokens.length ? `${t.text}${l.tokens[k + 1].text}` : ""]) {
        const w = printed.toUpperCase().replace(/[^0-9A-Z|]/g, "");
        if (w.length !== 15 || gstins.includes(w)) continue;
        const g = repairGstin(w);
        if (g && !gstins.includes(g)) { gstins.push(g); repaired.set(g, printed); }
      }
    });
  }
  const supplierGstin = gstins.find((g) => g !== ownGstin) ?? null;
  const ownWords = own.name.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const looksOwn = (s: string) => ownWords.length > 0 && ownWords.every((w) => s.toLowerCase().includes(w));
  let supplierName: string | null = null;
  for (const s of all) {
    const m = s.match(/\bfor\s+([A-Z][A-Za-z0-9 &.,'()-]{2,60}?)\s*$/);
    if (m && !looksOwn(m[1]) && !/authori[sz]ed|signatory/i.test(m[1])) supplierName = m[1].trim();
  }
  const printedGstin = supplierGstin ? repaired.get(supplierGstin) ?? supplierGstin : null;
  const squash = (v: string) => v.toUpperCase().replace(/\s/g, "");
  let gstLine = printedGstin ? doc.lines.findIndex((l) => squash(text(l)).includes(squash(printedGstin))) : -1;
  let address: string | null = null;
  let phone: string | null = null;
  if (gstLine >= 0) {
    // Walk up the seller block (left part of the page) to its first line
    const left = (l: Line) => l.tokens.filter((t) => t.x < doc.width * 0.55).map((t) => t.text).join(" ").trim();
    const block: string[] = [];
    for (let j = gstLine - 1; j >= Math.max(0, gstLine - 9); j--) {
      const s = left(doc.lines[j]);
      if (!s || /^(irn|ack|tax invoice|e-?invoice|invoice|bill of supply|original|duplicate|printed on)/i.test(s) || /:\s*[0-9a-f]{20,}/i.test(s)) break;
      block.unshift(s);
    }
    const nameIdx = supplierName ? block.findIndex((b) => b.toLowerCase().includes(supplierName!.toLowerCase())) : 0;
    if (!supplierName && block.length) supplierName = block[0];
    const rest = block.slice(Math.max(0, nameIdx) + 1);
    phone = rest.map((b) => b.match(/(?:\+?91[-\s]?)?\d{3,5}[-\s]?\d{6,8}|\b\d{10}\b/)?.[0]).find(Boolean) ?? null;
    address = rest.filter((b) => !/(auth\.? dealer|dealers? in|gstin|phone|ph\.|mob|email|e-mail|@)/i.test(b) && !/^[\d\s/+-]+$/.test(b)).join(", ") || null;
  }
  let supplierGuessed = false;
  if (!supplierName) {
    // No readable GSTIN or signature: the heading at the top left (before the buyer block) is usually the seller
    for (const l of doc.lines.slice(0, 12)) {
      // First column only: words up to the first wide gap
      const first: Token[] = [];
      for (const t of l.tokens) {
        const prev = first[first.length - 1];
        if (prev && t.x - (prev.x + prev.w) > 14) break;
        first.push(t);
      }
      const s = first.filter((t) => t.x < doc.width * 0.5).map((t) => t.text).join(" ").trim();
      if (/^(buyer|bill to|ship to|consignee|details of receiver)/i.test(s)) break;
      if (s.length >= 4 && /^[A-Z][A-Z0-9 &.,'()-]+$/.test(s) && !/(tax invoice|invoice|original|duplicate|bill of supply|estimate|irn|ack)/i.test(s) && !looksOwn(s)) { supplierName = s; supplierGuessed = true; break; }
    }
  }
  const email = fullText.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] ?? null;

  const invNoLike = (s: string) => /^[A-Z0-9][A-Z0-9/\-_.]{1,30}$/i.test(s) && /\d/.test(s) && parseDate(s) === null;
  let invoiceNo = labelValue(doc, /^(invoice|inv\.?|bill)\s*(no\.?|number|#)/i, invNoLike);
  const dateStr = labelValue(doc, /^(dated|date|invoice date|bill date|inv\.? date)\b/i, (s) => parseDate(s) !== null);
  const invoiceDate = parseDate(dateStr);
  let invoiceNoGuessed = false;
  if (!invoiceNo && dateStr) {
    // Label lost (e.g. OCR next to a QR code): on Tally-style bills the number sits just left of the date
    // under "Dated". Never from IRN / Ack / order / e-way lines.
    for (const l of doc.lines) {
      const s = text(l);
      const di = l.tokens.findIndex((t) => t.text === dateStr || parseDate(t.text) === invoiceDate);
      if (di <= 0 || /\b(ack|irn|e-?way|order|challan|printed)\b/i.test(s)) continue;
      const left = l.tokens.slice(0, di).filter((t) => t.x > doc.width * 0.35 && invNoLike(t.text) && /[/-]/.test(t.text));
      if (left.length) { invoiceNo = left[left.length - 1].text; invoiceNoGuessed = true; break; }
    }
  }

  // Items
  const header = findHeader(doc);
  let items: ExtractedItem[] = [];
  let endIndex = doc.lines.length;
  if (header) ({ items, endIndex } = parseItems(doc, header, notes));
  else notes.push("No item table header (Description / Qty / Rate / Amount) was found.");

  // Taxes, round-off, charges and totals after the items
  let subtotal: number | null = null;
  let cgst: number | null = null, sgst: number | null = null, igst: number | null = null, roundOff: number | null = null, grand: number | null = null, charges: number | null = null, invDisc: number | null = null;
  const tailAll = doc.lines.slice(endIndex);
  // The amount-in-words line and the HSN summary end the totals block
  const stop = tailAll.findIndex((l) => /amount chargeable|in words|hsn\s?[/i]\s?sac/i.test(text(l)));
  const tail = stop >= 0 ? tailAll.slice(0, stop) : tailAll;
  const unlabelled: number[] = [];
  for (const [k, l] of tail.entries()) {
    const s = text(l);
    const v = lastNumber(l);
    if (v === null) continue;
    if (k === 0 && /^[\d,.\s₹]+$/.test(s.trim())) { subtotal = v; continue; }
    if (/(central tax|\bcgst\b)/i.test(s) && cgst === null) cgst = v;
    else if (/(state tax|\bsgst\b|utgst)/i.test(s) && sgst === null) sgst = v;
    else if (/(integrated tax|\bigst\b)/i.test(s) && igst === null) igst = v;
    else if (/round\s*off|rounding/i.test(s)) roundOff = /\(-\)|less|-\s*\d/i.test(s.replace(/\(\+\/-\)/, "")) && !/\(\+\/-\)/.test(s) ? -Math.abs(v) : v;
    else if (/(freight|cartage|packing|forwarding|delivery|transport|loading)/i.test(s)) charges = (charges ?? 0) + v;
    else if (/(less|discount)/i.test(s)) invDisc = Math.abs(v);
    else if (/\b(grand\s+)?total\b/i.test(s)) grand = v;
    else if (/^(sub ?total|taxable)/i.test(s)) subtotal = v;
    else if (k > 0) unlabelled.push(v);
  }
  const itemsTotal = items.length ? round2(items.reduce((s2, it) => s2 + (it.taxable_amount ?? 0), 0)) : null;
  const expectedGrand = (base: number | null) => (base === null ? null : round2(base + (cgst ?? 0) + (sgst ?? 0) + (igst ?? 0) + (roundOff ?? 0) + (charges ?? 0) - (invDisc ?? 0)));
  let grandGuessed = false;
  if (grand === null && unlabelled.length) {
    // Label unreadable ("Total" read as "OM"): a printed number that equals items + taxes + round-off is the total
    const exp = [expectedGrand(itemsTotal), expectedGrand(subtotal)].filter((n): n is number => n !== null);
    const match = unlabelled.find((v) => exp.some((e) => Math.abs(v - e) <= 1));
    if (match !== undefined) grand = match;
    else { grand = Math.max(...unlabelled); grandGuessed = true; }
  }
  if (grand === null) {
    const tot = doc.lines.slice(0, endIndex + tail.length).filter((l) => /\b(grand\s+total|total amount|net amount|invoice total|total)\b/i.test(text(l)) && lastNumber(l) !== null);
    if (tot.length) grand = lastNumber(tot.reduce((a, b) => ((lastNumber(a) ?? 0) >= (lastNumber(b) ?? 0) ? a : b)));
  }
  // OCR misread of the printed subtotal while lines + taxes still give the printed total: trust the arithmetic, say so
  if (subtotal !== null && itemsTotal !== null && Math.abs(subtotal - itemsTotal) > 1 && grand !== null && Math.abs((expectedGrand(itemsTotal) ?? 0) - grand) <= 1) {
    notes.push(`The printed subtotal was read as ${subtotal.toFixed(2)}, but the item lines (${itemsTotal.toFixed(2)}) plus taxes give the printed total ${grand.toFixed(2)}; the subtotal was probably misread.`);
    subtotal = null;
  }
  if (grandGuessed) notes.push("The total's label was not readable; check the grand total.");

  // GST rates per line from the HSN summary when the lines do not show them
  const rates = hsnRates(doc, endIndex);
  for (const it of items) if (it.gst_rate === null && it.hsn_sac && rates.has(it.hsn_sac)) it.gst_rate = rates.get(it.hsn_sac)!;
  for (const it of items) if (it.gst_rate === null) it.uncertain_fields.push("gst_rate");

  const itemsSum = itemsTotal;
  const reconciled = itemsSum !== null && ((subtotal !== null && Math.abs(itemsSum - subtotal) <= 1) || (grand !== null && !grandGuessed && Math.abs((expectedGrand(itemsSum) ?? 0) - grand) <= 1));
  if (items.length && !reconciled) notes.push("The item amounts do not add up to the bill's subtotal/total; some lines may be missing or misread.");
  if (doc.source === "ocr" && doc.lowConfidence?.length) notes.push(`OCR was unsure about some numbers (e.g. ${doc.lowConfidence.slice(0, 5).join(", ")}); check them against the document.`);

  const uncertain: string[] = [];
  if (!supplierName || supplierGuessed) uncertain.push("supplier name");
  if (!invoiceNo || invoiceNoGuessed) uncertain.push("invoice number");
  if (supplierGstin && repaired.has(supplierGstin)) notes.push(`Supplier GSTIN read by OCR as "${repaired.get(supplierGstin)}" and corrected to ${supplierGstin} (its check digit is valid); compare with the bill.`);
  if (invoiceNoGuessed) notes.push("The invoice number label was not readable; the number next to the date was used — check it.");
  if (!invoiceDate) uncertain.push("invoice date");
  if (grand === null || grandGuessed) uncertain.push("grand total");

  const bill: ExtractedBill = {
    document_kind: /quotation|proforma/i.test(fullText.slice(0, 400)) ? "quotation" : /price\s?list/i.test(fullText.slice(0, 400)) ? "price_list" : "invoice",
    supplier: { name: supplierName, address, gstin: supplierGstin, phone, email },
    invoice_number: invoiceNo,
    invoice_date: invoiceDate,
    due_date: null,
    payment_terms: null,
    amount_paid_stated: null,
    items,
    invoice_discount_amount: invDisc,
    delivery_charges: charges,
    other_charges: null,
    charges_gst_rate: null,
    round_off: roundOff,
    taxable_total: subtotal,
    cgst_total: cgst,
    sgst_total: sgst,
    igst_total: igst,
    grand_total: grand,
    uncertain_fields: uncertain,
    review_notes: notes,
  };
  return {
    bill,
    report: { rowsFound: items.length, header: { supplier: !!supplierName, gstin: !!supplierGstin, invoiceNo: !!invoiceNo, invoiceDate: !!invoiceDate, total: grand !== null }, itemsSum, subtotal, reconciled, notes },
  };
}
