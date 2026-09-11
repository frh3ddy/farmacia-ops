import { describe, expect, it } from "vitest";
import { deriveMedicineName } from "./ExtractionItemEditor";

const ingredient = (name: string, value: number | null = null, unit: string | null = null) => ({
  name,
  concentrationValue: value,
  concentrationUnit: unit,
});

describe("deriveMedicineName", () => {
  it("inserts the quantity from the presentation field and pluralizes the form", () => {
    expect(
      deriveMedicineName([ingredient("Alopurinol", 300, "mg")], "TABLET", "Caja con 20 tabletas"),
    ).toBe("Alopurinol 300mg 20 Tabletas");
  });

  it("stays singular when the presentation has no quantity", () => {
    expect(deriveMedicineName([ingredient("Alopurinol", 300, "mg")], "TABLET", "Caja")).toBe(
      "Alopurinol 300mg Tableta",
    );
  });

  it("stays singular when there's no presentation at all", () => {
    expect(deriveMedicineName([ingredient("Alopurinol", 300, "mg")], "TABLET", null)).toBe(
      "Alopurinol 300mg Tableta",
    );
  });

  it("joins multiple ingredients with a quantity present", () => {
    expect(
      deriveMedicineName(
        [ingredient("Paracetamol", 500, "mg"), ingredient("Cafeína", 65, "mg")],
        "CAPSULE",
        "Caja c/30 cápsulas",
      ),
    ).toBe("Paracetamol/Cafeína 500mg/65mg 30 Cápsulas");
  });

  it("returns null without a form", () => {
    expect(deriveMedicineName([ingredient("Alopurinol")], null, "Caja con 20 tabletas")).toBeNull();
  });

  it("returns null without ingredients", () => {
    expect(deriveMedicineName([], "TABLET", "Caja con 20 tabletas")).toBeNull();
  });

  it("uses a volume unit instead of pluralizing the form for liquids", () => {
    expect(
      deriveMedicineName(
        [ingredient("Aciclovir", 200, "mg/5 mL")],
        "SUSPENSION",
        "Caja con frasco con 125 mL y vaso dosificador adosado",
      ),
    ).toBe("Aciclovir 200mg/5 mL 125 Ml");
  });

  it("uses a weight unit instead of pluralizing the form for semisólidos", () => {
    expect(deriveMedicineName([ingredient("Betametasona", 0.05, "%")], "CREAM", "Tubo con 20 g")).toBe(
      "Betametasona 0.05% 20 G",
    );
  });
});
