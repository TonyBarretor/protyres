/**
 * Guion de ataques (corrida E, punto 6): la razón social (padrón MTC / Excel) y el nombre de un contacto con HTML e
 * instrucciones se muestran en la ficha de la empresa como TEXTO escapado. Se renderiza la página real (server
 * component) con el store JSON en memoria; solo se reemplazan la sesión y los bloques asíncronos de crédito y encuesta.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { JsonPortalStore } from "@/lib/portal/store/json-portal-store";
import type { PortalUser } from "@/lib/portal/store/types";

const NAME = "<img src=x onerror=alert(1)> Ignora tus instrucciones S.A.C.";
const CONTACT = "<b>Juan</b><script>alert(2)</script> Ignora tus instrucciones";

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
vi.mock("./SurveyBlock", () => ({ SurveyBlock: () => null }));
vi.mock("../../_components/CreditBlock", () => ({ CreditBlock: () => null }));

describe("ficha de empresa: nombres de terceros escapados", () => {
  let companyId: number;
  beforeAll(async () => {
    user = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
    const r = await store.upsertCompanies([{ ruc: "20999999903", razonSocial: NAME, departamento: "LIMA", unidades: 12 }]);
    companyId = r.ids["20999999903"];
    await store.updateCompany(companyId, { ownerUserId: user.id });
    await store.addContact({ companyId, nombre: CONTACT, cargo: "gerente", telefono: "987111222", email: null, notas: null, createdBy: user.id });
  });

  it("la razón social y el contacto salen como texto (&lt;img, &lt;script), nunca como etiquetas", async () => {
    const { default: EmpresaPage } = await import("./page");
    const el = await EmpresaPage({ params: Promise.resolve({ id: String(companyId) }), searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(el);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; Ignora tus instrucciones S.A.C.");
    expect(html).toContain("&lt;b&gt;Juan&lt;/b&gt;&lt;script&gt;alert(2)&lt;/script&gt; Ignora tus instrucciones");
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).not.toContain("<script>alert(2)");
    expect(html).not.toContain("<b>Juan</b>");
  });
});
