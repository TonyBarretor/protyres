/**
 * Corrida L — padrón reducido del RUC de SUNAT: lectura (encabezados reales, `|` final, espacio inicial del de anexos,
 * escapes), zip en streaming, armado de direcciones (filas reales de EMPRESAS tomadas del archivo del 23/11/2026; la
 * persona natural es inventada), ubigeo, importación idempotente que no pisa la dirección de operación.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonPortalStore } from "../store/json-portal-store";
import { setCompanyDireccion } from "../match/company";
import { buildAddress, placeLine, titleCasePlace, type SunatPiezas } from "./address";
import { importSunat, razonDifiere } from "./import";
import { ANEXO_HEADERS, anexoRow, headerIndex, padronRow, readPadron, RUC_HEADERS, splitPadronLine } from "./parse";
import { distritosDe, lookupUbigeo, ubigeoByNames } from "./ubigeo";
import { direccionVisible, sunatAviso, ubicacionEfectiva } from "./ubicacion";
import { listZipEntries, openPadronLines } from "./zip";

const FIX = path.join(__dirname, "__fixtures__");
const MAIN = path.join(FIX, "padron_reducido_ruc.txt");
const ANEXOS = path.join(FIX, "padron_reducido_local_anexo.txt");

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sunat-test-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Un .zip mínimo de una entrada (deflate), con fecha DOS y, si se pide, el campo extra UT (segundos UTC). */
function makeZip(name: string, data: Buffer, opts: { dos?: { y: number; mo: number; d: number; h: number; mi: number; s: number }; utc?: number; stored?: boolean; truncate?: boolean } = {}): Buffer {
  const full = opts.stored ? data : zlib.deflateRawSync(data);
  // truncate: los datos comprimidos se cortan a la mitad, el tamaño descomprimido declarado sigue siendo el original
  const body = opts.truncate ? full.subarray(0, Math.floor(full.length / 2)) : full;
  const dos = opts.dos ?? { y: 2026, mo: 11, d: 23, h: 2, mi: 59, s: 40 };
  const time = (dos.h << 11) | (dos.mi << 5) | (dos.s >> 1);
  const date = ((dos.y - 1980) << 9) | (dos.mo << 5) | dos.d;
  const nameBuf = Buffer.from(name, "latin1");
  const extra = opts.utc === undefined ? Buffer.alloc(0) : Buffer.concat([Buffer.from([0x55, 0x54, 5, 0, 1]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(opts.utc!); return b; })()]);
  const crc = zlib.crc32(data);
  const method = opts.stored ? 0 : 8;
  const loc = Buffer.alloc(30);
  loc.writeUInt32LE(0x04034b50, 0);
  loc.writeUInt16LE(20, 4);
  loc.writeUInt16LE(0, 6);
  loc.writeUInt16LE(method, 8);
  loc.writeUInt16LE(time, 10);
  loc.writeUInt16LE(date, 12);
  loc.writeUInt32LE(crc, 14);
  loc.writeUInt32LE(body.length, 18);
  loc.writeUInt32LE(data.length, 22);
  loc.writeUInt16LE(nameBuf.length, 26);
  loc.writeUInt16LE(extra.length, 28);
  const local = Buffer.concat([loc, nameBuf, extra, body]);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(method, 10);
  cen.writeUInt16LE(time, 12);
  cen.writeUInt16LE(date, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(body.length, 20);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt16LE(extra.length, 30);
  cen.writeUInt32LE(0, 42);
  const central = Buffer.concat([cen, nameBuf, extra]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

async function mainRows(file = MAIN) {
  const { lines } = openPadronLines(file);
  return collect(readPadron(lines, { required: RUC_HEADERS, file, row: padronRow }));
}

describe("lectura del padrón", () => {
  it("encabezado real del principal (con | final) y del de anexos (con espacio inicial y otro orden)", () => {
    const [mainHead, anexoHead] = [MAIN, ANEXOS].map((f) => Buffer.from(fs.readFileSync(f)).toString("latin1").split("\n")[0]);
    expect(mainHead.endsWith("|")).toBe(true);
    expect(anexoHead.startsWith(" RUC|")).toBe(true);
    const m = headerIndex(mainHead, RUC_HEADERS, "principal");
    expect([m.get("RUC"), m.get("UBIGEO"), m.get("CODIGO DE ZONA"), m.get("KILOMETRO")]).toEqual([0, 4, 7, 14]);
    const a = headerIndex(anexoHead, ANEXO_HEADERS, "anexos");
    expect([a.get("RUC"), a.get("UBIGEO"), a.get("NUMERO"), a.get("KILOMETRO"), a.get("MANZANA")]).toEqual([0, 1, 6, 7, 11]);
  });

  it("falla con un mensaje claro si SUNAT cambia las columnas", () => {
    expect(() => headerIndex("RUC|NOMBRE O RAZÓN SOCIAL|ESTADO|UBIGEO|", RUC_HEADERS, "padron.txt")).toThrow(/padron\.txt: el encabezado no es el esperado.*faltan: ESTADO DEL CONTRIBUYENTE, CONDICION DE DOMICILIO, TIPO DE VIA/);
  });

  it("el | final no es una columna; \\| es un | dentro del campo y \\\\ una barra", () => {
    expect(splitPadronLine("20100193117|YARA PERU S.R.L.|ACTIVO|")).toEqual(["20100193117", "YARA PERU S.R.L.", "ACTIVO"]);
    expect(splitPadronLine("20614244730|EBEN EZER \\| INGENIERIA|ACTIVO|")).toEqual(["20614244730", "EBEN EZER | INGENIERIA", "ACTIVO"]);
    expect(splitPadronLine("1|S\\\\N|-|")).toEqual(["1", "S\\N", "-"]);
    expect(splitPadronLine("1|A\\\\|B|")).toEqual(["1", "A\\", "B"]);
  });

  it("Latin-1 y escapes de las filas reales: tildes, razón social con |, DEPARTAMENTO = | suelto", async () => {
    const rows = await mainRows();
    expect(rows).toHaveLength(27);
    const by = new Map(rows.map((r) => [r.ruc, r]));
    expect(by.get("20330033313")!.piezas.nombreVia).toBe("CIRCUNVALACIÓN DEL CLUB G");
    expect(by.get("20614244730")!.razonSocial).toBe("EBEN EZER INGENIERIA Y ARQUITECTURA S.A.C."); // el | escapado se lee (no parte la fila) y se quita del valor
    expect(by.get("20504741606")!.piezas.dpto).toBeNull();
    expect(by.get("20288803910")!.piezas.numero).toBe("S\\N");
    // CÓDIGO DE ZONA trae el tipo y TIPO DE ZONA el nombre (invertidos respecto del encabezado)
    expect(by.get("20100015103")!.piezas).toMatchObject({ tipoZona: "URB.", nombreZona: "SANTA RAQUEL" });
  });

  it("solo los RUC pedidos (se mira el RUC antes de partir la línea)", async () => {
    const { lines } = openPadronLines(MAIN);
    const rows = await collect(readPadron(lines, { required: RUC_HEADERS, file: MAIN, rucs: new Set(["20100193117", "20999999999"]), row: padronRow }));
    expect(rows.map((r) => r.ruc)).toEqual(["20100193117"]);
  });
});

describe("zip en streaming", () => {
  it("lee la entrada deflate sin descomprimir a disco; fecha del campo UT en hora de Lima", async () => {
    const zipFile = path.join(tmp, "padron_reducido_ruc.zip");
    // 07:59:40 UTC del 23/11/2026 = 02:59:40 en Lima (como el archivo real)
    fs.writeFileSync(zipFile, makeZip("padron_reducido_ruc.txt", fs.readFileSync(MAIN), { utc: Date.UTC(2026, 10, 23, 7, 59, 40) / 1000, dos: { y: 2026, mo: 11, d: 23, h: 2, mi: 59, s: 40 } }));
    const [e] = listZipEntries(zipFile);
    expect(e).toMatchObject({ name: "padron_reducido_ruc.txt", method: 8, size: fs.statSync(MAIN).size, modified: "2026-11-23T02:59:40" });
    const opened = openPadronLines(zipFile);
    expect(opened.modified).toBe("2026-11-23T02:59:40");
    const rows = await collect(readPadron(opened.lines, { required: RUC_HEADERS, file: zipFile, row: padronRow }));
    expect(rows.map((r) => r.ruc)).toEqual((await mainRows()).map((r) => r.ruc));
  });

  it("sin campo UT, la fecha DOS; entrada stored también", async () => {
    const zipFile = path.join(tmp, "stored.zip");
    fs.writeFileSync(zipFile, makeZip("padron_reducido_local_anexo.txt", fs.readFileSync(ANEXOS), { stored: true, dos: { y: 2026, mo: 11, d: 23, h: 3, mi: 1, s: 56 } }));
    const opened = openPadronLines(zipFile);
    expect(opened.modified).toBe("2026-11-23T03:01:56");
    const rows = await collect(readPadron(opened.lines, { required: ANEXO_HEADERS, file: zipFile, row: anexoRow }));
    expect(rows).toHaveLength(10);
  });

  it("un zip truncado falla (no da menos filas en silencio)", async () => {
    const zipFile = path.join(tmp, "trunc.zip");
    const big = Buffer.from(Array.from({ length: 4000 }, (_, i) => `2010019${String(i).padStart(4, "0")}|X${i * 7919}|ACTIVO|HABIDO|150140|JR.|A|-|-|${i}|-|-|-|-|-|`).join("\n"), "latin1");
    fs.writeFileSync(zipFile, makeZip("x.txt", Buffer.concat([Buffer.from(`${RUC_HEADERS.join("|")}|\n`, "latin1"), big]), { truncate: true }));
    const opened = openPadronLines(zipFile);
    await expect(collect(readPadron(opened.lines, { required: RUC_HEADERS, file: zipFile, row: padronRow }))).rejects.toThrow();
  });
});

describe("direcciones armadas (filas reales de empresas)", () => {
  const cases: [string, string][] = [
    ["20100193117", "Jr. Monterrosa 271, Dpto. 902, Santiago de Surco, Lima"],
    ["20100001226", "Av. Argentina 3250, Callao"],
    ["20100007691", "Calle Cappa 165, Zona Industrial Pque Int de Ind, Callao"],
    ["20100015103", "Av. Nicolas Ayllon 3820, Urb. Santa Raquel, Ate, Lima"],
    ["20100035554", "Calle Antonio Miro Quesada 260, Int. 3P, Lima"],
    ["20100036950", "Av. La Playa, Mz. 2 Lt. 14, Asoc. Agricola Santa Maria Eliz, Ventanilla, Callao"],
    ["20100039207", "Av. Argentina 2833, Zona Industrial, Callao"],
    ["20100118841", "Av. Canaval y Moreyra 555, Urb. El Palomar, San Isidro, Lima"],
    ["20101363008", "Autopista Ramiro Priale Km 7.5, Urb. La Capitana, Lurigancho, Lima"],
    ["20102579721", "Jr. Jorge Chavez 248, Paita, Piura"],
    ["20117751954", "Monterosa 239, Mz. C Lt. 8, Urb. Chacarilla del Estanque, Santiago de Surco, Lima"],
    ["20132062448", "Carretera Panamericana Norte Km 562, Zona Industrial Pque Industrial, Moche, Trujillo, La Libertad"],
    ["20140779441", "Óvalo Huandoy, Dpto. 102, Mz. E-3 Lt. 14, Urb. Los Naranjos, Los Olivos, Lima"],
    ["20193356151", "Psje. Los Delfines 159, Urb. Las Gardenias, Santiago de Surco, Lima"],
    ["20288803910", "Edif Los Cedros S/N, Int. 612, Residencial San Felipe, Jesús María, Lima"],
    ["20330033313", "Av. Circunvalación del Club G 134, Int. 1801, Dpto. 205, Urb. Club El Golf Los Incas, Santiago de Surco, Lima"],
    ["20332165217", "Sector 2, Mz. 1QA Lt. 15, P.J. San Fco.Tablada de Lurin, Villa María del Triunfo, Lima"],
    ["20389420345", "Prolongación Nicolas de Pierola 142, Ate, Lima"],
    ["20417926632", "Carretera Antigua Panamericana Sur Km 38.2, Lt. 3, Fundo Las Salinas, Lurin, Lima"],
    ["20504741606", "Calle German Schreiber 272, Int. 501, San Isidro, Lima"],
    ["20504757782", "Carretera Panamericana Sur Km 62.3, Mz. 1 Lt. 3-A, C.P. Chilca, Chilca, Cañete, Lima"],
    ["20512096990", "Malecón de la Marina 224, Dpto. 902, Urb. Santa Cruz, Miraflores, Lima"],
    ["20559255000", "Mz. A Lt. 06, A.H. San Pedro de Cosos, Aplao, Castilla, Arequipa"],
    ["20600662458", "Mz. F14 Lt. 10, Urb. Las Delicias de Villa, Chorrillos, Lima"],
    ["20601269440", "Calle Los Arces 505, Dpto. C402, Cayma, Arequipa"],
    ["20614244730", "Calle La Paz 200, Urb. Santa Patricia Et. Uno, La Molina, Lima"],
  ];

  it(`${cases.length} formas distintas: vía + número, Int., Dpto., Mz./Lt., Km, zonas, S/N, sin vía`, async () => {
    const by = new Map((await mainRows()).map((r) => [r.ruc, r]));
    const got = cases.map(([ruc]) => [ruc, buildAddress(by.get(ruc)!.piezas, by.get(ruc)!.ubigeo)]);
    expect(got).toEqual(cases);
  });

  it("persona natural con todo en '-': sin dirección ni ubigeo (es normal)", async () => {
    const r = (await mainRows()).find((x) => x.ruc === "10999999990")!;
    expect(r.ubigeo).toBeNull();
    expect(Object.values(r.piezas).every((v) => v === null)).toBe(true);
    expect(buildAddress(r.piezas, r.ubigeo)).toBeNull();
  });

  it("un 0 de relleno en número, interior, Dpto., Mz., Lt. o Km se omite ('Int. 0'); las piezas se guardan tal cual", () => {
    // en el archivo real hay miles: interior "0" en 186 anexos y 438 domicilios de empresas, número "0" en ~6 mil, Km "0"…
    const p = (x: Partial<SunatPiezas>): SunatPiezas => ({ tipoVia: null, nombreVia: null, tipoZona: null, nombreZona: null, numero: null, interior: null, lote: null, dpto: null, manzana: null, kilometro: null, ...x });
    expect(buildAddress(p({ tipoVia: "AV.", nombreVia: "ARGENTINA", numero: "2833", interior: "0" }), "070101")).toBe("Av. Argentina 2833, Callao");
    expect(buildAddress(p({ tipoVia: "AV.", nombreVia: "PERU", numero: "0", manzana: "0", lote: "00", dpto: "0", kilometro: "0.0" }), "040103")).toBe("Av. Peru, Cayma, Arequipa");
    // un 0 que es parte de un valor real se queda: "10", "B0", "0.5"
    expect(buildAddress(p({ tipoVia: "AV.", nombreVia: "PERU", numero: "10", interior: "B0", kilometro: "0.5" }), "040103")).toContain("Av. Peru 10 Km 0.5, Int. B0");
  });

  it("el tipo no se repite cuando el nombre ya lo trae ('Fundo Fundo', 'Calle Calle 7', 'Zona Industrial Industrial')", () => {
    const p = (x: Partial<SunatPiezas>): SunatPiezas => ({ tipoVia: null, nombreVia: null, tipoZona: null, nombreZona: null, numero: null, interior: null, lote: null, dpto: null, manzana: null, kilometro: null, ...x });
    expect(buildAddress(p({ tipoVia: "AV.", nombreVia: "LAS TORRES", lote: "20", tipoZona: "FND.", nombreZona: "FUNDO HUACHIPA" }), "150118")).toBe("Av. Las Torres, Lt. 20, Fundo Huachipa, Lurigancho, Lima");
    expect(buildAddress(p({ tipoVia: "CAL.", nombreVia: "CALLE 7", manzana: "K", lote: "22" }), "150103")).toBe("Calle 7, Mz. K Lt. 22, Ate, Lima");
    // sunat-ui (navegador): el tipo de varias palabras que el nombre ya trae completo no se repite ("Zona Industrial Zona Industrial")
    expect(buildAddress(p({ tipoVia: "AV.", nombreVia: "OSCAR R. BENAVIDES", numero: "956", tipoZona: "Z.I.", nombreZona: "ZONA INDUSTRIAL" }), "150101")).toBe("Av. Oscar R. Benavides 956, Zona Industrial, Lima");
    expect(buildAddress(p({ tipoVia: "AV.", nombreVia: "ARGENTINA", numero: "2833", tipoZona: "Z.I.", nombreZona: "ZONA INDUSTRIAL CONCHUCOS" }), "150101")).toBe("Av. Argentina 2833, Zona Industrial Conchucos, Lima");
    expect(buildAddress(p({ tipoVia: "CAR.", nombreVia: "HUACHIPA", tipoZona: "Z.I.", nombreZona: "INDUSTRIAL HUACHIPA ESTE" }), "150118")).toBe("Carretera Huachipa, Zona Industrial Huachipa Este, Lurigancho, Lima");
    expect(buildAddress(p({ tipoVia: "AV.", nombreVia: "HUANACAURE", numero: "918", tipoZona: "URB.", nombreZona: "4TA. ZONA TAHUANTINSUYO" }), "150112")).toBe("Av. Huanacaure 918, Urb. 4ta. Zona Tahuantinsuyo, Independencia, Lima");
  });

  it("lugar: Callao sin 'Prov. Const. del Callao'; distrito, provincia y departamento sin repetir", () => {
    expect(placeLine("070101")).toBe("Callao");
    expect(placeLine("070102")).toBe("Bellavista, Callao");
    expect(placeLine("150101")).toBe("Lima");
    expect(placeLine("120114")).toBe("El Tambo, Huancayo, Junín");
    expect(placeLine("999999")).toBeNull();
  });

  it("tipo título: artículos tras 'de' en minúscula, números romanos y piezas con dígitos tal cual", () => {
    expect(titleCasePlace("ZONA INDUSTRIAL II")).toBe("Zona Industrial II");
    expect(titleCasePlace("VILLA EL SALVADOR")).toBe("Villa El Salvador");
    expect(titleCasePlace("MALECON DE LA MARINA")).toBe("Malecon de la Marina");
    expect(titleCasePlace("SEC.INDUSTRIAL 27 OCTUBRE")).toBe("Sec.Industrial 27 Octubre");
  });

  it("locales anexos del orden de columnas propio (Km, Mz. sin vía, S/N y SN)", async () => {
    const { lines } = openPadronLines(ANEXOS);
    const rows = await collect(readPadron(lines, { required: ANEXO_HEADERS, file: ANEXOS, row: anexoRow }));
    const t77 = rows.filter((r) => r.ruc === "20100015103").map((r) => buildAddress(r.piezas, r.ubigeo));
    expect(t77).toEqual([
      "Av. del Ejercito 1153, Ayacucho, Huamanga, Ayacucho",
      "Carretera Jesus Yanamango, Mz. 99, Cajamarca",
      "Mz. F Lt. 1, Parque Industrial, Pimentel, Chiclayo, Lambayeque",
      "Variante Uchumayo Km 1.8, Sachaca, Arequipa",
      "Panamericana Norte, Mz. EFG Lt. 8-9, Urb. Calle A, San Martín de Porres, Lima",
      "Carretera Central Km 4.4, Ate, Lima",
    ]);
    const ransa = rows.filter((r) => r.ruc === "20100039207").map((r) => buildAddress(r.piezas, r.ubigeo));
    expect(ransa[0]).toMatch(/^Sector Churupucyo S\/N, /);
    expect(ransa[1]).toMatch(/^Av\. Los Pescadores S\/N, Sec\.Industrial 27 Octubre, /);
  });
});

describe("ubigeo (INEI, el que usa SUNAT)", () => {
  it("150140 = Lima / Lima / Santiago de Surco; nombres legibles; códigos nuevos y viejos", () => {
    expect(lookupUbigeo("150140")).toEqual({ ubigeo: "150140", departamento: "Lima", provincia: "Lima", distrito: "Santiago de Surco" });
    expect(lookupUbigeo("020101")?.departamento).toBe("Áncash");
    expect(lookupUbigeo("130112")?.distrito).toBe("Alto Trujillo");
    expect(lookupUbigeo("160208")).toBeNull();
    expect(lookupUbigeo("-")).toBeNull();
    expect(ubigeoByNames("LIMA", "LIMA", "SANTIAGO DE SURCO")).toBe("150140");
  });

  it("distritos de un departamento (Lima trae también los del Callao)", () => {
    const lima = distritosDe("LIMA");
    expect(lima.some((d) => d.ubigeo === "150140")).toBe(true);
    expect(lima.some((d) => d.ubigeo === "070101")).toBe(true);
    expect(distritosDe("AREQUIPA").every((d) => d.ubigeo.startsWith("04"))).toBe(true);
  });
});

describe("razón social de SUNAT aparte solo si difiere mucho", () => {
  it("mismo nombre con otra forma societaria, otro orden de palabras (persona natural) o abreviado: no", () => {
    expect(razonDifiere("TRANSPORTES 77 S.A.", "TRANSPORTES 77 SOCIEDAD ANONIMA")).toBe(false);
    expect(razonDifiere("SEGUNDO LEONCIO PRUEBA ZETA", "PRUEBA ZETA SEGUNDO LEONCIO")).toBe(false);
    expect(razonDifiere("EXPRESO TRANSPORTES SANTA CLARA LOPEZ SALAZAR S.C.R.L.", "EXP TRANSP STA CLARA LOPEZ SALAZAR S R L")).toBe(false);
    expect(razonDifiere("SERVICIOS ESPECIALIZADOS Y LOGISTICA EN GENERAL S.A.", "SERV ESP Y LOGISTICA EN GENERAL SA")).toBe(false);
  });
  it("otra empresa (cambió de nombre) o solo la sigla: sí", () => {
    expect(razonDifiere("GRAÑA Y MONTERO PETROLERA S.A.", "UNNA ENERGIA S.A.C.")).toBe(true);
    expect(razonDifiere("EPSEL S.A.", "EMPRESA PRESTADORA DE SERVICIOS DE SANEAMIENTO DE AGUA POTABLE Y ALCANTARILLADO DE LAMBAYEQUE S.A.")).toBe(true);
    expect(razonDifiere("", "ALGO S.A.C.")).toBe(true);
  });
});

describe("importación", () => {
  async function seed() {
    const s = JsonPortalStore.memory();
    await s.upsertCompanies([
      { ruc: "20100193117", razonSocial: "YARA PERU S.R.L.", sector: "carga", departamento: "LIMA", unidades: 40 },
      { ruc: "20100015103", razonSocial: "TRANSPORTES 77 S.A.", sector: "carga", departamento: "LIMA", unidades: 1242, provincia: "LIMA", distrito: "LA VICTORIA" },
      { ruc: "20100036950", razonSocial: "CONSTRUCCIONES METALICAS UNION S A", sector: "carga", departamento: "LIMA", unidades: 12 },
      { ruc: "20601269440", razonSocial: "MAC2 E.I.R.L.", sector: "carga", departamento: "LIMA", unidades: 15 },
      { ruc: "20888888881", razonSocial: "NO ESTA EN SUNAT S.A.C.", sector: "carga", departamento: "PIURA", unidades: 11 },
    ]);
    const vend = await s.upsertUser({ nombre: "Frank", whatsapp: "51900000001", rol: "vendedor" });
    // cliente de ventas que no está en el padrón del MTC (y su cliente final)
    await s.insertSales([{ fecha: "2026-10-01", ruc: "20100039207", razonSocial: "RANSA COMERCIAL S.A.C", cantidad: 4 }]);
    return { s, vend };
  }

  it("solo RUC del portal (padrón, manuales y ventas); estado, condición, ubigeo, piezas, dirección, anexos y fecha", async () => {
    const { s } = await seed();
    const r = await importSunat({ store: s, archivo: MAIN, anexos: ANEXOS, fecha: "2026-11-23" });
    expect(r).toMatchObject({ rucs: 6, encontradas: 5, noEncontradas: 1, conDireccion: 5, conAnexos: 2, anexos: 9, porFuente: { padron: 5, ventas: 1 } });
    expect(r.estados).toEqual({ ACTIVO: 3, "BAJA DE OFICIO": 2 });
    expect(r.condiciones).toEqual({ HABIDO: 4, "NO HABIDO": 1 });
    const yara = await s.getSunat("20100193117");
    expect(yara).toMatchObject({ encontrado: true, estado: "ACTIVO", condicion: "HABIDO", ubigeo: "150140", departamento: "LIMA", provincia: "LIMA", distrito: "SANTIAGO DE SURCO", direccion: "Jr. Monterrosa 271, Dpto. 902, Santiago de Surco, Lima", anexos: 0, fecha: "2026-11-23", razonSocial: null });
    expect(yara?.piezas).toMatchObject({ tipoVia: "JR.", nombreVia: "MONTERROSA", numero: "271", dpto: "902" });
    expect((await s.getSunat("20888888881"))).toMatchObject({ encontrado: false, direccion: null, estado: null });
    expect((await s.getSunat("20100039207"))?.direccion).toBe("Av. Argentina 2833, Zona Industrial, Callao");
    expect((await s.listSunatLocales("20100015103")).map((l) => l.ubigeo)).toEqual(["040117", "050101", "060101", "140112", "150103", "150135"]);
    // nada fuera del portal (la persona natural del archivo no se importa)
    expect(await s.getSunat("10999999990")).toBeNull();
  });

  it("reimportar con un archivo más nuevo actualiza sin duplicar y nunca pisa la dirección de operación", async () => {
    const { s, vend } = await seed();
    await importSunat({ store: s, archivo: MAIN, anexos: ANEXOS, fecha: "2026-11-23" });
    const t77 = (await s.getCompanyByRuc("20100015103"))!;
    await setCompanyDireccion(s, vend, t77.id, "Av. Nicolás Ayllón 4000 (patio), Ate");
    // archivo "más nuevo": Transportes 77 pasa a BAJA DE OFICIO y pierde dos locales
    const newer = path.join(tmp, "nuevo.txt");
    fs.writeFileSync(newer, Buffer.from(fs.readFileSync(MAIN).toString("latin1").replace("20100015103|TRANSPORTES 77 S.A.|ACTIVO|HABIDO|", "20100015103|TRANSPORTES 77 S.A.|BAJA DE OFICIO|NO HABIDO|"), "latin1"));
    const newerAx = path.join(tmp, "nuevo-anexos.txt");
    fs.writeFileSync(newerAx, Buffer.from(fs.readFileSync(ANEXOS).toString("latin1").split("\n").filter((l) => !/^20100015103\|(040117|150103)\|/.test(l)).join("\n"), "latin1"));
    const r2 = await importSunat({ store: s, archivo: newer, anexos: newerAx, fecha: "2026-12-01" });
    expect([r2.inserted, r2.updated, r2.localesBorrados]).toEqual([0, 6, 9]);
    const after = (await s.getCompanyByRuc("20100015103"))!;
    expect(after.direccion).toBe("Av. Nicolás Ayllón 4000 (patio), Ate");
    expect(after.razonSocial).toBe("TRANSPORTES 77 S.A.");
    const sun = (await s.getSunat("20100015103"))!;
    expect([sun.estado, sun.condicion, sun.fecha, sun.anexos]).toEqual(["BAJA DE OFICIO", "NO HABIDO", "2026-12-01", 4]);
    expect(await s.listSunatLocales("20100015103")).toHaveLength(4);
    // la de operación manda en todas las vistas
    expect(direccionVisible(after, sun)).toEqual({ texto: "Av. Nicolás Ayllón 4000 (patio), Ate", fuente: "operacion", segun: null });
    const yara = (await s.getCompanyByRuc("20100193117"))!;
    expect(direccionVisible(yara, await s.getSunat(yara.ruc))).toEqual({ texto: "Jr. Monterrosa 271, Dpto. 902, Santiago de Surco, Lima", fuente: "fiscal", segun: "Según SUNAT al 01/12/2026" });
  });

  it("empresa con muchos locales anexos: todos guardados y reemplazados enteros", async () => {
    const s = JsonPortalStore.memory();
    await s.upsertCompanies([{ ruc: "20999999991", razonSocial: "CADENA INVENTADA S.A.C.", sector: "carga", departamento: "LIMA", unidades: 50 }]);
    const head = fs.readFileSync(ANEXOS).toString("latin1").split("\n")[0];
    const many = path.join(tmp, "muchos.txt");
    const rows = Array.from({ length: 250 }, (_, i) => `20999999991|${i % 2 ? "150140" : "040103"}|AV.|PRINCIPAL|-|-|${100 + i}|-|-|-|-|-|`);
    fs.writeFileSync(many, Buffer.from([head, ...rows].join("\n") + "\n", "latin1"));
    const mainFile = path.join(tmp, "muchos-main.txt");
    fs.writeFileSync(mainFile, Buffer.from(`${fs.readFileSync(MAIN).toString("latin1").split("\n")[0]}\n20999999991|CADENA INVENTADA S.A.C.|ACTIVO|HABIDO|150131|AV.|PRINCIPAL|-|-|1|-|-|-|-|-|\n`, "latin1"));
    const r = await importSunat({ store: s, archivo: mainFile, anexos: many, fecha: "2026-11-23" });
    expect([r.anexos, r.conAnexos]).toEqual([250, 1]);
    await importSunat({ store: s, archivo: mainFile, anexos: many, fecha: "2026-11-23" });
    const locs = await s.listSunatLocales("20999999991");
    expect(locs).toHaveLength(250);
    expect((await s.getSunat("20999999991"))?.anexos).toBe(250);
    expect(locs[0].direccion).toBe("Av. Principal 100, Cayma, Arequipa");
  });
});

describe("ubicación efectiva y aviso", () => {
  const cfg = { estados: ["BAJA", "SUSPENSION TEMPORAL"], condiciones: ["NO HABIDO"], condicionesAviso: ["NO HALLADO"] };
  it("SUNAT manda si su domicilio está en el departamento de la empresa (Lima y Callao uno solo); si no, el MTC", () => {
    const surco = { ubigeo: "150140", departamento: "LIMA", provincia: "LIMA", distrito: "SANTIAGO DE SURCO" };
    expect(ubicacionEfectiva({ departamento: "LIMA", provincia: "LIMA", distrito: "ATE" }, surco)).toMatchObject({ distrito: "SANTIAGO DE SURCO", fuente: "sunat", ubigeo: "150140" });
    expect(ubicacionEfectiva({ departamento: "AREQUIPA", provincia: "AREQUIPA", distrito: "CAYMA" }, surco)).toMatchObject({ distrito: "CAYMA", fuente: "mtc", ubigeo: "040103" });
    expect(ubicacionEfectiva({ departamento: null }, surco)).toMatchObject({ departamento: "LIMA", distrito: "SANTIAGO DE SURCO", fuente: "sunat" });
    const callao = { ubigeo: "070101", departamento: "CALLAO", provincia: "CALLAO", distrito: "CALLAO" };
    expect(ubicacionEfectiva({ departamento: "LIMA" }, callao)).toMatchObject({ distrito: "CALLAO", fuente: "sunat" });
  });
  it("alerta en rojo (BAJA…, SUSPENSIÓN TEMPORAL, NO HABIDO), NO HALLADO en ámbar, ACTIVO y HABIDO nada", () => {
    expect(sunatAviso({ encontrado: true, estado: "BAJA DE OFICIO", condicion: "NO HABIDO" }, cfg)).toEqual({ nivel: "alerta", texto: "BAJA DE OFICIO · NO HABIDO" });
    expect(sunatAviso({ encontrado: true, estado: "SUSPENSION TEMPORAL", condicion: "HABIDO" }, cfg)).toEqual({ nivel: "alerta", texto: "SUSPENSIÓN TEMPORAL" });
    expect(sunatAviso({ encontrado: true, estado: "ACTIVO", condicion: "NO HALLADO" }, cfg)).toEqual({ nivel: "aviso", texto: "NO HALLADO" });
    expect(sunatAviso({ encontrado: true, estado: "ACTIVO", condicion: "HABIDO" }, cfg)).toBeNull();
    expect(sunatAviso({ encontrado: false, estado: null, condicion: null }, cfg)).toBeNull();
  });
});
