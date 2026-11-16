/**
 * Corrida H, 3b: lista de proveedores (Excel de contactos inventado: los teléfonos y el Excel real nunca van al repo),
 * emparejamiento con los proveedores del cotizador, sugerencias por marca e importación repetible.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { JsonStore } from "../../store/json-store";
import { importSuppliers } from "./suppliers-import";
import { cleanPhone, findSupplier, parseSuppliersXlsx, providerForSupplier, splitBrands, suggestSuppliers, supplierForProvider } from "./suppliers";

async function contactsXlsx(rows: (string | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Proveedores");
  ws.addRow([]);
  ws.addRow([null, "EMPRESA", "CONTACTO", "TELEFONO", "CORREO", "MARCAS"]);
  for (const r of rows) ws.addRow([null, ...r]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const ROWS: (string | null)[][] = [
  ["JCH LLANTAS", "ANA DEMO", "900000010", null, "WEST LAKE - CONTINENTAL - CHINAS"],
  ["STEELS Y ASOCIADOS", "LUIS DEMO", "900 000 011", null, "CHINAS - AROS - CONTI-GENERAL"],
  ["VAN LLANTAS", "ROSA DEMO", " 900000012", null, "MICHELLIN - BFGOODRICH - COOPER"],
  ["EMOTION DEMO", "JUAN DEMO", "900000013", null, "CONTINENTAL, PIRELLI, VENDE DE TODO"],
];

describe("lista de proveedores", () => {
  it("lee el Excel por sus encabezados (en cualquier fila y columna)", async () => {
    const { suppliers, warnings } = await parseSuppliersXlsx(await contactsXlsx(ROWS));
    expect(warnings).toEqual([]);
    expect(suppliers.map((x) => [x.key, x.name, x.contact, x.phone])).toEqual([
      ["jchllantas", "JCH LLANTAS", "ANA DEMO", "900 000 010"],
      ["steelsyasociados", "STEELS Y ASOCIADOS", "LUIS DEMO", "900 000 011"],
      ["vanllantas", "VAN LLANTAS", "ROSA DEMO", "900 000 012"],
      ["emotiondemo", "EMOTION DEMO", "JUAN DEMO", "900 000 013"],
    ]);
    expect(suppliers[0].brands).toEqual(["WEST LAKE", "CONTINENTAL", "CHINAS"]);
    expect(splitBrands("CAMARAS, PROTECTORES, INSUMOS")).toEqual(["CAMARAS", "PROTECTORES", "INSUMOS"]);
    expect(cleanPhone(" 987654321")).toBe("987 654 321");
  });

  it("empareja con los proveedores del cotizador (JCH, Steel) por nombre o por config", () => {
    const providers = [{ name: "JCH", aliases: ["J.CH. Comercial"] }, { name: "Steel" }, { name: "Protyres" }];
    expect(providerForSupplier("JCH LLANTAS", providers)).toBe("JCH");
    expect(providerForSupplier("STEELS Y ASOCIADOS", providers)).toBe("Steel");
    expect(providerForSupplier("VAN LLANTAS", providers)).toBeUndefined();
    expect(providerForSupplier("VAN LLANTAS", providers, { "Van Llantas": "Steel" })).toBe("Steel");
  });

  it("sugiere a quién pedir una marca que no está en ninguna lista", async () => {
    const { suppliers } = await parseSuppliersXlsx(await contactsXlsx(ROWS));
    expect(suggestSuppliers("Michelin", suppliers).map((x) => x.name)).toEqual(["VAN LLANTAS"]);
    expect(suggestSuppliers("Westlake", suppliers).map((x) => x.name)).toEqual(["JCH LLANTAS"]);
    // marca china sin proveedor que la nombre: los de "CHINAS"; los que venden de todo, solo si nadie más
    expect(suggestSuppliers("Aonaite", suppliers, { origin: "CHINA" }).map((x) => x.name)).toEqual(["JCH LLANTAS", "STEELS Y ASOCIADOS"]);
    expect(suggestSuppliers("Hankook", suppliers).map((x) => x.name)).toEqual(["EMOTION DEMO"]);
    expect(suggestSuppliers("Continental", suppliers).map((x) => x.name)).toEqual(["JCH LLANTAS", "EMOTION DEMO"]);
    expect(findSupplier("van", suppliers)?.name).toBe("VAN LLANTAS");
    expect(findSupplier("steel", suppliers)?.name).toBe("STEELS Y ASOCIADOS");
  });

  it("importación repetible: actualiza los datos y conserva las condiciones recordadas", async () => {
    const store = JsonStore.memory();
    const r1 = await importSuppliers(store, await contactsXlsx(ROWS));
    expect([r1.inserted, r1.updated]).toEqual([4, 0]);
    const list = await store.listSuppliers();
    expect(list.find((x) => x.name === "JCH LLANTAS")?.provider).toBe("JCH"); // config/providers.json + orders.supplierProviders
    expect(list.find((x) => x.name === "STEELS Y ASOCIADOS")?.provider).toBe("Steel");
    expect(supplierForProvider("JCH", list)?.name).toBe("JCH LLANTAS");
    await store.setSupplierTerms("jchllantas", { payment: "LETRAS 60", delivery: "ALMACEN LURIN" });
    const changed = ROWS.map((r) => (r[0] === "JCH LLANTAS" ? [r[0], "OTRA DEMO", "900000099", null, r[4]] : r));
    const r2 = await importSuppliers(store, await contactsXlsx(changed));
    expect([r2.inserted, r2.updated]).toEqual([0, 4]);
    expect((await store.listSuppliers()).find((x) => x.key === "jchllantas")).toMatchObject({ contact: "OTRA DEMO", phone: "900 000 099", lastPayment: "LETRAS 60", lastDelivery: "ALMACEN LURIN" });
  });
});
