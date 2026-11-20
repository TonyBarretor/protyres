import { describe, expect, it } from "vitest";
import { FakeWhatsAppClient } from "../../whatsapp/client";
import { JsonPortalStore } from "../store/json-portal-store";
import type { PortalStore } from "../store/types";
import { DEFAULT_SALES_SETTINGS } from "./config";
import { companySalesView, lastSaleReference, lastTyreSales, leasingPending, saleLineText } from "./history";
import { commitOdooUpload, notifyAdminsOfUpload, previewOdooUpload, uploadNoticeText } from "./import";
import { buildOdooXlsx, FX, sampleOdooLines, type OdooFixtureLine } from "./odoo-fixture";
import { readSalesXlsx } from "./xlsx";

async function setup(): Promise<{ store: PortalStore; frank: { id: number; nombre: string; rol: "vendedor" } }> {
  const store = JsonPortalStore.memory();
  await store.upsertCompanies([
    { ruc: FX.cliente, razonSocial: "TRANSPORTES PRUEBA SAC" },
    { ruc: FX.banco, razonSocial: "BANCO DE CREDITO DEL PERU" },
    { ruc: FX.clienteFinal, razonSocial: "MINERA CLIENTE FINAL SAA" },
  ]);
  const u = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
  await store.upsertUser({ nombre: "Ana Admin", whatsapp: "51900000009", rol: "admin" });
  return { store, frank: { id: u.id, nombre: u.nombre, rol: "vendedor" } };
}

async function upload(store: PortalStore, user: { id: number; nombre: string; rol: "vendedor" }, lines: OdooFixtureLine[], name = "reporte.xlsx") {
  const r = await readSalesXlsx(await buildOdooXlsx(lines), { users: await store.listUsers(), settings: DEFAULT_SALES_SETTINGS });
  const stats = await previewOdooUpload(store, r.odoo!);
  const res = await commitOdooUpload({ store, parsed: r.odoo!, fileName: name, hash: `h-${name}`, user, stats, log: () => undefined });
  return { stats, res };
}

describe("ventas-odoo: carga en el store", () => {
  it("vista previa: empresas enlazadas y fuera del padrón, nuevas frente a existentes", async () => {
    const { store, frank } = await setup();
    const r = await readSalesXlsx(await buildOdooXlsx(sampleOdooLines()), { users: await store.listUsers(), settings: DEFAULT_SALES_SETTINGS });
    const p = await previewOdooUpload(store, r.odoo!);
    expect(p.empresas).toEqual({ enPadron: 2, fueraDelPadron: 1 });
    expect(p.fueraDelPadron.map((c) => c.ruc)).toEqual([FX.fueraPadron]);
    expect(p.topEmpresas[0]).toMatchObject({ ruc: FX.banco, neumaticos: 10, companyId: expect.any(Number) });
    expect(p).toMatchObject({ lineasNuevas: 17, lineasExistentes: 0 });
    await upload(store, frank, sampleOdooLines());
    const again = await previewOdooUpload(store, r.odoo!);
    expect(again).toMatchObject({ lineasNuevas: 0, lineasExistentes: 17 });
  });

  it("carga doble: el mismo archivo, o uno más reciente que incluye el periodo anterior, actualiza sin duplicar", async () => {
    const { store, frank } = await setup();
    const first = await upload(store, frank, sampleOdooLines(), "a.xlsx");
    expect(first.res).toMatchObject({ inserted: 17, updated: 0 });
    const second = await upload(store, frank, sampleOdooLines(), "a.xlsx");
    expect(second.res).toMatchObject({ inserted: 0, updated: 17 });
    const newer = [...sampleOdooLines(), { fecha: "2026-11-02", documento: "F003-5100", ruc: FX.cliente, razon: "TRANSPORTES PRUEBA SAC", descripcion: "[P0759] 295/80R22.5 18PR FENIXWAY VALOR 89", cantidad: 4, precio: 260, costo: 200 }];
    const third = await upload(store, frank, newer, "b.xlsx");
    expect(third.res).toMatchObject({ inserted: 1, updated: 17 });
    expect((await store.countSales()).total).toBe(18);
    const uploads = await store.listSalesUploads();
    expect(uploads.map((u) => [u.fileName, u.userName, u.userRol, u.inserted, u.updated])).toEqual([
      ["b.xlsx", "Frank Rodríguez", "vendedor", 1, 17],
      ["a.xlsx", "Frank Rodríguez", "vendedor", 0, 17],
      ["a.xlsx", "Frank Rodríguez", "vendedor", 17, 0],
    ]);
  });

  it("solo los neumáticos cuentan para participación; la nota de crédito resta; excluidas y servicios no suman", async () => {
    const { store, frank } = await setup();
    await upload(store, frank, sampleOdooLines());
    const part = await store.participation([FX.cliente, FX.banco, FX.fueraPadron, FX.dni], "2025-01-01");
    // cliente: 8 - 1 (devolución) + 2 (Hecho: llanta con enllante) = 9; Cancelado (4) y Borrador (5), servicios, aros, ND: no
    expect(part[FX.cliente]).toEqual({ cantidad: 9, demo: false });
    expect(part[FX.banco].cantidad).toBe(10);
    expect(part[FX.fueraPadron].cantidad).toBe(6);
    expect(part[FX.dni].cantidad).toBe(4);
    const agg = (await store.salesAggregate("2025-01-01", "2027-01-01")).filter((a) => a.ruc === FX.cliente);
    expect(agg.reduce((n, a) => n + a.cantidad, 0)).toBe(9);
  });

  it("una empresa que solo compró servicios no queda como cliente por neumáticos", async () => {
    const { store, frank } = await setup();
    await upload(store, frank, [{ fecha: "2026-09-12", documento: "F003-7001", ruc: FX.clienteFinal, razon: "MINERA CLIENTE FINAL SAA", descripcion: "[SERVALI] SERVICIO DE ALINEAMIENTO", cantidad: 3, precio: 50, moneda: "PEN" }]);
    const [c] = await store.getCompaniesByRucs([FX.clienteFinal]);
    const [inp] = await store.scoringInputs({ companyIds: [c.id], marcas: [], since12m: "2025-01-01", lostSince: new Date(0) });
    expect(inp).toMatchObject({ ventasReales: false, vendidos12m: 0 });
    expect(await store.participation([FX.clienteFinal], "2025-01-01")).toEqual({});
  });

  it("cliente final (leasing): los neumáticos pasan a la empresa, dejan de contar para el banco y sobreviven a una recarga", async () => {
    const { store, frank } = await setup();
    await upload(store, frank, sampleOdooLines());
    expect((await leasingPending(store)).map((d) => [d.documento, d.neumaticos])).toEqual([["F003-5005", 10]]);
    const [cf] = await store.getCompaniesByRucs([FX.clienteFinal]);
    expect(await store.setClienteFinal({ bankRuc: FX.banco, documentos: ["f003 5005".replace(" ", "-")], company: { id: cf.id, ruc: cf.ruc }, userId: frank.id })).toBe(1);
    let part = await store.participation([FX.banco, FX.clienteFinal], "2025-01-01");
    expect(part[FX.banco]).toBeUndefined();
    expect(part[FX.clienteFinal].cantidad).toBe(10);
    expect(await leasingPending(store)).toEqual([]);
    // recarga del mismo periodo: el cliente final no se borra
    await upload(store, frank, sampleOdooLines());
    part = await store.participation([FX.banco, FX.clienteFinal], "2025-01-01");
    expect(part[FX.clienteFinal].cantidad).toBe(10);
    const banco = await companySalesView(store, { ruc: FX.banco });
    const fin = await companySalesView(store, { ruc: FX.clienteFinal });
    expect(banco.leasing.get(banco.neumaticos[0].id)?.clienteFinal).toBe("cliente final: MINERA CLIENTE FINAL SAA");
    expect(fin.leasing.get(fin.neumaticos[0].id)?.viaLeasing).toBe("vía leasing con BANCO DE CREDITO DEL PERU");
    expect(fin.neumaticosNetos).toBe(10);
    expect(banco.neumaticosNetos).toBe(0);
    expect(banco.esLeasing).toBe(true);
    const [inp] = await store.scoringInputs({ companyIds: [cf.id], marcas: [], since12m: "2025-01-01", lostSince: new Date(0) });
    expect(inp).toMatchObject({ ventasReales: true, vendidos12m: 10 });
  });

  it("ficha: historial con filtro por medida, servicios por tipo y contrato de servicio", async () => {
    const { store, frank } = await setup();
    await upload(store, frank, sampleOdooLines());
    const v = await companySalesView(store, { ruc: FX.cliente });
    expect(v.medidas[0]).toBe("295/80R22.5");
    expect(v.serviciosPorTipo.map((r) => [r.tipo, r.veces, r.cantidad])).toEqual([
      ["balanceo", 3, 8],
      ["contrato_personal", 1, 1],
    ]);
    expect(v.tieneContrato).toBe(true);
    expect(v.otros.map((s) => s.detalle!.descripcion)).toContain("[AR0081] ARO 8.25X22.5 ACTIVE EJE EUROPEO 10H");
    expect(v.lineas.some((s) => s.detalle?.excluida)).toBe(false);
    const f = await companySalesView(store, { ruc: FX.cliente }, { medida: "295/80R22.5" });
    expect(f.lineas.every((s) => s.medida === "295/80R22.5")).toBe(true);
  });

  it("última venta: las 3 últimas de esa medida con precio, costo y margen; y la referencia para el cotizador", async () => {
    const { store, frank } = await setup();
    await upload(store, frank, sampleOdooLines());
    const last = await lastTyreSales(store, FX.cliente, { medida: "295/80R22.5" });
    expect(last).toHaveLength(1); // la nota de crédito no es una venta
    expect(saleLineText(last[0])).toBe("12/09/2026 · Fenixway Valor 89 295/80R22.5 · 8 u. · precio US$ 255.00 · costo US$ 199.15 · margen 21.90%");
    expect(await lastSaleReference(store, FX.cliente, "295/80 R22.5")).toBe("Última venta a este cliente: Valor 89 a US$ 255 el 12/09/2026");
    expect(await lastSaleReference(store, FX.cliente, "11R22.5")).toMatch(/^Última venta a este cliente: Valor 96 a US\$ 250 el 07\/10\/2026$/);
    expect(await lastSaleReference(store, FX.cliente, "315/80R22.5")).toBeNull();
  });

  it("ventas de demostración siguen sin mezclarse con las reales", async () => {
    const { store, frank } = await setup();
    await store.insertSales([{ fecha: "2026-09-01", ruc: FX.cliente, cantidad: 50, isDemo: true, origen: "demo" }]);
    await upload(store, frank, sampleOdooLines());
    expect((await companySalesView(store, { ruc: FX.cliente })).lineas.some((s) => s.isDemo)).toBe(false);
    expect((await store.salesByClient()).find((r) => r.ruc === FX.cliente)!.neumaticos).toBe(9);
    expect(await store.deleteDemoSales()).toBe(1);
    expect((await store.participation([FX.cliente], "2025-01-01"))[FX.cliente].cantidad).toBe(9);
  });

  it("aviso al administrador cuando sube un vendedor: enviado, o aviso pendiente si la ventana de 24 h está cerrada", async () => {
    const { store } = await setup();
    const text = uploadNoticeText({ nombre: "Frank Rodríguez" }, "reporte.xlsx", { inserted: 17, updated: 0 }, { desde: "2026-09-12", hasta: "2026-10-08", neumaticosNetos: 31 });
    expect(text).toBe("Frank Rodríguez subió ventas: reporte.xlsx (2026-09-12 a 2026-10-08), 17 líneas nuevas y 0 actualizadas, 31 neumáticos netos.");
    const wa = new FakeWhatsAppClient();
    expect(await notifyAdminsOfUpload(store, wa, text, () => undefined)).toEqual([{ to: "51900000009", status: "enviado" }]);
    expect(wa.sent.map((m) => [m.to, m.body])).toEqual([["51900000009", text]]);
    const closed = { sendText: async () => { throw new Error("(#131047) Re-engagement message"); } };
    expect((await notifyAdminsOfUpload(store, closed, text, () => undefined))[0].status).toBe("aviso_pendiente");
    expect(JSON.stringify(await store.getPortalConversation("51900000009"))).toContain("subió ventas");
  });
});
