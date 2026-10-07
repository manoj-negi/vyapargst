import { Router } from "express";
import * as invoicesController from "../controllers/invoices.controller";
import { requireBusiness } from "../middleware/auth";

export const invoicesRouter = Router();

invoicesRouter.use(requireBusiness);

invoicesRouter.get("/invoices", invoicesController.listInvoices);
invoicesRouter.get("/invoices/new", invoicesController.showNewInvoice);
invoicesRouter.post("/invoices", invoicesController.createInvoice);
invoicesRouter.get("/invoices/:id", invoicesController.showInvoicePreview);
invoicesRouter.get("/invoices/:id/edit", invoicesController.showEditInvoice);
invoicesRouter.post("/invoices/:id/edit", invoicesController.updateInvoice);
invoicesRouter.get("/invoices/:id/pdf", invoicesController.downloadInvoicePdf);
invoicesRouter.post("/invoices/:id/payment", invoicesController.recordPayment);
invoicesRouter.post("/invoices/:id/cancel", invoicesController.cancelInvoice);
