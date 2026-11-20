/**
 * ventas-odoo, puntos 8 y 9: la ficha real (server component) con el store JSON en memoria y el reporte de prueba de
 * odoo-fixture.ts. Precio, costo y margen solo para vendedor/supervisor/admin (el técnico ve la ficha sin el bloque); el
 * formulario de cliente final solo en la ficha del banco. Se reemplazan la sesión, las server actions y crédito/encuesta.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SALES_SETTINGS } from "@/lib/portal/sales/config";
import { commitOdooUpload, previewOdooUpload } from "@/lib/portal/sales/import";
import { buildOdooXlsx, FX, sampleOdooLines } from "@/lib/portal/sales/odoo-fixture";
import { readSalesXlsx } from "@/lib/portal/sales/xlsx";
import { JsonPortalStore } from "@/lib/portal/store/json-portal-store";
import type { PortalUser } from "@/lib/portal/store/types";

const store = JsonPortalStore.memory();
let user: PortalUser;

vi.mock("@/lib/portal/auth/session", () => ({ requireUser: async () => user }));
vi.mock("@/lib/portal/store", () => ({ getPortalStore: async () => store }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: () => {
    throw new Error("redirect");
  },
}));
vi.mock("../../actions", () => {
  const noop = async () => undefined;
  return { addContact: noop, assignCompany: noop, deleteContact: noop, moveOpportunityStage: noop, releaseCompany: noop, setNextAction: noop, setTemperatura: noop, updateContact: noop };
});
vi.mock("./sales-actions", () => ({ assignClienteFinalAction: async () => undefined }));
vi.mock("./SurveyBlock", () => ({ SurveyBlock: () => null }));
vi.mock("../../_components/CreditBlock", () => ({ CreditBlock: () => null }));

let frank: PortalUser;
let tecnico: PortalUser;
const ids: Record<string, number> = {};

beforeAll(async () => {
  const r = await store.upsertCompanies([
    { ruc: FX.cliente, razonSocial: "TRANSPORTES PRUEBA SAC" },
    { ruc: FX.banco, razonSocial: "BANCO DE CREDITO DEL PERU" },
    { ruc: FX.clienteFinal, razonSocial: "MINERA CLIENTE FINAL SAA" },
  ]);
  Object.assign(ids, r.ids);
  frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
  tecnico = await store.upsertUser({ nombre: "Tito Técnico", whatsapp: "51900000004", rol: "tecnico" });
  const parsed = await readSalesXlsx(await buildOdooXlsx(sampleOdooLines()), { users: await store.listUsers(), settings: DEFAULT_SALES_SETTINGS });
  const stats = await previewOdooUpload(store, parsed.odoo!);
  await commitOdooUpload({ store, parsed: parsed.odoo!, fileName: "r.xlsx", hash: "h", user: frank, stats, log: () => undefined });
});

async function render(id: number, sp: Record<string, string> = {}): Promise<string> {
  const { default: EmpresaPage } = await import("./page");
  return renderToStaticMarkup(await EmpresaPage({ params: Promise.resolve({ id: String(id) }), searchParams: Promise.resolve(sp) }));
}

describe("ficha: historial de ventas y cliente final", () => {
  it("el vendedor ve precio, costo, proveedor y margen, la nota de crédito marcada y en negativo, servicios con contrato y otros productos", async () => {
    user = frank;
    const html = await render(ids[FX.cliente]);
    expect(html).toContain("Historial de ventas");
    expect(html).toContain("US$ 199.15");
    expect(html).toContain("21.90%");
    expect(html).toContain("PROVEEDOR PRUEBA SAC");
    expect(html).toContain("Nota de crédito");
    expect(html).toContain("−1");
    expect(html).toContain("Tiene contrato de servicio");
    expect(html).toContain("Otros productos");
    expect(html).not.toContain("Cliente final (leasing)");
  });

  it("filtro por medida: enlaces con la medida canónica y la elegida marcada", async () => {
    user = frank;
    const html = await render(ids[FX.cliente], { medida: "295/80 R22.5" });
    expect(html).toContain(`<a aria-current="page" href="/portal/empresas/${ids[FX.cliente]}?medida=295%2F80R22.5#ventas">`);
    expect(html).not.toContain("Fenixway Valor 96 11R22.5");
  });

  it("el técnico ve la ficha sin el historial (sin costos)", async () => {
    user = tecnico;
    const html = await render(ids[FX.cliente]);
    expect(html).toContain("TRANSPORTES PRUEBA SAC");
    expect(html).not.toContain("Historial de ventas");
    expect(html).not.toContain("199.15");
  });

  it("en la ficha del banco: formulario de cliente final con la factura por asignar y la búsqueda de la empresa", async () => {
    user = frank;
    const html = await render(ids[FX.banco], { cf: FX.clienteFinal });
    expect(html).toContain("Cliente final (leasing)");
    expect(html).toContain('name="documento" value="F003-5005"');
    expect(html).toContain("MINERA CLIENTE FINAL SAA");
    expect(html).toMatch(new RegExp(`name="clienteFinalId"[^>]*value="${ids[FX.clienteFinal]}"`));
    user = tecnico;
    expect(await render(ids[FX.banco])).not.toContain("Cliente final (leasing)");
  });
});
