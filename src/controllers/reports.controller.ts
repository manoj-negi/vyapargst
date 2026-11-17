import type { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { REPORTS, type ReportKey } from "../services/reports/reports";
import { sendCsv, toCsv } from "../services/reports/csv";
import { renderReportPdf } from "../services/reports/reportPdf";

export function showReportsIndex(_req: Request, res: Response) {
  res.render("reports/index", {
    title: "Reports",
    activeNav: "reports",
    reports: Object.entries(REPORTS).map(([key, r]) => ({ key, label: r.label })),
  });
}

export async function showReport(req: Request, res: Response) {
  const business = res.locals.business;
  const key = req.params.key as ReportKey;
  const def = REPORTS[key];
  if (!def) throw new AppError("Report not found", 404);

  const { from, to, productId, format } = req.query as Record<string, string>;
  const valid = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "");
  const filters = { from: valid(from), to: valid(to), productId: productId || "" };
  const report = await def.run(business.id, {
    from: filters.from ? new Date(filters.from) : undefined,
    to: filters.to ? new Date(`${filters.to}T23:59:59.999`) : undefined,
    productId: filters.productId || undefined,
  });

  const allRows = [...report.rows, ...(report.footer ?? [])];
  const period = report.dated ? `${filters.from || "Beginning"} to ${filters.to || "today"}` : `As on ${new Date().toLocaleDateString("en-IN")}`;
  const fileName = `${report.title}-${filters.from || "all"}-${filters.to || "today"}`;
  if (format === "csv") return sendCsv(res, fileName, toCsv(report.columns, allRows));
  if (format === "pdf") {
    return renderReportPdf(res, fileName, { title: report.title, subtitle: period, business, columns: report.columns, rows: allRows, note: report.note });
  }

  res.render("reports/show", {
    title: report.title,
    activeNav: "reports",
    reportKey: key,
    report,
    period,
    filters,
    products: key === "stock-movement" ? await prisma.product.findMany({ where: { businessId: business.id, isService: false }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [],
  });
}
