import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { INDIAN_STATES } from "../lib/indianStates";
import { GSTIN_REGEX, PAN_REGEX, PHONE_REGEX } from "../lib/validators";
import { copyStandardHsn } from "../services/hsn/copyStandardHsn";

const businessSchema = z.object({
  name: z.string().trim().min(1, "Business name is required"),
  tradeName: z.string().trim().optional().or(z.literal("")),
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
  businessType: z.string().trim().optional().or(z.literal("")),
  phone: z
    .string()
    .trim()
    .refine((v) => v === "" || PHONE_REGEX.test(v), "Invalid Indian mobile number")
    .optional()
    .or(z.literal("")),
  email: z.string().trim().email().optional().or(z.literal("")),
  address: z.string().trim().optional().or(z.literal("")),
  city: z.string().trim().optional().or(z.literal("")),
  state: z.string().trim().refine((v) => (INDIAN_STATES as readonly string[]).includes(v), "Select a valid state"),
  pincode: z.string().trim().optional().or(z.literal("")),
  country: z.string().trim().default("India"),
  gstRegistered: z.enum(["YES", "NO"]).default("YES"),
  bankName: z.string().trim().optional().or(z.literal("")),
  bankAccountNo: z
    .string()
    .trim()
    .refine((v) => v === "" || /^[0-9]{6,18}$/.test(v), "Account number must be 6-18 digits")
    .optional()
    .or(z.literal("")),
  bankIfsc: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === "" || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v), "Invalid IFSC code")
    .optional()
    .or(z.literal("")),
  bankAccountHolder: z.string().trim().optional().or(z.literal("")),
});

export async function showBusinessSetup(req: Request, res: Response) {
  const business = await prisma.business.findFirst({
    where: { ownerId: req.session.userId },
    include: { settings: true },
  });

  res.render("business/setup", {
    title: "Business Profile",
    activeNav: "business",
    business,
    states: INDIAN_STATES,
    errors: null,
  });
}

export async function saveBusinessSetup(req: Request, res: Response) {
  const parsed = businessSchema.safeParse(req.body);

  if (!parsed.success) {
    const business = await prisma.business.findFirst({ where: { ownerId: req.session.userId } });
    return res.status(422).render("business/setup", {
      title: "Business Profile",
      activeNav: "business",
      business: { ...business, ...req.body },
      states: INDIAN_STATES,
      errors: parsed.error.errors.map((e) => e.message),
    });
  }

  const data = parsed.data;
  const logoPath = req.file ? `/uploads/logos/${req.file.filename}` : undefined;

  const existing = await prisma.business.findFirst({ where: { ownerId: req.session.userId! } });

  const businessData = {
    name: data.name,
    tradeName: data.tradeName || null,
    gstin: data.gstin || null,
    pan: data.pan || null,
    businessType: data.businessType || null,
    phone: data.phone || null,
    email: data.email || null,
    address: data.address || null,
    city: data.city || null,
    state: data.state,
    pincode: data.pincode || null,
    country: data.country,
    gstRegistered: data.gstRegistered === "YES",
    bankName: data.bankName || null,
    bankAccountNo: data.bankAccountNo || null,
    bankIfsc: data.bankIfsc || null,
    bankAccountHolder: data.bankAccountHolder || null,
    ...(logoPath ? { logoPath } : {}),
  };

  let business;
  if (existing) {
    business = await prisma.business.update({ where: { id: existing.id }, data: businessData });
  } else {
    business = await prisma.business.create({
      data: {
        ...businessData,
        ownerId: req.session.userId!,
        settings: { create: {} },
      },
    });
    await copyStandardHsn(business.id);
  }

  req.session.businessId = business.id;
  res.redirect("/dashboard");
}
