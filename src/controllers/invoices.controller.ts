import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { toDecimal } from "../lib/decimal";
import { calculateInvoiceTotals, calculateLineItem, isIntraState } from "../services/gst/gstEngine";
import { allocateInvoiceNumber } from "../services/invoice/numbering";
import { deductStockForSale, restoreStockForCancelledSale } from "../services/stock/stockService";
import { buildInvoiceViewModel } from "../services/invoice/invoiceView";
import { renderInvoicePdf } from "../services/invoice/pdf";
import { INDIAN_STATES } from "../lib/indianStates";

const invoiceItemSchema = z.object({
  productId: z.string().trim().optional().or(z.literal("")),
  productName: z.string().trim().min(1),
  hsn: z.string().trim().optional().or(z.literal("")),
  unit: z.string().trim().optional().or(z.literal("")),
  quantity: z.coerce.number().positive("Quantity must be greater than 0"),
  unitPrice: z.coerce.number().min(0, "Price must be 0 or more"),
  priceType: z.enum(["INCLUSIVE", "EXCLUSIVE"]),
  discountValue: z.coerce.number().min(0),
  discountType: z.enum(["PERCENTAGE", "FIXED"]),
  gstRate: z.coerce.number().min(0).max(100),
});

const invoiceSchema = z.object({
  customerId: z.string().trim().min(1, "Please select a customer"),
  invoiceDate: z.string().optional(),
  dueDate: z.string().optional().or(z.literal("")),
  items: z.array(invoiceItemSchema).min(1, "Add at least one item"),
  invoiceDiscountValue: z.coerce.number().min(0).default(0),
  invoiceDiscountType: z.enum(["PERCENTAGE", "FIXED"]).default("PERCENTAGE"),
  paymentType: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CARD", "CREDIT", "OTHER"]).default("CASH"),
  receivedAmount: z.coerce.number().min(0).default(0),
});

export async function listInvoices(req: Request, res: Response) {
  const business = res.locals.business;
  const { customerId, paymentStatus, invoiceNo, from, to } = req.query as Record<string, string>;

  const where: Record<string, unknown> = { businessId: business.id, status: "ACTIVE" };
  if (customerId) where.customerId = customerId;
  if (paymentStatus) where.paymentStatus = paymentStatus;
  if (invoiceNo) where.invoiceNo = { contains: invoiceNo, mode: "insensitive" };
  if (from || to) {
    where.invoiceDate = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(`${to}T23:59:59`) } : {}),
    };
  }

  const invoices = await prisma.saleInvoice.findMany({
    where,
    include: { customer: true },
    orderBy: { invoiceDate: "desc" },
    take: 200,
  });

  const summary = invoices.reduce(
    (acc, inv) => {
      acc.totalSales += Number(inv.total);
      acc.received += Number(inv.receivedAmount);
      acc.outstanding += Number(inv.balance);
      return acc;
    },
    { totalSales: 0, received: 0, outstanding: 0 }
  );

  const customers = await prisma.customer.findMany({ where: { businessId: business.id }, orderBy: { name: "asc" } });

  res.render("invoices/list", {
    title: "Sale Invoices",
    activeNav: "invoices",
    invoices,
    customers,
    summary,
    invoiceCount: invoices.length,
    filters: { customerId: customerId || "", paymentStatus: paymentStatus || "", invoiceNo: invoiceNo || "", from: from || "", to: to || "" },
  });
}

export async function showNewInvoice(req: Request, res: Response) {
  const business = res.locals.business;
  const customers = await prisma.customer.findMany({ where: { businessId: business.id }, orderBy: { name: "asc" } });

  res.render("invoices/form", {
    title: "Create Sale Invoice",
    activeNav: "invoices",
    invoice: null,
    customers,
    states: INDIAN_STATES,
    errors: null,
  });
}

export async function createInvoice(req: Request, res: Response) {
  const business = res.locals.business;
  const parsed = invoiceSchema.safeParse(req.body);

  if (!parsed.success) {
    const customers = await prisma.customer.findMany({ where: { businessId: business.id }, orderBy: { name: "asc" } });
    return res.status(422).render("invoices/form", {
      title: "Create Sale Invoice",
      activeNav: "invoices",
      invoice: null,
      customers,
      states: INDIAN_STATES,
      errors: parsed.error.errors.map((e) => e.message),
    });
  }

  const data = parsed.data;
  const customer = await prisma.customer.findFirst({ where: { id: data.customerId, businessId: business.id } });
  if (!customer) throw new AppError("Customer not found", 404);

  const intra = isIntraState(business.state, customer.state);

  // Re-derive HSN/GST rate authoritatively from the live Product + Tax Master for catalog
  // items — never trust rate/HSN submitted by the browser. Quantity/price/discount are
  // legitimate user overrides and are validated (positive qty, non-negative price/discount).
  const enrichedItems = await Promise.all(
    data.items.map(async (item) => {
      if (!item.productId) return item;
      const product = await prisma.product.findFirst({
        where: { id: item.productId, businessId: business.id },
        include: { tax: true },
      });
      if (!product) return item;
      return {
        ...item,
        hsn: product.hsnCode || item.hsn,
        gstRate: product.tax ? Number(product.tax.rate) : 0,
      };
    })
  );

  const lineResults = enrichedItems.map((item) =>
    calculateLineItem({
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      priceType: item.priceType,
      discountValue: item.discountValue,
      discountType: item.discountType,
      gstRate: item.gstRate,
      isIntraState: intra,
    })
  );

  const settings = business.settings ?? {
    roundOffMode: "AUTOMATIC" as const,
    negativeStockPolicy: "ALLOW_WITH_WARNING" as const,
    invoicePrefix: "INV-",
    invoiceStartNumber: 1,
    financialYearFormat: false,
  };

  const totals = calculateInvoiceTotals({
    lines: lineResults,
    invoiceDiscount: { value: data.invoiceDiscountValue, type: data.invoiceDiscountType },
    roundOffMode: settings.roundOffMode,
  });

  const invoiceDate = data.invoiceDate ? new Date(data.invoiceDate) : new Date();
  const balance = Math.max(totals.total.toNumber() - data.receivedAmount, 0);
  const paymentStatus =
    data.receivedAmount <= 0 ? "UNPAID" : data.receivedAmount >= totals.total.toNumber() ? "PAID" : "PARTIALLY_PAID";

  const invoice = await prisma.$transaction(async (tx) => {
    const invoiceNo = await allocateInvoiceNumber(tx, business.id, settings, invoiceDate);

    const created = await tx.saleInvoice.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        invoiceNo,
        invoiceDate,
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        placeOfSupply: customer.state,
        taxType: intra ? "INTRA_STATE" : "INTER_STATE",
        subtotal: totals.subtotal.toNumber(),
        discount: totals.discount.toNumber(),
        taxableAmount: totals.taxableAmount.toNumber(),
        cgst: totals.cgst.toNumber(),
        sgst: totals.sgst.toNumber(),
        igst: totals.igst.toNumber(),
        cess: totals.cess.toNumber(),
        roundOff: totals.roundOff.toNumber(),
        total: totals.total.toNumber(),
        receivedAmount: data.receivedAmount,
        balance,
        paymentStatus,
        items: {
          create: enrichedItems.map((item, i) => ({
            productId: item.productId || null,
            productName: item.productName,
            hsn: item.hsn || null,
            unit: item.unit || null,
            quantity: item.quantity,
            rate: item.unitPrice,
            discount: item.discountValue,
            discountType: item.discountType,
            taxRate: item.gstRate,
            taxableAmount: lineResults[i].taxableValue.toNumber(),
            cgst: lineResults[i].cgst.toNumber(),
            sgst: lineResults[i].sgst.toNumber(),
            igst: lineResults[i].igst.toNumber(),
            finalAmount: lineResults[i].total.toNumber(),
          })),
        },
        ...(data.receivedAmount > 0
          ? { payments: { create: { amount: data.receivedAmount, type: data.paymentType } } }
          : {}),
      },
    });

    await deductStockForSale(
      tx,
      enrichedItems
        .filter((i) => i.productId)
        .map((i) => ({ productId: i.productId as string, quantity: i.quantity })),
      created.id,
      settings.negativeStockPolicy
    );

    return created;
  });

  req.session.flash = { type: "success", message: `Invoice ${invoice.invoiceNo} created.` };
  res.redirect(`/invoices/${invoice.id}`);
}

export async function showInvoicePreview(req: Request, res: Response) {
  const business = res.locals.business;
  const viewModel = await buildInvoiceViewModel(req.params.id, business.id);
  res.render("invoices/preview", { title: `Invoice ${viewModel.invoice.invoiceNo}`, activeNav: "invoices", ...viewModel });
}

export async function downloadInvoicePdf(req: Request, res: Response) {
  const business = res.locals.business;
  const viewModel = await buildInvoiceViewModel(req.params.id, business.id);
  const pdfBuffer = await renderInvoicePdf(viewModel);

  res.setHeader("Content-Type", "application/pdf");
  // e.g. Sale_103_05-08-2026.pdf
  const fileName = `Sale_${viewModel.invoice.invoiceNo}_${viewModel.formatDate(viewModel.invoice.invoiceDate)}`.replace(/[^A-Za-z0-9_-]/g, "-");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}.pdf"`);
  res.send(pdfBuffer);
}

const paymentSchema = z.object({
  amount: z.coerce.number().positive(),
  type: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CARD", "CREDIT", "OTHER"]).default("CASH"),
});

export async function recordPayment(req: Request, res: Response) {
  const business = res.locals.business;
  const parsed = paymentSchema.parse(req.body);

  const invoice = await prisma.saleInvoice.findFirst({ where: { id: req.params.id, businessId: business.id } });
  if (!invoice) throw new AppError("Invoice not found", 404);

  const newReceived = toDecimal(invoice.receivedAmount).plus(parsed.amount);
  const total = toDecimal(invoice.total);
  const balance = total.minus(newReceived).lessThan(0) ? 0 : total.minus(newReceived).toNumber();
  const paymentStatus = newReceived.greaterThanOrEqualTo(total) ? "PAID" : newReceived.greaterThan(0) ? "PARTIALLY_PAID" : "UNPAID";

  await prisma.$transaction([
    prisma.payment.create({ data: { invoiceId: invoice.id, amount: parsed.amount, type: parsed.type } }),
    prisma.saleInvoice.update({
      where: { id: invoice.id },
      data: { receivedAmount: newReceived.toNumber(), balance, paymentStatus },
    }),
  ]);

  req.session.flash = { type: "success", message: "Payment recorded." };
  res.redirect(`/invoices/${invoice.id}`);
}

export async function cancelInvoice(req: Request, res: Response) {
  const business = res.locals.business;
  const invoice = await prisma.saleInvoice.findFirst({ where: { id: req.params.id, businessId: business.id } });
  if (!invoice) throw new AppError("Invoice not found", 404);

  await prisma.$transaction(async (tx) => {
    await restoreStockForCancelledSale(tx, invoice.id);
    await tx.saleInvoice.update({ where: { id: invoice.id }, data: { status: "CANCELLED" } });
  });

  req.session.flash = { type: "success", message: `Invoice ${invoice.invoiceNo} cancelled and stock restored.` };
  res.redirect("/invoices");
}
