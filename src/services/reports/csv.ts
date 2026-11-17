import type { Response } from "express";

type Cell = string | number | null | undefined;

function escapeCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // Stop spreadsheet apps from executing cell text as a formula.
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: string[], rows: Cell[][]): string {
  return [columns, ...rows].map((r) => r.map(escapeCell).join(",")).join("\r\n");
}

export function sendCsv(res: Response, name: string, csv: string): void {
  const file = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "report";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${file}.csv"`);
  // BOM so Excel opens ₹ and other UTF-8 text correctly.
  res.send(`﻿${csv}`);
}
