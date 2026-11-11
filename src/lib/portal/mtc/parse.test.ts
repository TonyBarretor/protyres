import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeClase, parseDate, parseHeader, parseLine, parseMtcBuffer, pesoToKg, readMtcFile, splitLine } from "./parse";

const FIX = path.join(__dirname, "__fixtures__");
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name));

describe("fixtures are real-like", () => {
  it("are Latin-1 with CRLF", () => {
    const buf = fixture("carga25.csv");
    expect(buf.includes(Buffer.from("\r\n"))).toBe(true);
    expect(buf.includes(Buffer.from([0xd1]))).toBe(true); // "Ñ" in Latin-1
  });
});

describe("parseHeader", () => {
  it("recognises the three layouts", () => {
    expect(parseHeader(fixture("carga25.csv").toString("latin1").split("\n")[0]).format).toBe("carga");
    expect(parseHeader(fixture("carga2224.csv").toString("latin1").split("\n")[0]).format).toBe("carga");
    const p = parseHeader(fixture("pasajeros.csv").toString("latin1").split("\n")[0]);
    expect(p.format).toBe("pasajeros");
    expect(p.cols.has("ANIO_FABR")).toBe(true); // "ANIO_ FABR"
    expect(p.cols.has("N_EJES")).toBe(true); // "N_ EJES"
    expect(p.width).toBe(29);
  });
  it("rejects unknown headers", () => {
    expect(() => parseHeader("A;B;C")).toThrow(/no reconocida/);
  });
});

describe("helpers", () => {
  it("splitLine honours quotes and &AMP;", () => {
    expect(splitLine('1;"""R &AMP; V S.A.C.""";x\r')).toEqual(["1", '"R & V S.A.C."', "x"]);
    expect(splitLine("a;;b;")).toEqual(["a", "", "b", ""]);
  });
  it("normalizeClase", () => {
    expect(normalizeClase("ÓMNIBUS")).toBe("OMNIBUS");
    expect(normalizeClase("SEMIREMOLQUE")).toBe("SEMIRREMOLQUE");
    expect(normalizeClase("Semirremolque")).toBe("SEMIRREMOLQUE");
    expect(normalizeClase("STAT. WAGON")).toBe("STATION WAGON");
    expect(normalizeClase("CMTA  PANEl")).toBe("CMTA PANEL");
    expect(normalizeClase("ND")).toBeNull();
  });
  it("pesoToKg: kg stays, tonnes ×1000, decimal comma", () => {
    expect(pesoToKg("30000")).toBe(30000);
    expect(pesoToKg("9.4")).toBe(9400);
    expect(pesoToKg("9,4")).toBe(9400);
    expect(pesoToKg("ND")).toBeNull();
    expect(pesoToKg("0")).toBeNull();
  });
  it("garbage llantas (Excel date serial) → null", () => {
    const header = parseHeader(fixture("carga2224.csv").toString("latin1").split("\n")[0]);
    const r = parseLine("1;20111111111;X;20190130;99999999;MATPEL;T1E817;2007;CH;ND;TOYOTA;PUBLICO;CMTA PICKUP;DIESEL;ND;43544;2;0.938;1.852;2.79;5.25;1.76;1.81;LIMA;20231231", header);
    expect(r.ok && r.vehicle).toMatchObject({ llantas: null, ejes: 2, pesoBruto: 2790 });
  });
  it("parseDate", () => {
    expect(parseDate("30/01/2009")).toBe("20090130");
    expect(parseDate("20280614")).toBe("20280614");
    expect(parseDate("DS. 009-2004-MTC")).toBeNull();
  });
});

describe("carga 2025 (ND llantas, dd/mm/aaaa, decimal comma)", () => {
  const { vehicles, stats } = parseMtcBuffer(fixture("carga25.csv"));
  it("counts read/valid/discarded", () => {
    expect(stats.leidas).toBe(11);
    expect(stats.validas).toBe(9);
    expect(stats.descartadas).toEqual({ columnas: 1, fecha_corte: 1, ruc: 0, placa: 0 });
    expect(stats.porCorte).toEqual({ "20251231": 9 });
  });
  it("normalises a row", () => {
    const v = vehicles.find((x) => x.placa === "AAA111")!;
    expect(v).toMatchObject({ origen: "carga", ruc: "20111111111", razonSocial: "TRANSPORTES ANDINOS DEMO S.A.C.", marca: "VOLVO", clase: "CAMION", anio: 2015, ejes: 3, llantas: null, pesoBruto: 30000, chasis: "CHS0001", departamento: "LIMA", provincia: null, vigenciaHasta: "20290130", fechaCorte: "20251231" });
    expect(vehicles.find((x) => x.placa === "AAA112")).toMatchObject({ clase: "SEMIRREMOLQUE", vigenciaHasta: null });
  });
  it("keeps Latin-1 accents and strips them from departamento", () => {
    const v = vehicles.find((x) => x.placa === "BBB221")!;
    expect(v.razonSocial).toBe("COMPAÑÍA DE CARGA ÑANDÚ DEMO S.A.");
    expect(v.departamento).toBe("JUNIN");
  });
  it("recovers quoted &AMP; names and tonnes in carga", () => {
    const v = vehicles.find((x) => x.placa === "CCC331")!;
    expect(v.razonSocial).toBe("CORPORACIÓN R & V DEMO S.A.C.");
    expect(v.pesoBruto).toBe(30000);
    expect(vehicles.find((x) => x.placa === "CCC332")!.razonSocial).toBe("CORPORACIÓN R & V DEMO S.A.C.");
  });
});

describe("carga 2022–2024 (decimal point, llantas, mixed encoding)", () => {
  const { vehicles, stats } = parseMtcBuffer(fixture("carga2224.csv"));
  it("counts and keeps llantas", () => {
    expect(stats.leidas).toBe(11);
    expect(stats.validas).toBe(10);
    expect(stats.descartadas.fecha_corte).toBe(1);
    expect(vehicles.find((v) => v.placa === "AAA111" && v.fechaCorte === "20241231")?.llantas).toBe(10);
    expect(vehicles.find((v) => v.placa === "AAA112" && v.fechaCorte === "20241231")?.llantas).toBeNull();
    expect(vehicles.find((v) => v.placa === "BBB222")?.ejes).toBeNull();
  });
  it("repairs a UTF-8 line inside a Latin-1 file", () => {
    expect(vehicles.find((v) => v.placa === "EEE551")?.razonSocial).toBe("OCAÑO DEMO FELIX");
  });
});

describe("pasajeros", () => {
  const { vehicles, stats } = parseMtcBuffer(fixture("pasajeros.csv"), { cuts: ["20251231"] });
  it("counts and filters by cut", () => {
    expect(stats.leidas).toBe(6);
    expect(stats.validas).toBe(5);
    expect(stats.descartadas.columnas).toBe(1);
    expect(vehicles.map((v) => v.placa)).toEqual(["P1A001", "P1A002", "P1A003", "P2B001"]);
  });
  it("normalises tonnes to kg and accents", () => {
    const v = vehicles[0];
    expect(v).toMatchObject({ origen: "pasajeros", clase: "OMNIBUS", anio: 2019, ejes: 3, llantas: 8, pesoBruto: 18000, departamento: "HUANUCO", provincia: "HUANUCO" });
    expect(v.razonSocial).toBe("EMPRESA DE TRANSPORTES SEÑOR DE LOS MILAGROS DEMO S.A.");
    expect(vehicles[1].pesoBruto).toBe(9400);
    expect(vehicles[2].pesoBruto).toBeNull();
    expect(vehicles[3].pesoBruto).toBe(19000);
  });
});

describe("parseLine and streaming", () => {
  it("parseLine discards shifted rows", () => {
    const header = parseHeader(fixture("carga25.csv").toString("latin1").split("\n")[0]);
    expect(parseLine("1;20111111111;X;a;b;c;PL1;2000;CH;ND;M;S;CAMION;D;2;ND;2;1;1;1000;1;1;1;LIMA;TACNA", header)).toEqual({ ok: false, reason: "fecha_corte" });
    expect(parseLine("1;123;X;a;b;c;PL1;2000;CH;ND;M;S;CAMION;D;2;ND;2;1;1;1000;1;1;1;LIMA;20251231", header)).toEqual({ ok: false, reason: "ruc" });
  });
  it("streams a file with the same result as the sync parser", async () => {
    const file = path.join(FIX, "carga2224.csv");
    const streamed = await readMtcFile(file, { cuts: ["20241231"] });
    const sync = parseMtcBuffer(fixture("carga2224.csv"), { cuts: ["20241231"] });
    expect(streamed.vehicles).toEqual(sync.vehicles);
    expect(streamed.stats).toEqual(sync.stats);
  });
});
