import type { Prisma, PrismaClient } from "@prisma/client";

type TxClient = Prisma.TransactionClient | PrismaClient;

/** Indian financial year runs April -> March, formatted as "2026-27". */
export function computeFinancialYear(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed; April = 3
  const startYear = month >= 3 ? year : year - 1;
  const endYearShort = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endYearShort}`;
}

export interface NumberingSettings {
  invoicePrefix: string;
  invoiceStartNumber: number;
  financialYearFormat: boolean;
}

/**
 * Atomically allocates the next invoice number for a business inside the given transaction.
 * Must be called within the same Prisma transaction that creates the SaleInvoice row, so the
 * sequence increment and the invoice row are committed (or rolled back) together.
 */
export async function allocateInvoiceNumber(
  tx: TxClient,
  businessId: string,
  settings: NumberingSettings,
  invoiceDate: Date
): Promise<string> {
  return allocateNumber(tx, businessId, settings.invoicePrefix, settings, invoiceDate);
}

/** GST Rule 46(b): a tax invoice serial number may not exceed 16 characters. */
export const MAX_DOCUMENT_NUMBER_LENGTH = 16;

/** Longest number a prefix can produce (4-digit counter, plus "YYYY-YY/" when FY numbering is on). */
export function sampleDocumentNumber(prefix: string, financialYearFormat: boolean, date = new Date()): string {
  return financialYearFormat ? `${prefix}${computeFinancialYear(date)}/0001` : `${prefix}0001`;
}

/**
 * Allocates the next number in the series identified by prefix (+ financial year when enabled).
 * Each document type uses its own prefix, so each gets its own consecutive series.
 */
export async function allocateNumber(
  tx: TxClient,
  businessId: string,
  prefix: string,
  settings: Pick<NumberingSettings, "invoiceStartNumber" | "financialYearFormat">,
  invoiceDate: Date
): Promise<string> {
  // "" (not null) when FY numbering is off — see schema comment on InvoiceSequence.financialYear.
  const financialYear = settings.financialYearFormat ? computeFinancialYear(invoiceDate) : "";

  const sequence = await tx.invoiceSequence.upsert({
    where: {
      businessId_prefix_financialYear: { businessId, prefix, financialYear },
    },
    create: {
      businessId,
      prefix,
      financialYear,
      lastNumber: settings.invoiceStartNumber,
    },
    update: {
      lastNumber: { increment: 1 },
    },
  });

  const paddedNumber = String(sequence.lastNumber).padStart(4, "0");
  return financialYear ? `${prefix}${financialYear}/${paddedNumber}` : `${prefix}${paddedNumber}`;
}
