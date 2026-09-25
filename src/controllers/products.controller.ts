import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { toDecimal } from "../lib/decimal";

const productSchema = z.object({
  itemType: z.enum(["PRODUCT", "SERVICE"]).default("PRODUCT"),
  name: z.string().trim().min(1, "Item name is required"),
  itemCode: z.string().trim().optional().or(z.literal("")),
  barcode: z.string().trim().optional().or(z.literal("")),
  hsnCode: z.string().trim().optional().or(z.literal("")),
  categoryName: z.string().trim().optional().or(z.literal("")),
  unitName: z.string().trim().min(1, "Unit is required"),
  salePrice: z.coerce.number().min(0, "Sale price must be 0 or more"),
  purchasePrice: z.coerce.number().min(0).optional(),
  priceType: z.enum(["INCLUSIVE", "EXCLUSIVE"]).default("EXCLUSIVE"),
  taxId: z.string().trim().optional().or(z.literal("")),
  defaultDiscount: z.coerce.number().min(0).optional(),
  defaultDiscountType: z.enum(["PERCENTAGE", "FIXED"]).default("PERCENTAGE"),
  openingStock: z.coerce.number().min(0).default(0),
  minStock: z.coerce.number().min(0).default(0),
});

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
    create: { businessId, name, shortName: name.slice(0, 8) },
    update: {},
  });
}

async function loadFormOptions(businessId: string) {
  const [categories, units, taxes] = await Promise.all([
    prisma.category.findMany({ where: { businessId }, orderBy: { name: "asc" } }),
    prisma.unit.findMany({ where: { businessId }, orderBy: { name: "asc" } }),
    prisma.taxMaster.findMany({ where: { businessId, isActive: true }, orderBy: { rate: "asc" } }),
  ]);
  return { categories, units, taxes };
}

export async function listProducts(req: Request, res: Response) {
  const business = res.locals.business;
  const { q, category, gstRate, stockStatus, type } = req.query as Record<string, string>;

  const where: Record<string, unknown> = {
    businessId: business.id,
    isService: type === "service",
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
    include: { category: true, unit: true, tax: true },
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
  const [category, unit] = await Promise.all([
    findOrCreateCategory(business.id, data.categoryName || ""),
    findOrCreateUnit(business.id, data.unitName),
  ]);

  await prisma.product.create({
    data: {
      businessId: business.id,
      isService: data.itemType === "SERVICE",
      name: data.name,
      itemCode: data.itemCode || null,
      barcode: data.barcode || null,
      hsnCode: data.hsnCode || null,
      categoryId: category?.id || null,
      unitId: unit.id,
      salePrice: data.salePrice,
      purchasePrice: data.purchasePrice ?? null,
      priceType: data.priceType,
      taxId: data.taxId || null,
      defaultDiscount: data.defaultDiscount ?? 0,
      defaultDiscountType: data.defaultDiscountType,
      openingStock: data.openingStock,
      minStock: data.minStock,
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
  const [category, unit] = await Promise.all([
    findOrCreateCategory(business.id, data.categoryName || ""),
    findOrCreateUnit(business.id, data.unitName),
  ]);

  // Opening stock is fixed at creation; only stock adjustments should change currentStock afterward.
  const stockDelta = toDecimal(data.openingStock).minus(toDecimal(existing.openingStock));

  await prisma.product.update({
    where: { id: existing.id },
    data: {
      isService: data.itemType === "SERVICE",
      name: data.name,
      itemCode: data.itemCode || null,
      barcode: data.barcode || null,
      hsnCode: data.hsnCode || null,
      categoryId: category?.id || null,
      unitId: unit.id,
      salePrice: data.salePrice,
      purchasePrice: data.purchasePrice ?? null,
      priceType: data.priceType,
      taxId: data.taxId || null,
      defaultDiscount: data.defaultDiscount ?? 0,
      defaultDiscountType: data.defaultDiscountType,
      openingStock: data.openingStock,
      minStock: data.minStock,
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
