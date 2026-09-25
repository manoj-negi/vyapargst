import type { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { toDecimal } from "../lib/decimal";

export async function showDashboard(req: Request, res: Response) {
  const business = res.locals.business;

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [todaySales, monthSales, outstandingInvoices, products, recentInvoices] = await Promise.all([
    prisma.saleInvoice.aggregate({
      where: { businessId: business.id, status: "ACTIVE", invoiceDate: { gte: startOfDay } },
      _sum: { total: true },
    }),
    prisma.saleInvoice.aggregate({
      where: { businessId: business.id, status: "ACTIVE", invoiceDate: { gte: startOfMonth } },
      _sum: { total: true },
    }),
    prisma.saleInvoice.aggregate({
      where: { businessId: business.id, status: "ACTIVE", paymentStatus: { not: "PAID" } },
      _sum: { balance: true },
    }),
    prisma.product.findMany({ where: { businessId: business.id, isActive: true } }),
    prisma.saleInvoice.findMany({
      where: { businessId: business.id, status: "ACTIVE" },
      include: { customer: true },
      orderBy: { invoiceDate: "desc" },
      take: 8,
    }),
  ]);

  const lowStockCount = products.filter(
    (p) => !p.isService && toDecimal(p.currentStock).lessThanOrEqualTo(toDecimal(p.minStock))
  ).length;

  res.render("dashboard/index", {
    title: "Dashboard",
    activeNav: "dashboard",
    stats: {
      todaySales: Number(todaySales._sum.total || 0),
      monthSales: Number(monthSales._sum.total || 0),
      outstanding: Number(outstandingInvoices._sum.balance || 0),
      totalItems: products.length,
      lowStock: lowStockCount,
    },
    recentInvoices,
  });
}
