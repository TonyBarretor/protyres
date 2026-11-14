/**
 * Corrida G (puntos 4–6): las pantallas reales (server components) con el store JSON en memoria y el puntaje calculado.
 * Solo se reemplazan la sesión, las server actions y los bloques asíncronos de crédito y encuesta de la ficha.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ESTIMATE_NOTE, explainLine } from "@/lib/portal/scoring/explain";
import { defaultScoringConfig } from "@/lib/portal/scoring/config";
import { recalcScores } from "@/lib/portal/scoring/recalc";
import { compareValidations } from "@/lib/portal/scoring/validation";
import type { CompanyRow, PortalUser } from "@/lib/portal/store/types";
import type { JsonPortalStore } from "@/lib/portal/store/json-portal-store";
import { CATALOG, NOW, scoredStore } from "./_test/scored-store";

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
vi.mock("./actions", () => {
  const noop = async () => undefined;
  return { addContact: noop, assignCompany: noop, deleteContact: noop, moveOpportunityStage: noop, releaseCompany: noop, setNextAction: noop, setTemperatura: noop, updateContact: noop };
});
vi.mock("./validar-ranking/actions", () => ({ submitRankingValidation: async () => undefined }));
vi.mock("./empresas/[id]/SurveyBlock", () => ({ SurveyBlock: () => null }));
vi.mock("./_components/CreditBlock", () => ({ CreditBlock: () => null }));

let ranked: CompanyRow[];
let frank: PortalUser;
let otro: PortalUser;
let tecnico: PortalUser;
let admin: PortalUser;

beforeAll(async () => {
  const s = await scoredStore();
  store = s.store;
  ranked = s.ranked;
  frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
  otro = await store.upsertUser({ nombre: "Otro Vendedor", whatsapp: "51900000002", rol: "vendedor" });
  tecnico = await store.upsertUser({ nombre: "Tito Técnico", whatsapp: "51900000004", rol: "tecnico" });
  admin = await store.upsertUser({ nombre: "Tony Admin", whatsapp: "51900000009", rol: "admin" });
});

const sp = (v: Record<string, string | string[]> = {}) => Promise.resolve(v);
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** Términos del modelo que no deben verse en pantalla. */
const TECH = /puntos|peso|score|percentil|potencial|encaje|familiaridad|valor/i;

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

describe("Prospectos: atractivo por defecto, nivel y explicación", () => {
  it("ordena por atractivo, muestra el nivel como estimación y la línea de explicación", async () => {
    user = frank;
    const { default: Page } = await import("./page");
    const html = renderToStaticMarkup(await Page({ searchParams: sp() }));
    const top = ranked[0];
    expect(top.nivel).toBe("A");
    expect(html.indexOf(top.razonSocial)).toBeLessThan(html.indexOf(ranked[1].razonSocial));
    expect(html).toContain("Nivel A");
    expect(html).toContain("estimación");
    expect(html).toContain(explainLine(top.scoreDetalle));
    expect(html).toContain(ESTIMATE_NOTE);
    expect(html).toMatch(/<option value="atractivo" selected="">Atractivo<\/option>/);
    expect(visibleText(html)).not.toMatch(TECH);
  });

  it("filtro por nivel", async () => {
    user = frank;
    const { default: Page } = await import("./page");
    const html = renderToStaticMarkup(await Page({ searchParams: sp({ nivel: "B" }) }));
    const bs = ranked.filter((r) => r.nivel === "B");
    expect(bs.length).toBeGreaterThan(0);
    for (const r of ranked) expect(html.includes(`>${r.razonSocial}<`)).toBe(r.nivel === "B");
    expect(html).toMatch(/name="nivel" checked="" value="B"/);
    expect(html).not.toMatch(/name="nivel" checked="" value="[AC]"/);
  });
});

describe("Ficha: por qué este nivel", () => {
  it("factores en palabras con su fuerza, la nota de estimación y sin términos técnicos", async () => {
    user = frank;
    const { default: Page } = await import("./empresas/[id]/page");
    const top = ranked[0];
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: String(top.id) }), searchParams: sp() }));
    expect(html).toContain("Por qué este nivel");
    expect(html).toContain("Nivel A");
    expect(html).toContain(ESTIMATE_NOTE);
    expect(html).toContain("Tamaño de la flota");
    expect(html).toMatch(/suma mucho|suma bastante|suma poco|no suma/);
    const block = html.slice(html.indexOf("Por qué este nivel"), html.indexOf("Flota por marca"));
    expect(visibleText(block)).not.toMatch(TECH);
    expect(block).not.toContain(String(top.score));
  });

  it("los frenos se explican", async () => {
    user = frank;
    const target = ranked[1];
    await store.saveCredit(target.id, { estado: "rechazado" }, null, NOW);
    await recalcScores(store, defaultScoringConfig(), { catalog: CATALOG, now: NOW, companyIds: [target.id] });
    const { default: Page } = await import("./empresas/[id]/page");
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: String(target.id) }), searchParams: sp() }));
    expect(html).toContain("Crédito rechazado: el nivel queda en C como máximo.");
    expect(html).toContain("Nivel C");
  });

  it("sin puntaje: dice que aún no se calculó", async () => {
    user = frank;
    const r = await store.upsertCompanies([{ ruc: "20777777777", razonSocial: "RECIEN LLEGADA SAC", unidades: 12 }]);
    const { default: Page } = await import("./empresas/[id]/page");
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: String(r.ids["20777777777"]) }), searchParams: sp() }));
    expect(html).toContain("Por qué este nivel");
    expect(html).toContain("aún no se ha calculado");
  });
});

describe("Hoy: tus 20 mejores flotas", () => {
  it("sin dueño primero, luego las propias sin actividad; nunca las de otro; Asignarme vuelve a Hoy", async () => {
    const [, , , mine, theirs] = ranked;
    await store.setOwner(mine.id, frank.id);
    await store.setOwner(theirs.id, otro.id);
    user = frank;
    const { default: Page } = await import("./hoy/page");
    const html = renderToStaticMarkup(await Page({ searchParams: sp() }));
    expect(html).toContain("Tus 20 mejores flotas para trabajar");
    expect(html).toContain(ESTIMATE_NOTE);
    const block = html.slice(html.indexOf("Tus 20 mejores flotas para trabajar"));
    expect(block).not.toContain(`>${theirs.razonSocial}<`);
    const sinDueno = block.indexOf("Sin dueño");
    const propias = block.indexOf("Tuyas sin actividad en 30 días");
    expect(sinDueno).toBeGreaterThan(-1);
    expect(propias).toBeGreaterThan(sinDueno);
    expect(block.indexOf(`>${mine.razonSocial}<`)).toBeGreaterThan(propias);
    expect(block.indexOf(`>${ranked[0].razonSocial}<`)).toBeLessThan(propias);
    expect(count(block, 'href="/portal/empresas/')).toBe(20);
    // un botón Asignarme por cada sin dueño (las propias ya son suyas)
    expect(count(block, ">Asignarme<")).toBe(19);
    expect(count(block, 'name="volver" value="/portal/hoy"')).toBe(19);
    expect(block).toContain("Nivel A");
  });

  it("técnico: sin el bloque (no puede asignarse)", async () => {
    user = tecnico;
    const { default: Page } = await import("./hoy/page");
    const html = renderToStaticMarkup(await Page({ searchParams: sp() }));
    expect(html).not.toContain("Tus 20 mejores flotas");
  });
});

describe("Validar ranking", () => {
  it("20 empresas sin puntaje, nivel ni explicación; A, B, C o No la conozco y nota", async () => {
    user = frank;
    const { default: Page } = await import("./validar-ranking/page");
    const html = renderToStaticMarkup(await Page({ searchParams: sp() }));
    expect(count(html, 'value="desconocida"')).toBe(20);
    for (const v of ["A", "B", "C"]) expect(count(html, `value="${v}"`)).toBe(20);
    expect(count(html, "No la conozco")).toBeGreaterThanOrEqual(20);
    expect(count(html, 'name="nota_')).toBe(20);
    expect(html).not.toContain("Nivel A");
    expect(html).not.toContain("pt-nivel");
    expect(html).not.toContain("/portal/empresas/");
    for (const r of ranked) {
      const line = explainLine(r.scoreDetalle);
      if (line) expect(html).not.toContain(line);
    }
    expect(visibleText(html)).not.toMatch(/puntaje|percentil|suma mucho/i);
  });

  it("técnico no entra; tras enviar: gracias y otra ronda", async () => {
    user = tecnico;
    const { default: Page } = await import("./validar-ranking/page");
    await expect(Page({ searchParams: sp() })).rejects.toThrow("notFound");
    user = frank;
    const html = renderToStaticMarkup(await Page({ searchParams: sp({ gracias: "3" }) }));
    expect(html).toContain("Gracias");
    expect(html).toContain("3 respuestas");
    expect(html).toContain('href="/portal/validar-ranking"');
    expect(count(html, 'value="desconocida"')).toBe(0);
  });
});

describe("Tablero: validación del ranking (admin)", () => {
  it("coincidencia, las que más difieren con enlace y las notas; vacío sin respuestas", async () => {
    const { RankingSummary } = await import("./tablero/RankingSummary");
    const empty = renderToStaticMarkup(<RankingSummary data={{ report: compareValidations([]), companyName: {}, userName: {} }} />);
    expect(empty).toContain("Validación del ranking");
    expect(empty).toContain("Aún no hay respuestas");
    const [a, b] = ranked;
    const report = compareValidations([
      { id: 1, userId: frank.id, companyId: a.id, nivelVendedor: "C", nivelSistema: "A", scoreSistema: 80, nota: "ya no opera", createdAt: NOW },
      { id: 2, userId: frank.id, companyId: b.id, nivelVendedor: "A", nivelSistema: "A", scoreSistema: 79, nota: null, createdAt: NOW },
    ]);
    const html = renderToStaticMarkup(
      <RankingSummary data={{ report, companyName: { [a.id]: a.razonSocial, [b.id]: b.razonSocial }, userName: { [frank.id]: frank.nombre } }} />,
    );
    expect(html).toContain("50%");
    expect(html).toContain(`href="/portal/empresas/${a.id}"`);
    expect(html).toContain("ya no opera");
    expect(html).toContain("Frank");
    void admin;
  });
});
