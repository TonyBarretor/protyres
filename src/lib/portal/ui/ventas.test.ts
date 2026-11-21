/**
 * ventas-odoo (puntos 8, 9 y 11), pantallas: modelo del historial de la ficha, asignación del cliente final con su permiso,
 * clientes fuera del padrón y cifras de la vista previa. Store JSON en memoria y el reporte de prueba de odoo-fixture.ts
 * (RUC y razones sociales inventados, salvo el RUC público del BCP).
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SALES_SETTINGS } from "../sales/config";
import { commitOdooUpload, previewOdooUpload, type OdooPreviewStats } from "../sales/import";
import { buildOdooXlsx, FX, sampleOdooLines, type OdooFixtureLine } from "../sales/odoo-fixture";
import { readSalesXlsx } from "../sales/xlsx";
import { JsonPortalStore } from "../store/json-portal-store";
import type { PortalStore, PortalUser } from "../store/types";
import { canAssignClienteFinal, canSeeSalesHistory } from "./permissions";
import { assignClienteFinal, clientsOutsidePadron, fichaSalesView, fmtMes, leasingBankView, parseMedidaParam } from "./ventas";
import { countRows, fmtIsoDate, serviceRows, totalsCheck, vendorSummary } from "./ventas-preview";

/** Más facturas del banco: una segunda factura y la nota de crédito que revierte parte de F003-5005. */
const BANK_EXTRA: OdooFixtureLine[] = [
  { fecha: "2026-10-10", documento: "F003-5010", ruc: FX.banco, razon: "BANCO DE CREDITO DEL PERU", descripcion: "[P0759] 295/80R22.5 18PR FENIXWAY VALOR 89", cantidad: 4, precio: 250, costo: 199 },
  { fecha: "2026-10-12", tipoDoc: "Nota Crédito", documento: "F003-95", ocProveedor: "Reversión de: F003-5005, DEVOLUCION DE MERCADERIA", ruc: FX.banco, razon: "BANCO DE CREDITO DEL PERU", descripcion: "[P0118] 265/70R16 110/107Q GENERAL GRABBER MT", cantidad: 2, precio: 172, costo: 100.12, totalSoles: 0 },
];

interface Ctx {
  store: PortalStore;
  frank: PortalUser;
  tecnico: PortalUser;
  ids: Record<string, number>;
}

async function setup(): Promise<Ctx> {
  const store = JsonPortalStore.memory();
  const r = await store.upsertCompanies([
    { ruc: FX.cliente, razonSocial: "TRANSPORTES PRUEBA SAC" },
    { ruc: FX.banco, razonSocial: "BANCO DE CREDITO DEL PERU" },
    { ruc: FX.clienteFinal, razonSocial: "MINERA CLIENTE FINAL SAA" },
  ]);
  const frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
  const tecnico = await store.upsertUser({ nombre: "Tito Técnico", whatsapp: "51900000004", rol: "tecnico" });
  const parsed = await readSalesXlsx(await buildOdooXlsx([...sampleOdooLines(), ...BANK_EXTRA]), { users: await store.listUsers(), settings: DEFAULT_SALES_SETTINGS });
  const stats = await previewOdooUpload(store, parsed.odoo!);
  await commitOdooUpload({ store, parsed: parsed.odoo!, fileName: "r.xlsx", hash: "h", user: frank, stats, log: () => undefined });
  return { store, frank, tecnico, ids: r.ids };
}

const quiet = () => undefined;

describe("ficha: historial de ventas (punto 8)", () => {
  it("neumáticos con precio, costo, proveedor y margen, la más reciente primero; notas de crédito marcadas y en negativo; sin excluidas", async () => {
    const { store } = await setup();
    const v = await fichaSalesView(store, { ruc: FX.cliente });
    // F003-5008: "SERV.ENLLA 11R22.5 ..." con código de producto es un neumático con el enllante incluido
    // F003-5006 (STATUS Cancelado) sale desde el ajuste 1: STATUS es de compra
    expect(v.neumaticos.map((r) => r.documento)).toEqual(["F003-5008", "F003-5006", "F003-91", "F003-90", "F003-5001"]);
    const [, , solo, dev, fac] = v.neumaticos;
    expect(fac).toMatchObject({ fecha: "12/09/2026", producto: "Fenixway Valor 89 295/80R22.5", cantidad: 8, precio: "US$ 255.00", costo: "US$ 199.15", proveedor: "PROVEEDOR PRUEBA SAC", margen: "21.90%", notaCredito: false });
    expect(dev).toMatchObject({ notaCredito: true, soloMonto: false, cantidad: -1, revierte: "F003-5001", tipoDoc: "Nota de crédito" });
    expect(solo).toMatchObject({ notaCredito: true, soloMonto: true, revierte: "F003-5001" });
    // F003-5007 (anulada en SUNAT) no sale
    expect(v.neumaticos.some((r) => r.documento === "F003-5007")).toBe(false);
    expect(v.neumaticosNetos).toBe(8 - 1 + 2 + 4);
    expect(v.clienteFinal).toBeNull();
  });

  it("servicios por tipo con último mes, contrato de servicio y otros productos aparte", async () => {
    const { store } = await setup();
    const v = await fichaSalesView(store, { ruc: FX.cliente });
    const bal = v.servicios.find((s) => s.tipo === "balanceo")!;
    expect(bal).toMatchObject({ label: "Balanceo", veces: 3, cantidad: 8, ultimaFecha: "2026-09-13" });
    expect(bal.ultimoMes).toMatch(/^(set|sept?)\.? 2026$/);
    expect(v.tieneContrato).toBe(true);
    expect(v.otros.map((r) => r.producto).join(" | ")).toMatch(/ARO 8\.25X22\.5/i);
    expect(v.neumaticos.some((r) => /ARO/i.test(r.producto))).toBe(false);
  });

  it("filtro por medida (?medida= en cualquier forma) y límite con 'ver todas'", async () => {
    const { store } = await setup();
    expect(parseMedidaParam("295/80 R 22.5")).toBe("295/80R22.5");
    expect(parseMedidaParam("<script>")).toBeNull();
    const v = await fichaSalesView(store, { ruc: FX.cliente }, { medida: "295/80 R22.5" });
    expect(v.medida).toBe("295/80R22.5");
    expect(v.neumaticos.every((r) => r.medida === "295/80R22.5")).toBe(true);
    expect(v.medidas).toContain("295/80R22.5");
    const otra = await fichaSalesView(store, { ruc: FX.cliente }, { medida: "315/80R22.5" });
    expect(otra.neumaticos).toEqual([]);
    expect(otra.neumaticosTotal).toBe(0);
  });

  it("fmtMes y fmtIsoDate", () => {
    expect(fmtMes("2026-01-31")).toMatch(/^ene\.? 2026$/);
    expect(fmtIsoDate("2026-09-12")).toBe("12/09/2026");
    expect(fmtIsoDate(null)).toBe("—");
  });
});

describe("cliente final (punto 9)", () => {
  it("en la ficha del banco: facturas por asignar, con la nota de crédito colgada de su factura", async () => {
    const { store } = await setup();
    const v = await fichaSalesView(store, { ruc: FX.banco });
    expect(v.clienteFinal).not.toBeNull();
    const docs = v.clienteFinal!.pendientes;
    expect(docs.map((d) => d.documento)).toEqual(["F003-5010", "F003-5005"]);
    expect(docs[1]).toMatchObject({ neumaticos: 8, notas: ["F003-95"], clienteFinal: null });
    expect(v.clienteFinal!.asignadas).toEqual([]);
  });

  it("permiso: vendedor, supervisor y admin activos; técnico y usuarios inactivos no", async () => {
    const u = (rol: PortalUser["rol"], activo = true) => ({ id: 1, rol, activo });
    expect(canAssignClienteFinal(u("vendedor"))).toBe(true);
    expect(canAssignClienteFinal(u("supervisor"))).toBe(true);
    expect(canAssignClienteFinal(u("admin"))).toBe(true);
    expect(canAssignClienteFinal(u("tecnico"))).toBe(false);
    expect(canAssignClienteFinal(u("vendedor", false))).toBe(false);
    expect(canSeeSalesHistory(u("tecnico"))).toBe(false);
    expect(canSeeSalesHistory(null)).toBe(false);
    const { store, tecnico, ids } = await setup();
    const r = await assignClienteFinal(store, { user: tecnico, bankRuc: FX.banco, documentos: ["F003-5005"], targetCompanyId: ids[FX.clienteFinal], log: quiet });
    expect(r).toEqual({ ok: false, error: "Tu rol no puede asignar el cliente final." });
    expect((await store.querySales({ documentos: ["F003-5005"] }))[0].detalle!.clienteFinalRuc).toBeNull();
  });

  it("valida factura del banco, que haya alguna marcada y que el cliente final no sea el mismo banco", async () => {
    const { store, frank, ids } = await setup();
    const base = { user: frank, bankRuc: FX.banco, targetCompanyId: ids[FX.clienteFinal], log: quiet };
    expect(await assignClienteFinal(store, { ...base, documentos: [] })).toEqual({ ok: false, error: "Marca al menos una factura." });
    const ajena = await assignClienteFinal(store, { ...base, documentos: ["F003-5001"] });
    expect(ajena).toMatchObject({ ok: false, error: expect.stringContaining("F003-5001 no es una factura de BANCO DE CREDITO DEL PERU") });
    expect(await assignClienteFinal(store, { ...base, targetCompanyId: ids[FX.banco], documentos: ["F003-5005"] })).toMatchObject({ ok: false });
    expect(await assignClienteFinal(store, { ...base, targetCompanyId: 99999, documentos: ["F003-5005"] })).toMatchObject({ ok: false });
  });

  it("asigna varias facturas a la vez (con su nota de crédito), se ve en ambas fichas, se cambia y se quita", async () => {
    const { store, frank, ids } = await setup();
    const r = await assignClienteFinal(store, { user: frank, bankRuc: FX.banco, documentos: ["f003 5005", "F003-5010"], targetCompanyId: ids[FX.clienteFinal], log: quiet });
    expect(r).toMatchObject({ ok: true, lineas: 3, mensaje: "Cliente final asignado: MINERA CLIENTE FINAL SAA en 3 documentos (3 líneas)." });
    if (!r.ok) return;
    expect(new Set(r.documentos)).toEqual(new Set(["F003-5005", "F003-5010", "F003-95"]));
    expect(new Set(r.companyIds)).toEqual(new Set([ids[FX.banco], ids[FX.clienteFinal]]));

    const cliente = await fichaSalesView(store, { ruc: FX.clienteFinal });
    expect(cliente.neumaticos.map((x) => x.leasing)).toEqual(Array(3).fill("vía leasing con BANCO DE CREDITO DEL PERU"));
    expect(cliente.neumaticosNetos).toBe(10 + 4 - 2);
    const banco = await fichaSalesView(store, { ruc: FX.banco });
    expect(banco.neumaticosNetos).toBe(0);
    expect(banco.neumaticos.every((x) => x.leasing === "cliente final: MINERA CLIENTE FINAL SAA")).toBe(true);
    expect(banco.clienteFinal!.pendientes).toEqual([]);
    expect(banco.clienteFinal!.asignadas.map((d) => [d.documento, d.clienteFinal?.razonSocial])).toEqual([
      ["F003-5010", "MINERA CLIENTE FINAL SAA"],
      ["F003-5005", "MINERA CLIENTE FINAL SAA"],
    ]);
    const acts = await store.listActivities({ companyId: ids[FX.clienteFinal], limit: 5 });
    expect(acts[0].texto).toContain("Cliente final de");

    // cambiar a otra empresa: la anterior también se recalcula
    const cambio = await assignClienteFinal(store, { user: frank, bankRuc: FX.banco, documentos: ["F003-5010"], targetCompanyId: ids[FX.cliente], log: quiet });
    expect(cambio.ok && new Set(cambio.companyIds)).toEqual(new Set([ids[FX.banco], ids[FX.cliente], ids[FX.clienteFinal]]));

    const quitar = await assignClienteFinal(store, { user: frank, bankRuc: FX.banco, documentos: ["F003-5005", "F003-5010"], targetCompanyId: null, log: quiet });
    expect(quitar).toMatchObject({ ok: true, mensaje: "Cliente final quitado de 3 documentos (3 líneas)." });
    const despues = await fichaSalesView(store, { ruc: FX.banco });
    expect(despues.clienteFinal!.pendientes.map((d) => d.documento)).toEqual(["F003-5010", "F003-5005"]);
    expect((await fichaSalesView(store, { ruc: FX.clienteFinal })).neumaticos).toEqual([]);
  });
});

describe("cliente final de un banco que no está en el padrón (como en la base real)", () => {
  it("leasingBankView lista sus facturas con la razón social del reporte y se asigna por RUC", async () => {
    const store = JsonPortalStore.memory();
    const r = await store.upsertCompanies([{ ruc: FX.clienteFinal, razonSocial: "MINERA CLIENTE FINAL SAA" }]);
    const frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
    const parsed = await readSalesXlsx(await buildOdooXlsx([...sampleOdooLines(), ...BANK_EXTRA]), { users: [frank], settings: DEFAULT_SALES_SETTINGS });
    const stats = await previewOdooUpload(store, parsed.odoo!);
    await commitOdooUpload({ store, parsed: parsed.odoo!, fileName: "r.xlsx", hash: "h", user: frank, stats, log: quiet });
    const bank = await leasingBankView(store, FX.banco);
    expect(bank).toMatchObject({ ruc: FX.banco, nombre: "BANCO DE CREDITO DEL PERU", companyId: null, esLeasing: true });
    expect(bank!.docs.pendientes.map((d) => d.documento)).toEqual(["F003-5010", "F003-5005"]);
    expect(await leasingBankView(store, "20999999999")).toBeNull();
    expect(await leasingBankView(store, "abc")).toBeNull();
    const res = await assignClienteFinal(store, { user: frank, bankRuc: FX.banco, documentos: ["F003-5005"], targetCompanyId: r.ids[FX.clienteFinal], log: quiet });
    expect(res).toMatchObject({ ok: true, companyIds: [r.ids[FX.clienteFinal]] });
    expect((await leasingBankView(store, FX.banco))!.docs.asignadas.map((d) => [d.documento, d.notas, d.clienteFinal?.razonSocial])).toEqual([["F003-5005", ["F003-95"], "MINERA CLIENTE FINAL SAA"]]);
    expect(await assignClienteFinal(store, { user: frank, bankRuc: "20999999999", documentos: ["F003-5005"], targetCompanyId: r.ids[FX.clienteFinal], log: quiet })).toMatchObject({ ok: false });
  });
});

describe("Subir ventas: clientes fuera del padrón y vista previa (punto 11)", () => {
  it("clientes con RUC que compran y no están en el padrón (sin DNI ni documentos raros)", async () => {
    const { store } = await setup();
    const rows = await clientsOutsidePadron(store);
    expect(rows.map((r) => [r.ruc, r.razonSocial, r.neumaticos, r.ultimaVenta])).toEqual([[FX.fueraPadron, "EMPRESA FUERA DEL PADRON EIRL", 6, "01/10/2026"]]);
  });

  it("cuadre de totales, servicios por tipo, STATUS y vendedores", async () => {
    expect(totalsCheck({ sumaTotalVtaSoles: 1000.2, totalesArchivo: 1000 })).toMatchObject({ estado: "cuadra", diferencia: 0.2 });
    expect(totalsCheck({ sumaTotalVtaSoles: 1010, totalesArchivo: 1000 })).toMatchObject({ estado: "no_cuadra", diferencia: 10 });
    expect(totalsCheck({ sumaTotalVtaSoles: 5, totalesArchivo: null })).toEqual({ estado: "sin_totales", suma: 5 });
    const store = JsonPortalStore.memory();
    const frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
    const parsed = await readSalesXlsx(await buildOdooXlsx(sampleOdooLines()), { users: [frank], settings: DEFAULT_SALES_SETTINGS });
    const st: OdooPreviewStats = await previewOdooUpload(store, parsed.odoo!);
    expect(totalsCheck(st).estado).toBe("cuadra");
    expect(serviceRows(st).map((r) => [r.label, r.lineas])).toContainEqual(["Balanceo", 3]);
    // STATUS ya no excluye ventas (ajuste 1: antes salían Borrador y Cancelado); solo la anulada en SUNAT
    expect(countRows(st.excluidas.porMotivo)).toEqual([["ESTADO SUNAT: Anulado", 1]]);
    const v = vendorSummary(st);
    // "FRANK RODRIGUEZ" y "Frank Rodriguez" del archivo son el mismo usuario: una sola fila
    expect(v.reconocidos.filter((x) => x.nombre === "Frank Rodríguez")).toHaveLength(1);
    expect(v.reconocidos[0].textos.length).toBeGreaterThanOrEqual(2);
    expect(v.sinDueno.map((x) => x.nombre)).toContain("Facturación");
    const dup = vendorSummary({ vendedores: [{ texto: "Juan Pérez", vendedor: null, userId: null, lineas: 2 }, { texto: "JUAN PEREZ", vendedor: null, userId: null, lineas: 3 }] });
    expect(dup.sinDueno).toEqual([{ nombre: "Juan Pérez", lineas: 5, textos: ["Juan Pérez", "JUAN PEREZ"] }]);
  });
});
