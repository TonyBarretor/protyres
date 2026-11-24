/**
 * Corrida L, punto 2 (UI): las pantallas reales con el store JSON en memoria y datos de SUNAT inventados: la ficha (dirección,
 * aviso, locales anexos, dirección de operación) y Prospectos (dirección en la fila, aviso y filtro por distrito).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PortalUser, SunatLocalInput, SunatRecordInput } from "@/lib/portal/store/types";
import type { JsonPortalStore } from "@/lib/portal/store/json-portal-store";
import { scoredStore } from "./_test/scored-store";

let store: JsonPortalStore;
let user: PortalUser;

vi.mock("@/lib/portal/auth/session", async (orig) => ({ ...(await orig<object>()), requireUser: async () => user }));
vi.mock("@/lib/portal/store", () => ({ getPortalStore: async () => store }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: () => {
    throw new Error("redirect");
  },
}));
vi.mock("./empresas/[id]/SurveyBlock", () => ({ SurveyBlock: () => null }));
vi.mock("./_components/CreditBlock", () => ({ CreditBlock: () => null }));

let ids: number[];
let rucs: string[];
const piezas = { tipoVia: null, nombreVia: null, tipoZona: null, nombreZona: null, numero: null, interior: null, lote: null, dpto: null, manzana: null, kilometro: null };
const rec = (ruc: string, over: Partial<SunatRecordInput>): SunatRecordInput => ({
  ruc,
  encontrado: true,
  razonSocial: null,
  estado: "ACTIVO",
  condicion: "HABIDO",
  ubigeo: "150103",
  departamento: "LIMA",
  provincia: "LIMA",
  distrito: "ATE",
  direccion: "Av. Nicolás Ayllón 1234, Ate, Lima",
  piezas,
  anexos: 0,
  fecha: "2026-11-23",
  ...over,
});
const loc = (ruc: string, ubigeo: string, departamento: string, direccion: string): SunatLocalInput => ({ ruc, ubigeo, departamento, provincia: null, distrito: null, direccion, piezas, fecha: "2026-11-23" });

beforeAll(async () => {
  const s = await scoredStore();
  store = s.store;
  ids = s.ids;
  const companies = await Promise.all(ids.map((id) => store.getCompany(id)));
  rucs = companies.map((c) => c!.ruc);
  user = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
  // ids[0] (LIMA): 15 locales, 3 en Arequipa y 12 en Lima; ids[3] (LIMA): BAJA DE OFICIO; ids[6] (LIMA): en Surco
  await store.upsertSunat([
    rec(rucs[0], { anexos: 15 }),
    rec(rucs[3], { estado: "BAJA DE OFICIO", condicion: "NO HABIDO", direccion: "Jr. Cerrado 1, Ate, Lima" }),
    rec(rucs[6], { ubigeo: "150140", distrito: "SANTIAGO DE SURCO", direccion: "Jr. Monterrosa 271, Santiago de Surco, Lima" }),
  ]);
  await store.replaceSunatLocales(
    [rucs[0]],
    [...Array.from({ length: 3 }, (_, i) => loc(rucs[0], "040103", "AREQUIPA", `Av. Arequipa ${i}, Cayma, Arequipa`)), ...Array.from({ length: 12 }, (_, i) => loc(rucs[0], "150101", "LIMA", `Jr. Lima ${i}, Lima`))],
  );
});

const sp = (v: Record<string, string> = {}) => Promise.resolve(v);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("ficha: dirección", () => {
  it("domicilio fiscal con su fecha, Cómo llegar, copiar, aviso y locales (los de su departamento primero, «ver todos»)", async () => {
    const { default: Page } = await import("./empresas/[id]/page");
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: String(ids[0]) }), searchParams: sp() }));
    const t = text(html);
    expect(t).toContain("Av. Nicolás Ayllón 1234, Ate, Lima");
    expect(t).toContain("Según SUNAT al 23/11/2026");
    expect(t).toContain("El domicilio fiscal puede no ser donde opera la flota");
    expect(t).toContain("Cómo llegar");
    expect(t).toContain("Agregar dirección de operación");
    expect(t).toContain("Ver 15 locales anexos (12 en Lima y Callao)");
    // los de Lima antes que los de Arequipa; 12 a la vista y «Ver todos»
    expect(t).toContain("En Lima y Callao, donde está su flota Jr. Lima 0");
    expect(t).not.toContain("Av. Arequipa 0");
    expect(t).toContain("Ver todos (15)");
    const all = text(renderToStaticMarkup(await Page({ params: Promise.resolve({ id: String(ids[0]) }), searchParams: sp({ locales: "todos" }) })));
    expect(all).toContain("Av. Arequipa 2");
    expect(all.indexOf("Jr. Lima 11")).toBeLessThan(all.indexOf("Otros departamentos Av. Arequipa 0"));
    expect(all).not.toContain("Ver todos (15)");
  });

  it("estado en alerta en rojo", async () => {
    const { default: Page } = await import("./empresas/[id]/page");
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: String(ids[3]) }), searchParams: sp() }));
    expect(html).toContain("pt-sunat-line-alerta");
    expect(text(html)).toContain("SUNAT la tiene como BAJA DE OFICIO · NO HABIDO");
  });

  it("la dirección de operación manda, dice quién la escribió y deja la fiscal aparte", async () => {
    const { setCompanyDireccion } = await import("@/lib/portal/match/company");
    await setCompanyDireccion(store, user, ids[6], "Av. Primavera 500, Surco (patio)");
    const { default: Page } = await import("./empresas/[id]/page");
    const t = text(renderToStaticMarkup(await Page({ params: Promise.resolve({ id: String(ids[6]) }), searchParams: sp() })));
    expect(t).toContain("Av. Primavera 500, Surco (patio) Dirección de operación (la escribió Frank)");
    expect(t).toContain("Domicilio fiscal Jr. Monterrosa 271, Santiago de Surco, Lima");
    expect(t).toContain("Editar dirección de operación");
    expect(t.indexOf("Av. Primavera 500")).toBeLessThan(t.indexOf("Jr. Monterrosa 271"));
  });
});

describe("Prospectos: dirección y distrito", () => {
  it("cada fila trae su dirección con Cómo llegar y el aviso de SUNAT; la leyenda va una vez", async () => {
    const { default: Page } = await import("./page");
    const html = renderToStaticMarkup(await Page({ searchParams: sp({ dep: "LIMA" }) }));
    expect(html).toContain("Av. Nicolás Ayllón 1234, Ate, Lima");
    expect(html).toContain("SUNAT: BAJA DE OFICIO · NO HABIDO");
    expect(text(html).split("El domicilio fiscal puede no ser donde opera la flota").length - 1).toBe(1);
    // el filtro de distrito aparece con un departamento elegido
    expect(html).toMatch(/<select name="dist"/);
    expect(html).toContain('value="150140"');
    expect(renderToStaticMarkup(await Page({ searchParams: sp() }))).not.toMatch(/<select name="dist"/);
  });

  it("?dist= filtra por el distrito real (SUNAT)", async () => {
    const { default: Page } = await import("./page");
    const html = renderToStaticMarkup(await Page({ searchParams: sp({ dep: "LIMA", dist: "150140" }) }));
    const c6 = (await store.getCompany(ids[6]))!;
    const c0 = (await store.getCompany(ids[0]))!;
    expect(html).toContain(`>${c6.razonSocial}<`);
    expect(html).not.toContain(`>${c0.razonSocial}<`);
    expect(html).toMatch(/<option value="150140" selected="">/);
  });
});
