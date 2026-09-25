import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { INDIAN_STATES } from "../lib/indianStates";
import { GSTIN_REGEX, PAN_REGEX, PHONE_REGEX } from "../lib/validators";

const customerSchema = z.object({
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
});

export async function listCustomers(req: Request, res: Response) {
  const business = res.locals.business;
  const q = (req.query.q as string) || "";

  const customers = await prisma.customer.findMany({
    where: {
      businessId: business.id,
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

  res.render("customers/list", { title: "Customers", activeNav: "customers", customers, q });
}

export async function showNewCustomer(req: Request, res: Response) {
  res.render("customers/form", {
    title: "Add Customer",
    activeNav: "customers",
    customer: null,
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
    return res.status(422).render("customers/form", {
      title: "Add Customer",
      activeNav: "customers",
      customer: req.body,
      states: INDIAN_STATES,
      errors: parsed.error.errors.map((e) => e.message),
    });
  }

  const data = parsed.data;
  await prisma.customer.create({
    data: {
      businessId: business.id,
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
    },
  });

  req.session.flash = { type: "success", message: "Customer saved successfully." };
  res.redirect("/customers");
}

export async function updateCustomer(req: Request, res: Response) {
  const business = res.locals.business;
  const existing = await prisma.customer.findFirst({ where: { id: req.params.id, businessId: business.id } });
  if (!existing) throw new AppError("Customer not found", 404);

  const parsed = customerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).render("customers/form", {
      title: "Edit Customer",
      activeNav: "customers",
      customer: { ...existing, ...req.body },
      states: INDIAN_STATES,
      errors: parsed.error.errors.map((e) => e.message),
    });
  }

  const data = parsed.data;
  await prisma.customer.update({
    where: { id: existing.id },
    data: {
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
    },
  });

  req.session.flash = { type: "success", message: "Customer updated successfully." };
  res.redirect("/customers");
}
