import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import { SettingsSchema, type Settings } from "../../settings";
import { buildQuote, manualItem } from "../../quote/build";
import { parseRequestRegex } from "../../quote/request";
import {
  PEDIDO_MAX_ITEMS,
  buildPedidoXlsx,
  formatPedidoFileName,
  pedidoFromQuote,
  plazoDiasFromTerm,
  type PedidoData,
} from "./pedido-xlsx";

const sample: PedidoData = {
  fecha: "2026-11-11",
  atc: "Vendedor Prueba",
  cliente: {
    razonSocial: "Transportes Ficticios del Norte S.A.C.",
    ruc: "20999999991",
    direccionFiscal: "Av. Inventada 123, Lima",
    direccionEntrega: "Carretera Falsa km 10, Piura",
    contacto: "Ana Prueba - Cel. 900 000 001",
    agencia: "Agencia Demo",
    agenciaContacto: "Luis Demo",
    agenciaTelefono: "900 000 002",
  },
  plazoCreditoDias: 60,
  items: [
    { cantidad: 4, medida: "295/80R22.5 18PR", marca: "Fenixway", modelo: "Valor 87", precioUnitarioConIgv: 413.3 },
    { cantidad: 2, medida: "215/75R17.5 18PR", marca: "Marca X", modelo: "M1", precioUnitarioSinIgv: 100, igvPct: 18, terceros: { proveedor: "Proveedor Demo", precioCompraConIgv: 92 } },
  ],
  entrega: { fecha: "2026-11-14", enllante: false, marcado: true, flete: "360TYRES", valorFlete: "20 SOLES X LLANTA", pagoProveedor: "LETRAS 90", recojo: "ALMACEN 360" },
  observaciones: "Despachar por la mañana",
};

async function reload(buffer: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb.getWorksheet("Formato de Pedido")!;
}

describe("FORMATO PEDIDO ATC´S", () => {
  it("fills header, detail, third-party block; keeps formulas, labels and merges", async () => {
    const ws = await reload(await buildPedidoXlsx(sample));
    const v = (a: string) => ws.getCell(a).value;
    const fecha = v("G4");
    expect(fecha instanceof Date && fecha.toISOString().slice(0, 10)).toBe("2026-11-11");
    expect(v("G5")).toBe("Vendedor Prueba");
    expect(v("G6")).toBe("TRANSPORTES FICTICIOS DEL NORTE S.A.C.");
    expect(v("G7")).toBe(20999999991);
    expect(v("G8")).toBe("Av. Inventada 123, Lima");
    expect(v("G9")).toBe("Carretera Falsa km 10, Piura");
    const entrega = v("G10");
    expect(entrega instanceof Date && entrega.toISOString().slice(0, 10)).toBe("2026-11-14");
    expect(v("G11")).toBe("CREDITO 60 DÍAS");
    expect(v("G12")).toBe("NO");
    expect(v("G13")).toBe("SI");
    expect(v("G14")).toBe("Ana Prueba - Cel. 900 000 001");
    expect(v("G15")).toBe("360TYRES");
    expect(v("J15")).toBe("VALOR FLETE: 20 SOLES X LLANTA");

    // detail: inputs written, the template's row formula kept
    expect([v("E18"), v("F18"), v("I18")]).toEqual([4, "295/80R22.5 18PR FENIXWAY VALOR 87", 413.3]);
    expect(v("J18")).toEqual({ formula: "I18*E18", result: 1653.2 });
    expect([v("E19"), v("F19"), v("I19")]).toEqual([2, "215/75R17.5 18PR MARCA X M1", 118]);
    expect(v("J19")).toEqual({ formula: "I19*E19", result: 236 });
    expect([v("E20"), v("F20"), v("I20")]).toEqual([null, null, null]);
    expect(v("J24")).toMatchObject({ formula: "I24*E24" });
    for (let r = 18; r <= 24; r++) expect(v(`C${r}`)).toBeNull(); // código de sistema blank
    expect(v("E25")).toEqual({ formula: "SUM(E18:E24)", result: 6 });
    expect(v("J25")).toEqual({ formula: "SUM(J18:J24)", result: 1889.2 });
    expect(v("K25")).toEqual({ formula: "+J25/1.18", result: 1601.02 });
    expect(v("C27")).toBe("Observaciones: Despachar por la mañana");

    // terceros
    expect(v("G29")).toBe("PROVEEDOR DEMO");
    expect(v("G33")).toBe("215/75R17.5 18PR");
    expect(v("G34")).toBe("MARCA X");
    expect(v("G35")).toBe("M1");
    expect(v("G36")).toBe(92);
    expect(v("G37")).toBe("LETRAS 90");
    expect(v("G38")).toBe("ALMACEN 360");
    expect(v("C41")).toBe("CONTACTO DE PERSONA EN AGENCIA AGENCIA DEMO");
    expect(v("C42")).toBe("Luis Demo");
    expect(v("D43")).toBe("900 000 002");

    // the template's labels, merges and widths stay
    expect(v("C2")).toBe("FORMATO PEDIDO ATC´S");
    expect(v("C17")).toBe("CODIGO DE SISTEMA");
    expect(v("I17")).toBe("Precio Unit  INC IGV $");
    expect(v("C36")).toBe("PRECIO UNITARIO DE COMPRA INC IGV DOLARES");
    const merges = Object.keys((ws as unknown as { _merges: Record<string, unknown> })._merges);
    expect(merges.length).toBeGreaterThanOrEqual(65);
    expect(ws.getCell("G6").isMerged && ws.getCell("J6").isMerged).toBe(true);
    expect(ws.getColumn("J").width).toBeCloseTo(38.14, 1);
    expect(ws.getCell("G4").numFmt).toBe("mm-dd-yy");
  });

  it("joins several third-party items, writes soles labels and contado", async () => {
    const data: PedidoData = {
      ...sample,
      moneda: "PEN",
      plazoCreditoDias: 0,
      items: [
        { cantidad: 1, medida: "11R22.5 16PR", marca: "A", modelo: "X1", precioUnitarioConIgv: 500, terceros: { proveedor: "Prov 1", precioCompraConIgv: 400 } },
        { cantidad: 1, medida: "12R22.5 18PR", marca: "B", precioUnitarioConIgv: 600, terceros: { proveedor: "Prov 1", precioCompraConIgv: 480.5 } },
      ],
      entrega: undefined,
      observaciones: undefined,
    };
    const ws = await reload(await buildPedidoXlsx(data));
    const v = (a: string) => ws.getCell(a).value;
    expect(v("G11")).toBe("CONTADO");
    expect(v("G29")).toBe("PROV 1");
    expect(v("G33")).toBe("11R22.5 16PR / 12R22.5 18PR");
    expect(v("G35")).toBe("X1 / -");
    expect(v("G36")).toBe("400.00 / 480.50");
    expect(v("I17")).toBe("Precio Unit  INC IGV S/");
    expect(v("C36")).toBe("PRECIO UNITARIO DE COMPRA INC IGV SOLES");
    expect(v("G12")).toBeNull();
    expect(v("C27")).toBe("Observaciones: ");
  });

  it("refuses more items than the format's rows", async () => {
    const items = Array.from({ length: PEDIDO_MAX_ITEMS + 1 }, () => sample.items[0]);
    await expect(buildPedidoXlsx({ ...sample, items })).rejects.toThrow(/7 filas de ítems.*8/);
  });

  it("names the file after the short company name and the date", () => {
    expect(formatPedidoFileName(sample)).toBe("Pedido ATC - TRANSPORTES FICTICIOS DEL NORTE - 11-11-2026.xlsx");
    expect(formatPedidoFileName({ ...sample, cliente: { ...sample.cliente, razonSocial: "Demo/Uno E.I.R.L." } })).toBe("Pedido ATC - DEMO-UNO - 11-11-2026.xlsx");
  });

  it("the versioned template carries no customer data", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(process.cwd(), "config/templates/formato-pedido-atc.xlsx"));
    const ws = wb.getWorksheet("Formato de Pedido")!;
    const values: string[] = [];
    ws.eachRow((row) => row.eachCell((c) => {
      if (c.isMerged && c.master !== c) return;
      if (typeof c.value === "string" || typeof c.value === "number") values.push(`${c.address}`);
    }));
    // only labels in column C, the item headers in row 17 and "Total $"
    expect(values.every((a) => /^C\d+$/.test(a) || /^[EFIJ]17$/.test(a) || a === "I25")).toBe(true);
    expect(fs.existsSync("config/templates/formato-pedido-atc.xlsx")).toBe(true);
  });
});

describe("pedidoFromQuote", () => {
  let settings: Settings;
  beforeAll(() => {
    process.env.LLM_DISABLED = "1";
    settings = SettingsSchema.parse({ company: { name: "Professional Tyres", taxId: "RUC: 20565716396" }, pricing: { currency: "USD", taxPct: 18 }, quote: {} });
  });

  it("turns own and provider items into detail lines and the third-party block", async () => {
    const req = parseRequestRegex("295/80R22.5 18PR FENIXWAY VALOR 87 x4\n215/75R17.5 18PR CARLEO DH56 x2\nplazo: 45 días");
    const items = req.lines.map((l, i) => manualItem(l, [350, 100][i], undefined, settings));
    items[1] = { ...items[1], origin: "provider", provider: "Proveedor Demo", unitCost: 78 };
    const quote = buildQuote({ number: "NOVIEMBRE 2026 - 001", request: req, items, settings, today: "2026-11-10" });
    quote.customer.company = "Transportes Ficticios S.A.C.";

    const data = pedidoFromQuote(quote, {
      fecha: "2026-11-11",
      cliente: { ruc: "20999999991", direccionEntrega: "Almacén demo" },
      proveedores: { "proveedor demo": { contacto: "Pedro Demo" } },
      entrega: { enllante: false, marcado: false, flete: "CLIENTE" },
    });
    expect(data.atc).toBe(quote.salesperson.name);
    expect(data.moneda).toBe("USD");
    expect(data.plazoCreditoDias).toBe(45);
    expect(data.cliente).toMatchObject({ razonSocial: "Transportes Ficticios S.A.C.", ruc: "20999999991", direccionEntrega: "Almacén demo" });
    expect(data.items[0]).toMatchObject({ cantidad: 4, medida: "295/80R22.5 18PR", marca: "Fenixway", precioUnitarioSinIgv: 350, igvPct: 18 });
    expect(data.items[0].terceros).toBeUndefined();
    expect(data.items[1].terceros).toEqual({ proveedor: "PROVEEDOR DEMO", precioCompraConIgv: 92.04, contacto: "Pedro Demo" });

    const ws = await reload(await buildPedidoXlsx(data));
    expect(ws.getCell("I18").value).toBe(413);
    expect(ws.getCell("F19").value).toBe("215/75R17.5 18PR CARLEO DH56");
    expect(ws.getCell("G11").value).toBe("CREDITO 45 DÍAS");
    expect(ws.getCell("G29").value).toBe("PROVEEDOR DEMO");
    expect(ws.getCell("G30").value).toBe("Pedro Demo");
    expect(ws.getCell("G36").value).toBe(92.04);
  });

  it("reads the credit term", () => {
    expect(plazoDiasFromTerm("Crédito 60 dias")).toBe(60);
    expect(plazoDiasFromTerm("contado")).toBe(0);
    expect(plazoDiasFromTerm("factura")).toBeUndefined();
  });
});

// corrida E, punto 3: texto de terceros (razón social del MTC/Excel, contacto, ítems, observaciones) que empieza con
// = + - @ se escribe como TEXTO (celda de cadena), nunca como fórmula
describe("inyección de fórmulas", () => {
  it("una celda que empieza con = + - @ queda como texto", async () => {
    const data = {
      ...sample,
      cliente: { ...sample.cliente, razonSocial: '=HYPERLINK("http://x.example","clic")', contacto: "+cmd|' /C calc'!A0", direccionFiscal: "-2+3", direccionEntrega: "@SUM(1,1)" },
      items: [{ ...sample.items[0], modelo: "=1+1" }],
      observaciones: "=IMPORTXML(1)",
    };
    const ws = await reload(await buildPedidoXlsx(data));
    for (const a of ["G6", "G8", "G9"]) {
      const c = ws.getCell(a);
      expect(c.type, a).toBe(ExcelJS.ValueType.String);
      expect(c.formula, a).toBeFalsy();
    }
    expect(ws.getCell("G6").value).toBe('=HYPERLINK("HTTP://X.EXAMPLE","CLIC")');
    // ninguna fórmula del libro trae lo escrito por terceros (las fórmulas son solo las de la plantilla)
    const injected: string[] = [];
    ws.eachRow((row) => row.eachCell((c) => void (c.formula && /HYPERLINK|IMPORTXML|cmd|SUM\(1|1\+1/i.test(c.formula) ? injected.push(c.address) : 0)));
    expect(injected).toEqual([]);
  });
});
