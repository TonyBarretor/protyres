import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import { SettingsSchema, __setSettingsForTests, type Settings } from "../../settings";
import { routePortal } from "../bot";
import "../bot/commands/prepropuesta";
import { JsonPortalStore } from "../store";
import type { FleetVehicleInput, PortalUser } from "../store/types";
import { fillText, loadPrepropuestaConfig, parsePrepropuestaConfig } from "./config";
import { buildPrepropuestaData, fechaLarga, PrepropuestaError, validatePrepropuesta, type PrepropuestaData } from "./data";
import { countPdfPages, fuentesText, MAX_PAGES, pdfText, prepropuestaFileName, renderPrepropuestaPdf } from "./pdf";
import { generatePrepropuesta } from ".";

// miércoles 11/11/2026 09:00 en Lima
const NOW = new Date("2026-11-11T14:00:00Z");
const FRANK = "51900000001";
const SIN_FIRMA = "51900000005";
const BASE_ENV = { PORTAL_BASE_URL: "https://portal.example.pe", PORTAL_SESSION_SECRET: "test-secret-0123456789abcdef" };

/** Empresas inventadas (RUC y razón social ficticios). */
const RUC_ANDES = "20999000011";
const RUC_ANDES_SUR = "20999000022";
const RUC_VACIA = "20999000055";

const settings: Settings = SettingsSchema.parse({
  company: {
    name: "Professional Tyres",
    tradeName: "360° Tyres",
    signatureName: "360 by Professional Tyres",
    taxId: "RUC: 20565716396",
    logoPath: "config/branding/logo.png",
    footerImagePath: "config/branding/footer.png",
  },
  pricing: { currency: "USD" },
  quote: { numberFormat: "COT-{NNNN}" },
  salespeople: { [FRANK]: { name: "Vendedor de Prueba", title: "Asesor Comercial", phone: "900 000 001", email: "vendedor.prueba@example.pe", address: "Av. Inventada 123 - Lima" } },
});

function vehicle(companyId: number, placa: string, marca: string, clase: string, anio: number, llantas: number | null, medida: string | null): FleetVehicleInput {
  return { companyId, placa, marca, clase, anio, ejes: 2, llantas, llantasFuente: llantas ? "20241231" : null, pesoBruto: 18000, chasis: null, departamento: "LIMA", origen: "pasajeros", medidaProbable: medida, confianza: medida ? "media" : null };
}

let store: JsonPortalStore;
let frank: PortalUser;
let sinFirma: PortalUser;
let ids: Record<string, number>;

beforeEach(async () => {
  __setSettingsForTests(settings);
  store = JsonPortalStore.memory();
  frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: FRANK, rol: "vendedor" });
  sinFirma = await store.upsertUser({ nombre: "Sin Firma", whatsapp: SIN_FIRMA, rol: "vendedor" });
  const r = await store.upsertCompanies([
    { ruc: RUC_ANDES, razonSocial: "TRANSPORTES ANDES DEL PERU S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 40, llantasPiso: 250, antiguedadMedia: 9.6 },
    { ruc: RUC_ANDES_SUR, razonSocial: "EMPRESA ANDES SUR E.I.R.L.", sector: "carga", departamento: "AREQUIPA", unidades: 30, llantasPiso: 300 },
    { ruc: RUC_VACIA, razonSocial: "FLOTA SIN DATOS S.R.L.", unidades: 12, llantasPiso: 0 },
  ]);
  ids = r.ids;
  const andes = ids[RUC_ANDES];
  const marcas = ["VOLVO", "SCANIA", "MERCEDES BENZ", "YUTONG", "KING LONG", "HINO", "ISUZU", "MODASA"];
  const fleet: FleetVehicleInput[] = [];
  marcas.forEach((m, k) => {
    for (let i = 0; i < 8 - k; i++) fleet.push(vehicle(andes, `A${k}${i}-100`, m, k % 2 ? "CAMION" : "OMNIBUS", 2010 + i, k === 7 ? null : 6, k < 5 ? "295/80R22.5" : "215/75R17.5"));
  });
  await store.upsertFleet(fleet);
  await store.insertSales([{ fecha: "2026-09-01", ruc: RUC_ANDES, cantidad: 24, origen: "demo", isDemo: true }]);
  await store.addContact({ companyId: andes, nombre: "Carlos Quispe", cargo: "jefe de flota", telefono: "987654321", email: null, createdBy: frank.id });
});

afterEach(() => {
  __setSettingsForTests(null);
});

async function pdfPlainText(pdf: Buffer): Promise<{ text: string; pages: number }> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { text, totalPages } = await extractText(doc, { mergePages: true });
  return { text: String(text).replace(/\s+/g, " "), pages: totalPages };
}

const squash = (s: string) => pdfText(s).replace(/\s+/g, " ");

describe("config/prepropuesta.json", () => {
  it("es válida y trae las cifras de ANCRO con su fuente", () => {
    const cfg = loadPrepropuestaConfig(true);
    const ancro = cfg.casos.principal;
    expect(ancro.cliente).toBe("ANCRO S.R.L.");
    expect(ancro.comparativos.map((c) => [c.antes.texto, c.despues.texto, c.variacion])).toEqual([
      ["US$ 290", "US$ 247", "−15%"],
      ["US$ 151,048", "US$ 95,456", "−37%"],
    ]);
    expect(ancro.indicadores.map((i) => i.valor)).toEqual(["23–44%", "394", "6 de 6"]);
    for (const c of [...ancro.comparativos.map((x) => x.fuente), ...ancro.indicadores.map((x) => x.fuente)]) expect(c.archivo).toBe("INFORME_EJECUTIVO_COMERCIAL_SEPTIEMBRE.pdf");
    expect(cfg.casos.secundario.indicadores.every((i) => i.fuente.archivo === "INFORME_PRUEBA_ULTRASEAL_INNOVA_IA-5254.pdf")).toBe(true);
    expect(cfg.flota.nota).toBe("Unidades, ejes y llantas: datos públicos del MTC; la medida es una estimación a confirmar en la inspección.");
    expect(cfg.propuesta.pasos[0].titulo).toContain("5 unidades");
    expect(cfg.propuesta.pasos.some((p) => p.titulo.includes("70/20/10"))).toBe(true);
    expect(fuentesText(ancro)).toBe("Fuente: Informe ejecutivo semestral ANCRO S.R.L. (marzo – agosto 2026), pp. 1 y 2.");
  });

  it("rechaza textos vacíos", () => {
    const raw = JSON.parse(JSON.stringify(loadPrepropuestaConfig()));
    raw.quienesSomos.titulo = "  ";
    expect(() => parsePrepropuestaConfig(raw)).toThrow(/inválido/);
  });

  it("{empresa} sin doble punto", () => {
    expect(fillText("flota de {empresa}.", { empresa: "ZBUSS S.A.C." })).toBe("flota de ZBUSS S.A.C.");
    expect(fillText("para que {empresa} decida.", { empresa: "ACME SAC" })).toBe("para que ACME SAC decida.");
    expect(fechaLarga("2026-11-11")).toBe("11 de noviembre de 2026");
  });
});

describe("datos y validación", () => {
  it("arma empresa, flota top 6 + otras, medidas, vendedor; con alguna venta demo no hay participación", async () => {
    const d = await buildPrepropuestaData(store, ids[RUC_ANDES], frank, NOW);
    expect(d.fecha).toBe("2026-11-11");
    expect(d.empresa).toMatchObject({ razonSocial: "TRANSPORTES ANDES DEL PERU S.A.C.", ruc: RUC_ANDES, unidades: 40, llantasPiso: 250, antiguedadMedia: 10, atencion: "Carlos Quispe, jefe de flota" });
    expect(d.flota.filas).toHaveLength(6);
    expect(d.flota.filas[0]).toMatchObject({ marca: "VOLVO", clase: "OMNIBUS", unidades: 8, llantas: 48, anios: "2010–2017" });
    expect(d.flota.otras).toEqual({ grupos: 2, unidades: 3, llantas: 12 });
    expect(d.flota.medidas[0]).toMatchObject({ medida: "295/80R22.5", unidades: 30 });
    expect(d.participacion).toBeNull();
    expect(d.vendedor).toMatchObject({ nombre: "Vendedor de Prueba", telefono: "900 000 001", email: "vendedor.prueba@example.pe" });
    expect(validatePrepropuesta(d)).toEqual([]);
  });

  it("participación solo con ventas reales; una sola venta demo la omite entera", async () => {
    await store.insertSales([{ fecha: "2026-10-01", ruc: RUC_ANDES_SUR, cantidad: 10, origen: "csv", isDemo: false }]);
    expect((await buildPrepropuestaData(store, ids[RUC_ANDES_SUR], frank, NOW)).participacion).toEqual({ cantidad: 10 });
    await store.insertSales([{ fecha: "2026-10-02", ruc: RUC_ANDES_SUR, cantidad: 2, origen: "demo", isDemo: true }]);
    expect((await buildPrepropuestaData(store, ids[RUC_ANDES_SUR], frank, NOW)).participacion).toBeNull();
  });

  it("detecta campos vacíos visibles y obligatorios", async () => {
    const d = await buildPrepropuestaData(store, ids[RUC_ANDES], sinFirma, NOW);
    expect(validatePrepropuesta(d)).toEqual(["vendedor.nombre", "vendedor.telefono", "vendedor.email"]);
    const bad: PrepropuestaData = JSON.parse(JSON.stringify(d));
    bad.empresa.razonSocial = " ";
    bad.empresa.ruc = "123";
    bad.empresa.unidades = Number.NaN;
    bad.flota.filas[1].marca = "";
    bad.flota.medidas[0].medida = "undefined";
    expect(validatePrepropuesta(bad)).toEqual(
      expect.arrayContaining(["empresa.razonSocial", "empresa.ruc", "empresa.unidades", "flota.filas[1].marca", "flota.medidas[0].medida"]),
    );
    await expect(renderPrepropuestaPdf(d)).rejects.toThrow(PrepropuestaError);
    await expect(renderPrepropuestaPdf(d)).rejects.toThrow(/teléfono del vendedor.*config\/pilot\.json/);
  });

  it("sin flota ni llantas: los bloques opcionales se omiten (null), sin campos vacíos", async () => {
    const d = await buildPrepropuestaData(store, ids[RUC_VACIA], frank, NOW);
    expect(d.empresa).toMatchObject({ llantasPiso: null, sector: null, departamento: null, antiguedadMedia: null, atencion: null });
    expect(d.flota).toEqual({ filas: [], otras: null, medidas: [] });
    expect(d.participacion).toBeNull();
    expect(validatePrepropuesta(d)).toEqual([]);
  });

  it("nombre de archivo", () => {
    expect(prepropuestaFileName({ fecha: "2026-11-11", empresa: { razonSocial: "ZBUSS S.A.C." } as PrepropuestaData["empresa"] })).toBe("Pre-propuesta - ZBUSS S.A.C. - 11-11-2026.pdf");
    expect(prepropuestaFileName({ fecha: "2026-01-05", empresa: { razonSocial: "A/B: C" } as PrepropuestaData["empresa"] })).toBe("Pre-propuesta - A B C - 05-01-2026.pdf");
  });
});

describe("PDF", () => {
  it("se genera con ≤ 4 páginas, sin vacíos y con las cifras de ANCRO tal como están en la config", async () => {
    const cfg = loadPrepropuestaConfig();
    const gen = await generatePrepropuesta(store, ids[RUC_ANDES], frank, NOW);
    expect(gen.pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(gen.pages).toBeLessThanOrEqual(MAX_PAGES);
    expect(gen.fileName).toBe("Pre-propuesta - TRANSPORTES ANDES DEL PERU S.A.C. - 11-11-2026.pdf");
    const { text, pages } = await pdfPlainText(gen.pdf);
    expect(pages).toBe(gen.pages);
    expect(countPdfPages(gen.pdf)).toBe(pages);
    expect(text).not.toMatch(/\bundefined\b|\bnull\b|\bNaN\b|\[object|\{empresa\}|\{\s*\}/);
    expect(text).not.toMatch(/: ?·|· ?·|:\s*$/);
    const ancro = cfg.casos.principal;
    for (const c of ancro.comparativos) for (const s of [c.etiqueta, c.antes.texto, c.despues.texto, c.antes.periodo, c.despues.periodo, c.variacion]) expect(text).toContain(squash(s));
    for (const i of ancro.indicadores) expect(text).toContain(squash(i.valor));
    for (const i of cfg.casos.secundario.indicadores) expect(text).toContain(squash(i.valor));
    expect(text).toContain("ANCRO S.R.L.");
    expect(text).toContain("Innova Ambiental S.A.");
    expect(text).toContain(squash(cfg.flota.nota));
    // datos de la empresa y del vendedor
    for (const s of ["TRANSPORTES ANDES DEL PERU S.A.C.", RUC_ANDES, "Carlos Quispe", "295/80R22.5", "Vendedor de Prueba", "900 000 001", "vendedor.prueba@example.pe", "Página 1 de 4", "Página 4 de 4"]) expect(text).toContain(s);
    // hay una venta demo: el bloque de participación no aparece (el PDF va al cliente)
    expect(text).not.toContain("DEMO");
    expect(text).not.toContain("Participación");
  }, 30_000);

  it("peor caso (6 filas + Otras, 3 medidas, participación real, textos largos): ≤ 4 páginas", async () => {
    const largo = (s: string, n: number) => `${s} ${"X".repeat(n)}`;
    const data: PrepropuestaData = {
      fecha: "2026-11-11",
      fechaTexto: "11 de noviembre de 2026",
      empresa: {
        id: 1,
        razonSocial: largo("EMPRESA DE TRANSPORTES INTERPROVINCIALES Y SERVICIOS LOGISTICOS MULTIPLES DEL SUR ANDINO", 30) + " S.A.C.",
        ruc: "20999000099",
        sector: "Pasajeros y carga",
        departamento: "MADRE DE DIOS",
        unidades: 1234,
        llantasPiso: 9876,
        antiguedadMedia: 14,
        atencion: "Maria Fernanda de los Angeles Huamani Quispe, jefa de mantenimiento de flota y neumaticos",
      },
      flota: {
        filas: Array.from({ length: 6 }, (_, i) => ({
          marca: largo(`MERCEDES BENZ ${i}`, 12),
          clase: "SEMIRREMOLQUE CAMION",
          anios: "1998–2026",
          unidades: 200 - i,
          llantas: 2400 - i,
        })),
        otras: { grupos: 37, unidades: 500, llantas: 4000 },
        medidas: [
          { medida: "295/80R22.5", unidades: 600, confianza: "alta" },
          { medida: "11R22.5", unidades: 300, confianza: "media" },
          { medida: "215/75R17.5", unidades: 100, confianza: null },
        ],
      },
      participacion: { cantidad: 12345 },
      vendedor: {
        nombre: "Vendedor de Prueba Con Nombre Muy Largo Apellido Compuesto",
        cargo: "Asesor Comercial Senior de Flotas Corporativas",
        telefono: "900 000 001",
        email: "vendedor.de.prueba.con.correo.largo@example.pe",
        direccion: "Av. Inventada 1234, Urb. Los Jardines del Pacifico, Santiago de Surco - Lima",
      },
    };
    expect(validatePrepropuesta(data)).toEqual([]);
    const pdf = await renderPrepropuestaPdf(data);
    const { text, pages } = await pdfPlainText(pdf);
    expect(pages).toBeLessThanOrEqual(MAX_PAGES);
    expect(countPdfPages(pdf)).toBe(pages);
    expect(text).toContain(`Página ${pages} de ${pages}`);
    expect(text).toContain("Participación");
    expect(text).toContain("Otras (37 marca/clase)");
    expect(text).toContain("215/75R17.5");
  }, 30_000);

  it("empresa sin flota ni ventas: igual ≤ 4 páginas y sin bloques vacíos", async () => {
    const gen = await generatePrepropuesta(store, ids[RUC_VACIA], frank, NOW);
    const { text, pages } = await pdfPlainText(gen.pdf);
    expect(pages).toBeLessThanOrEqual(MAX_PAGES);
    expect(text).not.toMatch(/\bundefined\b|\bnull\b|\bNaN\b/);
    expect(text).not.toContain("Flota por marca");
    expect(text).not.toContain("Medidas probables");
    expect(text).not.toContain("Llantas en piso");
    expect(text).not.toContain("DEMO");
  }, 30_000);
});

describe("comando prepropuesta", () => {
  interface Out {
    kind: "text" | "document";
    body?: string;
    file?: Buffer;
    fileName?: string;
    caption?: string;
    mimeType?: string;
  }
  let out: Out[];
  beforeEach(() => {
    out = [];
  });
  const send = (text: string, from = FRANK) =>
    routePortal({
      from,
      text,
      store,
      now: NOW,
      env: BASE_ENV,
      reply: async (body) => void out.push({ kind: "text", body }),
      sendDocument: async (file, fileName, caption, mimeType) => void out.push({ kind: "document", file, fileName, caption, mimeType }),
      sendTextTo: async () => undefined,
    });

  it("manda el PDF sin leyenda y luego el mensaje aparte; registra la actividad", async () => {
    expect(await send("prepropuesta 20999000011")).toBe(true);
    expect(out.map((m) => m.kind)).toEqual(["document", "text"]);
    const doc = out[0];
    expect(doc.caption ?? "").toBe("");
    expect(doc.mimeType).toBe("application/pdf");
    expect(doc.fileName).toBe("Pre-propuesta - TRANSPORTES ANDES DEL PERU S.A.C. - 11-11-2026.pdf");
    expect(doc.file!.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(out[1].body).toMatch(/^📄 Pre-propuesta para \*TRANSPORTES ANDES DEL PERU S\.A\.C\.\* lista: /);
    const acts = await store.listActivities({ companyId: ids[RUC_ANDES] });
    expect(acts.find((a) => a.tipo === "prepropuesta")).toMatchObject({ userId: frank.id, canal: "whatsapp" });
  }, 30_000);

  it("varias empresas: lista y sigue al elegir", async () => {
    await send("pre-propuesta andes");
    expect(out.at(-1)!.body).toMatch(/¿Cuál\?/);
    out = [];
    await send("1");
    expect(out.map((m) => m.kind)).toEqual(["document", "text"]);
  }, 30_000);

  it("sin datos del vendedor: avisa y no manda PDF ni registra actividad", async () => {
    await send("prepropuesta 20999000011", SIN_FIRMA);
    expect(out.map((m) => m.kind)).toEqual(["text"]);
    expect(out[0].body).toMatch(/No pude generar la pre-propuesta.*teléfono del vendedor/);
    expect((await store.listActivities({ companyId: ids[RUC_ANDES] })).some((a) => a.tipo === "prepropuesta")).toBe(false);
  });

  it("vendedor que no es dueño: no genera; sin dueño sí", async () => {
    const otro = await store.upsertUser({ nombre: "Otro Vendedor", whatsapp: "51900000009", rol: "vendedor" });
    await store.updateCompany(ids[RUC_ANDES], { ownerUserId: otro.id });
    await send("prepropuesta 20999000011");
    expect(out.map((m) => m.kind)).toEqual(["text"]);
    expect(out[0].body).toMatch(/solo la genera su vendedor dueño/);
    expect((await store.listActivities({ companyId: ids[RUC_ANDES] })).some((a) => a.tipo === "prepropuesta")).toBe(false);
  });

  it("sin empresa: pide cuál", async () => {
    await send("prepropuesta");
    expect(out.map((m) => m.kind)).toEqual(["text"]);
    expect(out[0].body).toMatch(/¿Para qué empresa\?/);
  });
});
