import path from "node:path";
import ejs from "ejs";
import type { Response } from "express";
import { renderHtmlToPdf } from "../invoice/pdf";

export interface PrintableReport {
  title: string;
  subtitle?: string;
  business: { name: string; gstin?: string | null };
  columns: string[];
  rows: (string | number | null | undefined)[][];
  note?: string;
}

export async function renderReportPdf(res: Response, name: string, report: PrintableReport): Promise<void> {
  const html = await ejs.renderFile(path.join(__dirname, "../../../views/reports/print.ejs"), { report, generatedAt: new Date() });
  const pdf = await renderHtmlToPdf(html);
  const file = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "report";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${file}.pdf"`);
  res.send(pdf);
}
