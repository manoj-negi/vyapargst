import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { INDIAN_STATES } from "../lib/indianStates";
import { GSTIN_REGEX, PAN_REGEX, PHONE_REGEX } from "../lib/validators";
import { copyStandardHsn } from "../services/hsn/copyStandardHsn";
import { fieldErrorsFrom } from "../lib/viewHelpers";
import fs from "node:fs/promises";
import { clampWidthMm, describeImage, makeTransparent } from "../services/business/stamp";

const checkbox = z.preprocess((v) => v === "on" || v === "1" || v === "true" || v === true, z.boolean());

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
  upiId: z
    .string()
    .trim()
    .refine((v) => v === "" || /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,63}$/.test(v), "Invalid UPI ID (expected name@bank)")
    .optional()
    .or(z.literal("")),
  upiName: z.string().trim().max(80).optional().or(z.literal("")),
  invoiceTerms: z.string().trim().max(2000).optional().or(z.literal("")),
  // Stamp & signature (signatory box of sale documents)
  signatureMode: z.enum(["clean", "original"]).optional(),
  signatureWidthMm: z.preprocess((v) => (v === "" || v == null ? undefined : v), z.coerce.number().optional()),
  signatureOnInvoices: checkbox.default(false),
  signatureHidesHeading: checkbox.default(false),
  removeSignature: checkbox.default(false),
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
    res.locals.fieldErrors = fieldErrorsFrom(parsed.error);
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
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;
  const logoPath = files.logo?.[0] ? `/uploads/logos/${files.logo[0].filename}` : undefined;
  const signatureFile = files.signature?.[0];

  const existing = await prisma.business.findFirst({ where: { ownerId: req.session.userId! } });

  const rerender = async (message: string) => {
    await Promise.all(Object.values(files).flat().map((f) => f && fs.unlink(f.path).catch(() => {})));
    return res.status(422).render("business/setup", {
      title: "Business Profile",
      activeNav: "business",
      business: { ...existing, ...req.body, signatureOnInvoices: data.signatureOnInvoices, signatureHidesHeading: data.signatureHidesHeading },
      states: INDIAN_STATES,
      errors: [message],
    });
  };
  // The upload limit allows phone photos of a stamp; logos stay at 2 MB
  if (files.logo?.[0] && files.logo[0].size > 2 * 1024 * 1024) return rerender("The logo can be at most 2 MB.");

  // Stamp & signature: keep the original upload, make a transparent-background copy, print the chosen one
  let signature: Record<string, unknown> = {};
  let signatureNote = "";
  if (data.removeSignature && !signatureFile) {
    signature = { signaturePath: null, signatureOriginalPath: null, signatureCleanPath: null, signatureOnInvoices: false };
  } else if (signatureFile) {
    let info;
    try {
      info = await describeImage(signatureFile.path);
    } catch (err) {
      return rerender(err instanceof Error ? err.message : "The stamp image could not be read.");
    }
    const originalPath = `/uploads/logos/${signatureFile.filename}`;
    let cleanPath: string | null = null;
    try {
      cleanPath = (await makeTransparent(signatureFile.path)).publicPath;
    } catch (err) {
      signatureNote = ` ${err instanceof Error ? err.message : "A transparent version could not be made."} The image is used as uploaded.`;
    }
    // A PNG that is already transparent is used as uploaded unless the user picks otherwise
    const useClean = !!cleanPath && (data.signatureMode ? data.signatureMode === "clean" : !info.hasAlpha);
    signature = {
      signatureOriginalPath: originalPath,
      signatureCleanPath: cleanPath,
      signatureUseClean: useClean,
      signaturePath: useClean ? cleanPath : originalPath,
    };
  } else if (existing?.signatureOriginalPath && data.signatureMode) {
    const useClean = data.signatureMode === "clean" && !!existing.signatureCleanPath;
    signature = { signatureUseClean: useClean, signaturePath: useClean ? existing.signatureCleanPath : existing.signatureOriginalPath };
  }
  const hasSignature = signature.signaturePath !== undefined ? !!signature.signaturePath : !!existing?.signaturePath;
  signature = {
    ...signature,
    signatureWidthMm: clampWidthMm(data.signatureWidthMm ?? existing?.signatureWidthMm ?? 50),
    signatureHidesHeading: data.signatureHidesHeading,
    ...(data.removeSignature && !signatureFile ? {} : { signatureOnInvoices: hasSignature && data.signatureOnInvoices }),
  };

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
    upiId: data.upiId || null,
    upiName: data.upiName || null,
    invoiceTerms: data.invoiceTerms || null,
    ...(logoPath ? { logoPath } : {}),
    ...signature,
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
  req.session.flash = { type: "success", message: (existing ? "Business profile saved. New documents will use these details." : "Business created.") + signatureNote };
  res.redirect(existing ? "/business/setup" : "/dashboard");
}
