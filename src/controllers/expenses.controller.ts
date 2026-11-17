import crypto from "node:crypto";
import type { Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { fieldErrorsFrom } from "../lib/viewHelpers";
import { cancelExpense, createExpense } from "../services/expenses/expenseService";

const DEFAULT_CATEGORIES = ["Rent", "Salary", "Electricity", "Transport", "Office Supplies", "Repairs", "Telephone & Internet", "Miscellaneous"];

const expenseSchema = z.object({
  date: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.date().optional()),
  categoryName: z.string().trim().min(1, "Choose or type an expense category").max(60),
  amount: z.coerce.number().positive("Amount must be more than 0"),
  mode: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CARD", "OTHER"], { message: "Choose a payment mode" }),
  paidTo: z.string().trim().max(100).optional(),
  note: z.string().trim().max(300).optional(),
  clientToken: z.string().trim().max(64).optional(),
});

export async function listExpenses(req: Request, res: Response) {
  const business = res.locals.business;
  const { from, to, categoryId, status } = req.query as Record<string, string>;
  const where: Prisma.ExpenseWhereInput = {
    businessId: business.id,
    status: status === "CANCELLED" ? "CANCELLED" : status === "ALL" ? undefined : "ACTIVE",
    ...(categoryId ? { categoryId } : {}),
  };
  if (from || to) where.date = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999`) } : {}) };
  const [expenses, categories] = await Promise.all([
    prisma.expense.findMany({ where, include: { category: true }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 500 }),
    prisma.expenseCategory.findMany({ where: { businessId: business.id }, orderBy: { name: "asc" } }),
  ]);
  res.render("expenses/list", {
    title: "Expenses",
    activeNav: "expenses",
    expenses,
    categories,
    total: expenses.filter((e) => e.status === "ACTIVE").reduce((s, e) => s + Number(e.amount), 0),
    filters: { from: from || "", to: to || "", categoryId: categoryId || "", status: status || "" },
  });
}

async function renderForm(res: Response, values: Record<string, unknown>, errors: string[] | null, status = 200) {
  const categories = await prisma.expenseCategory.findMany({ where: { businessId: res.locals.business.id }, orderBy: { name: "asc" } });
  const names = [...new Set([...categories.map((c) => c.name), ...DEFAULT_CATEGORIES])].sort();
  res.status(status).render("expenses/form", {
    title: "Add Expense",
    activeNav: "expenses",
    categoryNames: names,
    values: { date: new Date().toISOString().slice(0, 10), mode: "CASH", ...values, clientToken: values.clientToken || crypto.randomUUID() },
    errors,
  });
}

export async function showNewExpense(_req: Request, res: Response) {
  await renderForm(res, {}, null);
}

export async function createExpenseHandler(req: Request, res: Response) {
  const parsed = expenseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.locals.fieldErrors = fieldErrorsFrom(parsed.error);
    return renderForm(res, req.body, parsed.error.errors.map((e) => e.message), 422);
  }
  try {
    const { expense, duplicate } = await createExpense(
      { business: res.locals.business, userId: req.session.userId },
      { ...parsed.data, date: parsed.data.date ?? new Date() }
    );
    req.session.flash = { type: duplicate ? "info" : "success", message: duplicate ? `${expense.expenseNo} was already saved.` : `Expense ${expense.expenseNo} saved.` };
    res.redirect("/expenses");
  } catch (err) {
    if (err instanceof AppError && err.status < 500) return renderForm(res, req.body, [err.message], 422);
    throw err;
  }
}

export async function cancelExpenseHandler(req: Request, res: Response) {
  try {
    const expense = await cancelExpense({ business: res.locals.business, userId: req.session.userId }, req.params.id, String(req.body?.reason ?? ""));
    req.session.flash = { type: "success", message: `${expense.expenseNo} cancelled.` };
  } catch (err) {
    if (!(err instanceof AppError) || err.status >= 500) throw err;
    req.session.flash = { type: "danger", message: err.message };
  }
  res.redirect("/expenses");
}
