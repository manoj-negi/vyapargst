import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";

const taxSchema = z.object({
  name: z.string().trim().min(1),
  rate: z.coerce.number().min(0).max(100),
  cessRate: z.coerce.number().min(0).max(100).default(0),
});

export async function listTaxMaster(req: Request, res: Response) {
  const business = res.locals.business;
  const taxes = await prisma.taxMaster.findMany({
    where: { businessId: business.id },
    orderBy: { rate: "asc" },
  });
  res.render("settings/tax-master", { title: "Tax Master", activeNav: "tax-master", taxes });
}

export async function createTaxMaster(req: Request, res: Response) {
  const business = res.locals.business;
  const parsed = taxSchema.parse(req.body);
  const half = parsed.rate / 2;

  await prisma.taxMaster.create({
    data: {
      businessId: business.id,
      name: parsed.name,
      rate: parsed.rate,
      cgstRate: half,
      sgstRate: half,
      igstRate: parsed.rate,
      cessRate: parsed.cessRate,
    },
  });

  req.session.flash = { type: "success", message: "Tax rate added." };
  res.redirect("/settings/tax-master");
}

export async function toggleTaxMaster(req: Request, res: Response) {
  const business = res.locals.business;
  const tax = await prisma.taxMaster.findFirst({ where: { id: req.params.id, businessId: business.id } });
  if (!tax) throw new AppError("Tax rate not found", 404);

  await prisma.taxMaster.update({ where: { id: tax.id }, data: { isActive: !tax.isActive } });
  res.redirect("/settings/tax-master");
}

const hsnSchema = z.object({
  hsnCode: z.string().trim().regex(/^[0-9]{4,8}$/, "HSN must be 4-8 digits"),
  description: z.string().trim().min(1),
  keywords: z.string().trim().optional().or(z.literal("")),
  gstRate: z.coerce.number().min(0).max(100),
});

const HSN_PAGE_SIZE = 20;

// Rebuilds the list URL (search + page) the user was on, so actions return them to the same view.
function hsnListUrl(body: Record<string, unknown>) {
  const params = new URLSearchParams();
  if (typeof body.returnQ === "string" && body.returnQ) params.set("q", body.returnQ);
  if (typeof body.returnPage === "string" && /^[0-9]+$/.test(body.returnPage)) params.set("page", body.returnPage);
  const qs = params.toString();
  return qs ? `/settings/hsn-master?${qs}` : "/settings/hsn-master";
}

async function findOwnHsn(businessId: string, id: string) {
  const hsn = await prisma.hSNMaster.findFirst({ where: { id, businessId } });
  if (!hsn) throw new AppError("HSN code not found", 404);
  return hsn;
}

export async function listHsnMaster(req: Request, res: Response) {
  const business = res.locals.business;
  const search = (req.query.q as string) || "";
  const requestedPage = Math.max(1, Number.parseInt(req.query.page as string, 10) || 1);

  const where = {
    businessId: business.id,
    ...(search
      ? {
          OR: [
            { hsnCode: { contains: search, mode: "insensitive" as const } },
            { description: { contains: search, mode: "insensitive" as const } },
            { keywords: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const total = await prisma.hSNMaster.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / HSN_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);

  const hsnCodes = await prisma.hSNMaster.findMany({
    where,
    orderBy: [{ gstRate: "asc" }, { hsnCode: "asc" }],
    skip: (page - 1) * HSN_PAGE_SIZE,
    take: HSN_PAGE_SIZE,
  });

  res.render("settings/hsn-master", {
    title: "HSN Master",
    activeNav: "hsn-master",
    hsnCodes,
    search,
    pagination: { page, totalPages, total, pageSize: HSN_PAGE_SIZE, query: search ? { q: search } : {} },
  });
}

export async function createHsnMaster(req: Request, res: Response) {
  const business = res.locals.business;
  const parsed = hsnSchema.parse(req.body);

  await prisma.hSNMaster.create({
    data: {
      businessId: business.id,
      hsnCode: parsed.hsnCode,
      description: parsed.description,
      keywords: parsed.keywords || null,
      gstRate: parsed.gstRate,
    },
  });

  req.session.flash = { type: "success", message: "HSN code added." };
  res.redirect("/settings/hsn-master");
}

export async function updateHsnMaster(req: Request, res: Response) {
  const business = res.locals.business;
  const hsn = await findOwnHsn(business.id, req.params.id);
  const parsed = hsnSchema.parse(req.body);

  await prisma.hSNMaster.update({
    where: { id: hsn.id },
    data: {
      hsnCode: parsed.hsnCode,
      description: parsed.description,
      keywords: parsed.keywords || null,
      gstRate: parsed.gstRate,
    },
  });

  req.session.flash = { type: "success", message: "HSN code updated." };
  res.redirect(hsnListUrl(req.body));
}

export async function deleteHsnMaster(req: Request, res: Response) {
  const business = res.locals.business;
  const hsn = await findOwnHsn(business.id, req.params.id);

  // Products keep their HSN as a plain string, so removing the master row doesn't affect them.
  await prisma.hSNMaster.delete({ where: { id: hsn.id } });

  req.session.flash = { type: "success", message: "HSN code deleted." };
  res.redirect(hsnListUrl(req.body));
}

export async function toggleHsnMaster(req: Request, res: Response) {
  const business = res.locals.business;
  const hsn = await findOwnHsn(business.id, req.params.id);

  await prisma.hSNMaster.update({ where: { id: hsn.id }, data: { isActive: !hsn.isActive } });
  res.redirect(hsnListUrl(req.body));
}
