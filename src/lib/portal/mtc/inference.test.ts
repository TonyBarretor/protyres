import path from "node:path";
import { describe, expect, it } from "vitest";
import { inferTyreSize, loadTyreRules } from "./inference";

const rules = loadTyreRules(path.join(__dirname, "..", "..", "..", "..", "config", "tyre-inference.json"));
const v = (clase: string | null, ejes: number | null, llantas: number | null, pesoBruto: number | null) => ({ clase, ejes, llantas, pesoBruto });

describe("inferTyreSize with config/tyre-inference.json", () => {
  it.each([
    ["ómnibus 3 ejes / 8 llantas", v("ÓMNIBUS", 3, 8, 18000), "295/80R22.5", "alta"],
    ["ómnibus 2 ejes / 6 llantas", v("OMNIBUS", 2, 6, 9400), "295/80R22.5", "media"],
    ["remolcador", v("REMOLCADOR", 3, null, 48000), "295/80R22.5", "media"],
    ["camión 3 ejes ≥ 25 t", v("CAMION", 3, 10, 30000), "12R22.5", "media"],
    ["camión 4 ejes ≥ 25 t", v("CAMION", 4, 12, 25000), "12R22.5", "media"],
    ["semirremolque 2 llantas/eje", v("SEMIREMOLQUE", 3, 6, 40500), "385/65R22.5", "media"],
    ["semirremolque 4 llantas/eje", v("SEMIRREMOLQUE", 3, 12, 40500), "11R22.5", "media"],
    ["camión 2 ejes < 9 t", v("CAMION", 2, 6, 7500), "215/75R17.5", "baja"],
    ["camión 2 ejes 9 t", v("CAMION", 2, 6, 9000), "235/75R17.5", "media"],
    ["camión 2 ejes 14 t", v("CAMION", 2, 6, 14000), "235/75R17.5", "media"],
    ["camión 2 ejes > 14 t", v("CAMION", 2, 6, 18000), "11R22.5", "media"],
  ] as const)("%s", (_name, vehicle, medida, confianza) => {
    expect(inferTyreSize(vehicle, rules)).toMatchObject({ medida, confianza });
  });

  it.each([
    ["pickup", v("CMTA PICKUP", 2, 4, 1670)],
    ["ómnibus 4 ejes", v("OMNIBUS", 4, 10, 20000)],
    ["camión 3 ejes < 25 t", v("CAMION", 3, 10, 24999)],
    ["camión 2 ejes sin peso", v("CAMION", 2, 6, null)],
    ["semirremolque sin llantas", v("SEMIRREMOLQUE", 3, null, 40000)],
    ["sin clase", v(null, 2, 6, 9000)],
  ] as const)("no rule: %s", (_name, vehicle) => {
    expect(inferTyreSize(vehicle, rules)).toEqual({ medida: null, confianza: null, regla: null });
  });

  it("first matching rule wins", () => {
    const custom = [
      { id: "a", clases: ["CAMION"], medida: "A", confianza: "baja" as const },
      { id: "b", clases: ["CAMION"], ejes: 2, medida: "B", confianza: "alta" as const },
    ];
    expect(inferTyreSize(v("CAMION", 2, 6, 9000), custom)).toEqual({ medida: "A", confianza: "baja", regla: "a" });
  });
});
