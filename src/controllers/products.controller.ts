import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { toDecimal } from "../lib/decimal";
import { STANDARD_UNITS, standardShortName } from "../lib/units";

// Blank form inputs arrive as "" — treat them as "not provided" instead of coercing to 0.
const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const optionalAmount = z.preprocess(blankToUndefined, z.coerce.number().min(0).optional());
const priceTypeEnum = z.enum(["INCLUSIVE", "EXCLUSIVE"]).default("EXCLUSIVE");

const productSchema = z.object({
  itemType: z.enum(["PRODUCT", "SERVICE"]).default("PRODUCT"),
  name: z.string().trim().min(1, "Item name is required"),
  itemCode: z.string().trim().optional().or(z.literal("")),
  barcode: z.string().trim().optional().or(z.literal("")),
  hsnCode: z.string().trim().optional().or(z.literal("")),
  categoryName: z.string().trim().optional().or(z.literal("")),
  unitName: z.string().trim().min(1, "Unit is required"),
  secondaryUnitName: z.string().trim().optional().or(z.literal("")),
  conversionRate: z.preprocess(blankToUndefined, z.coerce.number().positive("Conversion rate must be greater than 0").optional()),
  salePrice: z.coerce.number().min(0, "Sale price must be 0 or more"),
  priceType: priceTypeEnum,
  purchasePrice: z.coerce.number().min(0).optional(),
  purchasePriceType: priceTypeEnum,
  wholesalePrice: optionalAmount,
  wholesalePriceType: priceTypeEnum,
  minWholesaleQty: optionalAmount,
  taxId: z.string().trim().optional().or(z.literal("")),
  defaultDiscount: z.coerce.number().min(0).optional(),
  defaultDiscountType: z.enum(["PERCENTAGE", "FIXED"]).default("PERCENTAGE"),
  openingStock: z.coerce.number().min(0).default(0),
  openingStockPrice: optionalAmount,
  openingStockDate: z.preprocess(blankToUndefined, z.coerce.date().optional()),
  stockLocation: z.string().trim().optional().or(z.literal("")),
  minStock: z.coerce.number().min(0).default(0),
}).superRefine((data, ctx) => {
  if (data.secondaryUnitName) {
    if (data.secondaryUnitName === data.unitName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Secondary unit must be different from the base unit" });
    }
    if (data.conversionRate === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Conversion rate is required when a secondary unit is selected" });
    }
  }
  if (data.wholesalePrice !== undefined && data.minWholesaleQty === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Minimum wholesale quantity is required when a wholesale price is set" });
  }
});

type ProductInput = z.infer<typeof productSchema>;

async function findOrCreateCategory(businessId: string, name: string) {
  if (!name) return null;
  return prisma.category.upsert({
    where: { businessId_name: { businessId, name } },
    create: { businessId, name },
    update: {},
  });
}

async function findOrCreateUnit(businessId: string, name: string) {
  return prisma.unit.upsert({
    where: { businessId_name: { businessId, name } },
    create: { businessId, name, shortName: standardShortName(name) ?? name.slice(0, 8) },
    update: {},
  });
}

async function loadFormOptions(businessId: string) {
  const [categories, units, taxes] = await Promise.all([
    prisma.category.findMany({ where: { businessId }, orderBy: { name: "asc" } }),
    prisma.unit.findMany({ where: { businessId }, orderBy: { name: "asc" } }),
    prisma.taxMaster.findMany({ where: { businessId, isActive: true }, orderBy: { rate: "asc" } }),
  ]);
  // Offer the standard unit list plus any custom units this business has created.
  const unitOptions = [...STANDARD_UNITS];
  for (const u of units) {
    if (!unitOptions.some((o) => o.name === u.name)) unitOptions.push({ name: u.name, shortName: u.shortName });
  }
  return { categories, units: unitOptions, taxes };
}

async function buildProductData(businessId: string, data: ProductInput, imagePath: string | undefined) {
  const [category, unit, secondaryUnit] = await Promise.all([
    findOrCreateCategory(businessId, data.categoryName || ""),
    findOrCreateUnit(businessId, data.unitName),
    data.secondaryUnitName ? findOrCreateUnit(businessId, data.secondaryUnitName) : Promise.resolve(null),
  ]);

  return {
    isService: data.itemType === "SERVICE",
    name: data.name,
    itemCode: data.itemCode || null,
    barcode: data.barcode || null,
    hsnCode: data.hsnCode || null,
    ...(imagePath ? { imagePath } : {}),
    categoryId: category?.id || null,
    unitId: unit.id,
    secondaryUnitId: secondaryUnit?.id || null,
    conversionRate: secondaryUnit ? data.conversionRate ?? null : null,
    salePrice: data.salePrice,
    priceType: data.priceType,
    purchasePrice: data.purchasePrice ?? null,
    purchasePriceType: data.purchasePriceType,
    wholesalePrice: data.wholesalePrice ?? null,
    wholesalePriceType: data.wholesalePriceType,
    minWholesaleQty: data.wholesalePrice !== undefined ? data.minWholesaleQty ?? null : null,
    taxId: data.taxId || null,
    defaultDiscount: data.defaultDiscount ?? 0,
    defaultDiscountType: data.defaultDiscountType,
    openingStock: data.openingStock,
    openingStockPrice: data.openingStockPrice ?? null,
    openingStockDate: data.openingStockDate ?? null,
    stockLocation: data.stockLocation || null,
    minStock: data.minStock,
  };
}

function uploadedImagePath(req: Request) {
  return req.file ? `/uploads/items/${req.file.filename}` : undefined;
}

export async function listProducts(req: Request, res: Response) {
  const business = res.locals.business;
  const { q, category, gstRate, stockStatus, type } = req.query as Record<string, string>;

  const where: Record<string, unknown> = {
    businessId: business.id,
    isService: type === "service",
    isActive: true,
  };

  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { itemCode: { contains: q, mode: "insensitive" } },
      { hsnCode: { contains: q, mode: "insensitive" } },
      { barcode: { contains: q, mode: "insensitive" } },
    ];
  }
  if (category) where.categoryId = category;
  if (gstRate) where.taxId = gstRate;

  let products = await prisma.product.findMany({
    where,
    include: { category: true, unit: true, tax: true },
    orderBy: { name: "asc" },
  });

  if (stockStatus === "low") {
    products = products.filter((p) => toDecimal(p.currentStock).lessThanOrEqualTo(toDecimal(p.minStock)) && toDecimal(p.currentStock).greaterThan(0));
  } else if (stockStatus === "out") {
    products = products.filter((p) => toDecimal(p.currentStock).lessThanOrEqualTo(0));
  }

  const { categories, taxes } = await loadFormOptions(business.id);

  res.render("products/list", {
    title: "Products",
    activeNav: "products",
    products,
    categories,
    taxes,
    filters: { q: q || "", category: category || "", gstRate: gstRate || "", stockStatus: stockStatus || "", type: type || "product" },
  });
}

export async function showNewProduct(req: Request, res: Response) {
  const business = res.locals.business;
  const options = await loadFormOptions(business.id);
  res.render("products/form", { title: "Add Item", activeNav: "products", product: null, errors: null, ...options });
}

export async function showEditProduct(req: Request, res: Response) {
  const business = res.locals.business;
  const product = await prisma.product.findFirst({
    where: { id: req.params.id, businessId: business.id },
    include: { category: true, unit: true, secondaryUnit: true, tax: true },
  });
  if (!product) throw new AppError("Item not found", 404);

  const stockTransactions = await prisma.stockTransaction.findMany({
    where: { productId: product.id },
    orderBy: { date: "desc" },
    take: 25,
    include: { referenceInvoice: { include: { customer: true } } },
  });

  const options = await loadFormOptions(business.id);
  res.render("products/form", {
    title: "Edit Item",
    activeNav: "products",
    product,
    errors: null,
    stockTransactions,
    ...options,
  });
}

export async function createProduct(req: Request, res: Response) {
  const business = res.locals.business;
  const parsed = productSchema.safeParse(req.body);

  if (!parsed.success) {
    const options = await loadFormOptions(business.id);
    return res.status(422).render("products/form", {
      title: "Add Item",
      activeNav: "products",
      product: req.body,
      errors: parsed.error.errors.map((e) => e.message),
      ...options,
    });
  }

  const data = parsed.data;

  const duplicate = await prisma.product.findFirst({
    where: { businessId: business.id, name: { equals: data.name, mode: "insensitive" }, isActive: true }
  });
  if (duplicate) {
    const options = await loadFormOptions(business.id);
    return res.status(422).render("products/form", {
      title: "Add Item",
      activeNav: "products",
      product: req.body,
      errors: ["An item with this name already exists."],
      ...options,
    });
  }

  const productData = await buildProductData(business.id, data, uploadedImagePath(req));

  await prisma.product.create({
    data: {
      businessId: business.id,
      ...productData,
      currentStock: data.openingStock,
    },
  });

  req.session.flash = { type: "success", message: "Item saved successfully." };
  res.redirect("/products");
}

export async function updateProduct(req: Request, res: Response) {
  const business = res.locals.business;
  const existing = await prisma.product.findFirst({ where: { id: req.params.id, businessId: business.id } });
  if (!existing) throw new AppError("Item not found", 404);

  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) {
    const options = await loadFormOptions(business.id);
    return res.status(422).render("products/form", {
      title: "Edit Item",
      activeNav: "products",
      product: { ...existing, ...req.body },
      errors: parsed.error.errors.map((e) => e.message),
      ...options,
    });
  }

  const data = parsed.data;

  const duplicate = await prisma.product.findFirst({
    where: { 
      businessId: business.id, 
      name: { equals: data.name, mode: "insensitive" }, 
      id: { not: existing.id },
      isActive: true
    }
  });
  if (duplicate) {
    const options = await loadFormOptions(business.id);
    return res.status(422).render("products/form", {
      title: "Edit Item",
      activeNav: "products",
      product: { ...existing, ...req.body },
      errors: ["An item with this name already exists."],
      ...options,
    });
  }

  const productData = await buildProductData(business.id, data, uploadedImagePath(req));

  // Opening stock is fixed at creation; only stock adjustments should change currentStock afterward.
  const stockDelta = toDecimal(data.openingStock).minus(toDecimal(existing.openingStock));

  await prisma.product.update({
    where: { id: existing.id },
    data: {
      ...productData,
      currentStock: toDecimal(existing.currentStock).plus(stockDelta).toNumber(),
    },
  });

  req.session.flash = { type: "success", message: "Item updated successfully." };
  res.redirect("/products");
}

export async function deleteProduct(req: Request, res: Response) {
  const business = res.locals.business;
  const product = await prisma.product.findFirst({ where: { id: req.params.id, businessId: business.id } });
  if (!product) throw new AppError("Item not found", 404);

  await prisma.product.update({ where: { id: product.id }, data: { isActive: false } });
  req.session.flash = { type: "success", message: "Item removed." };
  res.redirect("/products");
}
