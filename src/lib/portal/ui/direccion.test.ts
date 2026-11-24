import { describe, expect, it } from "vitest";
import { SunatSchema } from "../sunat/config";
import type { SunatBrief, SunatLocal } from "../store/types";
import { direccionAutor, direccionUi, localesUi, LOCALES_SHOWN } from "./direccion";

const cfg = SunatSchema.parse({});
const empresa = { razonSocial: "TRANSPORTES DEMO S.A.C.", ruc: "20100000001", departamento: "AREQUIPA", distrito: "CAYMA", provincia: "AREQUIPA" };
const sunat = (over: Partial<SunatBrief> = {}): SunatBrief => ({
  encontrado: true,
  estado: "ACTIVO",
  condicion: "HABIDO",
  ubigeo: "150140",
  departamento: "LIMA",
  provincia: "LIMA",
  distrito: "SANTIAGO DE SURCO",
  direccion: "Jr. Monterrosa 271, Dpto. 902, Santiago de Surco, Lima",
  anexos: 0,
  fecha: "2026-11-23",
  ...over,
});
const local = (id: number, ubigeo: string, departamento: string, direccion: string | null): SunatLocal => ({
  id,
  ruc: empresa.ruc,
  ubigeo,
  departamento,
  provincia: null,
  distrito: null,
  direccion,
  piezas: { tipoVia: null, nombreVia: null, tipoZona: null, nombreZona: null, numero: null, interior: null, lote: null, dpto: null, manzana: null, kilometro: null },
  fecha: "2026-11-23",
});

describe("dirección en pantalla (corrida L)", () => {
  it("sin dirección de operación: el domicilio fiscal con «Según SUNAT al …» y Cómo llegar a esa dirección", () => {
    const d = direccionUi(empresa, sunat({ anexos: 3 }), cfg);
    expect(d).toMatchObject({ texto: "Jr. Monterrosa 271, Dpto. 902, Santiago de Surco, Lima", fuente: "fiscal", nota: "Según SUNAT al 23/11/2026", hayFiscal: true, fiscal: null, aviso: null, sinDireccion: null, anexos: 3 });
    expect(decodeURIComponent(d.mapa.url)).toContain("Jr. Monterrosa 271, Dpto. 902, Santiago de Surco, Lima, Perú");
    expect(d.mapa.aproximada).toBe(false);
  });

  it("la de operación manda en todas las vistas, dice quién la escribió y deja la fiscal aparte", () => {
    const d = direccionUi({ ...empresa, direccion: "Av. Ejército 1200, Cayma" }, sunat(), cfg, { autor: "Frank" });
    expect(d).toMatchObject({ texto: "Av. Ejército 1200, Cayma", fuente: "operacion", nota: "Dirección de operación (la escribió Frank)", hayFiscal: true });
    expect(d.fiscal).toMatchObject({ texto: "Jr. Monterrosa 271, Dpto. 902, Santiago de Surco, Lima", segun: "Según SUNAT al 23/11/2026" });
    expect(decodeURIComponent(d.mapa.url)).toContain("Av. Ejército 1200, Cayma");
    expect(direccionUi({ ...empresa, direccion: "Av. Ejército 1200" }, null, cfg).nota).toBe("Dirección de operación");
  });

  it("estado o condición: rojo para BAJA / NO HABIDO, ámbar para NO HALLADO", () => {
    expect(direccionUi(empresa, sunat({ estado: "BAJA DE OFICIO", condicion: "NO HABIDO" }), cfg).aviso).toEqual({ nivel: "alerta", texto: "BAJA DE OFICIO · NO HABIDO" });
    expect(direccionUi(empresa, sunat({ estado: "SUSPENSION TEMPORAL" }), cfg).aviso).toEqual({ nivel: "alerta", texto: "SUSPENSIÓN TEMPORAL" });
    expect(direccionUi(empresa, sunat({ condicion: "NO HALLADO SE MUDO D" }), cfg).aviso).toEqual({ nivel: "aviso", texto: "NO HALLADO (SE MUDÓ DE DOMICILIO)" });
  });

  it("sin dirección dice por qué (persona natural, no está en el padrón, no se importó) y Cómo llegar es aproximado", () => {
    const pn = direccionUi({ ...empresa, ruc: "10412345678" }, sunat({ direccion: null }), cfg);
    expect(pn).toMatchObject({ texto: null, sinDireccion: "Sin dirección: persona natural (SUNAT no publica su domicilio).", hayFiscal: false });
    expect(pn.mapa.aproximada).toBe(true);
    expect(direccionUi(empresa, sunat({ encontrado: false, direccion: null }), cfg).sinDireccion).toBe("Sin dirección: no aparece en el padrón de SUNAT al 23/11/2026.");
    expect(direccionUi(empresa, null, cfg).sinDireccion).toBe("Sin dirección: aún no se cargó SUNAT para este RUC.");
    expect(direccionUi(empresa, sunat({ direccion: null }), cfg).sinDireccion).toBe("Sin dirección: SUNAT no tiene su domicilio fiscal.");
  });

  it("quién escribió la dirección de operación: la nota más reciente de «Agregar dirección»", () => {
    const users = [
      { id: 1, nombre: "Frank Rodríguez" },
      { id: 2, nombre: "Ana Pérez" },
    ];
    const acts = [
      { userId: 1, texto: "Dirección: Av. Uno", data: { evento: "direccion" }, occurredAt: new Date("2026-11-01") },
      { userId: 2, texto: "Dirección: Av. Dos", data: { evento: "direccion" }, occurredAt: new Date("2026-11-20") },
      { userId: 1, texto: "Llamada", data: null, occurredAt: new Date("2026-11-22") },
    ];
    expect(direccionAutor(acts, users)).toBe("Ana");
    expect(direccionAutor([], users)).toBeNull();
  });

  it("locales anexos: los del departamento de la flota primero y destacados; los primeros N y «ver todos»", () => {
    const many = [
      local(1, "150140", "LIMA", "Av. Lima 1, Santiago de Surco, Lima"),
      ...Array.from({ length: 20 }, (_, i) => local(10 + i, "150101", "LIMA", `Jr. Lima ${i}, Lima`)),
      local(2, "040103", "AREQUIPA", "Av. Arequipa 2, Cayma, Arequipa"),
      local(3, "040101", "AREQUIPA", null),
    ];
    const l = localesUi(many, "AREQUIPA");
    expect(l.total).toBe(23);
    expect(l.destacados).toBe(2);
    expect(l.departamento).toBe("Arequipa");
    expect(l.items).toHaveLength(LOCALES_SHOWN);
    expect(l.ocultos).toBe(23 - LOCALES_SHOWN);
    expect(l.items.slice(0, 2).map((x) => [x.id, x.destacado])).toEqual([
      [2, true],
      [3, true],
    ]);
    // sin calle: el lugar, y Cómo llegar a ese lugar
    expect(l.items[1].texto).toBe("Arequipa, Arequipa (sin calle)");
    expect(decodeURIComponent(l.items[1].url)).toContain("Arequipa, Arequipa, Perú");
    expect(l.items[2].destacado).toBe(false);
    const all = localesUi(many, "AREQUIPA", { todos: true });
    expect(all.items).toHaveLength(23);
    expect(all.ocultos).toBe(0);
    // Lima y Callao cuentan como uno; sin departamento, nada destacado
    expect(localesUi([local(4, "070101", "CALLAO", "Av. Gambetta 1, Callao")], "LIMA").destacados).toBe(1);
    // sunat-ui (navegador): una flota de Lima con locales en Callao y Lima decía «en Callao» en todos; ahora «Lima y Callao»
    const ransa = localesUi([local(5, "070101", "CALLAO", "Av. Argentina 2833, Callao"), local(6, "150101", "LIMA", "Jr. Wiese 502, Lima")], "LIMA");
    expect(ransa.departamento).toBe("Lima y Callao");
    expect(localesUi(many, null).destacados).toBe(0);
  });
});
