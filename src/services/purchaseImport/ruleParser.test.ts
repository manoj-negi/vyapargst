import { describe, expect, it } from "vitest";
import type { LayoutDoc } from "./layout";
import { cleanOcrWord } from "./layout";
import { groundInText } from "./localAi";
import { gstinCheckChar, parseBillLayout, parseDate, repairGstin } from "./ruleParser";
import type { ExtractedBill } from "./schema";

/** Builds a layout from monospaced text: each word's x is its column × 4.5 points (as layoutText writes it) */
function layout(src: string, source: LayoutDoc["source"] = "pdf-text"): LayoutDoc {
  const lines = src.split("\n").map((line, i) => {
    const tokens = Array.from(line.matchAll(/\S+/g)).map((m) => ({ text: m[0], x: m.index! * 4.5, w: m[0].length * 4.5 }));
    return { y: i * 12, page: 1, tokens };
  });
  return { lines: lines.filter((l) => l.tokens.length), width: 595, source };
}

const OWN = { gstin: "05AVYPN6961A1Z7", name: "THE CITY CART" };

// Shape of a Tally e-invoice (as in a real supplier bill), with the item table and totals block
const TALLY = `
                                 Tax Invoice
  SEHGAL ENTERPRISES                         Invoice No.          Dated
  Shop No. 2 & 3, Durga Mandir Complex       26-27/2626           4-Nov-26
  103, Dhamawala Mohalla, Dehradun
  0135-2652661
  GSTIN/UIN: 05ASNPS0578E1ZI
  Buyer (Bill to)
  The City Cart
  GSTIN/UIN : 05AVYPN6961A1Z7
  Sl  Description of Goods        HSN/SAC   Quantity   Rate     Rate   per   Disc. %     Amount
                                                     (Incl. of Tax)
  1   Index File @ 18%            48203000   10 Pcs    110.00   93.22  Pcs                932.20
  2   Ex-Note Book EXEMPT         48202000   10 Pcs    154.10  154.10  Pcs              1,541.00
  3   Bill Book 100 Page          482010      1 Pcs     48.00   40.68  Pcs                 40.68
                                                                                     2,513.88
                         Central Tax - CGST                                             91.54
                         State Tax - SGST                                               91.54
                         Round Off (+/-)                                                 0.04
                         Total                                    21 Pcs            2,697.00
  Amount Chargeable (in words)
  HSN/SAC        Taxable    Rate   Amount   Rate   Amount   Total
  482010           40.68      9%     3.66     9%     3.66    7.32
                                                for SEHGAL ENTERPRISES`;

describe("local bill parser", () => {
  it("reads supplier, invoice, every item and the totals of a Tally invoice", () => {
    const { bill, report } = parseBillLayout(layout(TALLY), OWN);
    expect(bill.supplier.name).toBe("SEHGAL ENTERPRISES");
    expect(bill.supplier.gstin).toBe("05ASNPS0578E1ZI"); // not the buyer's own GSTIN
    expect(bill.supplier.phone).toBe("0135-2652661");
    expect(bill.invoice_number).toBe("26-27/2626");
    expect(bill.invoice_date).toBe("2026-11-04");
    expect(bill.items.map((i) => [i.description, i.hsn_sac, i.quantity, i.unit, i.rate, i.gst_rate, i.taxable_amount])).toEqual([
      ["Index File", "48203000", 10, "Pcs", 93.22, 18, 932.2],
      ["Ex-Note Book", "48202000", 10, "Pcs", 154.1, 0, 1541],
      ["Bill Book 100 Page", "482010", 1, "Pcs", 40.68, 9 + 9, 40.68],
    ]);
    expect(bill.items.every((i) => i.rate_includes_tax === false)).toBe(true);
    expect(bill.round_off).toBe(0.04);
    expect(bill.grand_total).toBe(2697); // not the HSN summary's total
    expect(report.reconciled).toBe(true);
  });

  it("finds no rows (and says so) instead of inventing them", () => {
    const { bill, report } = parseBillLayout(layout("Some letter\nwith no table at all\nThanks"), OWN);
    expect(bill.items).toEqual([]);
    expect(report.rowsFound).toBe(0);
    expect(report.notes.join(" ")).toMatch(/No item table header/);
    expect(bill.grand_total).toBeNull();
  });

  it("uses the arithmetic of the line when OCR puts a column in the wrong place", () => {
    // "per" header missing, so the unit/rate drift under "Disc. %"; qty × rate must still give the amount
    const doc = layout(`
  Sl  Description of Goods        HSN/SAC   Quantity   Rate     Rate      Disc. %   Amount
  1   L Folder                    392690     30 pkt     70.00    59.32       pkt   1,779.60
                                                                                   1,779.60`, "ocr");
    const { bill } = parseBillLayout(doc, OWN);
    expect(bill.items[0]).toMatchObject({ quantity: 30, rate: 59.32, discount_percent: null, taxable_amount: 1779.6 });
    expect(bill.items[0].uncertain_fields).not.toContain("amount");
  });
});

describe("GSTIN check and OCR repair", () => {
  it("computes the check character", () => {
    expect(gstinCheckChar("05ASNPS0578E1Z")).toBe("I");
    expect(gstinCheckChar("05AVYPN6961A1Z")).toBe("7");
  });
  it("undoes look-alike OCR swaps only when the check character confirms it", () => {
    expect(repairGstin("OSASNPSO578E1Z1")).toBe("05ASNPS0578E1ZI");
    expect(repairGstin("O5AVYPN6961A1Z7")).toBe("05AVYPN6961A1Z7");
    expect(repairGstin("05ASNPS0578E1Z9")).toBeNull(); // wrong check character: not "fixed" by guessing
    expect(repairGstin("12345")).toBeNull();
  });
});

describe("OCR word clean-up", () => {
  it("drops table-rule marks and splits serials and units", () => {
    expect(cleanOcrWord("1)Index", 0, 35).map((t) => t.text)).toEqual(["1", "Index"]);
    expect(cleanOcrWord("93.22]", 0, 30).map((t) => t.text)).toEqual(["93.22"]);
    expect(cleanOcrWord("48203000!", 0, 45).map((t) => t.text)).toEqual(["48203000"]);
    expect(cleanOcrWord("4Pcs", 0, 20).map((t) => t.text)).toEqual(["4", "Pcs"]);
    expect(cleanOcrWord("55.08|Pcs", 0, 45).map((t) => t.text)).toEqual(["55.08", "Pcs"]);
    expect(cleanOcrWord("|", 0, 5)).toEqual([]);
  });
});

describe("dates", () => {
  it("reads Indian bill dates", () => {
    expect(parseDate("4-Nov-26")).toBe("2026-11-04");
    expect(parseDate("04/11/2026")).toBe("2026-11-04");
    expect(parseDate("2026-11-04")).toBe("2026-11-04");
    expect(parseDate("31/13/2026")).toBeNull();
  });
});

describe("local AI answers are checked against the document", () => {
  const text = `Ack No. : 132629698708269\nInvoice No. 26-27/2626\nIndex File 48203000 10 Pcs 93.22 932.20\nTotal 9,891.00`;
  const item = (description: string, rate: number, line_total: number) => ({
    description, supplier_item_code: null, barcode: null, hsn_sac: "48203000", quantity: 10, free_quantity: null, unit: "Pcs", pack_size: null,
    rate, rate_includes_tax: false, discount_percent: null, discount_amount: null, gst_rate: null, cgst_amount: null, sgst_amount: null, igst_amount: null,
    taxable_amount: line_total, line_total, uncertain_fields: [],
  });
  const bill = (invoice_number: string, items: ExtractedBill["items"], grand_total: number): ExtractedBill => ({
    document_kind: "invoice", supplier: { name: "X", address: null, gstin: "05ASNPS0578E1ZI", phone: null, email: null }, invoice_number, invoice_date: null, due_date: null,
    payment_terms: null, amount_paid_stated: null, items, invoice_discount_amount: null, delivery_charges: null, other_charges: null, charges_gst_rate: null, round_off: null,
    taxable_total: null, cgst_total: null, sgst_total: null, igst_total: null, grand_total, uncertain_fields: [], review_notes: [],
  });

  it("keeps printed values", () => {
    const out = groundInText(bill("26-27/2626", [item("Index File", 93.22, 932.2)], 9891), text);
    expect(out.invoice_number).toBe("26-27/2626");
    expect(out.items[0]).toMatchObject({ rate: 93.22, line_total: 932.2 });
    expect(out.grand_total).toBe(9891);
  });
  it("removes numbers that are not on the bill, the Ack number as invoice number, and invented rows", () => {
    const out = groundInText(bill("132629698708269", [item("Index File", 95, 950), item("Gel Pen Blue", 10, 100)], 9999), text);
    expect(out.invoice_number).toBeNull();
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ rate: null, line_total: null });
    expect(out.items[0].uncertain_fields).toEqual(expect.arrayContaining(["rate", "line_total"]));
    expect(out.grand_total).toBeNull();
    expect(out.supplier.gstin).toBeNull(); // GSTIN not printed in this text
  });
  it("drops dates that are not printed and flags lines whose qty × rate is not their amount", () => {
    const dated = `Dated 4-Nov-26\n${text}`;
    const ok = groundInText({ ...bill("26-27/2626", [item("Index File", 93.22, 932.2)], 9891), invoice_date: "2026-11-04" }, dated);
    expect(ok.invoice_date).toBe("2026-11-04");
    expect(ok.items[0].uncertain_fields).toEqual([]);
    const bad = groundInText({ ...bill("26-27/2626", [item("Index File", 10, 932.2)], 9891), invoice_date: "2022-11-04" }, dated);
    expect(bad.invoice_date).toBeNull();
    expect(bad.items[0].uncertain_fields).toEqual(expect.arrayContaining(["quantity", "rate", "line_total"]));
  });
});
