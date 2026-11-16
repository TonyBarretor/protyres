/**
 * Corrida H, punto 6: contraste entre la OC / lo escrito y la cotización (producto, cantidad total, precio y UB).
 * Caso real (si data/referencia-360tyres está): el Excel con formato Prosegur de la cotización 471 dice UB 1811 en la
 * tercera línea, mientras que el PDF y los nombres de archivo dicen 1911.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { crossCheck, linesFromSheet, type CheckLine } from "./crosscheck";
import { loadPedidoSheet } from "./reference-compare";

const Q: CheckLine[] = [
  { producto: "215/75R17.5 18PR FENIXWAY VALOR 99", cantidad: 4, precio: 123.17, ub: "0101" },
  { producto: "215/75R17.5 18PR FENIXWAY VALOR 89", cantidad: 4, precio: 126.42, ub: "0202" },
  { producto: "215/75R17.5 18PR FENIXWAY VALOR 99", cantidad: 2, precio: 123.17, ub: "0303" },
];

describe("contraste OC / cotización", () => {
  it("iguales: nada; otra UB, otra cantidad, otro precio u otro producto: cada cosa en una línea", () => {
    expect(crossCheck(Q, Q)).toEqual([]);
    expect(crossCheck(Q.map((l) => (l.ub === "0303" ? { ...l, ub: "0313" } : l)), Q)).toEqual(["UB 0313 está en la OC pero no en la cotización.", "UB 0303 está en la cotización pero no en la OC."]);
    expect(crossCheck([{ ...Q[0], cantidad: 5 }, Q[1], Q[2]], Q)).toEqual(["*215/75R17.5 18PR FENIXWAY VALOR 99*: 7 en la OC y 6 en la cotización.", "UB 0101: lo de la OC no es lo de la cotización."]);
    expect(crossCheck([Q[0], { ...Q[1], precio: 130 }, Q[2]], Q)).toEqual(["*215/75R17.5 18PR FENIXWAY VALOR 89*: precio 130 en la OC y 126.42 en la cotización."]);
    expect(crossCheck([Q[0], Q[2]], Q, { a: "lo que escribiste", b: "la cotización 471" })).toEqual([
      "*215/75R17.5 18PR FENIXWAY VALOR 89* (4) está en la cotización 471 pero no en lo que escribiste.",
      "UB 0202 está en la cotización 471 pero no en lo que escribiste.",
    ]);
  });

  const REF = "data/referencia-360tyres/Cotizacion_471_Juliaca_UBs_formato_Prosegur.xlsx";
  it.skipIf(!fs.existsSync(REF))("caso real: la cotización 471 en formato Prosegur (UB 1811) frente al PDF y los nombres (1911)", async () => {
    const lines = linesFromSheet(await loadPedidoSheet(fs.readFileSync(REF)));
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => l.ub)).toEqual(["1231", "1812", "1811", "2005", "2201"]);
    // lo que dicen el PDF de la cotización y el nombre del pedido: 1231-1812-1911-2005-2201
    const pdf = lines.map((l) => (l.ub === "1811" ? { ...l, ub: "1911" } : l));
    expect(crossCheck(lines, pdf, { a: "el Excel de Prosegur", b: "la cotización 471" })).toEqual([
      "UB 1811 está en el Excel de Prosegur pero no en la cotización 471.",
      "UB 1911 está en la cotización 471 pero no en el Excel de Prosegur.",
    ]);
  });
});
