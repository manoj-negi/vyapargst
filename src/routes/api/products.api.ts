import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireBusiness } from "../../middleware/auth";

export const productsApiRouter = Router();

productsApiRouter.use(requireBusiness);

/** Item-name autocomplete used by the Sale Invoice line-item table. */
productsApiRouter.get("/api/products/search", async (req, res) => {
  const business = res.locals.business;
  const q = ((req.query.q as string) || "").trim();
  if (q.length < 1) return res.json({ results: [] });

  const products = await prisma.product.findMany({
    where: {
      businessId: business.id,
      isActive: true,
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { itemCode: { contains: q, mode: "insensitive" } },
        { hsnCode: { contains: q, mode: "insensitive" } },
        { barcode: { contains: q, mode: "insensitive" } },
      ],
    },
    include: { unit: true, tax: true },
    take: 8,
    orderBy: { name: "asc" },
  });

  res.json({
    results: products.map((p) => ({
      id: p.id,
      name: p.name,
      itemCode: p.itemCode,
      hsnCode: p.hsnCode,
      unitName: p.unit?.name || "",
      salePrice: p.salePrice,
      priceType: p.priceType,
      gstRate: p.tax ? Number(p.tax.rate) : 0,
      defaultDiscount: p.defaultDiscount,
      defaultDiscountType: p.defaultDiscountType,
      currentStock: p.currentStock,
    })),
  });
});
