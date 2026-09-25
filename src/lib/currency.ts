import type Decimal from "decimal.js";

const inrFormatter = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Formats a number/Decimal as Indian-grouped currency, e.g. 115513.9 -> "₹1,15,513.90" */
export function formatINR(value: Decimal.Value | number | null | undefined): string {
  if (value === null || value === undefined) return "₹0.00";
  const num = typeof value === "number" ? value : Number(value.toString());
  return `₹${inrFormatter.format(num)}`;
}

/** Same as formatINR but without the currency symbol. */
export function formatNumberIN(value: Decimal.Value | number | null | undefined): string {
  if (value === null || value === undefined) return "0.00";
  const num = typeof value === "number" ? value : Number(value.toString());
  return inrFormatter.format(num);
}

/** Converts a number into Indian currency words, e.g. 17110 -> "Rupees Seventeen Thousand One Hundred Ten Only" */
export function amountInWords(value: Decimal.Value | number): string {
  const num = typeof value === "number" ? value : Number(value.toString());
  const rupees = Math.floor(num);
  const paise = Math.round((num - rupees) * 100);

  const rupeeWords = rupees === 0 ? "Zero" : numberToIndianWords(rupees);
  let result = `Rupees ${rupeeWords}`;
  if (paise > 0) {
    result += ` and ${numberToIndianWords(paise)} Paise`;
  }
  return `${result} Only`;
}

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety",
];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? " " + ONES[n % 10] : ""}`;
}

function threeDigits(n: number): string {
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  let out = "";
  if (hundred) out += `${ONES[hundred]} Hundred`;
  if (rest) out += `${out ? " " : ""}${twoDigits(rest)}`;
  return out;
}

/** Indian numbering system: ones, thousands, lakhs, crores. */
function numberToIndianWords(n: number): string {
  if (n === 0) return "Zero";

  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  const hundred = n;

  const parts: string[] = [];
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${threeDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigits(thousand)} Thousand`);
  if (hundred) parts.push(threeDigits(hundred));

  return parts.join(" ");
}
