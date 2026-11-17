import type { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { toDecimal } from "../lib/decimal";
import { partyBalances } from "../services/parties/ledger";

export async function showDashboard(req: Request, res: Response) {
  const business = res.locals.business;

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const sales = { businessId: business.id, status: "ACTIVE" as const, docType: "SALE_INVOICE" as const };

  const [todaySales, monthSales, monthReturns, monthPurchases, products, recentInvoices, balances] = await Promise.all([
    prisma.saleInvoice.aggregate({ where: { ...sales, invoiceDate: { gte: startOfDay } }, _sum: { total: true } }),
    prisma.saleInvoice.aggregate({ where: { ...sales, invoiceDate: { gte: startOfMonth } }, _sum: { total: true } }),
    prisma.saleInvoice.aggregate({ where: { ...sales, docType: "CREDIT_NOTE", invoiceDate: { gte: startOfMonth } }, _sum: { total: true } }),
    prisma.saleInvoice.aggregate({ where: { ...sales, docType: "PURCHASE_BILL", invoiceDate: { gte: startOfMonth } }, _sum: { total: true } }),
    prisma.product.findMany({ where: { businessId: business.id, isActive: true } }),
    prisma.saleInvoice.findMany({
      where: sales,
      include: { customer: true },
      orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }],
      take: 8,
    }),
    partyBalances(business.id),
  ]);

  // Net sales per month for the last six months (sale invoices minus sale returns, cancelled excluded)
  const trendStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const trendDocs = await prisma.saleInvoice.findMany({
    where: { businessId: business.id, status: "ACTIVE", docType: { in: ["SALE_INVOICE", "CREDIT_NOTE"] }, invoiceDate: { gte: trendStart } },
    select: { invoiceDate: true, total: true, docType: true },
  });
  const salesTrend = Array.from({ length: 6 }, (_, i) => {
    const month = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
    return { key: `${month.getFullYear()}-${month.getMonth()}`, label: month.toLocaleDateString("en-IN", { month: "short" }), year: month.getFullYear(), total: toDecimal(0), count: 0 };
  });
  for (const doc of trendDocs) {
    const d = new Date(doc.invoiceDate);
    const bucket = salesTrend.find((b) => b.key === `${d.getFullYear()}-${d.getMonth()}`);
    if (!bucket) continue;
    bucket.total = bucket.total.plus(toDecimal(doc.total).times(doc.docType === "CREDIT_NOTE" ? -1 : 1));
    if (doc.docType === "SALE_INVOICE") bucket.count += 1;
  }

  const lowStock = products.filter(
    (p) => !p.isService && toDecimal(p.currentStock).lessThanOrEqualTo(toDecimal(p.minStock))
  );
  const lowStockCount = lowStock.length;
  const balanceList = [...balances.values()];

  res.render("dashboard/index", {
    title: "Dashboard",
    activeNav: "dashboard",
    stats: {
      todaySales: Number(todaySales._sum.total || 0),
      // Net of sale returns raised this month
      monthSales: Number(monthSales._sum.total || 0) - Number(monthReturns._sum.total || 0),
      monthPurchases: Number(monthPurchases._sum.total || 0),
      outstanding: balanceList.reduce((s, b) => s + (b.greaterThan(0) ? b.toNumber() : 0), 0),
      toPay: balanceList.reduce((s, b) => s + (b.lessThan(0) ? -b.toNumber() : 0), 0),
      totalItems: products.length,
      lowStock: lowStockCount,
    },
    recentInvoices,
    salesTrend: salesTrend.map((b) => ({ label: b.label, year: b.year, total: b.total.toNumber(), count: b.count })),
    lowStockItems: lowStock
      .sort((a, b) => toDecimal(a.currentStock).comparedTo(toDecimal(b.currentStock)))
      .slice(0, 6)
      .map((p) => ({ id: p.id, name: p.name, currentStock: p.currentStock, minStock: p.minStock })),
  });
}
