/**
 * Corrida H, punto 3: bloque "PRODUCTOS DE TERCEROS" repetido por producto, detalle agrupado y filas insertadas.
 *  - Siempre (datos inventados): cada copia del bloque es igual al bloque de la plantilla celda por celda (valores fijos,
 *    estilos, combinadas y alto), lo de abajo se desplaza, y con más de 7 líneas el detalle crece con el formato de la fila 24.
 *  - Con el pedido real del vendedor (data/referencia-360tyres, fuera de git; si no está, esa parte no corre): el Excel
 *    generado con 1, 2 y 3 bloques se compara celda por celda con la referencia; las únicas diferencias son las listadas
 *    (KNOWN_*), cada una con su motivo.
 */
import fs from "node:fs";
import type ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { BLOCK_STRIDE, buildPedidoXlsx, groupPedidoItems, PEDIDO_CELLS, type PedidoData, type PedidoItem } from "./pedido-xlsx";
import { compareSheets, loadPedidoSheet, type CellDiff } from "./reference-compare";
import { pedidoFromReference, prosegurLines } from "./reference-input";

const base: PedidoData = {
  fecha: "2026-11-16",
  atc: "Vendedor Prueba",
  cliente: { razonSocial: "Transportes Ficticios S.A.C.", ruc: "20999999991", direccionFiscal: "Av. Inventada 1", direccionEntrega: "Jr. Falso 2", contacto: "Ana Prueba", agencia: "Agencia Demo", agenciaContacto: "Luis Demo", agenciaTelefono: "900 000 002" },
  plazoCreditoDias: 30,
  items: [],
  entrega: { fecha: "2026-11-17", enllante: false, marcado: true, flete: "360PT", valorFlete: "20 SOLES APROX" },
  observaciones: "facturar",
  observacionesTerceros: "despachar en agencia",
};
const v99 = (cantidad: number, ub: string): PedidoItem => ({ cantidad, medida: "215/75R17.5 18PR", marca: "FENIXWAY", modelo: "VALOR 99", precioUnitarioSinIgv: 123.17, igvPct: 18, ubs: [ub], stock: {} });
const v89 = (cantidad: number, ub: string): PedidoItem => ({ cantidad, medida: "215/75R17.5 18PR", marca: "FENIXWAY", modelo: "VALOR 89", precioUnitarioSinIgv: 126.42, igvPct: 18, ubs: [ub], stock: {} });
const ext = (cantidad: number): PedidoItem => ({
  cantidad,
  medida: "11R22.5 16PR",
  marca: "MARCA X",
  modelo: "M1",
  precioUnitarioSinIgv: 300,
  igvPct: 18,
  terceros: { proveedor: "Proveedor Demo", contacto: "Pedro Demo", telefono: "900 000 003", precioCompraConIgv: 295, pago: "LETRAS 60", entrega: "ALMACEN DEMO" },
});

const val = (ws: ExcelJS.Worksheet, a: string) => {
  const v = ws.getCell(a).value;
  if (v && typeof v === "object" && "result" in v) return (v as { result: unknown }).result;
  return v;
};

describe("detalle agrupado por producto", () => {
  it("5 líneas de cotización -> 2 líneas de pedido (6 y 12) con sus UB; precios distintos no se juntan", () => {
    const g = groupPedidoItems([v99(4, "0001"), v89(4, "0002"), v99(2, "0003"), v89(4, "0004"), v89(4, "0005")]);
    expect(g.map((x) => [x.modelo, x.cantidad, x.ubs])).toEqual([
      ["VALOR 99", 6, ["0001", "0003"]],
      ["VALOR 89", 12, ["0002", "0004", "0005"]],
    ]);
    expect(groupPedidoItems([v99(1, "a"), { ...v99(1, "b"), precioUnitarioSinIgv: 120 }])).toHaveLength(2);
    expect(groupPedidoItems([v99(1, "a"), { ...v99(1, "b"), stock: undefined, terceros: { proveedor: "X" } }])).toHaveLength(2);
  });
});

describe("bloque por producto: cada copia igual a la plantilla", () => {
  for (const [n, items] of [
    [1, [v99(4, "0001"), v99(2, "0003")]],
    [2, [v99(4, "0001"), v89(4, "0002"), v99(2, "0003")]],
    [3, [v99(4, "0001"), v89(4, "0002"), ext(3)]],
  ] as [number, PedidoItem[]][]) {
    it(`${n} bloque(s): estilos, combinadas y textos fijos iguales al bloque 1; la agencia queda debajo`, async () => {
      const tpl = await loadPedidoSheet(fs.readFileSync(`config/templates/formato-pedido-atc.xlsx`));
      const ws = await loadPedidoSheet(await buildPedidoXlsx({ ...base, items }));
      const T = PEDIDO_CELLS.terceros;
      for (let k = 0; k < n; k++) {
        const top = T.firstRow + BLOCK_STRIDE * k;
        // contra la plantilla: solo pueden diferir los valores que se llenan (columna G de las filas 29..38, C39)
        const diffs = compareSheets(ws, tpl, T.firstRow, T.lastRow, BLOCK_STRIDE * k, { heights: true }).filter((d) => !(d.what === "valor" && (/^G/.test(d.where) || d.where === `C${top + 11}`)));
        expect(diffs, `bloque ${k + 1}`).toEqual([]);
        expect(val(ws, `C${top}`)).toMatch(/^SOBRE EL DETALLE DE MERCADERIA-PRODUCTOS DE TERCEROS/);
        expect(val(ws, `C${top + 11}`)).toBe("Observaciones: despachar en agencia");
        if (k < n - 1) for (const c of "CDEFGHIJ") expect(val(ws, `${c}${top + 12}`) ?? null, `fila en blanco ${top + 12}`).toBeNull();
      }
      const agency = PEDIDO_CELLS.agenciaRow + BLOCK_STRIDE * (n - 1);
      expect(val(ws, `C${agency}`)).toBe("CONTACTO DE PERSONA EN AGENCIA AGENCIA DEMO");
      expect(val(ws, `C${agency + 1}`)).toBe("Luis Demo");
      expect(val(ws, `C${agency + 2}`)).toBe("CELULAR");
      expect(val(ws, `D${agency + 2}`)).toBe("900 000 002");
      // lo de arriba no se movió
      expect(val(ws, "E25")).toBe(items.reduce((s, it) => s + it.cantidad, 0));
      expect(ws.getCell("E25").formula).toBe("SUM(E18:E24)");
    });
  }

  it("stock propio y proveedor externo: valores de cada bloque", async () => {
    const ws = await loadPedidoSheet(await buildPedidoXlsx({ ...base, items: [v99(4, "0001"), ext(3)] }));
    const col = (top: number) => Array.from({ length: 10 }, (_, i) => val(ws, `G${top + 1 + i}`) ?? null);
    expect(col(28)).toEqual(["STOCK 360PT", "PATRICIA", null, "-", "215/75R17.5 18PR", "FENIXWAY", "VALOR 99", 0, "contado", "SAN LUIS STOCK"]);
    expect(col(41)).toEqual(["PROVEEDOR DEMO", "PEDRO DEMO", "900 000 003", "-", "11R22.5 16PR", "MARCA X", "M1", 295, "LETRAS 60", "ALMACEN DEMO"]);
    // precio con IGV: la fórmula del vendedor (+K*1.18) con el precio sin IGV en K
    expect(ws.getCell("I18").formula).toBe("+K18*1.18");
    expect(val(ws, "K18")).toBe(123.17);
    expect(val(ws, "I18")).toBeCloseTo(145.3406, 4);
    expect(ws.getCell("J18").formula).toBe("I18*E18");
  });

  it("más de 7 líneas: inserta filas con el formato de la fila 24 y mueve totales, bloques y agencia", async () => {
    const items = Array.from({ length: 9 }, (_, i): PedidoItem => ({ cantidad: i + 1, medida: `MEDIDA ${i}`, marca: "M", modelo: `X${i}`, precioUnitarioSinIgv: 100 + i, igvPct: 18, stock: {} }));
    const ws = await loadPedidoSheet(await buildPedidoXlsx({ ...base, items }));
    expect(val(ws, "F26")).toBe("MEDIDA 8 M X8");
    expect(ws.getCell("J26").formula).toBe("I26*E26");
    expect(ws.getCell("I26").formula).toBe("+K26*1.18");
    expect(ws.getCell("C26").isMerged && ws.getCell("F26").isMerged && ws.getCell("H26").isMerged).toBe(true);
    expect(ws.getCell("E27").formula).toBe("SUM(E18:E26)");
    expect(val(ws, "E27")).toBe(45);
    expect(ws.getCell("J27").formula).toBe("SUM(J18:J26)");
    expect(ws.getCell("K27").formula).toBe("+J27/1.18");
    expect(val(ws, "I27")).toBe("Total $");
    expect(val(ws, "C29")).toBe("Observaciones: facturar");
    expect(val(ws, "C30")).toMatch(/^SOBRE EL DETALLE/);
    // 9 productos = 9 bloques; la agencia, debajo del último
    expect(val(ws, `G${30 + BLOCK_STRIDE * 8 + 7}`)).toBe("X8");
    expect(val(ws, `C${43 + BLOCK_STRIDE * 8}`)).toBe("CONTACTO DE PERSONA EN AGENCIA AGENCIA DEMO");
  });
});

// ---------- contra el pedido real del vendedor ----------

const REF = "data/referencia-360tyres/Nov26-Prosegur-Venta_009_Juliaca_UBs_1231-1812-1911-2005-2201.xlsx";
const PROSEGUR = "data/referencia-360tyres/Cotizacion_471_Juliaca_UBs_formato_Prosegur.xlsx";
const haveRef = fs.existsSync(REF) && fs.existsSync(PROSEGUR);

/**
 * Diferencias esperadas con el archivo del vendedor (todas de la plantilla versionada o de lo que él escribió a mano;
 * ninguna sale de repetir el bloque):
 *  - G4: la plantilla trae =TODAY(); el pedido escribe la fecha (no cambia al abrirlo otro día).
 *  - C9 y C16: el vendedor reescribió esos títulos a mano ("…POR GRAEL JULIACA PROSEGUR", "…PRODUCTOS DE GSM").
 *  - C18 "-": guion a mano en el código de sistema (el pedido lo deja vacío: lo llena Patricia).
 *  - G8, G9..J9, G18..H19 (alineación y color de fuente), I/J18..24 (formato $ fijo; la plantilla usa 0.00 porque también
 *    hay pedidos en soles), F/G/H23..24, G/J32 y G/J45 (color de tema), G/J36 y G/J49 (negrita), G/J37 y G/J50 (relleno
 *    amarillo de la plantilla) y alto 15 vs 15,75 en las filas del bloque: estilos de la plantilla, que salió de otro archivo del cliente.
 *  - J20..J24, E25, J25 y combinadas C22:D22..F24:H24: la plantilla corrigió las 7 filas de ítems (el archivo del vendedor
 *    tenía fórmulas y combinadas solo en las primeras filas y J25 sumaba J18:J21).
 *  - C36 / C49: la plantilla dice "… INC IGV DOLARES" (en soles pasa a SOLES).
 */
const KNOWN_VALUE = new Set(["G4", "C9", "C16", "C18", "J20", "J21", "J22", "J23", "J24", "E25", "J25", "C36", "C49"]);
const KNOWN_STYLE_ROWS = new Set([8, 9, 18, 19, 20, 21, 22, 23, 24, 32, 36, 37, 45, 49, 50]);
const KNOWN_MERGES = new Set(["merge C22:D22", "merge C23:D23", "merge F23:H23", "merge C24:D24", "merge F24:H24"]);
const unexpected = (diffs: CellDiff[]) =>
  diffs.filter((d) => {
    if (d.what === "alto") return false; // 15 vs 15,75 (plantilla)
    if (d.what === "merge") return !KNOWN_MERGES.has(d.where);
    if (d.what === "valor") return !KNOWN_VALUE.has(d.where);
    return !KNOWN_STYLE_ROWS.has(Number(d.where.replace(/^\D+/, "")));
  });

describe.skipIf(!haveRef)("pedido real del vendedor (Venta 009, data/referencia-360tyres)", () => {
  const load = async () => {
    const ref = await loadPedidoSheet(fs.readFileSync(REF));
    const pro = await loadPedidoSheet(fs.readFileSync(PROSEGUR));
    // la cotización en formato Prosegur dice UB 1811 en la tercera línea; el PDF y los nombres dicen 1911 (punto 6)
    return { ref, data: pedidoFromReference(ref, prosegurLines(pro), { "1811": "1911" }) };
  };

  it("2 bloques (el caso real): igual celda por celda salvo las diferencias conocidas", async () => {
    const { ref, data } = await load();
    expect(data.items).toHaveLength(5); // 5 líneas de la cotización
    const ws = await loadPedidoSheet(await buildPedidoXlsx(data));
    expect([val(ws, "E18"), val(ws, "E19")]).toEqual([6, 12]); // -> 2 líneas de pedido
    expect(unexpected(compareSheets(ws, ref, 2, 52, 0, { heights: true }))).toEqual([]);
    // los valores de los dos bloques, exactos
    for (let r = 28; r <= 52; r++) for (const c of ["C", "G"]) if (r !== 36 && r !== 49) expect(String(val(ws, `${c}${r}`) ?? "").trimEnd(), `${c}${r}`).toBe(String(val(ref, `${c}${r}`) ?? "").trimEnd());
  });

  it("1 bloque: cabecera, detalle y bloque como la referencia", async () => {
    const { ref, data } = await load();
    const only99 = { ...data, items: data.items.filter((it) => it.modelo === "VALOR 99") };
    const ws = await loadPedidoSheet(await buildPedidoXlsx(only99));
    const diffs = unexpected(compareSheets(ws, ref, 2, 39, 0, { heights: true })).filter((d) => !/^[EFGHIJK]19$|^[JK]25$/.test(d.where)); // la línea 2 (Valor 89) y el total no están
    expect(diffs).toEqual([]);
    expect(val(ws, "C41")).toBe("CONTACTO DE PERSONA EN AGENCIA"); // la agencia sigue en su sitio
  });

  it("3 bloques: los dos de la referencia y un tercero de proveedor externo; lo de abajo baja 13 filas", async () => {
    const { ref, data } = await load();
    const three = { ...data, items: [...data.items, ext(2)] };
    const ws = await loadPedidoSheet(await buildPedidoXlsx(three));
    const diffs = unexpected(compareSheets(ws, ref, 2, 52, 0, { heights: true })).filter((d) => !/^[EFGHIJK]20$|^[EJK]25$/.test(d.where)); // la línea 3 y los totales
    expect(diffs).toEqual([]);
    // el bloque 3 (filas 54..65) tiene el formato del bloque 1 de la referencia
    const b3 = compareSheets(ws, ref, 28, 39, 26).filter((d) => !(d.what === "valor" && /^G/.test(d.where)));
    expect(unexpected(b3.map((d) => ({ ...d, where: d.where.replace(/\d+$/, (n) => String(Number(n) - 26)) })))).toEqual([]);
    expect(val(ws, "G55")).toBe("PROVEEDOR DEMO");
    expect(val(ws, "C67")).toBe("CONTACTO DE PERSONA EN AGENCIA");
  });
});
