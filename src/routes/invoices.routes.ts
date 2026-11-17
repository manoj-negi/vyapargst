import { Router } from "express";
import type { DocType } from "@prisma/client";
import { documentController } from "../controllers/documents.controller";
import { docConfig } from "../services/documents/docTypes";
import { requireBusiness } from "../middleware/auth";

export const invoicesRouter = Router();

/** Same pages for every trade document; /invoices keeps its original URLs. */
const DOCUMENT_TYPES: DocType[] = ["SALE_INVOICE", "ESTIMATE", "CREDIT_NOTE", "PURCHASE_BILL", "DEBIT_NOTE"];

for (const docType of DOCUMENT_TYPES) {
  const base = docConfig(docType).basePath;
  const c = documentController(docType);
  invoicesRouter.get(base, requireBusiness, c.list);
  invoicesRouter.get(`${base}/new`, requireBusiness, c.showNew);
  invoicesRouter.post(base, requireBusiness, c.create);
  invoicesRouter.get(`${base}/:id`, requireBusiness, c.show);
  invoicesRouter.get(`${base}/:id/edit`, requireBusiness, c.showEdit);
  invoicesRouter.post(`${base}/:id/edit`, requireBusiness, c.update);
  invoicesRouter.get(`${base}/:id/pdf`, requireBusiness, c.pdf);
  invoicesRouter.post(`${base}/:id/payment`, requireBusiness, c.recordPayment);
  invoicesRouter.post(`${base}/:id/cancel`, requireBusiness, c.cancel);
}
