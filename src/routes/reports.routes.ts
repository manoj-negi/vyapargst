import { Router } from "express";
import * as reports from "../controllers/reports.controller";
import * as payments from "../controllers/payments.controller";
import * as expenses from "../controllers/expenses.controller";
import { requireBusiness } from "../middleware/auth";

export const reportsRouter = Router();

reportsRouter.get("/reports", requireBusiness, reports.showReportsIndex);
reportsRouter.get("/reports/:key", requireBusiness, reports.showReport);

reportsRouter.get("/payments", requireBusiness, payments.listPayments);
reportsRouter.get("/payments/new", requireBusiness, payments.showNewPayment);
reportsRouter.post("/payments", requireBusiness, payments.createPayment);
reportsRouter.get("/payments/:id", requireBusiness, payments.showPayment);
reportsRouter.post("/payments/:id/cancel", requireBusiness, payments.cancelPayment);

reportsRouter.get("/expenses", requireBusiness, expenses.listExpenses);
reportsRouter.get("/expenses/new", requireBusiness, expenses.showNewExpense);
reportsRouter.post("/expenses", requireBusiness, expenses.createExpenseHandler);
reportsRouter.post("/expenses/:id/cancel", requireBusiness, expenses.cancelExpenseHandler);
