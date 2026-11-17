import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { toDecimal } from "../lib/decimal";
import { cancelDocument, saveDocument, type ActionContext, type DocumentInput, type DocumentLineInput } from "./documents/documentService";
import { cancelVoucher, createVoucher } from "./payments/paymentService";
import { partyBalances, partyStatement } from "./parties/ledger";
import { createExpense } from "./expenses/expenseService";
import { cashBankReport, gstSummaryReport, salesReport } from "./reports/reports";
import { buildInvoiceViewModel } from "./invoice/invoiceView";

// Every test gets its own business, so tests never see each other's data.
async function setup(policy: "PREVENT" | "ALLOW_WITH_WARNING" = "ALLOW_WITH_WARNING") {
  const user = await prisma.user.create({ data: { email: `t-${crypto.randomUUID()}@test.local`, passwordHash: "x", name: "Tester" } });
  const business = await prisma.business.create({
    data: { ownerId: user.id, name: "Test Traders", state: "Uttarakhand", gstin: "05ABCDE1234F1Z5", settings: { create: { negativeStockPolicy: policy } } },
    include: { settings: true },
  });
  const [gst12, gst18] = await Promise.all(
    [12, 18].map((rate) =>
      prisma.taxMaster.create({ data: { businessId: business.id, name: `GST ${rate}%`, rate, cgstRate: rate / 2, sgstRate: rate / 2, igstRate: rate } })
    )
  );
  const pen = await prisma.product.create({
    data: { businessId: business.id, name: "Pen", hsnCode: "9608", salePrice: 100, purchasePrice: 60, taxId: gst18.id, openingStock: 50, currentStock: 50 },
  });
  const book = await prisma.product.create({
    data: { businessId: business.id, name: "Notebook", hsnCode: "4820", salePrice: 112, priceType: "INCLUSIVE", purchasePrice: 70, taxId: gst12.id, openingStock: 20, currentStock: 20 },
  });
  const customer = await prisma.customer.create({ data: { businessId: business.id, name: "Local Customer", state: "Uttarakhand" } });
  const outstation = await prisma.customer.create({ data: { businessId: business.id, name: "Delhi Customer", state: "Delhi", openingBalance: 500 } });
  const supplier = await prisma.customer.create({ data: { businessId: business.id, name: "Supplier Co", state: "Uttarakhand", partyType: "SUPPLIER", openingBalance: -1000 } });
  const ctx: ActionContext = { business, userId: user.id };
  return { ctx, business, pen, book, customer, outstation, supplier, gst18 };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

const line = (product: { id: string; name: string }, quantity: number, unitPrice: number, over: Partial<DocumentLineInput> = {}): DocumentLineInput => ({
  productId: product.id,
  productName: product.name,
  quantity,
  unitPrice,
  priceType: "EXCLUSIVE",
  discountValue: 0,
  discountType: "PERCENTAGE",
  gstRate: 0, // ignored for catalog items: the rate comes from the product master
  ...over,
});

const stockOf = async (id: string) => toDecimal((await prisma.product.findUniqueOrThrow({ where: { id } })).currentStock).toNumber();
const docOf = (id: string) => prisma.saleInvoice.findUniqueOrThrow({ where: { id } });
const money = (v: unknown) => toDecimal(v as string).toFixed(2);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("sale invoices", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await setup();
  });

  it("saves totals, stock, payment and party balance together", async () => {
    const input: DocumentInput = {
      partyId: f.customer.id,
      items: [line(f.pen, 3, 100), line(f.book, 2, 112, { priceType: "INCLUSIVE" })],
      paidNowAmount: 200,
      paidNowMode: "UPI",
    };
    const { document } = await saveDocument(f.ctx, "SALE_INVOICE", input);

    // Pen: 300 + 18% = 354 (CGST/SGST 27 each). Notebook: 224 inclusive of 12% -> taxable 200, tax 24.
    expect(document.invoiceNo).toBe("INV-0001");
    expect(money(document.taxableAmount)).toBe("500.00");
    expect(money(document.cgst)).toBe("39.00");
    expect(money(document.sgst)).toBe("39.00");
    expect(money(document.total)).toBe("578.00");
    expect(money(document.receivedAmount)).toBe("200.00");
    expect(money(document.balance)).toBe("378.00");
    expect(document.paymentStatus).toBe("PARTIALLY_PAID");

    expect(await stockOf(f.pen.id)).toBe(47);
    expect(await stockOf(f.book.id)).toBe(18);

    const vouchers = await prisma.paymentVoucher.findMany({ where: { businessId: f.business.id } });
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0].mode).toBe("UPI");

    const balance = (await partyBalances(f.business.id)).get(f.customer.id)!;
    expect(balance.toFixed(2)).toBe("378.00");
  });

  it("uses IGST for an inter-state customer", async () => {
    const { document } = await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.outstation.id, items: [line(f.pen, 1, 100)] });
    expect(document.taxType).toBe("INTER_STATE");
    expect(money(document.igst)).toBe("18.00");
    expect(money(document.cgst)).toBe("0.00");
  });

  it("does not create a second invoice when the same form is submitted twice", async () => {
    const input: DocumentInput = { partyId: f.customer.id, items: [line(f.pen, 2, 100)], paidNowAmount: 236, clientToken: crypto.randomUUID() };
    const [a, b] = await Promise.all([saveDocument(f.ctx, "SALE_INVOICE", input), saveDocument(f.ctx, "SALE_INVOICE", input)]);
    expect(a.document.id).toBe(b.document.id);
    expect([a.duplicate, b.duplicate].filter(Boolean)).toHaveLength(1);
    expect(await prisma.saleInvoice.count({ where: { businessId: f.business.id } })).toBe(1);
    expect(await prisma.paymentVoucher.count({ where: { businessId: f.business.id } })).toBe(1);
    expect(await stockOf(f.pen.id)).toBe(48);
  });

  it("gives concurrent invoices consecutive unique numbers and exact stock", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 1, 100)] }))
    );
    const numbers = results.map((r) => r.document.invoiceNo).sort();
    expect(numbers).toEqual(["INV-0001", "INV-0002", "INV-0003", "INV-0004", "INV-0005", "INV-0006"]);
    expect(await stockOf(f.pen.id)).toBe(44);
  });

  it("editing reverses the old stock and applies the new quantities", async () => {
    const { document } = await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 5, 100), line(f.book, 1, 112)] });
    expect(await stockOf(f.pen.id)).toBe(45);

    await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 2, 100)] }, document.id);
    expect(await stockOf(f.pen.id)).toBe(48);
    expect(await stockOf(f.book.id)).toBe(20);

    const net = await prisma.stockTransaction.groupBy({ by: ["productId"], where: { referenceInvoiceId: document.id }, _sum: { quantity: true } });
    const byProduct = Object.fromEntries(net.map((n) => [n.productId, toDecimal(n._sum.quantity).toNumber()]));
    expect(byProduct[f.pen.id]).toBe(-2);
    expect(byProduct[f.book.id]).toBe(0);
    expect((await docOf(document.id)).invoiceNo).toBe("INV-0001");
  });

  it("refuses an edit that makes the total smaller than what was already paid, and changes nothing", async () => {
    const { document } = await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 5, 100)], paidNowAmount: 590 });
    await expect(saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 1, 100)] }, document.id)).rejects.toThrow(/exceed its total/);
    const after = await docOf(document.id);
    expect(money(after.total)).toBe("590.00");
    expect(await stockOf(f.pen.id)).toBe(45);
    expect(await prisma.saleInvoiceItem.count({ where: { invoiceId: document.id } })).toBe(1);
  });

  it("keeps the original tax rate and price type on lines that were already on the invoice", async () => {
    const { document } = await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 1, 100)] });
    const gst12 = await prisma.taxMaster.findFirstOrThrow({ where: { businessId: f.business.id, rate: 12 } });
    await prisma.product.update({ where: { id: f.pen.id }, data: { taxId: gst12.id, salePrice: 999, priceType: "INCLUSIVE" } });

    const view = await buildInvoiceViewModel(document.id, f.business.id);
    expect(money(view.invoice.total)).toBe("118.00");
    expect(Number(view.items[0].taxRate)).toBe(18);

    const { document: edited } = await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 2, 100)] }, document.id);
    expect(money(edited.total)).toBe("236.00"); // still 18%, still exclusive
  });

  it("keeps the business and party details the invoice was issued with", async () => {
    const { document } = await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 1, 100)] });
    await prisma.business.update({ where: { id: f.business.id }, data: { name: "Renamed Traders", gstin: "05ZZZZZ9999Z1Z5" } });
    const view = await buildInvoiceViewModel(document.id, f.business.id);
    expect(view.business.name).toBe("Test Traders");
    expect(view.business.gstin).toBe("05ABCDE1234F1Z5");
  });

  it("rolls back everything when stock would go negative under the PREVENT policy", async () => {
    const g = await setup("PREVENT");
    await expect(saveDocument(g.ctx, "SALE_INVOICE", { partyId: g.customer.id, items: [line(g.pen, 51, 100)], paidNowAmount: 10 })).rejects.toThrow(/Insufficient stock/);
    expect(await prisma.saleInvoice.count({ where: { businessId: g.business.id } })).toBe(0);
    expect(await prisma.paymentVoucher.count({ where: { businessId: g.business.id } })).toBe(0);
    expect(await stockOf(g.pen.id)).toBe(50);
    // The number was not consumed either
    const { document } = await saveDocument(g.ctx, "SALE_INVOICE", { partyId: g.customer.id, items: [line(g.pen, 1, 100)] });
    expect(document.invoiceNo).toBe("INV-0001");
  });

  it("cancels only after payments are cancelled, reverses stock once, and refuses a second cancel", async () => {
    const { document } = await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 4, 100)], paidNowAmount: 100 });
    await expect(cancelDocument(f.ctx, "SALE_INVOICE", document.id, "mistake")).rejects.toThrow(/payments recorded/);

    const voucher = await prisma.paymentVoucher.findFirstOrThrow({ where: { businessId: f.business.id } });
    await cancelVoucher(f.ctx, voucher.id, "wrong entry");
    expect(money((await docOf(document.id)).balance)).toBe("472.00");

    await cancelDocument(f.ctx, "SALE_INVOICE", document.id, "mistake");
    expect(await stockOf(f.pen.id)).toBe(50);
    await expect(cancelDocument(f.ctx, "SALE_INVOICE", document.id, "again")).rejects.toThrow(/already cancelled/);
    expect(await stockOf(f.pen.id)).toBe(50);
    expect((await partyBalances(f.business.id)).get(f.customer.id)!.toFixed(2)).toBe("0.00");

    const audit = await prisma.auditLog.findMany({ where: { entityId: document.id }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["CREATE", "CANCEL"]);
  });
});

describe("estimates and returns", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await setup();
  });

  it("estimate has no stock or balance effect and converts to exactly one invoice", async () => {
    const { document: est } = await saveDocument(f.ctx, "ESTIMATE", { partyId: f.customer.id, items: [line(f.pen, 10, 100)] });
    expect(est.invoiceNo).toBe("EST-0001");
    expect(await stockOf(f.pen.id)).toBe(50);
    expect((await partyBalances(f.business.id)).get(f.customer.id)!.toNumber()).toBe(0);

    const { document: inv } = await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 10, 100)], convertedFromId: est.id });
    expect(inv.convertedFromId).toBe(est.id);
    expect(await stockOf(f.pen.id)).toBe(40);

    await expect(
      saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 10, 100)], convertedFromId: est.id })
    ).rejects.toThrow(/already been converted/);
    expect(await stockOf(f.pen.id)).toBe(40);
    expect(await prisma.saleInvoice.count({ where: { businessId: f.business.id, docType: "SALE_INVOICE" } })).toBe(1);
  });

  it("credit note returns stock, sets off the invoice balance and limits quantities", async () => {
    const { document: inv } = await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 5, 100)] });
    const { document: cn } = await saveDocument(f.ctx, "CREDIT_NOTE", {
      partyId: f.customer.id,
      originalDocId: inv.id,
      adjustAgainstOriginal: true,
      items: [line(f.pen, 2, 100)],
    });
    expect(cn.invoiceNo).toBe("CN-0001");
    expect(money(cn.total)).toBe("236.00");
    expect(money(cn.adjustedAmount)).toBe("236.00");
    expect(await stockOf(f.pen.id)).toBe(47);

    const after = await docOf(inv.id);
    expect(money(after.balance)).toBe("354.00");
    expect(after.paymentStatus).toBe("PARTIALLY_PAID");
    expect((await partyBalances(f.business.id)).get(f.customer.id)!.toFixed(2)).toBe("354.00");

    await expect(
      saveDocument(f.ctx, "CREDIT_NOTE", { partyId: f.customer.id, originalDocId: inv.id, items: [line(f.pen, 4, 100)] })
    ).rejects.toThrow(/Only 3/);

    // Invoice cannot be cancelled while the credit note is active; cancelling the note restores everything
    await expect(cancelDocument(f.ctx, "SALE_INVOICE", inv.id, "x")).rejects.toThrow(/credit\/debit notes/);
    await cancelDocument(f.ctx, "CREDIT_NOTE", cn.id, "entered wrongly");
    expect(money((await docOf(inv.id)).balance)).toBe("590.00");
    expect(await stockOf(f.pen.id)).toBe(45);
  });

  it("purchase bill adds stock and a payable; payment out settles it oldest first; debit note reverses", async () => {
    const { document: bill } = await saveDocument(f.ctx, "PURCHASE_BILL", {
      partyId: f.supplier.id,
      partyInvoiceNo: "SUP/77",
      items: [line(f.pen, 10, 60)],
    });
    expect(bill.invoiceNo).toBe("PB-0001");
    expect(money(bill.total)).toBe("708.00");
    expect(await stockOf(f.pen.id)).toBe(60);
    // Opening payable 1000 + bill 708
    expect((await partyBalances(f.business.id)).get(f.supplier.id)!.toFixed(2)).toBe("-1708.00");

    const { voucher } = await createVoucher(f.ctx, { direction: "OUT", partyId: f.supplier.id, date: new Date(), amount: 500, mode: "BANK_TRANSFER", autoAllocate: true });
    expect(voucher.voucherNo).toBe("PO-0001");
    expect(money((await docOf(bill.id)).balance)).toBe("208.00");
    expect((await partyBalances(f.business.id)).get(f.supplier.id)!.toFixed(2)).toBe("-1208.00");

    const { document: dn } = await saveDocument(f.ctx, "DEBIT_NOTE", { partyId: f.supplier.id, originalDocId: bill.id, adjustAgainstOriginal: true, items: [line(f.pen, 1, 60)] });
    // 60 + 18% = 70.80, rounded to 71 by the business's automatic round-off
    expect(money(dn.total)).toBe("71.00");
    expect(money(dn.adjustedAmount)).toBe("71.00");
    expect(await stockOf(f.pen.id)).toBe(59);
    expect(money((await docOf(bill.id)).balance)).toBe("137.00");
    expect((await partyBalances(f.business.id)).get(f.supplier.id)!.toFixed(2)).toBe("-1137.00");
  });

  it("rejects allocating more than a bill's balance and leaves nothing behind", async () => {
    const { document: inv } = await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 1, 100)] });
    await expect(
      createVoucher(f.ctx, { direction: "IN", partyId: f.customer.id, date: new Date(), amount: 200, mode: "CASH", allocations: [{ documentId: inv.id, amount: 200 }] })
    ).rejects.toThrow(/exceed its total/);
    expect(await prisma.paymentVoucher.count({ where: { businessId: f.business.id } })).toBe(0);
    expect(money((await docOf(inv.id)).balance)).toBe("118.00");
  });
});

describe("ledger and reports", () => {
  it("statement, balances, cash book and GST summary agree with each other", async () => {
    const f = await setup();
    const day = (d: number) => new Date(Date.UTC(2026, 9, d, 6));
    const { document: inv1 } = await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.outstation.id, date: day(1), items: [line(f.pen, 2, 100)] });
    await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.outstation.id, date: day(5), items: [line(f.book, 1, 112, { priceType: "INCLUSIVE" })], chargesAmount: 50, chargesTaxRate: 18 });
    await createVoucher(f.ctx, { direction: "IN", partyId: f.outstation.id, date: day(7), amount: 300, mode: "CASH", autoAllocate: true });
    await createExpense(f.ctx, { date: day(8), categoryName: "Rent", amount: 1500, mode: "BANK_TRANSFER" });

    // inv1 = 236; inv2 = 112 + 50 + 9 charges tax = 171; opening 500; paid 300
    const balance = (await partyBalances(f.business.id)).get(f.outstation.id)!;
    expect(balance.toFixed(2)).toBe("607.00");
    expect(money((await docOf(inv1.id)).balance)).toBe("0.00");

    const statement = await partyStatement(f.business.id, f.outstation.id, day(3), day(31));
    expect(statement.openingBalance.toFixed(2)).toBe("736.00"); // 500 + inv1
    expect(statement.closingBalance.toFixed(2)).toBe("607.00");
    expect(statement.entries.map((e) => e.kind)).toEqual(["Sale Invoice", "Payment In"]);

    // Cash book: the payment and the expense, but not the unpaid invoice amounts
    const cash = await cashBankReport(f.business.id, { from: day(1), to: day(31) });
    expect(cash.rows).toHaveLength(2);

    const sales = await salesReport(f.business.id, { from: day(1), to: day(31) });
    const gst = await gstSummaryReport(f.business.id, { from: day(1), to: day(31) });
    const salesTotal = sales.footer![0];
    const outward = gst.rows.find((r) => r[0] === "Total outward")!;
    expect(sales.columns.slice(4, 8)).toEqual(["Section", "Department", "GSTIN", "Taxable ₹"]); // no "Unclassified" when there are none
    expect(outward[3]).toBe(salesTotal[7]); // taxable: 200 + 100 + 50 charges
    expect(outward[3]).toBe("350.00");
    expect(outward[6]).toBe(salesTotal[10]); // IGST
  });
});

describe("invoices saved by the previous version of the app", () => {
  it("can be viewed and edited with correct stock, keeping their number and historical rate", async () => {
    const f = await setup();
    // Shape of an old invoice: no docType-specific fields, no snapshots, line priceType null, and an
    // earlier edit that wrote a SALE row plus a "Restored from cancelled invoice" ADJUSTMENT row.
    const old = await prisma.saleInvoice.create({
      data: {
        businessId: f.business.id, customerId: f.customer.id, invoiceNo: "INV-0007", placeOfSupply: "Uttarakhand", taxType: "INTRA_STATE",
        subtotal: 300, taxableAmount: 300, cgst: 27, sgst: 27, total: 354, balance: 354,
        items: { create: [{ productId: f.pen.id, productName: "Pen", hsn: "9608", quantity: 3, rate: 100, taxRate: 18, taxableAmount: 300, cgst: 27, sgst: 27, finalAmount: 354 }] },
      },
    });
    await prisma.stockTransaction.createMany({
      data: [
        { productId: f.pen.id, type: "SALE", quantity: -5, resultingStock: 45, referenceInvoiceId: old.id },
        { productId: f.pen.id, type: "ADJUSTMENT", quantity: 5, resultingStock: 50, referenceInvoiceId: old.id, note: "Restored from cancelled invoice" },
        { productId: f.pen.id, type: "SALE", quantity: -3, resultingStock: 47, referenceInvoiceId: old.id },
      ],
    });
    await prisma.product.update({ where: { id: f.pen.id }, data: { currentStock: 47 } });

    const view = await buildInvoiceViewModel(old.id, f.business.id);
    expect(view.business.name).toBe("Test Traders"); // falls back to the live record
    expect(view.hsnTaxGroups[0].totalTax).toBe(54);

    const { document } = await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 4, 100)] }, old.id);
    expect(document.invoiceNo).toBe("INV-0007");
    expect(money(document.total)).toBe("472.00");
    expect(await stockOf(f.pen.id)).toBe(46);
  });
});

describe("section and department on invoices", () => {
  it("are stored separately per invoice, never on the customer, and do not change totals", async () => {
    const f = await setup();
    const before = await prisma.customer.findUniqueOrThrow({ where: { id: f.customer.id } });
    const save = (over: Partial<DocumentInput>, id?: string) => saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 1, 100)], ...over }, id);
    const { document: onlySection } = await save({ section: "  Retail   Asset Hub " });
    const { document: onlyDept } = await save({ department: "HRM" });
    const { document: both } = await save({ section: "GA", department: "Accounts" });
    const { document: neither } = await save({ section: "", department: "" });

    expect([onlySection.section, onlySection.department]).toEqual(["Retail Asset Hub", null]);
    expect([onlyDept.section, onlyDept.department]).toEqual([null, "HRM"]);
    expect([both.section, both.department]).toEqual(["GA", "Accounts"]);
    expect([neither.section, neither.department]).toEqual([null, null]);
    expect([onlySection, onlyDept, both, neither].every((d) => !d.legacySectionDepartment)).toBe(true);
    expect([onlySection, both, neither].map((d) => money(d.total))).toEqual(["118.00", "118.00", "118.00"]);

    // Printed / previewed with their own labels, only when filled
    const view = async (id: string) => (await buildInvoiceViewModel(id, f.business.id)).division;
    expect(await view(onlySection.id)).toEqual([{ label: "Section", value: "Retail Asset Hub" }]);
    expect(await view(onlyDept.id)).toEqual([{ label: "Department", value: "HRM" }]);
    expect(await view(both.id)).toEqual([{ label: "Section", value: "GA" }, { label: "Department", value: "Accounts" }]);
    expect(await view(neither.id)).toEqual([]);

    // Editing one invoice leaves the others and the customer alone
    await save({ section: "GA", department: "" }, onlySection.id);
    expect([(await docOf(onlySection.id)).section, (await docOf(onlySection.id)).department]).toEqual(["GA", null]);
    expect((await docOf(onlyDept.id)).department).toBe("HRM");
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: f.customer.id } });
    expect([after.section, after.department, after.updatedAt.getTime()]).toEqual([before.section, before.department, before.updatedAt.getTime()]);
    expect(await prisma.customer.count({ where: { businessId: f.business.id } })).toBe(3);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: onlySection.id, action: "UPDATE" } });
    expect(audit.detail).toMatchObject({ previousSection: "Retail Asset Hub", newSection: "GA", previousDepartment: null, newDepartment: null });

    // Separate columns in the sales register
    const register = await salesReport(f.business.id, {});
    const [sec, dep] = [register.columns.indexOf("Section"), register.columns.indexOf("Department")];
    expect(register.columns).not.toContain("Section / Department");
    expect(register.rows.map((r) => `${r[sec]}|${r[dep]}`).sort()).toEqual(["GA|", "GA|Accounts", "|", "|HRM"].sort());
  });

  it("keeps an older combined value unclassified until the user classifies it, without changing its text", async () => {
    const f = await setup();
    const { document } = await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, department: "HRM", items: [line(f.pen, 1, 100)] });
    // As the migration leaves values saved under the old combined label
    await prisma.saleInvoice.update({ where: { id: document.id }, data: { legacySectionDepartment: true } });
    expect((await buildInvoiceViewModel(document.id, f.business.id)).division).toEqual([{ label: null, value: "HRM" }]);

    // Saved again without classifying (explicitly, or by an older client sending the same text back)
    await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, department: "HRM", legacySectionDepartment: true, items: [line(f.pen, 2, 100)] }, document.id);
    await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, department: "HRM", items: [line(f.pen, 2, 100)] }, document.id);
    let doc = await docOf(document.id);
    expect([doc.section, doc.department, doc.legacySectionDepartment]).toEqual([null, "HRM", true]);
    const register = await salesReport(f.business.id, {});
    expect(register.rows[0][register.columns.indexOf("Unclassified")]).toBe("HRM");

    // Classified as a section: the same text moves to Section; the original stays in the audit trail
    await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, section: "HRM", department: "", legacySectionDepartment: false, items: [line(f.pen, 2, 100)] }, document.id);
    doc = await docOf(document.id);
    expect([doc.section, doc.department, doc.legacySectionDepartment]).toEqual(["HRM", null, false]);
    const audit = await prisma.auditLog.findMany({ where: { entityId: document.id, action: "UPDATE" }, orderBy: { createdAt: "desc" }, take: 1 });
    expect(audit[0].detail).toMatchObject({ previousDepartment: "HRM", previousUnclassified: true, newSection: "HRM", newDepartment: null, newUnclassified: false });
  });

  it("is ignored on purchase bills", async () => {
    const f = await setup();
    const { document } = await saveDocument(f.ctx, "PURCHASE_BILL", { partyId: f.supplier.id, section: "Stores", department: "Stores", items: [line(f.pen, 1, 60)] });
    expect([document.section, document.department]).toEqual([null, null]);
  });
});

describe("previous discounts for a party and item", () => {
  const at = (d: number) => new Date(Date.UTC(2026, 9, d));

  it("uses the latest saved sale invoice's line discount, section / department first, and never estimates, returns or cancelled invoices", async () => {
    const f = await setup();
    const sale = (date: Date, over: Partial<DocumentInput>, items: DocumentLineInput[]) =>
      saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, date, items, ...over }).then((r) => r.document);

    // Like INV-0029: 3% on paper and 20% on tissue for Retail Asset Hub
    const older = await sale(at(10), { section: "Retail Asset Hub" }, [line(f.pen, 1, 100, { discountValue: 2 })]);
    const inv29 = await sale(at(17), { section: "Retail Asset Hub" }, [line(f.pen, 10, 100, { discountValue: 3 }), line(f.book, 3, 100, { discountValue: 20 })]);
    // Same day, saved later, another section: wins for the party-wide lookup, not for Retail Asset Hub
    const ga = await sale(at(17), { section: "GA" }, [line(f.pen, 1, 100, { discountValue: 0 })]);
    // Fixed ₹ off the line, other customer, estimate, return and a cancelled invoice: none of them count
    await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.outstation.id, date: at(20), section: "Retail Asset Hub", items: [line(f.pen, 1, 100, { discountValue: 50 })] });
    await saveDocument(f.ctx, "ESTIMATE", { partyId: f.customer.id, date: at(21), section: "Retail Asset Hub", items: [line(f.pen, 1, 100, { discountValue: 40 })] });
    await saveDocument(f.ctx, "CREDIT_NOTE", { partyId: f.customer.id, date: at(21), section: "Retail Asset Hub", originalDocId: inv29.id, items: [line(f.pen, 1, 100, { discountValue: 30 })] });
    const cancelled = await sale(at(22), { section: "Retail Asset Hub" }, [line(f.pen, 1, 100, { discountValue: 25 })]);
    await cancelDocument(f.ctx, "SALE_INVOICE", cancelled.id, "test");

    const { previousDiscounts } = await import("./documents/discountHistory");
    const ids = [f.pen.id, f.book.id];
    const scoped = await previousDiscounts(f.business.id, { customerId: f.customer.id, productIds: ids, section: "retail  asset hub" });
    expect(scoped[f.pen.id]).toMatchObject({ discountValue: "3.00", discountType: "PERCENTAGE", invoiceNo: inv29.invoiceNo, match: "division", section: "Retail Asset Hub" });
    expect(scoped[f.book.id]).toMatchObject({ discountValue: "20.00", invoiceNo: inv29.invoiceNo, match: "division" });

    // No section given: the party's most recent invoice (same date, saved later), including an explicit 0%
    const party = await previousDiscounts(f.business.id, { customerId: f.customer.id, productIds: ids });
    expect(party[f.pen.id]).toMatchObject({ discountValue: "0.00", invoiceNo: ga.invoiceNo, match: "party", section: "GA" });

    // A section with no history falls back to the party, and says so
    const other = await previousDiscounts(f.business.id, { customerId: f.customer.id, productIds: ids, section: "HRM" });
    expect(other[f.pen.id]).toMatchObject({ invoiceNo: ga.invoiceNo, match: "party" });
    // Department given but never used: also a fallback
    const dept = await previousDiscounts(f.business.id, { customerId: f.customer.id, productIds: ids, section: "Retail Asset Hub", department: "Loans" });
    expect(dept[f.pen.id].match).toBe("party");

    // The invoice being edited is not its own history
    const editing = await previousDiscounts(f.business.id, { customerId: f.customer.id, productIds: [f.book.id], excludeInvoiceId: inv29.id });
    expect(editing[f.book.id]).toBeUndefined();
    expect(older.invoiceNo).not.toBe(inv29.invoiceNo);

    // Fixed discounts keep their type and amount (₹ off the line); other customers are separate
    const outstation = await previousDiscounts(f.business.id, { customerId: f.outstation.id, productIds: ids });
    expect(outstation[f.pen.id]).toMatchObject({ discountValue: "50.00", discountType: "PERCENTAGE" });
    await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.outstation.id, date: at(23), items: [line(f.pen, 2, 100, { discountValue: 15, discountType: "FIXED" })] });
    expect((await previousDiscounts(f.business.id, { customerId: f.outstation.id, productIds: [f.pen.id] }))[f.pen.id]).toMatchObject({ discountValue: "15.00", discountType: "FIXED" });

    // Reading history changes nothing: the product master and the old invoice are untouched
    expect((await prisma.product.findUniqueOrThrow({ where: { id: f.pen.id } })).defaultDiscount).toBeNull();
    const lines29 = await prisma.saleInvoiceItem.findMany({ where: { invoiceId: inv29.id } });
    expect(lines29.map((l) => money(l.discount)).sort()).toEqual(["20.00", "3.00"]);
  });
});

describe("cost saved with sale invoice lines (for estimated profit)", () => {
  it("records today's cost on new lines, keeps it through edits and price changes, and never back-fills older invoices", async () => {
    const f = await setup();
    // Pen: purchase 60 excl. GST; Notebook: purchase 70 entered with 12% tax → 62.50 excl. GST
    await prisma.product.update({ where: { id: f.book.id }, data: { purchasePriceType: "INCLUSIVE" } });
    const { document } = await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 2, 100), line(f.book, 1, 112, { priceType: "INCLUSIVE" })] });
    const items = async (id: string) => (await prisma.saleInvoiceItem.findMany({ where: { invoiceId: id }, orderBy: { productName: "asc" } })).map((i) => [i.productName, i.unitCost?.toFixed(2) ?? null, i.costBasis]);
    expect(await items(document.id)).toEqual([["Notebook", "62.50", "purchase-price"], ["Pen", "60.00", "purchase-price"]]);
    expect(money(document.total)).toBe("348.00"); // totals unaffected

    // Later purchase-price change, then an edit that adds a line: saved costs stay, the new line takes today's
    await prisma.product.update({ where: { id: f.pen.id }, data: { purchasePrice: 80 } });
    const typed: DocumentLineInput = { productId: null, productName: "Gift wrap", quantity: 1, unitPrice: 10, priceType: "EXCLUSIVE", discountValue: 0, discountType: "PERCENTAGE", gstRate: 0 };
    await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 3, 100), line(f.book, 1, 112, { priceType: "INCLUSIVE" }), typed] }, document.id);
    expect(await items(document.id)).toEqual([["Gift wrap", null, "missing"], ["Notebook", "62.50", "purchase-price"], ["Pen", "60.00", "purchase-price"]]);

    // An invoice saved before costs were recorded keeps no cost when edited
    await prisma.saleInvoiceItem.updateMany({ where: { invoiceId: document.id }, data: { unitCost: null, costBasis: null } });
    await saveDocument(f.ctx, "SALE_INVOICE", { partyId: f.customer.id, items: [line(f.pen, 3, 100), line(f.book, 1, 112, { priceType: "INCLUSIVE" })] }, document.id);
    expect(await items(document.id)).toEqual([["Notebook", null, null], ["Pen", null, null]]);

    // Purchase bills and estimates record no sale cost
    const { document: est } = await saveDocument(f.ctx, "ESTIMATE", { partyId: f.customer.id, items: [line(f.pen, 1, 100)] });
    expect(await items(est.id)).toEqual([["Pen", null, null]]);
  });
});
