import { describe, expect, it } from "vitest";
import { cleanDivisionValue, divisionLines, divisionOf, divisionText } from "./division";

describe("section and department display", () => {
  it("labels each filled field and hides empty ones", () => {
    expect(divisionLines({ section: "GA" })).toEqual([{ label: "Section", value: "GA" }]);
    expect(divisionLines({ department: "HRM" })).toEqual([{ label: "Department", value: "HRM" }]);
    expect(divisionText({ section: "GA", department: "Accounts" })).toBe("Section: GA · Department: Accounts");
    expect(divisionLines({ section: " ", department: null })).toEqual([]);
  });

  it("shows an unclassified older value as typed, without a label", () => {
    expect(divisionOf({ department: "Retail Asset Hub", legacySectionDepartment: true })).toEqual({ section: null, department: null, unclassified: "Retail Asset Hub" });
    expect(divisionLines({ department: "HRM", legacySectionDepartment: true })).toEqual([{ label: null, value: "HRM" }]);
  });

  it("normalises spacing and length", () => {
    expect(cleanDivisionValue("  Retail   Asset Hub ")).toBe("Retail Asset Hub");
    expect(cleanDivisionValue("x".repeat(100))).toHaveLength(80);
    expect(cleanDivisionValue("")).toBeNull();
  });
});
