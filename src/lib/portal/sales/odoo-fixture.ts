/**
 * Pruebas (ventas-odoo): arma un .xlsx con la misma forma que el "Reporte Ventas" de Odoo (fila de grupos VENTA/COMPRA,
 * encabezados en la fila 2, TOTALES con fórmulas, MARGEN y pie de texto). Datos inventados: RUC, razones sociales y montos
 * no son de clientes reales.
 */
import ExcelJS from "exceljs";

export const ODOO_HEADERS = [
  "FECHA", "VENCIMIENTO", "TIPO DOC", "N° FACTURA", "MONEDA FACT VENTA", "ESTADO SUNAT", "OC ODOO", "OC PROVEEDOR", "GR. REMISIÓN", "RUC", "RAZON",
  "COND VTA", "DESCRIPCIÓN", "CANTIDAD", "T.C.", "VTA UND S/", "TOTAL VTA S/", "TOTAL VTA S/ SIN SERV", "VTA UND $", "TOTAL VTA $", "VENDEDOR",
  "COSTO UND S/", "COSTO TOTAL S/", "COSTO UND $", "COSTO TOTAL $", "FACTURA PROVEEDOR", "NOMBRE PROVEEDOR", "MONEDA FACT. PROV", "T.C", "STATUS", "MARGEN",
];

export interface OdooFixtureLine {
  fecha: string;
  tipoDoc?: string;
  documento: string;
  moneda?: "USD" | "PEN";
  ocProveedor?: string;
  ruc: string;
  razon: string;
  descripcion: string;
  cantidad: number;
  /** Precio unitario en la moneda de la factura (el otro se calcula con tc = 3.5, como lo haría el reporte). */
  precio: number;
  costo?: number;
  vendedor?: string;
  proveedor?: string;
  status?: string | null;
  margen?: string;
  /** Total en soles tal cual (por defecto precio × cantidad en soles; las notas de crédito en dólares del reporte real traen 0). */
  totalSoles?: number;
}

/** Fecha "AAAA-MM-DD" como Date de Excel (UTC). */
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export async function buildOdooXlsx(lines: OdooFixtureLine[], opts: { totales?: boolean } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Reporte Ventas");
  ws.addRow([...Array(19).fill("VENTA"), null, ...Array(9).fill("COMPRA")]);
  ws.addRow(ODOO_HEADERS);
  const tc = 3.5;
  for (const l of lines) {
    const usd = (l.moneda ?? "USD") === "USD";
    const pu$ = usd ? l.precio : Math.round((l.precio / tc) * 100) / 100;
    const puS = usd ? Math.round(l.precio * tc * 100) / 100 : l.precio;
    const cu$ = l.costo === undefined ? 0 : usd ? l.costo : Math.round((l.costo / tc) * 100) / 100;
    const cuS = l.costo === undefined ? 0 : usd ? Math.round(l.costo * tc * 100) / 100 : l.costo;
    const totalS = l.totalSoles ?? Math.round(puS * l.cantidad * 100) / 100;
    ws.addRow([
      d(l.fecha), d(l.fecha), l.tipoDoc ?? "Factura", l.documento, l.moneda ?? "USD", "Aceptado", "P00001", l.ocProveedor ?? null, null, l.ruc, l.razon,
      "30 días", l.descripcion, l.cantidad, tc, puS, totalS, totalS, pu$, Math.round(pu$ * l.cantidad * 100) / 100, l.vendedor ?? "FRANK RODRIGUEZ",
      cuS, Math.round(cuS * l.cantidad * 100) / 100, cu$, Math.round(cu$ * l.cantidad * 100) / 100, "F520-000001", l.proveedor ?? "PROVEEDOR PRUEBA SAC", "USD", tc,
      l.status === undefined ? "Contabilizado" : l.status, l.margen ?? "20.00%",
    ]);
  }
  if (opts.totales !== false) {
    const last = lines.length + 2;
    const tot = ws.addRow(["TOTALES"]);
    const sum = lines.reduce((n, l) => n + (l.totalSoles ?? Math.round(((l.moneda ?? "USD") === "USD" ? Math.round(l.precio * tc * 100) / 100 : l.precio) * l.cantidad * 100) / 100), 0);
    tot.getCell(17).value = { formula: `SUM(Q3:Q${last})`, result: Math.round(sum * 100) / 100 };
    const m = ws.addRow(["MARGEN"]);
    m.getCell(2).value = { formula: `AE${last + 1}`, result: 20 };
    ws.addRow(["Desarrollado por un proveedor de prueba - https://example.com"]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** RUC inventados para las pruebas. */
export const FX = {
  cliente: "20999000011",
  fueraPadron: "20999000099",
  banco: "20100047218", // RUC del BCP: está en sales.leasingRucs por defecto (dato público, no es un cliente)
  clienteFinal: "20999000022",
  dni: "40999001",
  raro: "909-90-90909",
};

/** Un reporte chico con todos los casos de las reglas. */
export function sampleOdooLines(): OdooFixtureLine[] {
  return [
    { fecha: "2026-09-12", documento: "F003-5001", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[P0759] 295/80R22.5 18PR FENIXWAY VALOR 89", cantidad: 8, precio: 255, costo: 199.15, margen: "21.90%" },
    { fecha: "2026-09-12", documento: "F003-5001", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[SERV.BALAN] SERVICIO DE BALANCEO VEHICULAR", cantidad: 2, precio: 20, moneda: "PEN", margen: "SERVICIO SIN COSTO" },
    { fecha: "2026-09-12", documento: "F003-5001", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[SERV.BALAN] SERVICIO DE BALANCEO VEHICULAR", cantidad: 2, precio: 20, moneda: "PEN", margen: "SERVICIO SIN COSTO" },
    { fecha: "2026-09-13", documento: "F003-5002", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[SERV.BA] SERVICIO DE BALANCEO VEHICULAR", cantidad: 4, precio: 20, moneda: "PEN" },
    { fecha: "2026-09-13", documento: "F003-5002", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[SERPER] SERV.CONTRATO NEUMATICOS-PERSONAL", cantidad: 1, precio: 3000, moneda: "PEN" },
    { fecha: "2026-09-13", documento: "F003-5002", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[AR0081] ARO 8.25X22.5 ACTIVE EJE EUROPEO 10H", cantidad: 2, precio: 90, costo: 60 },
    { fecha: "2026-09-20", tipoDoc: "Nota Crédito", documento: "F003-90", ocProveedor: "Reversión de: F003-5001, DEVOLUCION DE MERCADERIA", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[P0759] 295/80R22.5 18PR FENIXWAY VALOR 89", cantidad: 1, precio: 255, costo: 199.15, totalSoles: 0, margen: "0.00%" },
    { fecha: "2026-09-21", tipoDoc: "Nota Crédito", documento: "F003-91", ocProveedor: "Reversal of: F003-5001, DESCUENTO COMERCIAL", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[P0759] 295/80R22.5 18PR FENIXWAY VALOR 89", cantidad: 8, precio: 5, totalSoles: 0, margen: "0.00%" },
    { fecha: "2026-09-22", tipoDoc: "Nota Debito", documento: "F NDI-00000001", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "MORA", cantidad: 1, precio: 30, moneda: "PEN", status: null },
    { fecha: "2026-10-01", documento: "F003-5003", ruc: FX.fueraPadron, razon: "EMPRESA FUERA DEL PADRON EIRL", descripcion: "[P0336] 215/75R17.5 18PR FENIXWAY VALOR 99 MIX", cantidad: 6, precio: 126.42, costo: 90, status: null, vendedor: "Frank Rodriguez" },
    { fecha: "2026-10-02", tipoDoc: "Boleta", documento: "B BOL-00000007", ruc: FX.dni, razon: "PERSONA NATURAL PRUEBA", descripcion: "[P1420] 195/55ZR16 87W KUMHO ECSTA HS52 TL KOREA", cantidad: 4, precio: 65, moneda: "PEN", vendedor: "DANYER SAAVERDRA" },
    { fecha: "2026-10-03", documento: "F003-5004", ruc: FX.raro, razon: "FOREIGN TYRE CO", descripcion: "[P0737] 265/65R17 HANKOOK DYNAPRO RT05 MT", cantidad: 2, precio: 150, vendedor: "Facturación" },
    { fecha: "2026-10-04", documento: "F003-5005", ruc: FX.banco, razon: "BANCO DE CREDITO DEL PERU", descripcion: "[P0118] 265/70R16 110/107Q GENERAL GRABBER MT", cantidad: 10, precio: 172, costo: 100.12, vendedor: "JUAN BUSTIOS" },
    { fecha: "2026-10-05", documento: "F003-5006", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[P0433] 295/80R22.5 18PR FENIXWAY FLAMA 66 DEL", cantidad: 4, precio: 240, status: "Cancelado" },
    { fecha: "2026-10-06", documento: "F003-5007", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[P0043] 265/65R17 10PR MARSHAL MT51", cantidad: 5, precio: 120, status: "Borrador" },
    { fecha: "2026-10-07", documento: "F003-5008", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[P0434] SERV.ENLLA11R22.5 18PR FENIXWAY VALOR 96 MIX", cantidad: 2, precio: 250, status: "Hecho" },
    { fecha: "2026-10-08", documento: "F003-5009", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[A003] PITON S/CAMARA CURVO V3-20-4", cantidad: 6, precio: 2, status: "Compra" },
  ];
}
