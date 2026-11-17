import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { DocType, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { INDIAN_STATES } from "../lib/indianStates";
import { docConfig, type DocTypeConfig } from "../services/documents/docTypes";
import { cancelDocument, saveDocument, type ActionContext, type DocumentInput } from "../services/documents/documentService";
import { buildInvoiceViewModel } from "../services/invoice/invoiceView";
import { renderInvoicePdf } from "../services/invoice/pdf";
import { createVoucher } from "../services/payments/paymentService";
import { fieldErrorsFrom } from "../lib/viewHelpers";
import { loadFormOptions } from "./products.controller";
import { canViewProfit } from "../lib/permissions";

const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const optionalDate = z.preprocess(blankToUndefined, z.coerce.date().optional());
// qs turns items[0..20] into an array but higher indexes into an object; accept both.
const asArray = (v: unknown) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : v);

const itemSchema = z.object({
  productId: z.string().trim().optional().or(z.literal("")),
  productName: z.string().trim().min(1, "Every line needs an item name"),
  hsn: z.string().trim().optional().or(z.literal("")),
  unit: z.string().trim().optional().or(z.literal("")),
  quantity: z.coerce.number().positive("Quantity must be greater than 0"),
  unitPrice: z.coerce.number().min(0, "Price must be 0 or more"),
  priceType: z.enum(["INCLUSIVE", "EXCLUSIVE"]).default("EXCLUSIVE"),
  discountValue: z.preprocess(blankToUndefined, z.coerce.number().min(0).default(0)),
  discountType: z.enum(["PERCENTAGE", "FIXED"]).default("PERCENTAGE"),
  gstRate: z.preprocess(blankToUndefined, z.coerce.number().min(0).max(100).default(0)),
});

const documentSchema = z.object({
  customerId: z.string({ required_error: "Please select a party" }).trim().min(1, "Please select a party"),
  invoiceDate: optionalDate,
  dueDate: optionalDate,
  items: z.preprocess(asArray, z.array(itemSchema, { required_error: "Add at least one item", invalid_type_error: "Add at least one item" }).min(1, "Add at least one item")),
  invoiceDiscountValue: z.preprocess(blankToUndefined, z.coerce.number().min(0).default(0)),
  invoiceDiscountType: z.enum(["PERCENTAGE", "FIXED"]).default("PERCENTAGE"),
  manualRoundOff: z.preprocess(blankToUndefined, z.coerce.number().optional()),
  chargesLabel: z.string().trim().optional(),
  chargesAmount: z.preprocess(blankToUndefined, z.coerce.number().min(0, "Charges cannot be negative").default(0)),
  chargesTaxRate: z.preprocess(blankToUndefined, z.coerce.number().min(0).max(100).default(0)),
  partyInvoiceNo: z.string().trim().max(40).optional(),
  partyInvoiceDate: optionalDate,
  section: z.string().trim().max(80, "Section can be at most 80 characters").optional(),
  department: z.string().trim().max(80, "Department can be at most 80 characters").optional(),
  // "1" keeps an older combined Section / Department value unclassified, "0" means it was classified
  legacySectionDepartment: z.enum(["0", "1"]).optional(),
  notes: z.string().trim().max(1000).optional(),
  convertedFromId: z.string().trim().optional(),
  originalDocId: z.string().trim().optional(),
  adjustAgainstOriginal: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()).default(false),
  paidNowAmount: z.preprocess(blankToUndefined, z.coerce.number().min(0, "Amount paid cannot be negative").default(0)),
  paidNowMode: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CARD", "CREDIT", "OTHER"]).default("CASH"),
  paidNowReference: z.string().trim().max(60).optional(),
  clientToken: z.string().trim().max(64).optional(),
});

function toInput(data: z.infer<typeof documentSchema>, config: DocTypeConfig): DocumentInput {
  return {
    partyId: data.customerId,
    date: data.invoiceDate,
    dueDate: data.dueDate ?? null,
    items: data.items.map((i) => ({ ...i, productId: i.productId || null, hsn: i.hsn || null, unit: i.unit || null })),
    invoiceDiscountValue: data.invoiceDiscountValue,
    invoiceDiscountType: data.invoiceDiscountType,
    manualRoundOff: data.manualRoundOff,
    chargesLabel: data.chargesLabel,
    chargesAmount: data.chargesAmount,
    chargesTaxRate: data.chargesTaxRate,
    partyInvoiceNo: data.partyInvoiceNo,
    partyInvoiceDate: data.partyInvoiceDate ?? null,
    section: data.section || null,
    department: data.department || null,
    legacySectionDepartment: data.legacySectionDepartment === undefined ? undefined : data.legacySectionDepartment === "1",
    notes: data.notes,
    convertedFromId: data.convertedFromId || null,
    originalDocId: data.originalDocId || null,
    adjustAgainstOriginal: data.adjustAgainstOriginal,
    // CREDIT means "nothing paid now"
    paidNowAmount: config.settlementDirection && data.paidNowMode !== "CREDIT" ? data.paidNowAmount : 0,
    paidNowMode: data.paidNowMode,
    paidNowReference: data.paidNowReference,
    clientToken: data.clientToken,
  };
}

function ctxFrom(req: Request, res: Response): ActionContext {
  return { business: res.locals.business, userId: req.session.userId };
}

async function partiesFor(businessId: string, config: DocTypeConfig) {
  const wanted = config.side === "SALE" ? ["CUSTOMER", "BOTH"] : ["SUPPLIER", "BOTH"];
  return prisma.customer.findMany({
    where: { businessId, isActive: true, partyType: { in: wanted as ("CUSTOMER" | "SUPPLIER" | "BOTH")[] } },
    orderBy: { name: "asc" },
  });
}

/** Items shown on a form: the saved lines when editing, or lines copied from an estimate / original invoice. */
function formItems(items: Prisma.SaleInvoiceItemGetPayload<{ include: { product: { select: { priceType: true; purchasePriceType: true } } } }>[], config: DocTypeConfig) {
  // Saved costs stay on the server: the profit panel fetches them from the owner-only API
  return items.map(({ product, unitCost: _cost, costBasis: _basis, ...item }) => ({
    ...item,
    // Older invoices did not store the price type; fall back to the item's current setting.
    priceType: item.priceType ?? (config.side === "PURCHASE" ? product?.purchasePriceType : product?.priceType) ?? "EXCLUSIVE",
  }));
}

async function renderForm(req: Request, res: Response, config: DocTypeConfig, opts: { invoice?: Record<string, unknown> | null; errors?: string[] | null; status?: number; prefill?: Record<string, unknown> | null }) {
  const business = res.locals.business;
  const parties = await partiesFor(business.id, config);
  const invoice = opts.invoice ?? null;
  res.status(opts.status ?? 200).render("invoices/form", {
    title: invoice ? `Edit ${config.label} ${invoice.invoiceNo}` : `New ${config.label}`,
    activeNav: config.activeNav,
    config,
    invoice,
    prefill: opts.prefill ?? null,
    customers: parties,
    states: INDIAN_STATES,
    errors: opts.errors ?? null,
    clientToken: (req.body && typeof req.body.clientToken === "string" && req.body.clientToken) || crypto.randomUUID(),
    taxRates: await prisma.taxMaster.findMany({ where: { businessId: business.id, isActive: true }, orderBy: { rate: "asc" } }),
    unitOptions: (await loadFormOptions(business.id)).units,
    // Private profit panel (sale invoices, owner only; the API checks this again)
    showProfit: config.docType === "SALE_INVOICE" && canViewProfit(req, res),
  });
}

/** Re-renders the form with the user's input and the error after a rejected save. */
async function rerenderWithError(req: Request, res: Response, config: DocTypeConfig, errors: string[], existingId?: string) {
  const body = req.body || {};
  const items = asArray(body.items);
  const invoice = existingId
    ? { ...(await prisma.saleInvoice.findUnique({ where: { id: existingId } })), ...body, items: Array.isArray(items) ? items.map(formLineFromBody) : [] }
    : null;
  const prefill = existingId ? null : { ...body, items: Array.isArray(items) ? items.map(formLineFromBody) : [] };
  return renderForm(req, res, config, { invoice, prefill, errors, status: 422 });
}

function uniqueCaseInsensitive(values: string[]) {
  return values.filter((v, i) => values.findIndex((w) => w.toLowerCase() === v.toLowerCase()) === i);
}

/** Section / department copied onto a new document (an unclassified older value stays unclassified). */
function divisionPrefill(doc: { section: string | null; department: string | null; legacySectionDepartment: boolean }) {
  return { section: doc.section, department: doc.department, legacySectionDepartment: doc.legacySectionDepartment };
}

function formLineFromBody(i: Record<string, unknown>) {
  return {
    productId: i.productId,
    productName: i.productName,
    hsn: i.hsn,
    unit: i.unit,
    quantity: i.quantity,
    rate: i.unitPrice,
    priceType: i.priceType,
    discount: i.discountValue,
    discountType: i.discountType,
    taxRate: i.gstRate,
  };
}

export function documentController(docType: DocType) {
  const config = docConfig(docType);

  async function list(req: Request, res: Response) {
    const business = res.locals.business;
    const { customerId, paymentStatus, invoiceNo, from, to, status, section, department } = req.query as Record<string, string>;
    // "q" searches number, section, department and customer; "invoiceNo" is kept for older links
    const q = ((req.query.q as string) || invoiceNo || "").trim();

    const where: Prisma.SaleInvoiceWhereInput = { businessId: business.id, docType, status: status === "CANCELLED" ? "CANCELLED" : status === "ALL" ? undefined : "ACTIVE" };
    if (customerId) where.customerId = customerId;
    if (paymentStatus) where.paymentStatus = paymentStatus as Prisma.EnumPaymentStatusFilter["equals"];
    if (q) {
      where.OR = [
        { invoiceNo: { contains: q, mode: "insensitive" } },
        { section: { contains: q, mode: "insensitive" } },
        { department: { contains: q, mode: "insensitive" } },
        { customer: { name: { contains: q, mode: "insensitive" } } },
      ];
    }
    // Older unclassified values are neither a section nor a department, so they only match "None"
    const and: Prisma.SaleInvoiceWhereInput[] = [];
    if (section === "__none") and.push({ section: null });
    else if (section) and.push({ section: { equals: section, mode: "insensitive" } });
    if (department === "__none") and.push({ OR: [{ department: null }, { legacySectionDepartment: true }] });
    else if (department) and.push({ department: { equals: department, mode: "insensitive" }, legacySectionDepartment: false });
    if (and.length) where.AND = and;
    if (from || to) {
      where.invoiceDate = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(`${to}T23:59:59.999`) } : {}),
      };
    }

    const [invoices, agg, count, sectionRows, departmentRows] = await Promise.all([
      prisma.saleInvoice.findMany({
        where,
        include: { customer: true, convertedTo: { select: { id: true, invoiceNo: true, status: true } } },
        orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }],
        take: 500,
      }),
      prisma.saleInvoice.aggregate({ where: { ...where, status: "ACTIVE" }, _sum: { total: true, receivedAmount: true, balance: true } }),
      prisma.saleInvoice.count({ where }),
      config.side === "SALE"
        ? prisma.saleInvoice.groupBy({ by: ["section"], where: { businessId: business.id, docType, section: { not: null } }, orderBy: { section: "asc" } })
        : Promise.resolve([] as { section: string | null }[]),
      config.side === "SALE"
        ? prisma.saleInvoice.groupBy({ by: ["department"], where: { businessId: business.id, docType, department: { not: null }, legacySectionDepartment: false }, orderBy: { department: "asc" } })
        : Promise.resolve([] as { department: string | null }[]),
    ]);

    res.render("invoices/list", {
      title: config.pluralLabel,
      activeNav: config.activeNav,
      config,
      invoices,
      customers: await partiesFor(business.id, config),
      summary: {
        totalSales: Number(agg._sum.total || 0),
        received: Number(agg._sum.receivedAmount || 0),
        outstanding: Number(agg._sum.balance || 0),
      },
      invoiceCount: count,
      sections: uniqueCaseInsensitive(sectionRows.map((r) => r.section as string)),
      departments: uniqueCaseInsensitive(departmentRows.map((r) => r.department as string)),
      filters: { customerId: customerId || "", paymentStatus: paymentStatus || "", q, invoiceNo: q, section: section || "", department: department || "", from: from || "", to: to || "", status: status || "" },
    });
  }

  async function showNew(req: Request, res: Response) {
    const business = res.locals.business;
    const { fromEstimate, against, duplicateOf } = req.query as Record<string, string>;
    let prefill: Record<string, unknown> | null = null;

    // Duplicate: same party, section, department, lines and charges; new number and today's date; no payments
    if (duplicateOf && !config.returnOf) {
      const source = await prisma.saleInvoice.findFirst({
        where: { id: duplicateOf, businessId: business.id, docType },
        include: { items: { include: { product: { select: { priceType: true, purchasePriceType: true } } } } },
      });
      if (!source) throw new AppError(`${config.label} to copy was not found`, 404);
      prefill = {
        customerId: source.customerId,
        ...divisionPrefill(source),
        sourceLabel: `Copy of ${source.invoiceNo}. It gets a new number and today's date; payments are not copied.`,
        invoiceDiscountValue: source.invoiceDiscountValue ?? source.discount,
        invoiceDiscountType: source.invoiceDiscountType ?? "FIXED",
        chargesLabel: source.chargesLabel,
        chargesAmount: source.chargesAmount,
        chargesTaxRate: source.chargesTaxRate,
        notes: source.notes,
        items: formItems(source.items, config),
      };
    }

    if (fromEstimate && docType === "SALE_INVOICE") {
      const estimate = await prisma.saleInvoice.findFirst({
        where: { id: fromEstimate, businessId: business.id, docType: "ESTIMATE" },
        include: { items: { include: { product: { select: { priceType: true, purchasePriceType: true } } } }, convertedTo: true },
      });
      if (!estimate) throw new AppError("Estimate not found", 404);
      if (estimate.status === "CANCELLED") throw new AppError("This estimate is cancelled", 400);
      if (estimate.convertedTo) {
        req.session.flash = { type: "info", message: `${estimate.invoiceNo} was already converted to ${estimate.convertedTo.invoiceNo}.` };
        return res.redirect(`/invoices/${estimate.convertedTo.id}`);
      }
      prefill = {
        customerId: estimate.customerId,
        convertedFromId: estimate.id,
        sourceLabel: `Converting estimate ${estimate.invoiceNo}`,
        ...divisionPrefill(estimate),
        invoiceDiscountValue: estimate.invoiceDiscountValue ?? 0,
        invoiceDiscountType: estimate.invoiceDiscountType ?? "PERCENTAGE",
        chargesLabel: estimate.chargesLabel,
        chargesAmount: estimate.chargesAmount,
        chargesTaxRate: estimate.chargesTaxRate,
        notes: estimate.notes,
        items: formItems(estimate.items, config),
      };
    }

    if (against && config.returnOf) {
      const original = await prisma.saleInvoice.findFirst({
        where: { id: against, businessId: business.id, docType: config.returnOf, status: "ACTIVE" },
        include: { items: { include: { product: { select: { priceType: true, purchasePriceType: true } } } } },
      });
      if (!original) throw new AppError("Original document not found or cancelled", 404);
      prefill = {
        customerId: original.customerId,
        originalDocId: original.id,
        sourceLabel: `Return against ${original.invoiceNo} dated ${original.invoiceDate.toLocaleDateString("en-IN")}`,
        ...divisionPrefill(original),
        adjustAgainstOriginal: true,
        items: formItems(original.items, config),
      };
    }

    await renderForm(req, res, config, { prefill });
  }

  async function create(req: Request, res: Response) {
    const parsed = documentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.locals.fieldErrors = fieldErrorsFrom(parsed.error);
      return rerenderWithError(req, res, config, parsed.error.errors.map((e) => (e.path[0] === "items" && typeof e.path[1] === "number" ? `Line ${e.path[1] + 1}: ${e.message}` : e.message)));
    }

    try {
      const { document, duplicate } = await saveDocument(ctxFrom(req, res), docType, toInput(parsed.data, config));
      req.session.flash = duplicate
        ? { type: "info", message: `${document.invoiceNo} was already saved — showing it instead of creating a duplicate.` }
        : { type: "success", message: `${config.label} ${document.invoiceNo} saved.` };
      res.redirect(`${config.basePath}/${document.id}${req.body.after === "print" ? "?print=1" : ""}`);
    } catch (err) {
      if (err instanceof AppError && err.status < 500 && err.status !== 404) return rerenderWithError(req, res, config, [err.message]);
      throw err;
    }
  }

  async function show(req: Request, res: Response) {
    const business = res.locals.business;
    const viewModel = await buildInvoiceViewModel(req.params.id, business.id, docType);
    res.render("invoices/preview", { title: `${config.label} ${viewModel.invoice.invoiceNo}`, activeNav: config.activeNav, paymentToken: crypto.randomUUID(), ...viewModel });
  }

  async function showEdit(req: Request, res: Response) {
    const business = res.locals.business;
    const invoice = await prisma.saleInvoice.findFirst({
      where: { id: req.params.id, businessId: business.id, docType },
      include: { items: { include: { product: { select: { priceType: true, purchasePriceType: true } } } }, originalDoc: true },
    });
    if (!invoice) throw new AppError(`${config.label} not found`, 404);
    if (invoice.status === "CANCELLED") throw new AppError(`A cancelled ${config.label.toLowerCase()} cannot be edited`, 400);

    await renderForm(req, res, config, {
      invoice: {
        ...invoice,
        // Older invoices only stored the discount amount; show it as a ₹ amount.
        invoiceDiscountValue: invoice.invoiceDiscountValue ?? invoice.discount,
        invoiceDiscountType: invoice.invoiceDiscountType ?? "FIXED",
        adjustAgainstOriginal: Number(invoice.adjustedAmount) > 0,
        sourceLabel: invoice.originalDoc ? `Return against ${invoice.originalDoc.invoiceNo}` : null,
        items: formItems(invoice.items, config),
      },
    });
  }

  async function update(req: Request, res: Response) {
    const parsed = documentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.locals.fieldErrors = fieldErrorsFrom(parsed.error);
      return rerenderWithError(req, res, config, parsed.error.errors.map((e) => (e.path[0] === "items" && typeof e.path[1] === "number" ? `Line ${e.path[1] + 1}: ${e.message}` : e.message)), req.params.id);
    }

    try {
      const input = toInput(parsed.data, config);
      input.paidNowAmount = 0; // payments on an existing document go through Payment In/Out
      const { document } = await saveDocument(ctxFrom(req, res), docType, input, req.params.id);
      req.session.flash = { type: "success", message: `${config.label} ${document.invoiceNo} updated.` };
      res.redirect(`${config.basePath}/${document.id}${req.body.after === "print" ? "?print=1" : ""}`);
    } catch (err) {
      if (err instanceof AppError && err.status < 500 && err.status !== 404) return rerenderWithError(req, res, config, [err.message], req.params.id);
      throw err;
    }
  }

  async function pdf(req: Request, res: Response) {
    const business = res.locals.business;
    const viewModel = await buildInvoiceViewModel(req.params.id, business.id, docType);
    const pdfBuffer = await renderInvoicePdf(viewModel);
    res.setHeader("Content-Type", "application/pdf");
    const fileName = `${config.label}_${viewModel.invoice.invoiceNo}_${viewModel.formatDate(viewModel.invoice.invoiceDate)}`.replace(/[^A-Za-z0-9_-]/g, "-");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}.pdf"`);
    res.send(pdfBuffer);
  }

  async function cancel(req: Request, res: Response) {
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
    try {
      const doc = await cancelDocument(ctxFrom(req, res), docType, req.params.id, reason);
      req.session.flash = { type: "success", message: `${doc.invoiceNo} cancelled. Its stock and balance effects were reversed.` };
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      req.session.flash = { type: "danger", message: err.message };
    }
    res.redirect(`${config.basePath}/${req.params.id}`);
  }

  const paymentSchema = z.object({
    amount: z.coerce.number().positive("Amount must be more than 0"),
    type: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CARD", "OTHER"], { message: "Choose a payment mode" }).default("CASH"),
    date: optionalDate,
    reference: z.string().trim().max(60).optional(),
    clientToken: z.string().trim().max(64).optional(),
  });

  /** Records a payment against this one document (creates a Payment In/Out allocated to it). */
  async function recordPayment(req: Request, res: Response) {
    const business = res.locals.business;
    const doc = await prisma.saleInvoice.findFirst({ where: { id: req.params.id, businessId: business.id, docType } });
    if (!doc) throw new AppError(`${config.label} not found`, 404);
    if (!config.settlementDirection) throw new AppError(`${config.pluralLabel} do not take payments`, 400);

    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) {
      req.session.flash = { type: "danger", message: parsed.error.errors.map((e) => e.message).join("; ") };
      return res.redirect(`${config.basePath}/${doc.id}`);
    }
    try {
      const { voucher, duplicate } = await createVoucher(ctxFrom(req, res), {
        direction: config.settlementDirection,
        partyId: doc.customerId,
        date: parsed.data.date ?? new Date(),
        amount: parsed.data.amount,
        mode: parsed.data.type,
        reference: parsed.data.reference,
        allocations: [{ documentId: doc.id, amount: parsed.data.amount }],
        clientToken: parsed.data.clientToken,
      });
      req.session.flash = { type: duplicate ? "info" : "success", message: duplicate ? `Payment ${voucher.voucherNo} was already recorded.` : `Payment ${voucher.voucherNo} recorded.` };
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      req.session.flash = { type: "danger", message: err.message };
    }
    res.redirect(`${config.basePath}/${doc.id}`);
  }

  return { list, showNew, create, show, showEdit, update, pdf, cancel, recordPayment };
}
