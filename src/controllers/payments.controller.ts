import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { fieldErrorsFrom } from "../lib/viewHelpers";
import { cancelVoucher, createVoucher } from "../services/payments/paymentService";
import { DOC_TYPES } from "../services/documents/docTypes";

const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);

const voucherSchema = z.object({
  direction: z.enum(["IN", "OUT"]),
  partyId: z.string().trim().min(1, "Select a party"),
  date: z.preprocess(blankToUndefined, z.coerce.date().optional()),
  amount: z.coerce.number().positive("Amount must be more than 0"),
  mode: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CARD", "OTHER"], { message: "Choose a payment mode" }),
  reference: z.string().trim().max(60).optional(),
  note: z.string().trim().max(300).optional(),
  allocationMode: z.enum(["AUTO", "MANUAL"]).default("AUTO"),
  alloc: z.record(z.string(), z.preprocess(blankToUndefined, z.coerce.number().min(0).optional())).optional(),
  clientToken: z.string().trim().max(64).optional(),
});

function settlesWith(direction: "IN" | "OUT") {
  return Object.values(DOC_TYPES).filter((c) => c.settlementDirection === direction).map((c) => c.docType);
}

export async function listPayments(req: Request, res: Response) {
  const business = res.locals.business;
  const { direction, from, to, partyId, status } = req.query as Record<string, string>;
  const where: Prisma.PaymentVoucherWhereInput = {
    businessId: business.id,
    status: status === "CANCELLED" ? "CANCELLED" : status === "ALL" ? undefined : "ACTIVE",
    ...(direction === "IN" || direction === "OUT" ? { direction } : {}),
    ...(partyId ? { partyId } : {}),
  };
  if (from || to) where.date = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999`) } : {}) };

  const [vouchers, parties] = await Promise.all([
    prisma.paymentVoucher.findMany({ where, include: { party: true, allocations: { include: { document: { select: { invoiceNo: true } } } } }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 500 }),
    prisma.customer.findMany({ where: { businessId: business.id }, orderBy: { name: "asc" } }),
  ]);
  const active = vouchers.filter((v) => v.status === "ACTIVE");
  res.render("payments/list", {
    title: direction === "OUT" ? "Payment Out" : direction === "IN" ? "Payment In" : "Payments",
    activeNav: direction === "OUT" ? "payment-out" : "payment-in",
    vouchers,
    parties,
    totals: {
      in: active.filter((v) => v.direction === "IN").reduce((s, v) => s + Number(v.amount), 0),
      out: active.filter((v) => v.direction === "OUT").reduce((s, v) => s + Number(v.amount), 0),
    },
    filters: { direction: direction || "", from: from || "", to: to || "", partyId: partyId || "", status: status || "" },
  });
}

async function renderVoucherForm(req: Request, res: Response, values: Record<string, unknown>, errors: string[] | null, status = 200) {
  const business = res.locals.business;
  const direction = values.direction === "OUT" ? "OUT" : "IN";
  const parties = await prisma.customer.findMany({ where: { businessId: business.id, isActive: true }, orderBy: { name: "asc" } });
  const partyId = typeof values.partyId === "string" ? values.partyId : "";
  const openDocs = partyId
    ? await prisma.saleInvoice.findMany({
        where: { businessId: business.id, customerId: partyId, status: "ACTIVE", balance: { gt: 0 }, docType: { in: settlesWith(direction) } },
        orderBy: [{ invoiceDate: "asc" }, { createdAt: "asc" }],
      })
    : [];
  res.status(status).render("payments/form", {
    title: direction === "IN" ? "Payment In" : "Payment Out",
    activeNav: direction === "IN" ? "payment-in" : "payment-out",
    direction,
    parties,
    openDocs: openDocs.map((d) => ({ ...d, label: DOC_TYPES[d.docType].label })),
    values: { date: new Date().toISOString().slice(0, 10), mode: "CASH", allocationMode: "AUTO", ...values, clientToken: values.clientToken || crypto.randomUUID() },
    errors,
  });
}

export async function showNewPayment(req: Request, res: Response) {
  const { direction, partyId, documentId } = req.query as Record<string, string>;
  const values: Record<string, unknown> = { direction: direction === "OUT" ? "OUT" : "IN", partyId: partyId || "" };
  if (documentId) {
    const doc = await prisma.saleInvoice.findFirst({ where: { id: documentId, businessId: res.locals.business.id } });
    if (doc) Object.assign(values, { partyId: doc.customerId, amount: Number(doc.balance), allocationMode: "MANUAL", alloc: { [doc.id]: Number(doc.balance) } });
  }
  await renderVoucherForm(req, res, values, null);
}

export async function createPayment(req: Request, res: Response) {
  const parsed = voucherSchema.safeParse(req.body);
  if (!parsed.success) {
    res.locals.fieldErrors = fieldErrorsFrom(parsed.error);
    return renderVoucherForm(req, res, req.body, parsed.error.errors.map((e) => e.message), 422);
  }
  const data = parsed.data;

  const allocations =
    data.allocationMode === "MANUAL"
      ? Object.entries(data.alloc ?? {})
          .filter(([, amount]) => amount !== undefined && amount > 0)
          .map(([documentId, amount]) => ({ documentId, amount: amount as number }))
      : [];

  try {
    const { voucher, duplicate } = await createVoucher(
      { business: res.locals.business, userId: req.session.userId },
      {
        direction: data.direction,
        partyId: data.partyId,
        date: data.date ?? new Date(),
        amount: data.amount,
        mode: data.mode,
        reference: data.reference,
        note: data.note,
        allocations,
        autoAllocate: data.allocationMode === "AUTO",
        clientToken: data.clientToken,
      }
    );
    req.session.flash = { type: duplicate ? "info" : "success", message: duplicate ? `${voucher.voucherNo} was already saved.` : `Payment ${voucher.voucherNo} saved.` };
    res.redirect(`/payments/${voucher.id}`);
  } catch (err) {
    if (err instanceof AppError && err.status < 500) return renderVoucherForm(req, res, req.body, [err.message], 422);
    throw err;
  }
}

export async function showPayment(req: Request, res: Response) {
  const voucher = await prisma.paymentVoucher.findFirst({
    where: { id: req.params.id, businessId: res.locals.business.id },
    include: { party: true, allocations: { include: { document: true } } },
  });
  if (!voucher) throw new AppError("Payment not found", 404);
  const allocated = voucher.allocations.reduce((s, a) => s + Number(a.amount), 0);
  res.render("payments/show", {
    title: `${voucher.direction === "IN" ? "Payment In" : "Payment Out"} ${voucher.voucherNo}`,
    activeNav: voucher.direction === "IN" ? "payment-in" : "payment-out",
    voucher,
    allocations: voucher.allocations.map((a) => ({ ...a, basePath: DOC_TYPES[a.document.docType].basePath, label: DOC_TYPES[a.document.docType].label })),
    unallocated: Number(voucher.amount) - allocated,
  });
}

export async function cancelPayment(req: Request, res: Response) {
  try {
    const voucher = await cancelVoucher({ business: res.locals.business, userId: req.session.userId }, req.params.id, String(req.body?.reason ?? ""));
    req.session.flash = { type: "success", message: `${voucher.voucherNo} cancelled; the documents it settled are open again.` };
  } catch (err) {
    if (!(err instanceof AppError) || err.status >= 500) throw err;
    req.session.flash = { type: "danger", message: err.message };
  }
  res.redirect(`/payments/${req.params.id}`);
}
