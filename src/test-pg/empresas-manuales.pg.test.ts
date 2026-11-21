/**
 * Corrida J contra Postgres real: empresas creadas a mano y vehículos cargados a mano dan lo mismo en el store JSON y en
 * PgPortalStore (alta, RUC repetido, vehículo nuevo / corregido / de otra empresa, flota por marca sin los manuales,
 * borrado, fusión con el padrón que conserva lo cargado a mano y poda que no los toca); y dos vendedores que pulsan
 * *Asignármela y guardar todo* a la vez sobre la misma empresa sin dueño: solo uno se la lleva (con una sola oportunidad
 * abierta) y el otro recibe un aviso claro y guarda solo la nota.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompany, addVehicle } from "../lib/portal/companies/manual";
import { configureReportBot } from "../lib/portal/bot/report";
import { JsonPortalStore } from "../lib/portal/store/json-portal-store";
import { PgPortalStore } from "../lib/portal/store/pg-portal-store";
import type { Company, FleetVehicle, FleetVehicleInput, PortalStore } from "../lib/portal/store/types";
import { SettingsSchema } from "../lib/settings";
import { JsonStore } from "../lib/store/json-store";
import { FakeWhatsAppClient } from "../lib/whatsapp/client";
import { BotHandler } from "../lib/whatsapp/handler";
import type { InboundMessage } from "../lib/whatsapp/webhook";
import { testDbUrl, truncateAll } from "./harness";
import { bothTraces, diffTraces } from "./parity";

let pg: PgPortalStore;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ["LLM_DISABLED", "PHOTOS_DISABLED", "PORTAL_SESSION_SECRET", "PORTAL_BASE_URL"]) saved[k] = process.env[k];
  process.env.LLM_DISABLED = "1";
  process.env.PHOTOS_DISABLED = "1";
  process.env.PORTAL_SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.PORTAL_BASE_URL = "https://portal.example.pe";
  await truncateAll(testDbUrl());
  pg = PgPortalStore.connect(testDbUrl());
});
afterAll(async () => {
  await pg?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Sin ids (en Postgres un insert que choca gasta un número de la secuencia) ni horas. */
const co = (c: Company | null) => (c ? { ruc: c.ruc, razonSocial: c.razonSocial, sector: c.sector, departamento: c.departamento, unidades: c.unidades, llantasPiso: c.llantasPiso, origen: c.origen, owner: c.ownerUserId !== null, createdBy: c.createdBy !== null, nivel: c.nivel ?? null, score: c.score } : null);
const veh = (v: FleetVehicle) => ({ placa: v.placa, marca: v.marca, clase: v.clase, ejes: v.ejes, llantas: v.llantas, medida: v.medidaProbable, confianza: v.confianza, origen: v.origen });
const mtc = (companyId: number, placa: string): FleetVehicleInput => ({ companyId, placa, marca: "SCANIA", clase: "TRACTO", anio: 2019, ejes: 3, llantas: 10, llantasFuente: "20241231", pesoBruto: 30000, chasis: null, departamento: "LIMA", origen: "carga", medidaProbable: "295/80R22.5", confianza: "media" });

describe("empresas creadas a mano: JSON y Postgres dan lo mismo", () => {
  it("alta, RUC repetido, vehículos a mano, flota por marca, fusión con el padrón y poda", async () => {
    const { json, pg: p } = await bothTraces<PortalStore>(JsonPortalStore.memory(), pg, async (s, trace) => {
      const frank = await s.upsertUser({ nombre: "Frank Prueba", whatsapp: "51900000001", rol: "vendedor" });
      const sol = await createCompany(s, frank, { ruc: "20600000013", razonSocial: "Transportes Sol SAC", sector: "carga", departamento: "Lima", unidades: 2, contacto: { nombre: "Rosa Díaz", cargo: "Jefa de flota", telefono: "987654321" } }, { canal: "whatsapp", now: new Date("2026-11-20T15:00:00Z") });
      if (!sol.ok) throw new Error(sol.error);
      trace("alta", { created: sol.created, company: co(sol.company) });
      trace("alta.opps", (await s.listOpportunities({ companyId: sol.company.id })).map((o) => [o.etapa, o.ownerUserId === frank.id]));
      trace("alta.contactos", (await s.listContacts(sol.company.id)).map((c) => c.nombre));
      const dup = await s.createManualCompany({ ruc: "20600000013", razonSocial: "OTRA", sector: null, departamento: null, createdBy: frank.id });
      trace("duplicado", { created: dup.created, company: co(dup.company), mismo: dup.company.id === sol.company.id });

      trace("veh.nuevo", await addVehicle(s, frank, sol.company, { placa: "abc 123", marca: "Volvo", clase: "Tracto", ejes: 3, llantas: 10, medida: "295/80R22.5" }).then((r) => (r.ok ? { updated: r.updated, v: veh(r.vehicle) } : r)));
      trace("veh.otro", await addVehicle(s, frank, sol.company, { placa: "XYZ-987", llantas: 6 }).then((r) => (r.ok ? { updated: r.updated, v: veh(r.vehicle) } : r)));
      trace("veh.corrige", await addVehicle(s, frank, sol.company, { placa: "ABC123", marca: "Volvo", clase: "Tracto", ejes: 3, llantas: 12, medida: "295/80R22.5" }).then((r) => (r.ok ? { updated: r.updated, v: veh(r.vehicle) } : r)));
      const luna = (await s.createManualCompany({ ruc: "20612345679", razonSocial: "EXPRESO LUNA", sector: "pasajeros", departamento: "AREQUIPA", createdBy: frank.id })).company;
      trace("veh.otraEmpresa", await s.addManualVehicle(luna.id, { placa: "ABC-123", marca: null, clase: null, ejes: null, llantas: null, medida: null }).then((r) => (r.ok ? r.ok : { reason: r.reason, mismo: r.companyId === sol.company.id })));
      trace("veh.lista", (await s.listManualVehicles(sol.company.id)).map(veh));
      trace("veh.empresa", co(await s.getCompany(sol.company.id)));
      trace("veh.porMarca", await s.fleetByBrand(sol.company.id));
      const xyz = (await s.listManualVehicles(sol.company.id)).find((v) => v.placa === "XYZ-987")!;
      trace("veh.borrar", [await s.deleteManualVehicle(luna.id, xyz.id), await s.deleteManualVehicle(sol.company.id, xyz.id), await s.deleteManualVehicle(sol.company.id, xyz.id)]);

      // el padrón trae a SOL (sin departamento) y otra empresa; LUNA no
      const up = await s.upsertCompanies([
        { ruc: "20600000013", razonSocial: "TRANSPORTES SOL S.A.C.", sector: "carga", departamento: null, unidades: 14, llantasPiso: 140 },
        { ruc: "20602221505", razonSocial: "ZBUSS S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 85 },
      ]);
      trace("padron.merged", up.merged ?? []);
      await s.upsertFleet([mtc(sol.company.id, "MTC-001"), mtc(sol.company.id, "MTC-002")]);
      trace("padron.poda", await s.pruneFleet([sol.company.id], [{ placa: "MTC-001", origen: "carga" }]));
      trace("padron.flota", (await s.listFleet(sol.company.id)).map(veh));
      trace("padron.sol", co(await s.getCompany(sol.company.id)));
      trace("padron.luna", co(await s.getCompany(luna.id)));
      trace("padron.origenes", (await s.companyOriginCounts()).map((c) => [c.ruc, c.carga, c.pasajeros]));
      trace("padron.otraVez", (await s.upsertCompanies([{ ruc: "20600000013", razonSocial: "TRANSPORTES SOL S.A.C." }])).merged ?? []);
    });
    expect(json["alta"]).toMatchObject({ created: true, company: { origen: "manual", departamento: "LIMA", owner: true, createdBy: true } });
    expect(json["veh.otraEmpresa"]).toEqual({ reason: "otra_empresa", mismo: true });
    expect(json["padron.merged"]).toEqual(["20600000013"]);
    expect(json["padron.sol"]).toMatchObject({ origen: "mtc", departamento: "LIMA", razonSocial: "TRANSPORTES SOL S.A.C." });
    expect(diffTraces(json, p)).toEqual([]);
  });
});

const settings = SettingsSchema.parse({
  company: { name: "Professional Tyres", tradeName: "360° Tyres", signatureName: "360 by Professional Tyres", taxId: "RUC: 20565716396" },
  pricing: { currency: "USD", taxPct: 18, own: { pricesIncludeTax: true, maxDiscountPct: 20, defaultDiscountPct: 0 }, provider: { marginPct: 15, pricesIncludeTax: false }, exchangeRates: { PEN: 3.75 }, stalePriceDays: 30 },
  quote: { numberFormat: "COT-{NNNN}", counterStart: 1, validityDays: 7 },
  salespeople: { "51900000011": { name: "Vendedor Uno" }, "51900000012": { name: "Vendedor Dos" } },
});

describe("*Asignármela y guardar todo* de dos vendedores a la vez", () => {
  it("solo uno se la lleva (una oportunidad abierta, su contacto); el otro recibe el aviso y guarda solo la nota", async () => {
    configureReportBot({ llm: null });
    const sellers = ["51900000011", "51900000012"];
    // dos instancias (como dos funciones de Vercel), cada una con su pool
    const extra = PgPortalStore.connect(testDbUrl());
    const stores: PortalStore[] = [pg, extra];
    const problems: string[] = [];
    try {
      for (const [i, phone] of sellers.entries()) await pg.upsertUser({ nombre: `Vendedor ${i ? "Dos" : "Uno"}`, whatsapp: phone, rol: "vendedor" });
      for (let round = 0; round < 5; round++) {
        const ruc = `2088800${String(round).padStart(4, "0")}`;
        // un nombre de una palabra distinto por ronda (con las de rondas anteriores ya asignadas, "carrera" las confundiría)
        const name = `${["QUIMBAYA", "ZORZALITO", "PELICANERA", "VICUNERA", "CONDORITAS"][round]} S.A.C.`;
        const { ids } = await pg.upsertCompanies([{ ruc, razonSocial: name, sector: "carga", departamento: "LIMA", unidades: 30, llantasPiso: 300 }]);
        const clients = sellers.map(() => new FakeWhatsAppClient());
        const bots = sellers.map((_, i) => new BotHandler({ client: clients[i], store: JsonStore.memory(), settings, portalStore: stores[i] }));
        let n = 0;
        const msg = (from: string, body: string): InboundMessage => ({ id: `wamid.jrace.${round}.${from}.${++n}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: body, forwarded: false });
        const short = name.replace(/ S\.A\.C\.$/, "");
        for (const [i, b] of bots.entries()) {
          await b.handle(msg(sellers[i], `Visité ${short}, hablé con Carlos Quispe ${i ? "Dos" : "Uno"}, jefe de flota`));
          await b.handle(msg(sellers[i], "sí"));
          const asked = clients[i].texts().at(-1) ?? "";
          if (!asked.includes("no tiene dueño. ¿Qué guardo?")) problems.push(`ronda ${round}, vendedor ${i}: no ofreció los botones («${asked.slice(0, 80)}»)`);
        }
        await Promise.all(bots.map((b, i) => b.handle(msg(sellers[i], "asignármela"))));
        const replies = clients.map((c) => c.texts().at(-1) ?? "");
        const won = replies.filter((t) => t.includes("• Empresa asignada a ti")).length;
        const lost = replies.filter((t) => t.includes("acaba de quedar asignada a")).length;
        const company = (await pg.getCompany(ids[ruc]))!;
        const open = await pg.listOpportunities({ companyId: ids[ruc], open: true });
        const contacts = await pg.listContacts(ids[ruc]);
        const visits = (await pg.listActivities({ companyId: ids[ruc] })).filter((a) => a.tipo === "visita");
        if (won !== 1 || lost !== 1 || open.length !== 1 || open[0].ownerUserId !== company.ownerUserId || contacts.length !== 1 || visits.length !== 2) {
          problems.push(`ronda ${round}: ${won} ganó, ${lost} avisado, ${open.length} oportunidades abiertas, ${contacts.length} contactos, ${visits.length} visitas · ${replies.map((r) => r.split("\n").slice(0, 2).join(" / ")).join(" | ")}`);
        }
      }
      expect(problems).toEqual([]);
    } finally {
      configureReportBot(null);
      await extra.close();
    }
  });
});
