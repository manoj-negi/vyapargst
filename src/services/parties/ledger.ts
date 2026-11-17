import type { DocType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Decimal, toDecimal } from "../../lib/decimal";
import { DOC_TYPES } from "../documents/docTypes";

/**
 * Party balances, derived from documents and payments (never stored, so they cannot drift).
 * Positive = the party owes the business (to receive); negative = the business owes the party (to pay).
 *
 *   opening + sale invoices + debit notes + payments out − credit notes − purchase bills − payments in
 */
export async function partyBalances(businessId: string, partyIds?: string[]): Promise<Map<string, Decimal>> {
  const partyFilter = partyIds ? { in: partyIds } : undefined;
  const [parties, docs, vouchers] = await Promise.all([
    prisma.customer.findMany({ where: { businessId, ...(partyFilter ? { id: partyFilter } : {}) }, select: { id: true, openingBalance: true } }),
    prisma.saleInvoice.groupBy({
      by: ["customerId", "docType"],
      where: { businessId, status: "ACTIVE", docType: { not: "ESTIMATE" }, ...(partyFilter ? { customerId: partyFilter } : {}) },
      _sum: { total: true },
    }),
    prisma.paymentVoucher.groupBy({
      by: ["partyId", "direction"],
      where: { businessId, status: "ACTIVE", ...(partyFilter ? { partyId: partyFilter } : { partyId: { not: null } }) },
      _sum: { amount: true },
    }),
  ]);

  const balances = new Map<string, Decimal>();
  for (const p of parties) balances.set(p.id, toDecimal(p.openingBalance));
  for (const d of docs) {
    const sign = DOC_TYPES[d.docType].ledgerSign;
    balances.set(d.customerId, (balances.get(d.customerId) ?? new Decimal(0)).plus(toDecimal(d._sum.total).times(sign)));
  }
  for (const v of vouchers) {
    if (!v.partyId) continue;
    const sign = v.direction === "IN" ? -1 : 1;
    balances.set(v.partyId, (balances.get(v.partyId) ?? new Decimal(0)).plus(toDecimal(v._sum.amount).times(sign)));
  }
  return balances;
}

export interface LedgerEntry {
  date: Date;
  kind: string;
  number: string;
  link: string | null;
  debit: Decimal;
  credit: Decimal;
  balance: Decimal;
}

export interface PartyStatement {
  openingBalance: Decimal;
  entries: LedgerEntry[];
  totalDebit: Decimal;
  totalCredit: Decimal;
  closingBalance: Decimal;
}

/**
 * Party statement for a period. Debit increases what the party owes (sales, payments made to
 * them); credit reduces it (purchases, returns, payments received). The opening line carries the
 * party's opening balance plus everything dated before `from`.
 */
export async function partyStatement(businessId: string, partyId: string, from?: Date, to?: Date): Promise<PartyStatement> {
  const party = await prisma.customer.findFirstOrThrow({ where: { id: partyId, businessId } });
  const [docs, vouchers] = await Promise.all([
    prisma.saleInvoice.findMany({
      where: { businessId, customerId: partyId, status: "ACTIVE", docType: { not: "ESTIMATE" }, ...(to ? { invoiceDate: { lte: to } } : {}) },
      orderBy: [{ invoiceDate: "asc" }, { createdAt: "asc" }],
    }),
    prisma.paymentVoucher.findMany({
      where: { businessId, partyId, status: "ACTIVE", ...(to ? { date: { lte: to } } : {}) },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  const raw: Omit<LedgerEntry, "balance">[] = [
    ...docs.map((d) => {
      const config = DOC_TYPES[d.docType as DocType];
      const amount = toDecimal(d.total);
      return {
        date: d.invoiceDate,
        kind: config.label,
        number: d.invoiceNo,
        link: `${config.basePath}/${d.id}`,
        debit: config.ledgerSign > 0 ? amount : new Decimal(0),
        credit: config.ledgerSign < 0 ? amount : new Decimal(0),
      };
    }),
    ...vouchers.map((v) => ({
      date: v.date,
      kind: v.direction === "IN" ? "Payment In" : "Payment Out",
      number: v.voucherNo,
      link: `/payments/${v.id}`,
      debit: v.direction === "OUT" ? toDecimal(v.amount) : new Decimal(0),
      credit: v.direction === "IN" ? toDecimal(v.amount) : new Decimal(0),
    })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  let opening = toDecimal(party.openingBalance);
  const inPeriod = raw.filter((e) => {
    if (from && e.date < from) {
      opening = opening.plus(e.debit).minus(e.credit);
      return false;
    }
    return true;
  });

  let running = opening;
  const entries = inPeriod.map((e) => {
    running = running.plus(e.debit).minus(e.credit);
    return { ...e, balance: running };
  });

  return {
    openingBalance: opening,
    entries,
    totalDebit: entries.reduce((s, e) => s.plus(e.debit), new Decimal(0)),
    totalCredit: entries.reduce((s, e) => s.plus(e.credit), new Decimal(0)),
    closingBalance: running,
  };
}
