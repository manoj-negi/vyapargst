import Decimal from "decimal.js";

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export function toDecimal(value: Decimal.Value | null | undefined): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  return new Decimal(value);
}

/** Round to 2 decimal places using standard "round half up" — correct for currency. */
export function round2(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
