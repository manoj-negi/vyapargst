import { Prisma } from "@prisma/client";
import type { PaymentDirection, PaymentType, PaymentVoucher } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Decimal, toDecimal } from "../../lib/decimal";
import { AppError } from "../../middleware/errorHandler";
import { allocateNumber } from "../invoice/numbering";
import { writeAudit } from "../audit/audit";
import { refreshSettlement } from "./settlement";
import { docConfig } from "../documents/docTypes";
import type { ActionContext } from "../documents/documentService";

type TxClient = Prisma.TransactionClient;

export interface VoucherInput {
  direction: PaymentDirection;
  partyId: string | null;
  date: Date;
  amount: Decimal.Value;
  mode: PaymentType;
  reference?: string | null;
  note?: string | null;
  /** Explicit allocations; when omitted and autoAllocate is set, oldest open documents are settled first */
  allocations?: { documentId: string; amount: Decimal.Value }[];
  autoAllocate?: boolean;
  clientToken?: string | null;
}

/** Oldest-first allocation of an amount across the party's open documents settled in this direction. */
async function autoAllocations(tx: TxClient, businessId: string, partyId: string, direction: PaymentDirection, amount: Decimal) {
  const docTypes = (["SALE_INVOICE", "CREDIT_NOTE", "PURCHASE_BILL", "DEBIT_NOTE"] as const).filter(
    (t) => docConfig(t).settlementDirection === direction
  );
  const open = await tx.saleInvoice.findMany({
    where: { businessId, customerId: partyId, docType: { in: [...docTypes] }, status: "ACTIVE", balance: { gt: 0 } },
    orderBy: [{ invoiceDate: "asc" }, { createdAt: "asc" }],
  });
  const result: { documentId: string; amount: Decimal }[] = [];
  let left = amount;
  for (const doc of open) {
    if (left.lessThanOrEqualTo(0)) break;
    const take = Decimal.min(left, toDecimal(doc.balance));
    result.push({ documentId: doc.id, amount: take });
    left = left.minus(take);
  }
  return result;
}

/**
 * Records a payment-in or payment-out with its allocations inside the caller's transaction.
 * Any unallocated remainder stays on the party's account as an advance.
 */
export async function createVoucherInTx(tx: TxClient, ctx: ActionContext, input: VoucherInput): Promise<PaymentVoucher> {
  const business = ctx.business;
  const amount = toDecimal(input.amount);
  if (!amount.greaterThan(0)) throw new AppError("Payment amount must be more than 0", 422);
  if (input.mode === "CREDIT") throw new AppError("Choose how the money was paid (cash, bank, UPI…)", 422);

  if (input.partyId) {
    const party = await tx.customer.findFirst({ where: { id: input.partyId, businessId: business.id } });
    if (!party) throw new AppError("Party not found", 422);
  }

  const allocations =
    input.allocations && input.allocations.length > 0
      ? input.allocations.map((a) => ({ documentId: a.documentId, amount: toDecimal(a.amount) })).filter((a) => a.amount.greaterThan(0))
      : input.autoAllocate && input.partyId
        ? await autoAllocations(tx, business.id, input.partyId, input.direction, amount)
        : [];

  const allocated = allocations.reduce((s, a) => s.plus(a.amount), new Decimal(0));
  if (allocated.greaterThan(amount)) throw new AppError("Allocated amounts are more than the payment amount", 422);

  for (const a of allocations) {
    const doc = await tx.saleInvoice.findFirst({ where: { id: a.documentId, businessId: business.id } });
    if (!doc) throw new AppError("Document to settle was not found", 422);
    if (doc.status !== "ACTIVE") throw new AppError(`${doc.invoiceNo} is cancelled`, 422);
    if (doc.customerId !== input.partyId) throw new AppError(`${doc.invoiceNo} belongs to a different party`, 422);
    if (docConfig(doc.docType).settlementDirection !== input.direction) {
      throw new AppError(`${doc.invoiceNo} cannot be settled by a payment-${input.direction.toLowerCase()}`, 422);
    }
  }

  const settings = business.settings;
  const prefix = input.direction === "IN" ? settings?.paymentInPrefix ?? "PI-" : settings?.paymentOutPrefix ?? "PO-";
  const voucherNo = await allocateNumber(
    tx,
    business.id,
    prefix,
    { financialYearFormat: settings?.financialYearFormat ?? false, invoiceStartNumber: 1 },
    input.date
  );

  const voucher = await tx.paymentVoucher.create({
    data: {
      businessId: business.id,
      partyId: input.partyId,
      direction: input.direction,
      voucherNo,
      date: input.date,
      amount: amount.toFixed(2),
      mode: input.mode,
      reference: input.reference?.trim() || null,
      note: input.note?.trim() || null,
      clientToken: input.clientToken || null,
      allocations: { create: allocations.map((a) => ({ documentId: a.documentId, amount: a.amount.toFixed(2) })) },
    },
  });

  // refreshSettlement rejects the whole transaction if any document would be over-settled.
  for (const a of allocations) await refreshSettlement(tx, a.documentId);

  await writeAudit(tx, {
    businessId: business.id,
    userId: ctx.userId,
    entity: "PAYMENT",
    entityId: voucher.id,
    action: "CREATE",
    detail: { voucherNo, direction: input.direction, amount: amount.toFixed(2), allocated: allocated.toFixed(2) },
  });
  return voucher;
}

export async function createVoucher(ctx: ActionContext, input: VoucherInput): Promise<{ voucher: PaymentVoucher; duplicate: boolean }> {
  if (input.clientToken) {
    const already = await prisma.paymentVoucher.findUnique({ where: { clientToken: input.clientToken } });
    if (already) return { voucher: already, duplicate: true };
  }
  try {
    const voucher = await prisma.$transaction((tx) => createVoucherInTx(tx, ctx, input), { timeout: 30000 });
    return { voucher, duplicate: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && input.clientToken) {
      const already = await prisma.paymentVoucher.findUnique({ where: { clientToken: input.clientToken } });
      if (already) return { voucher: already, duplicate: true };
    }
    throw err;
  }
}

/** Cancels a payment; the documents it settled get their balances back. */
export async function cancelVoucher(ctx: ActionContext, id: string, reason: string): Promise<PaymentVoucher> {
  return prisma.$transaction(async (tx) => {
    const voucher = await tx.paymentVoucher.findFirst({ where: { id, businessId: ctx.business.id }, include: { allocations: true } });
    if (!voucher) throw new AppError("Payment not found", 404);

    const flipped = await tx.paymentVoucher.updateMany({
      where: { id: voucher.id, status: "ACTIVE" },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason.trim() || null },
    });
    if (flipped.count === 0) throw new AppError(`${voucher.voucherNo} is already cancelled`, 409);

    for (const a of voucher.allocations) await refreshSettlement(tx, a.documentId);

    await writeAudit(tx, {
      businessId: ctx.business.id,
      userId: ctx.userId,
      entity: "PAYMENT",
      entityId: voucher.id,
      action: "CANCEL",
      detail: { voucherNo: voucher.voucherNo, amount: voucher.amount.toString(), reason: reason.trim() },
    });
    return tx.paymentVoucher.findUniqueOrThrow({ where: { id: voucher.id } });
  });
}
