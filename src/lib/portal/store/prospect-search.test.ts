/**
 * Corrida F, puntos 1 y 2: búsqueda tolerante de Prospectos ("zbuss" / "z buss" / "Z-Buss", tildes, RUC) y medidas
 * probables con su cantidad de unidades en cada fila de la lista (sin entrar a la ficha). Mismo contrato en Postgres
 * (pg-portal-store.ts, columna companies.razon_norm) y JSON.
 */
import { describe, expect, it } from "vitest";
import { JsonPortalStore } from "./json-portal-store";
import { companyNameKey, searchTerms, ttlCache } from "./shared";
import type { FleetVehicleInput } from "./types";
import { PortalTimeoutError } from "../ui/deadline";
import { parseProspectFilters } from "../ui/filters";
import { loadProspectos } from "../ui/prospectos";

const NOW = new Date("2026-11-11T15:00:00Z");

function vehicle(companyId: number, placa: string, medidaProbable: string | null, over: Partial<FleetVehicleInput> = {}): FleetVehicleInput {
  return {
    companyId,
    placa,
    marca: "SCANIA",
    clase: "REMOLCADOR",
    anio: 2018,
    ejes: 3,
    llantas: 10,
    llantasFuente: "20241231",
    pesoBruto: 48000,
    chasis: null,
    departamento: "LIMA",
    origen: "carga",
    medidaProbable,
    confianza: "media",
    ...over,
  };
}

async function seeded() {
  const store = JsonPortalStore.memory();
  const { ids } = await store.upsertCompanies([
    { ruc: "20999000001", razonSocial: "Z BUSS TRANSPORTES S.A.C.", sector: "pasajeros", departamento: "LIMA", unidades: 30, llantasPiso: 180 },
    { ruc: "20999000002", razonSocial: "ZBUSS EXPRESS E.I.R.L.", sector: "pasajeros", departamento: "LIMA", unidades: 20, llantasPiso: 120 },
    { ruc: "20999000003", razonSocial: "Z-BUSS DEL NORTE S.A.", sector: "pasajeros", departamento: "PIURA", unidades: 15, llantasPiso: 90 },
    { ruc: "20888000004", razonSocial: "Transportes Ñandú & Cía S.R.L.", sector: "carga", departamento: "CUSCO", unidades: 12, llantasPiso: 100 },
    { ruc: "20888000005", razonSocial: "BUSES DEL SUR S.A.", sector: "pasajeros", departamento: "AREQUIPA", unidades: 11, llantasPiso: 66 },
    // caso real: con "z" y "buss" sueltas, "bus service automotriz" contiene las dos y salía al buscar "z buss"
    { ruc: "20888000006", razonSocial: "BUS SERVICE AUTOMOTRIZ S.A.C", sector: "mixto", departamento: "LIMA", unidades: 10, llantasPiso: 50 },
  ]);
  return { store, ids };
}

const rucs = (r: { rows: { ruc: string }[] }) => r.rows.map((x) => x.ruc).sort();

describe("búsqueda tolerante de Prospectos", () => {
  it("normaliza nombres: minúsculas, sin tildes, sin espacios ni signos", () => {
    expect(companyNameKey("Z-BUSS del Norte S.A.")).toBe("zbussdelnortesa");
    expect(companyNameKey("Transportes Ñandú & Cía")).toBe("transportesnanducia");
    // una letra suelta va pegada a la palabra siguiente (o a la anterior si es la última): "z buss" = "zbuss"
    expect(searchTerms("  Z  buss ")).toEqual({ compact: "zbuss", words: ["zbuss"] });
    expect(searchTerms("buss z")).toEqual({ compact: "bussz", words: ["bussz"] });
    expect(searchTerms("transportes z buss")).toEqual({ compact: "transporteszbuss", words: ["transportes", "zbuss"] });
    expect(searchTerms("s.a.c.")).toEqual({ compact: "sac", words: ["sac"] });
    expect(searchTerms("  ")).toEqual({ compact: "", words: [] });
  });

  it("'zbuss', 'z buss', 'ZBUSS' y 'Z-Buss' encuentran las tres variantes del nombre y nada más", async () => {
    const { store } = await seeded();
    const all3 = ["20999000001", "20999000002", "20999000003"];
    for (const q of ["zbuss", "z buss", "ZBUSS", "Z-Buss", "Zbuss"]) expect(rucs(await store.searchCompanies({ q, now: NOW })), q).toEqual(all3);
  });

  it("tildes, ñ y signos no importan; varias palabras deben estar todas", async () => {
    const { store } = await seeded();
    expect(rucs(await store.searchCompanies({ q: "nandu", now: NOW }))).toEqual(["20888000004"]);
    expect(rucs(await store.searchCompanies({ q: "ÑANDÚ cia", now: NOW }))).toEqual(["20888000004"]);
    expect(rucs(await store.searchCompanies({ q: "buss norte", now: NOW }))).toEqual(["20999000003"]);
    expect(rucs(await store.searchCompanies({ q: "buses", now: NOW }))).toEqual(["20888000005"]);
  });

  it("por RUC: inicio del número, con o sin espacios", async () => {
    const { store } = await seeded();
    expect(rucs(await store.searchCompanies({ q: "20888", now: NOW }))).toEqual(["20888000004", "20888000005", "20888000006"]);
    expect(rucs(await store.searchCompanies({ q: "20999 000002", now: NOW }))).toEqual(["20999000002"]);
  });
});

describe("medidas probables en la lista de Prospectos", () => {
  it("cada fila trae hasta 3 medidas probables con su cantidad de unidades, de más a menos", async () => {
    const { store, ids } = await seeded();
    const a = ids["20999000001"];
    const v: FleetVehicleInput[] = [];
    for (let i = 0; i < 5; i++) v.push(vehicle(a, `AAA-10${i}`, "295/80R22.5"));
    for (let i = 0; i < 3; i++) v.push(vehicle(a, `AAA-20${i}`, "11R22.5"));
    for (let i = 0; i < 2; i++) v.push(vehicle(a, `AAA-30${i}`, "215/75R17.5"));
    v.push(vehicle(a, "AAA-400", "225/70R19.5"));
    v.push(vehicle(a, "AAA-500", null));
    await store.upsertFleet(v);
    const res = await store.searchCompanies({ q: "z buss transportes", now: NOW, withMedidas: true });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].medidas).toEqual([
      { medida: "295/80R22.5", unidades: 5 },
      { medida: "11R22.5", unidades: 3 },
      { medida: "215/75R17.5", unidades: 2 },
    ]);
    const other = await store.searchCompanies({ q: "20888000005", now: NOW, withMedidas: true });
    expect(other.rows[0].medidas).toEqual([]);
    // sin pedirlas (bot, reportes) no se calculan
    expect((await store.searchCompanies({ q: "z buss transportes", now: NOW })).rows[0].medidas).toBeUndefined();
  });
});

describe("loadProspectos", () => {
  it("trae las filas con medidas y falla con un error claro si la base no contesta a tiempo", async () => {
    const { store, ids } = await seeded();
    await store.upsertFleet([vehicle(ids["20999000002"], "BBB-100", "11R22.5")]);
    const data = await loadProspectos(store, parseProspectFilters({ q: "zbuss" }), { now: NOW });
    expect(data.result.total).toBe(3);
    expect(data.result.rows.find((r) => r.ruc === "20999000002")?.medidas).toEqual([{ medida: "11R22.5", unidades: 1 }]);
    const hung = Object.assign(Object.create(store), { listMarcas: () => new Promise(() => undefined) }) as typeof store;
    await expect(loadProspectos(hung, parseProspectFilters({}), { now: NOW, deadlineMs: 30 })).rejects.toBeInstanceOf(PortalTimeoutError);
  });
});

describe("ttlCache (marcas y departamentos en Postgres: cambian solo con el import del MTC)", () => {
  it("reutiliza el valor dentro del plazo, recalcula al vencer y no guarda un fallo", async () => {
    let t = 0;
    let calls = 0;
    const cached = ttlCache(async () => ++calls, 1000, () => t);
    expect(await cached()).toBe(1);
    t = 999;
    expect(await cached()).toBe(1);
    t = 1001;
    expect(await cached()).toBe(2);
    let fail = true;
    const flaky = ttlCache(async () => {
      if (fail) throw new Error("base caída");
      return "ok";
    }, 1000, () => t);
    await expect(flaky()).rejects.toThrow("base caída");
    fail = false;
    expect(await flaky()).toBe("ok");
  });
});
