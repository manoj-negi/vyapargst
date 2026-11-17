import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { INDIAN_STATES } from "../lib/indianStates";
import { GSTIN_REGEX, PAN_REGEX, PHONE_REGEX } from "../lib/validators";
import { toDecimal } from "../lib/decimal";
import { partyBalances, partyStatement } from "../services/parties/ledger";
import { writeAudit } from "../services/audit/audit";
import { toCsv, sendCsv } from "../services/reports/csv";
import { renderReportPdf } from "../services/reports/reportPdf";
import { fieldErrorsFrom } from "../lib/viewHelpers";

export const customerSchema = z.object({
  name: z.string().trim().min(1, "Customer name is required"),
  phone: z
    .string()
    .trim()
    .refine((v) => v === "" || PHONE_REGEX.test(v), "Invalid Indian mobile number")
    .optional()
    .or(z.literal("")),
  email: z.string().trim().email().optional().or(z.literal("")),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === "" || GSTIN_REGEX.test(v), "Invalid GSTIN format")
    .optional()
    .or(z.literal("")),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === "" || PAN_REGEX.test(v), "Invalid PAN format")
    .optional()
    .or(z.literal("")),
  billingAddress: z.string().trim().optional().or(z.literal("")),
  shippingAddress: z.string().trim().optional().or(z.literal("")),
  state: z.string().trim().refine((v) => (INDIAN_STATES as readonly string[]).includes(v), "Select a valid state"),
  pincode: z.string().trim().optional().or(z.literal("")),
  customerType: z.enum(["REGISTERED", "UNREGISTERED", "CONSUMER"]).default("CONSUMER"),
  department: z.string().trim().optional().or(z.literal("")),
  section: z.string().trim().optional().or(z.literal("")),
  partyType: z.enum(["CUSTOMER", "SUPPLIER", "BOTH"]).default("CUSTOMER"),
  openingBalanceAmount: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().min(0, "Opening balance cannot be negative").default(0)),
  openingBalanceSide: z.enum(["RECEIVE", "PAY"]).default("RECEIVE"),
  openingBalanceDate: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.date().optional()),
});

export function toCustomerData(data: z.infer<typeof customerSchema>) {
  return {
    name: data.name,
    phone: data.phone || null,
    email: data.email || null,
    gstin: data.gstin || null,
    pan: data.pan || null,
    billingAddress: data.billingAddress || null,
    shippingAddress: data.shippingAddress || null,
    state: data.state,
    pincode: data.pincode || null,
    customerType: data.customerType,
    department: data.department || null,
    section: data.section || null,
    partyType: data.partyType,
    openingBalance: toDecimal(data.openingBalanceAmount).times(data.openingBalanceSide === "PAY" ? -1 : 1).toFixed(2),
    openingBalanceDate: data.openingBalanceAmount > 0 ? data.openingBalanceDate ?? new Date() : null,
  };
}

const PARTY_LABELS: Record<string, string> = { CUSTOMER: "Customer", SUPPLIER: "Supplier", BOTH: "Customer & Supplier" };

export async function listCustomers(req: Request, res: Response) {
  const business = res.locals.business;
  const q = (req.query.q as string) || "";
  const type = (req.query.type as string) || "";
  const typeFilter = type === "supplier" ? ["SUPPLIER", "BOTH"] : type === "customer" ? ["CUSTOMER", "BOTH"] : null;

  const customers = await prisma.customer.findMany({
    where: {
      businessId: business.id,
      ...(typeFilter ? { partyType: { in: typeFilter as ("CUSTOMER" | "SUPPLIER" | "BOTH")[] } } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { phone: { contains: q, mode: "insensitive" } },
              { gstin: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { name: "asc" },
  });

  const balances = await partyBalances(business.id, customers.map((c) => c.id));
  const rows = customers.map((c) => ({ ...c, balance: balances.get(c.id)?.toNumber() ?? 0, partyLabel: PARTY_LABELS[c.partyType] }));
  const toReceive = rows.reduce((s, r) => s + (r.balance > 0 ? r.balance : 0), 0);
  const toPay = rows.reduce((s, r) => s + (r.balance < 0 ? -r.balance : 0), 0);

  res.render("customers/list", {
    title: type === "supplier" ? "Suppliers" : type === "customer" ? "Customers" : "Parties",
    activeNav: type === "supplier" ? "suppliers" : "customers",
    customers: rows,
    q,
    type,
    totals: { toReceive, toPay },
  });
}

export async function showNewCustomer(req: Request, res: Response) {
  res.render("customers/form", {
    title: "Add Customer",
    activeNav: "customers",
    customer: req.query.type === "supplier" ? { partyType: "SUPPLIER", state: res.locals.business.state } : null,
    states: INDIAN_STATES,
    errors: null,
  });
}

export async function showEditCustomer(req: Request, res: Response) {
  const business = res.locals.business;
  const customer = await prisma.customer.findFirst({ where: { id: req.params.id, businessId: business.id } });
  if (!customer) throw new AppError("Customer not found", 404);

  res.render("customers/form", {
    title: "Edit Customer",
    activeNav: "customers",
    customer,
    states: INDIAN_STATES,
    errors: null,
  });
}

export async function createCustomer(req: Request, res: Response) {
  const business = res.locals.business;
  const parsed = customerSchema.safeParse(req.body);

  if (!parsed.success) {
    res.locals.fieldErrors = fieldErrorsFrom(parsed.error);
    return res.status(422).render("customers/form", {
      title: "Add Customer",
      activeNav: "customers",
      customer: req.body,
      states: INDIAN_STATES,
      errors: parsed.error.errors.map((e) => e.message),
    });
  }

  const data = parsed.data;
  const created = await prisma.customer.create({
    data: {
      businessId: business.id,
      ...toCustomerData(data),
    },
  });

  req.session.flash = { type: "success", message: `${PARTY_LABELS[created.partyType]} saved successfully.` };
  res.redirect(created.partyType === "SUPPLIER" ? "/customers?type=supplier" : "/customers");
}

export async function updateCustomer(req: Request, res: Response) {
  const business = res.locals.business;
  const existing = await prisma.customer.findFirst({ where: { id: req.params.id, businessId: business.id } });
  if (!existing) throw new AppError("Customer not found", 404);

  const parsed = customerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.locals.fieldErrors = fieldErrorsFrom(parsed.error);
    return res.status(422).render("customers/form", {
      title: "Edit Customer",
      activeNav: "customers",
      customer: { ...existing, ...req.body },
      states: INDIAN_STATES,
      errors: parsed.error.errors.map((e) => e.message),
    });
  }

  const data = parsed.data;
  const updates = toCustomerData(data);
  await prisma.$transaction(async (tx) => {
    await tx.customer.update({ where: { id: existing.id }, data: updates });
    if (!toDecimal(existing.openingBalance).equals(toDecimal(updates.openingBalance))) {
      await writeAudit(tx, {
        businessId: business.id,
        userId: req.session.userId,
        entity: "PARTY",
        entityId: existing.id,
        action: "OPENING_BALANCE_CHANGE",
        detail: { from: existing.openingBalance.toString(), to: updates.openingBalance },
      });
    }
  });

  req.session.flash = { type: "success", message: `${PARTY_LABELS[updates.partyType]} updated successfully.` };
  res.redirect(`/customers/${existing.id}`);
}

/** Party statement: opening balance, every document and payment in the period, running balance. */
export async function showStatement(req: Request, res: Response) {
  const business = res.locals.business;
  const party = await prisma.customer.findFirst({ where: { id: req.params.id, businessId: business.id } });
  if (!party) throw new AppError("Party not found", 404);

  const { from, to, format } = req.query as Record<string, string>;
  const fromDate = from ? new Date(from) : undefined;
  const toDate = to ? new Date(`${to}T23:59:59.999`) : undefined;
  const statement = await partyStatement(business.id, party.id, fromDate, toDate);

  const columns = ["Date", "Type", "Number", "Debit (₹)", "Credit (₹)", "Balance (₹)"];
  const fmtBal = (v: ReturnType<typeof toDecimal>) => `${v.abs().toFixed(2)} ${v.isNegative() ? "Cr" : "Dr"}`;
  const tableRows = [
    [from || "", "Opening Balance", "", "", "", fmtBal(statement.openingBalance)],
    ...statement.entries.map((e) => [e.date.toISOString().slice(0, 10), e.kind, e.number, e.debit.isZero() ? "" : e.debit.toFixed(2), e.credit.isZero() ? "" : e.credit.toFixed(2), fmtBal(e.balance)]),
    ["", "Total", "", statement.totalDebit.toFixed(2), statement.totalCredit.toFixed(2), fmtBal(statement.closingBalance)],
  ];
  const title = `Statement — ${party.name}`;
  const subtitle = `${from || "Beginning"} to ${to || "today"} · Dr = ${party.name} owes you, Cr = you owe ${party.name}`;
  if (format === "csv") return sendCsv(res, `statement-${party.name}`, toCsv(columns, tableRows));
  if (format === "pdf") return renderReportPdf(res, `statement-${party.name}`, { title, subtitle, business, columns, rows: tableRows });

  const openDocs = await prisma.saleInvoice.findMany({
    where: { businessId: business.id, customerId: party.id, status: "ACTIVE", balance: { gt: 0 }, docType: { not: "ESTIMATE" } },
    orderBy: { invoiceDate: "asc" },
  });

  res.render("customers/statement", {
    title,
    activeNav: party.partyType === "SUPPLIER" ? "suppliers" : "customers",
    party,
    partyLabel: PARTY_LABELS[party.partyType],
    statement,
    openDocs,
    filters: { from: from || "", to: to || "" },
  });
}
