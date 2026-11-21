/**
 * Catálogo pequeño para las pruebas de la voz con transcripciones reales de Deepgram (corrida H, puntos 5 y 6): los
 * diseños, marcas y medidas que se dictaron en los audios, como en las listas de precios del piloto. Prosegur con su
 * perfil (pide UB) y una cotización anterior en Juliaca.
 */
import type { DictationCatalog } from "../dictation";

export const TEST_DESIGNS: { brand: string; model: string }[] = [
  ...["Valor 99", "Valor 89", "Valor 87", "Valor 85", "Valor 96", "Flama 77", "Flama 89", "Flama 66", "Fuerte 89"].map((model) => ({ brand: "Fenixway", model })),
  ...["CM958", "CB972", "AZ670", "CM986", "CM993", "CM922"].map((model) => ({ brand: "Westlake", model })),
  ...["RR202", "RLB450", "RR902", "RLB458"].map((model) => ({ brand: "Double Coin", model })),
  { brand: "Doublestar", model: "DSR168" },
  { brand: "Triangle", model: "TRD02" },
  { brand: "Linglong", model: "LLF02" },
  { brand: "Linglong", model: "LAU605" },
];

export const TEST_CATALOG: DictationCatalog = {
  designs: TEST_DESIGNS,
  brands: ["Fenixway", "Westlake", "Double Coin", "Doublestar", "Triangle", "Linglong"],
  sizes: ["295/80R22.5", "315/80R22.5", "275/80R22.5", "11R22.5", "12R22.5", "215/75R17.5", "235/75R17.5", "385/65R22.5", "12R20", "215/75R15"],
  // corrida I: las lonas de cada medida en las listas (las dictadas se validan contra estas)
  plies: { "295/80R22.5": [16, 18], "315/80R22.5": [18, 20], "11R22.5": [16, 18], "12R22.5": [18], "12R20": [18], "275/80R22.5": [16], "385/65R22.5": [20] },
  profiles: [{ key: "prosegur", name: "Prosegur", names: ["prosegur", "prosegur sa", "prosegur s.a.", "Prosegur", "PROSEGUR SA"], units: ["Juliaca", "Ayacucho"], ub: true }],
};
