import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { toDecimal } from "../lib/decimal";
import { STANDARD_UNITS, standardShortName } from "../lib/units";
import { adjustStock } from "../services/stock/stockService";
import { writeAudit } from "../services/audit/audit";
import { fieldErrorsFrom } from "../lib/viewHelpers";

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
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["secondaryUnitName"], message: "Secondary unit must be different from the base unit" });
    }
    if (data.conversionRate === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["conversionRate"], message: "Conversion rate is required when a secondary unit is selected" });
    }
  }
  if (data.wholesalePrice !== undefined && data.minWholesaleQty === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["minWholesaleQty"], message: "Minimum wholesale quantity is required when a wholesale price is set" });
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

export async function loadFormOptions(businessId: string) {
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

/** Re-renders the item form with what the user typed and the errors beside their fields. */
async function renderProductFormError(res: Response, title: string, product: Record<string, unknown>, errors: string[], fieldErrors: Record<string, string> = {}) {
  const options = await loadFormOptions(res.locals.business.id);
  res.locals.fieldErrors = fieldErrors;
  return res.status(422).render("products/form", { title, activeNav: "products", product, errors, fieldErrors, stockTransactions: [], ...options });
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
    return renderProductFormError(res, "Add Item", req.body, parsed.error.errors.map((e) => e.message), fieldErrorsFrom(parsed.error));
  }

  const data = parsed.data;

  const duplicate = await prisma.product.findFirst({
    where: { businessId: business.id, name: { equals: data.name, mode: "insensitive" }, isActive: true }
  });
  if (duplicate) {
    return renderProductFormError(res, "Add Item", req.body, ["An item with this name already exists."], { name: "An item with this name already exists." });
  }

  const productData = await buildProductData(business.id, data, uploadedImagePath(req));

  await prisma.product.create({
    data: {
      businessId: business.id,
      ...productData,
      currentStock: data.openingStock,
    },
  });

  req.session.flash = { type: "success", message: `Item "${data.name}" saved.` };
  res.redirect(req.body.after === "new" ? "/products/new" : "/products");
}

export async function updateProduct(req: Request, res: Response) {
  const business = res.locals.business;
  const existing = await prisma.product.findFirst({ where: { id: req.params.id, businessId: business.id } });
  if (!existing) throw new AppError("Item not found", 404);

  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) {
    return renderProductFormError(res, "Edit Item", { ...existing, ...req.body }, parsed.error.errors.map((e) => e.message), fieldErrorsFrom(parsed.error));
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
    return renderProductFormError(res, "Edit Item", { ...existing, ...req.body }, ["An item with this name already exists."], { name: "An item with this name already exists." });
  }

  const productData = await buildProductData(business.id, data, uploadedImagePath(req));

  // Opening stock is fixed at creation; only stock adjustments should change currentStock afterward.
  const stockDelta = toDecimal(data.openingStock).minus(toDecimal(existing.openingStock));

  await prisma.product.update({
    where: { id: existing.id },
    data: {
      ...productData,
      ...(req.body.removeImage === "1" && !req.file ? { imagePath: null } : {}),
      currentStock: toDecimal(existing.currentStock).plus(stockDelta).toNumber(),
    },
  });

  req.session.flash = { type: "success", message: `Item "${data.name}" updated.` };
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

const adjustmentSchema = z.object({
  direction: z.enum(["ADD", "REDUCE"]),
  quantity: z.coerce.number().positive("Quantity must be more than 0"),
  reason: z.string().trim().min(1, "A reason is required").max(200),
  date: z.preprocess(blankToUndefined, z.coerce.date().optional()),
});

/** Manual stock correction (damage, recount, etc.) recorded as an ADJUSTMENT movement with its reason. */
export async function adjustProductStock(req: Request, res: Response) {
  const business = res.locals.business;
  const product = await prisma.product.findFirst({ where: { id: req.params.id, businessId: business.id } });
  if (!product) throw new AppError("Item not found", 404);
  if (product.isService) throw new AppError("Services do not have stock", 400);

  const parsed = adjustmentSchema.safeParse(req.body);
  if (!parsed.success) {
    req.session.flash = { type: "danger", message: parsed.error.errors.map((e) => e.message).join("; ") };
    return res.redirect(`/products/${product.id}/edit`);
  }
  const qty = toDecimal(parsed.data.quantity).times(parsed.data.direction === "REDUCE" ? -1 : 1);
  try {
    await prisma.$transaction(async (tx) => {
      await adjustStock(tx, product.id, qty, parsed.data.reason, parsed.data.date ?? new Date(), business.settings?.negativeStockPolicy ?? "ALLOW_WITH_WARNING");
      await writeAudit(tx, { businessId: business.id, userId: req.session.userId, entity: "PRODUCT", entityId: product.id, action: "STOCK_ADJUSTMENT", detail: { quantity: qty.toString(), reason: parsed.data.reason } });
    });
    req.session.flash = { type: "success", message: `Stock ${parsed.data.direction === "ADD" ? "added" : "reduced"} by ${parsed.data.quantity}.` };
  } catch (err) {
    if (!(err instanceof AppError) || err.status >= 500) throw err;
    req.session.flash = { type: "danger", message: err.message };
  }
  res.redirect(`/products/${product.id}/edit`);
}

/**
 * Quick-create from the invoice/purchase form's "New item" dialog (JSON). Uses the same validation
 * and defaults as the full item form, so the item is identical to one added on the Items page.
 */
export async function quickCreateProduct(req: Request, res: Response) {
  const business = res.locals.business;
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ errors: parsed.error.errors.map((e) => e.message), fieldErrors: fieldErrorsFrom(parsed.error) });
  }
  const data = parsed.data;
  const duplicate = await prisma.product.findFirst({ where: { businessId: business.id, name: { equals: data.name, mode: "insensitive" }, isActive: true } });
  if (duplicate) return res.status(422).json({ errors: ["An item with this name already exists."], fieldErrors: { name: "An item with this name already exists." } });

  const product = await prisma.product.create({
    data: { businessId: business.id, ...(await buildProductData(business.id, data, undefined)), currentStock: data.openingStock },
    include: { unit: true, tax: true },
  });
  res.status(201).json({
    product: {
      id: product.id,
      name: product.name,
      itemCode: product.itemCode,
      hsnCode: product.hsnCode,
      unitName: product.unit?.name || "",
      salePrice: product.salePrice,
      priceType: product.priceType,
      purchasePrice: product.purchasePrice,
      purchasePriceType: product.purchasePriceType,
      gstRate: product.tax ? Number(product.tax.rate) : 0,
      defaultDiscount: product.defaultDiscount,
      defaultDiscountType: product.defaultDiscountType,
      currentStock: product.currentStock,
      isService: product.isService,
    },
  });
}
