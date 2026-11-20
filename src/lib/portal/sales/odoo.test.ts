import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyLine, serviceTypeOf } from "./classify";
import { DEFAULT_SALES_SETTINGS } from "./config";
import { canonicalMedida } from "./history";
import { creditNoteReason, docTypeOf } from "./odoo";
import { buildOdooXlsx, FX, sampleOdooLines } from "./odoo-fixture";
import { checkUploadMeta, readSalesXlsx } from "./xlsx";
import ExcelJS from "exceljs";

const users = [
  { id: 1, nombre: "Frank Rodríguez", whatsapp: "51900000001" },
  { id: 2, nombre: "Danyer Saavedra", whatsapp: "51900000002" },
];
async function buildSalesXlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Ventas").addRows(rows);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const read = async (buf: Buffer) => readSalesXlsx(buf, { users, settings: DEFAULT_SALES_SETTINGS });

describe("ventas-odoo: clasificación de la DESCRIPCIÓN", () => {
  it("neumático: código, medida (normalizador del cotizador), marca (catálogo) y diseño", () => {
    expect(classifyLine("[P0759] 235/75R17.5 18PR FENIXWAY VALOR 89")).toMatchObject({ codigo: "P0759", tipoLinea: "neumatico", medida: "235/75R17.5", marca: "Fenixway", diseno: "Valor 89", seguro: true });
    expect(classifyLine("[P1420] 195/55ZR16 87W KUMHO ECSTA HS52 TL KOREA")).toMatchObject({ medida: "195/55R16", marca: "Kumho", diseno: "Ecsta Hs52" });
    expect(classifyLine("[P0985] 12R22.5 FENIX WAY 18PR VALOR 99")).toMatchObject({ medida: "12R22.5", marca: "Fenixway", diseno: "Valor 99" });
    // escrituras del reporte que el normalizador general no toma
    expect(classifyLine("[P0811] 295/8022.5 18PR DOUBLE COIN RLB450")).toMatchObject({ tipoLinea: "neumatico", medida: "295/80R22.5", marca: "Double Coin" });
    expect(classifyLine("[P1363] 24.5 32 12PR TDB-124 R-1 ASCENSO TL (INDIA)")).toMatchObject({ tipoLinea: "neumatico", medida: "24.5-32" });
    expect(classifyLine("[P0112] 19.5/24 12PR GOODYEAR IT525 R4 TL")).toMatchObject({ tipoLinea: "neumatico", medida: "19.5L-24" });
  });

  it("la misma llanta con o sin prefijo LT/P es la misma medida (filtro e historial no se parten); el diseño conserva el +", () => {
    expect(classifyLine("[P0051] LT265/65 R17 8PR 116Q SCORPION MTR PIRELLI TL").medida).toBe("265/65R17");
    expect(classifyLine("[P0737] 265/65R17 HANKOOK DYNAPRO RT05 MT").medida).toBe("265/65R17");
    expect(classifyLine("[P1500] P255/70R16 COMFORSER CF1100").medida).toBe("255/70R16");
    expect(classifyLine("[P1752] 225/70R15C 112/110R CONTINENTAL VANCONTACT").medida).toBe("225/70R15C");
    expect(classifyLine("[P0999] 11R22.5 MICHELIN XZE2+").diseno).toBe("Xze2+");
    expect(canonicalMedida("LT265/65R17")).toBe("265/65R17");
  });

  it("la llanta vendida con el enllante incluido es neumático, no servicio", () => {
    expect(classifyLine("[P1370] SERV. ENLLA 265/60R18 WESTLAKE SL366")).toMatchObject({ tipoLinea: "neumatico", medida: "265/60R18", marca: "Westlake" });
    expect(classifyLine("[P0434] SERV.ENLLA11R22.5 18PR FENIXWAY VALOR")).toMatchObject({ tipoLinea: "neumatico", medida: "11R22.5" });
  });

  it("servicios: el tipo sale del texto y unifica variantes (SERV.BA, SERV.BALAN y SERV.VARI son balanceo)", () => {
    for (const d of ["[SERV.BALAN] SERVICIO DE BALANCEO VEHICULAR", "[SERV.BA] SERVICIO DE BALANCEO VEHICULAR", "[SERV.VARI] SERVICIO DE BALANCEO VEHICULAR"]) {
      expect(classifyLine(d)).toMatchObject({ tipoLinea: "servicio", tipoServicio: "balanceo", seguro: true });
    }
    expect(classifyLine("[SERVALI] SERVICIO DE ALINEAMIENTO").tipoServicio).toBe("alineamiento");
    expect(classifyLine("[SERV.ENLL] SERVICIO DE ENLLANTE VEHICULAR").tipoServicio).toBe("enllante");
    expect(classifyLine("[SERV.LLAN] SERVICIO MONTAJE DE LLANTA").tipoServicio).toBe("enllante");
    expect(classifyLine("[SA019] SERVICIO DESENLLANTE/ ENLLAN NEUMATICOS").tipoServicio).toBe("desenllante");
    expect(classifyLine("[SERV.RO] SERVICIO ROTACION VARIOS NEUMATICOS").tipoServicio).toBe("rotacion");
    expect(classifyLine("[SERV.PAR] SERVICIO DE PARCHADO LLANTA").tipoServicio).toBe("parchado");
    expect(classifyLine("[SERV.CAM] SERVICIO DE CAMBIO NEUMATICOS").tipoServicio).toBe("cambio_neumaticos");
    expect(classifyLine("[SERV.MAN] MANTENIMIENTO CORRECTIVO").tipoServicio).toBe("mantenimiento_correctivo");
    expect(classifyLine("[SERPER] SERV.CONTRATO NEUMATICOS-PERSONAL").tipoServicio).toBe("contrato_personal");
    expect(classifyLine("[SERVINSU] SERV.CONTRATO NEUMATICOS-INSUMOS").tipoServicio).toBe("contrato_insumos");
    expect(classifyLine("[SERVBAHE] SERV.CONTRATO NEUMATICOS-BALANCEADORA Y HERRAMIENTAS").tipoServicio).toBe("contrato_equipos");
    expect(classifyLine("[SERV.SOFTNEU] SERVICIO DE SOFTWARE - NEUMATICOS").tipoServicio).toBe("software");
    expect(classifyLine("[CTH0042] SERV. REENCAUCHE BANSOL R1LP DEL 225MM 12R22.5")).toMatchObject({ tipoLinea: "servicio", tipoServicio: "reencauche" });
    expect(classifyLine("[SERV.VARI] SERVICIO CAMBIO DE PITON").tipoServicio).toBe("otros");
    expect(serviceTypeOf("servicio de alineamiento vehicular")).toBe("alineamiento");
  });

  it("otros productos: aros, parches, Sika, grasa, cemento, válvulas, cámaras y cargos (aunque traigan una medida)", () => {
    expect(classifyLine("[AR0081] ARO 8.25X22.5 ACTIVE EJE EUROPEO 10H")).toMatchObject({ tipoLinea: "otro", tipoOtro: "aro", medida: null });
    expect(classifyLine("[P0144] ARO 17\" FIERRO HI LUX")).toMatchObject({ tipoLinea: "otro", tipoOtro: "aro" });
    expect(classifyLine("[A0011] PARCHE VIPAL RAC 10")).toMatchObject({ tipoLinea: "otro", tipoOtro: "parche" });
    expect(classifyLine("[SK010] SIKAGARDVR-840 Pt 1L")).toMatchObject({ tipoLinea: "otro", tipoOtro: "sika" });
    expect(classifyLine("[AC0064] GRASA DE MONTAJE TECH 722 x 8 lbs").tipoOtro).toBe("grasa");
    expect(classifyLine("[P0148] CEMENTO VULCANIZANTE CV-01 VIPAL 362GR.").tipoOtro).toBe("cemento");
    expect(classifyLine("[P0439] GUARDACAMARA 7.50-16")).toMatchObject({ tipoLinea: "otro", tipoOtro: "camara" });
    expect(classifyLine("MORA")).toMatchObject({ tipoLinea: "otro", tipoOtro: "cargo", codigo: null });
    expect(classifyLine("DESCUENTOS").tipoOtro).toBe("cargo");
  });

  it("lo dudoso queda marcado (seguro: false) con el motivo", () => {
    expect(classifyLine("[P1602] ARO + LLANTA 12R22.5")).toMatchObject({ tipoLinea: "neumatico", seguro: false });
    expect(classifyLine("[TOYOTA_4X4HILUX_2022_BMP879] TOYOTA HILUX 4X4 D/C")).toMatchObject({ tipoLinea: "otro", tipoOtro: "vehiculo", seguro: false });
    expect(classifyLine("[AR0082] SERV. ENLLA ARO 16\" FIERRO MOD FORD RANGER")).toMatchObject({ tipoLinea: "otro", seguro: false });
  });

  it("tipo de documento y motivo de la nota de crédito", () => {
    expect(docTypeOf("Nota Crédito")).toBe("nota_credito");
    expect(docTypeOf("Nota Debito")).toBe("nota_debito");
    expect(docTypeOf("Boleta")).toBe("boleta");
    expect(creditNoteReason("Reversión de: F003-4319, AJUSTE DE PRECIO")).toEqual({ ref: "F003-4319", motivo: "AJUSTE DE PRECIO" });
    expect(creditNoteReason("Reversal of: B BOL-00000018, DEVOLUCION DE MERCADERIA")).toEqual({ ref: "B BOL-00000018", motivo: "DEVOLUCION DE MERCADERIA" });
    expect(creditNoteReason(null)).toEqual({ ref: null, motivo: null });
  });
});

describe("ventas-odoo: lectura del reporte", () => {
  it("encabezados en la fila 2 (fila 1 de grupos) y pie TOTALES / MARGEN / texto ignorado", async () => {
    const r = await read(await buildOdooXlsx(sampleOdooLines()));
    expect(r.formato).toBe("odoo");
    expect(r.headerRow).toBe(2);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(sampleOdooLines().length);
    const s = r.odoo!.stats;
    expect(s.filasIgnoradas).toEqual([20, 21, 22]);
    expect(s.totalesArchivo).toBeCloseTo(s.sumaTotalVtaSoles, 2);
  });

  it("nota de crédito resta cantidad y montos; la de solo descuento resta montos y no neumáticos; la de débito no suma", async () => {
    const r = await read(await buildOdooXlsx(sampleOdooLines()));
    const byDoc = (doc: string) => r.rows.filter((x) => x.detalle!.documento === doc);
    const [dev] = byDoc("F003-90");
    expect(dev.cantidad).toBe(-1);
    expect(dev.detalle!.totalUsd).toBe(-255);
    expect(dev.detalle!.costoTotalUsd).toBeCloseTo(-199.15, 2);
    expect(dev.detalle!.precioUnitarioUsd).toBe(255); // el precio unitario es una tarifa: sin signo
    expect(dev.detalle!.cuentaUnidades).toBe(true);
    const [desc] = byDoc("F003-91");
    expect(desc.cantidad).toBe(-8);
    expect(desc.detalle!.totalUsd).toBe(-40);
    expect(desc.detalle!.cuentaUnidades).toBe(false);
    const [nd] = byDoc("F NDI-00000001");
    expect(nd.detalle).toMatchObject({ tipoDoc: "nota_debito", cuentaUnidades: false });
    const s = r.odoo!.stats;
    expect(s.notasCredito).toMatchObject({ documentos: 2, lineas: 2, neumaticos: 1, soloMonto: 1 });
    expect(s.notasDebito).toEqual({ documentos: 1, lineas: 1 });
    // 8 (F003-5001) - 1 (devolución) + 6 + 4 (boleta) + 2 (documento raro) + 10 (banco) + 2 (Hecho) = 31; Cancelado y Borrador no
    expect(s.neumaticosNetos).toBe(31);
  });

  it("STATUS Cancelado y Borrador: se guardan excluidas y no cuentan; vacío, Hecho y Compra cuentan", async () => {
    const r = await read(await buildOdooXlsx(sampleOdooLines()));
    const st = (status: string | null) => r.rows.filter((x) => x.detalle!.status === status);
    expect(st("Cancelado").every((x) => x.detalle!.excluida && !x.detalle!.cuentaUnidades)).toBe(true);
    expect(st("Borrador").every((x) => x.detalle!.excluida)).toBe(true);
    expect(st("Hecho")[0].detalle).toMatchObject({ excluida: false, cuentaUnidades: true });
    expect(st("Compra")[0].detalle).toMatchObject({ excluida: false, tipoLinea: "otro" });
    expect(st(null).every((x) => !x.detalle!.excluida)).toBe(true);
    expect(r.odoo!.stats.excluidas).toMatchObject({ lineas: 2, porStatus: { Cancelado: 1, Borrador: 1 }, neumaticos: 9 });
  });

  it("documento del cliente: RUC, persona natural (DNI) y otro largo con advertencia, sin perder la fila", async () => {
    const r = await read(await buildOdooXlsx(sampleOdooLines()));
    const of = (ruc: string) => r.rows.find((x) => x.ruc === ruc.replace(/\D/g, ""))!;
    expect(of(FX.cliente).detalle!.docCliente).toBe("ruc");
    expect(of(FX.dni).detalle!.docCliente).toBe("dni");
    expect(of(FX.raro).detalle).toMatchObject({ docCliente: "otro" });
    expect(of(FX.raro).detalle!.advertencia).toMatch(/10 dígitos/);
    expect(r.odoo!.stats.advertencias).toHaveLength(1);
    expect(r.odoo!.stats.personasNaturales).toEqual({ lineas: 1, neumaticos: 4 });
  });

  it("clave estable: dos líneas idénticas de la misma factura no se fusionan", async () => {
    const r = await read(await buildOdooXlsx(sampleOdooLines()));
    const bal = r.rows.filter((x) => x.detalle!.documento === "F003-5001" && x.detalle!.codigoProducto === "SERV.BALAN");
    expect(bal).toHaveLength(2);
    expect(bal.map((x) => x.detalle!.lineKey)).toEqual(["FA|F003-5001|SERV.BALAN|1", "FA|F003-5001|SERV.BALAN|2"]);
    expect(new Set(r.rows.map((x) => x.detalle!.lineKey)).size).toBe(r.rows.length);
  });

  it("vendedor: alias de config y variantes de mayúsculas contra los usuarios; Facturación queda como texto sin dueño", async () => {
    const settings = { ...DEFAULT_SALES_SETTINGS, vendorAliases: { "DANYER SAAVERDRA": "Danyer Saavedra" } };
    const r = await readSalesXlsx(await buildOdooXlsx(sampleOdooLines()), { users, settings });
    const v = (texto: string) => r.odoo!.stats.vendedores.find((x) => x.texto === texto)!;
    expect(v("FRANK RODRIGUEZ")).toMatchObject({ vendedor: "Frank Rodríguez", userId: 1 });
    expect(v("Frank Rodriguez")).toMatchObject({ vendedor: "Frank Rodríguez", userId: 1 });
    expect(v("DANYER SAAVERDRA")).toMatchObject({ vendedor: "Danyer Saavedra", userId: 2 });
    expect(v("Facturación")).toMatchObject({ vendedor: "Facturación", userId: null });
    expect(v("JUAN BUSTIOS")).toMatchObject({ vendedor: "Juan Bustios", userId: null });
  });

  it("moneda, tipo de cambio y montos en soles y dólares tal como vienen", async () => {
    const r = await read(await buildOdooXlsx(sampleOdooLines()));
    const x = r.rows[0];
    expect(x.precioUnitario).toBe(892.5);
    expect(x.total).toBe(7140);
    expect(x.detalle).toMatchObject({ moneda: "USD", tipoCambio: 3.5, precioUnitarioUsd: 255, totalUsd: 2040, costoUnitarioUsd: 199.15, proveedor: "PROVEEDOR PRUEBA SAC", margen: "21.90%", margenPct: 21.9 });
    expect(r.rows[1].detalle).toMatchObject({ moneda: "PEN", margen: "SERVICIO SIN COSTO", margenPct: null });
  });

  it("el formato simple sigue funcionando", async () => {
    const r = await readSalesXlsx(await buildSalesXlsx([["Fecha", "RUC", "Cantidad"], ["2026-01-05", "20999000011", 4]]), { users });
    expect(r.formato).toBe("simple");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].detalle).toBeUndefined();
  });

  it("un PDF u otro formato: el mensaje pide el Excel de Odoo", () => {
    expect(checkUploadMeta({ name: "reporte.pdf", size: 1000 }, 4_000_000)).toBe("Sube el reporte en Excel (.xlsx). Expórtalo desde Odoo a Excel.");
    expect(checkUploadMeta({ name: "reporte.xls", size: 1000 }, 4_000_000)).toBe("Sube el reporte en Excel (.xlsx). Expórtalo desde Odoo a Excel.");
  });
});

// El archivo real del cliente (no está en git): la prueba corre donde está, y se salta donde no.
const REAL = path.resolve(process.cwd(), "data/referencia-360tyres/Reporte_Ventas_01-2025_hasta_11-2026.xlsx");
describe.skipIf(!fs.existsSync(REAL))("ventas-odoo: archivo real de Odoo (data/referencia-360tyres)", () => {
  it("suma de TOTAL VTA S/ igual a la fila TOTALES antes de excluir nada, y las cifras tras las reglas", async () => {
    const t0 = Date.now();
    const r = await read(fs.readFileSync(REAL));
    const ms = Date.now() - t0;
    const s = r.odoo!.stats;
    expect(r.errors).toEqual([]);
    expect(s.lineas).toBe(2920);
    expect(s.headerRow).toBe(2);
    expect(s.sumaTotalVtaSoles).toBe(11176075.4);
    expect(s.totalesArchivo).toBeCloseTo(11176075.4, 2);
    expect(s.filasIgnoradas).toHaveLength(3);
    expect(s.desde).toBe("2025-08-08");
    expect(s.hasta).toBe("2026-11-19");
    expect(s.porTipo.neumatico + s.porTipo.servicio + s.porTipo.otro + s.excluidas.lineas).toBe(2920);
    expect(s.excluidas.porStatus).toEqual({ Cancelado: 10, Borrador: 4 });
    expect(s.notasCredito.lineas).toBe(47);
    expect(s.notasDebito.lineas).toBe(3);
    expect(s.personasNaturales.lineas).toBe(47);
    expect(s.advertencias).toHaveLength(5);
    // 3 líneas idénticas legítimas (misma factura, descripción y cantidad) con claves distintas
    expect(new Set(r.rows.map((x) => x.detalle!.lineKey)).size).toBe(2920);
    expect(ms).toBeLessThan(10_000);
  });
});
