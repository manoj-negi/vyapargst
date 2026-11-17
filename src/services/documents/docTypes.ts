import type { DocType, StockTransactionType } from "@prisma/client";

export interface DocTypeConfig {
  docType: DocType;
  /** Printed title, e.g. "Tax Invoice" */
  title: string;
  /** Short label used in lists and messages */
  label: string;
  pluralLabel: string;
  /** URL base for this document type's pages */
  basePath: string;
  activeNav: string;
  side: "SALE" | "PURCHASE";
  partyLabel: string;
  /** Stock effect of one unit on this document: -1 removes stock, +1 adds it, 0 none */
  stockSign: -1 | 0 | 1;
  stockType: StockTransactionType | null;
  /**
   * Effect on what the party owes the business: +1 increases the receivable (sale invoice,
   * debit note), -1 decreases it (credit note, purchase bill), 0 none (estimate).
   */
  ledgerSign: -1 | 0 | 1;
  /** Payment direction that settles this document's balance */
  settlementDirection: "IN" | "OUT" | null;
  /** Document type a return note is raised against */
  returnOf: DocType | null;
  prefixSetting:
    | "invoicePrefix"
    | "estimatePrefix"
    | "creditNotePrefix"
    | "purchasePrefix"
    | "debitNotePrefix";
}

export const DOC_TYPES: Record<DocType, DocTypeConfig> = {
  SALE_INVOICE: {
    docType: "SALE_INVOICE",
    title: "Tax Invoice",
    label: "Sale Invoice",
    pluralLabel: "Sale Invoices",
    basePath: "/invoices",
    activeNav: "invoices",
    side: "SALE",
    partyLabel: "Customer",
    stockSign: -1,
    stockType: "SALE",
    ledgerSign: 1,
    settlementDirection: "IN",
    returnOf: null,
    prefixSetting: "invoicePrefix",
  },
  ESTIMATE: {
    docType: "ESTIMATE",
    title: "Estimate",
    label: "Estimate",
    pluralLabel: "Estimates / Quotations",
    basePath: "/estimates",
    activeNav: "estimates",
    side: "SALE",
    partyLabel: "Customer",
    stockSign: 0,
    stockType: null,
    ledgerSign: 0,
    settlementDirection: null,
    returnOf: null,
    prefixSetting: "estimatePrefix",
  },
  CREDIT_NOTE: {
    docType: "CREDIT_NOTE",
    title: "Credit Note",
    label: "Credit Note",
    pluralLabel: "Sale Returns / Credit Notes",
    basePath: "/credit-notes",
    activeNav: "credit-notes",
    side: "SALE",
    partyLabel: "Customer",
    stockSign: 1,
    stockType: "SALE_RETURN",
    ledgerSign: -1,
    settlementDirection: "OUT",
    returnOf: "SALE_INVOICE",
    prefixSetting: "creditNotePrefix",
  },
  PURCHASE_BILL: {
    docType: "PURCHASE_BILL",
    title: "Purchase Bill",
    label: "Purchase Bill",
    pluralLabel: "Purchase Bills",
    basePath: "/purchases",
    activeNav: "purchases",
    side: "PURCHASE",
    partyLabel: "Supplier",
    stockSign: 1,
    stockType: "PURCHASE",
    ledgerSign: -1,
    settlementDirection: "OUT",
    returnOf: null,
    prefixSetting: "purchasePrefix",
  },
  DEBIT_NOTE: {
    docType: "DEBIT_NOTE",
    title: "Debit Note",
    label: "Debit Note",
    pluralLabel: "Purchase Returns / Debit Notes",
    basePath: "/debit-notes",
    activeNav: "debit-notes",
    side: "PURCHASE",
    partyLabel: "Supplier",
    stockSign: -1,
    stockType: "PURCHASE_RETURN",
    ledgerSign: 1,
    settlementDirection: "IN",
    returnOf: "PURCHASE_BILL",
    prefixSetting: "debitNotePrefix",
  },
};

export function docConfig(docType: DocType): DocTypeConfig {
  return DOC_TYPES[docType];
}
