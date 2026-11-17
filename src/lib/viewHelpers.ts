import type { ZodError } from "zod";
import { divisionLines, divisionOf, divisionText } from "./division";

const inrFormatter = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export type FieldErrors = Record<string, string>;

/** First message per top-level field, for showing errors beside the field that caused them. */
export function fieldErrorsFrom(error: ZodError): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of error.errors) {
    const key = issue.path.map(String).join(".");
    if (key && !fields[key]) fields[key] = issue.message;
  }
  return fields;
}

/** Helpers available in every EJS view (registered on app.locals). */
export const viewHelpers = {
  /** ₹1,23,456.00 */
  inr(value: unknown): string {
    const n = Number(value ?? 0);
    return `${n < 0 ? "-" : ""}₹${inrFormatter.format(Math.abs(Number.isFinite(n) ? n : 0))}`;
  },
  /** 03 Nov 2026 */
  fdate(value: unknown): string {
    if (!value) return "";
    const d = new Date(value as string);
    if (Number.isNaN(d.getTime())) return "";
    return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  },
  /** Quantities without trailing zeros: 2, 2.5 */
  qty(value: unknown): string {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "0";
  },
  initials(name: unknown): string {
    return String(name ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  },
  /** " is-invalid" when the field has an error, for appending to a class attribute */
  invalid(errors: FieldErrors | null | undefined, name: string): string {
    return errors && errors[name] ? " is-invalid" : "";
  },
  /** The field's error message as an inline feedback element (empty when valid) */
  fieldError(errors: FieldErrors | null | undefined, name: string): string {
    const msg = errors && errors[name];
    return msg ? `<div class="invalid-feedback d-block" role="alert">${escapeHtml(msg)}</div>` : "";
  },
  paymentStatusClass(status: string): string {
    return status === "PAID" ? "status-paid" : status === "PARTIALLY_PAID" ? "status-partial" : "status-unpaid";
  },
  paymentStatusLabel(status: string): string {
    return status === "PAID" ? "Paid" : status === "PARTIALLY_PAID" ? "Partly paid" : "Unpaid";
  },
  /** Section / department of a sale document: { section, department, unclassified } */
  divisionOf,
  divisionLines,
  divisionText,
  modeLabel(mode: string): string {
    return ({ CASH: "Cash", UPI: "UPI", BANK_TRANSFER: "Bank", CARD: "Card", CREDIT: "Credit", OTHER: "Other" } as Record<string, string>)[mode] ?? mode;
  },
};
