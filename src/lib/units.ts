// Standard units offered in the item form's unit pickers; a business's own custom units are merged in.
export const STANDARD_UNITS: ReadonlyArray<{ name: string; shortName: string }> = [
  { name: "BAGS", shortName: "Bag" },
  { name: "BOTTLES", shortName: "Btl" },
  { name: "BOX", shortName: "Box" },
  { name: "BUNDLES", shortName: "Bdl" },
  { name: "CANS", shortName: "Can" },
  { name: "CARTONS", shortName: "Ctn" },
  { name: "CUBIC METER", shortName: "Mtq" },
  { name: "DAY", shortName: "Day" },
  { name: "DOZENS", shortName: "Dzn" },
  { name: "Each", shortName: "Each" },
  { name: "GRAMMES", shortName: "Gm" },
  { name: "HOUR", shortName: "Hur" },
  { name: "KILOGRAMS", shortName: "Kg" },
  { name: "KILOMETER", shortName: "Kmt" },
  { name: "LITRE", shortName: "Ltr" },
  { name: "METERS", shortName: "Mtr" },
  { name: "MILILITRE", shortName: "Ml" },
  { name: "NUMBERS", shortName: "Nos" },
  { name: "PACKS", shortName: "Pac" },
  { name: "PAIRS", shortName: "Prs" },
  { name: "PIECES", shortName: "Pcs" },
  { name: "QUINTAL", shortName: "Qtl" },
  { name: "ROLLS", shortName: "Rol" },
  { name: "SERVICE", shortName: "Ser" },
  { name: "SET", shortName: "Set" },
  { name: "SQUARE FEET", shortName: "Sqf" },
  { name: "SQUARE METERS", shortName: "Sqm" },
  { name: "TABLETS", shortName: "Tbs" },
  { name: "TON / METRIC TON", shortName: "Ton" },
  { name: "UNIT", shortName: "Unit" },
];

export function standardShortName(name: string): string | undefined {
  return STANDARD_UNITS.find((u) => u.name === name)?.shortName;
}
