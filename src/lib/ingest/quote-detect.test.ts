import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCustomerProfiles, SettingsSchema } from "../settings";
import { buildQuote, manualItem } from "../quote/build";
import { renderQuotePdf } from "../quote/pdf";
import { renderProsegurXlsx } from "../quote/prosegur-xlsx";
import { parseRequestRegex } from "../quote/request";
import { detectQuoteDocument, detectQuoteInSheets, detectQuoteInText } from "./quote-detect";

const samples = path.resolve(process.cwd(), "samples");
const read = (f: string) => fs.readFileSync(path.join(samples, f));
const clientdata = path.resolve(process.cwd(), "clientdata");
const hasClientData = fs.existsSync(clientdata) && fs.readdirSync(clientdata).length >= 4;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const settings = SettingsSchema.parse({ company: { name: "Professional Tyres", tradeName: "360° Tyres", taxId: "RUC: 20565716396" }, pricing: {}, quote: {} });
const quote = () => {
  const req = parseRequestRegex("215/75R17.5 18PR FENIXWAY VALOR 99 x2 UB 1830\npara PROSEGUR SA\nunidad: Ayacucho\nsolicitante: Johann Castañeda");
  return buildQuote({ number: "OCTUBRE 2026 - 451", request: req, items: req.lines.map((l) => manualItem(l, 123.17, undefined, settings)), settings, today: "2026-10-15", customerProfile: "prosegur" });
};

beforeAll(() => {
  process.env.LLM_DISABLED = "1";
});

describe("quote documents are told apart from price lists", () => {
  it("the client's Prosegur format and the salesman's own quote (samples)", async () => {
    expect(await detectQuoteDocument(read("prosegur-451.xlsx"), { fileName: "prosegur-451.xlsx", mimeType: XLSX })).toBe("prosegur");
    expect(await detectQuoteDocument(read("seller-451-reference.xlsx"), { fileName: "COTIZ 451.xlsx" })).toBe("own-quote");
  });

  it("the files the bot itself sends: the 360° PDF and the filled Prosegur Excel", async () => {
    const pdf = await renderQuotePdf(quote(), settings, { photos: false });
    expect(await detectQuoteDocument(pdf, { fileName: "OCTUBRE 2026 - 451.pdf", mimeType: "application/pdf" })).toBe("own-quote");
    const profile = loadCustomerProfiles().find((p) => p.format === "prosegur")!;
    const { buffer, fileName } = await renderProsegurXlsx(quote(), settings, profile);
    expect(await detectQuoteDocument(buffer, { fileName, mimeType: XLSX })).toBe("prosegur");
  });

  it("price lists are not quotes", async () => {
    expect(await detectQuoteDocument(read("proveedor-a-lista.xlsx"), { fileName: "proveedor-a-lista.xlsx" })).toBeNull(); // MARCA + MEDIDA, no ITEM
    expect(await detectQuoteDocument(read("proveedor-b-lista.pdf"), { fileName: "lista.pdf", mimeType: "application/pdf" })).toBeNull();
    expect(await detectQuoteDocument(read("proveedor-c-lista.csv"), { fileName: "lista.csv", mimeType: "text/csv" })).toBeNull(); // only xlsx / pdf are checked
    expect(await detectQuoteDocument(Buffer.from("not a zip"), { fileName: "roto.xlsx" })).toBeNull(); // unreadable: left to the ingestion
  });

  it.runIf(hasClientData)("the client's real lists (own list, Odoo stock, JCH, Steel) are not quotes", async () => {
    for (const f of fs.readdirSync(clientdata)) {
      expect([f, await detectQuoteDocument(fs.readFileSync(path.join(clientdata, f)), { fileName: f })]).toEqual([f, null]);
    }
  });

  it("a document titled COTIZACIÓN with a client box; a provider's quotation addressed to us is allowed", () => {
    const sheet = (rows: string[][]) => [{ name: "Hoja1", rows }];
    expect(detectQuoteInSheets(sheet([["COTIZACIÓN N° 0087"], ["Cliente:", "Minera Andes S.A.C."], ["Descripción", "Cant.", "Precio"]]))).toBe("quote");
    expect(detectQuoteInSheets(sheet([["COTIZACIÓN N° 0087"], ["Cliente:", "PROFESSIONAL TYRES S.A.C."], ["ITEM", "MEDIDA", "MARCA", "PRECIO"]]))).toBeNull();
    expect(detectQuoteInSheets(sheet([["LISTA DE PRECIOS OCTUBRE"], ["ITEM", "CODIGO", "DESCRIPCION", "PRECIO"]]))).toBeNull();
    expect(detectQuoteInSheets(sheet([["Item", "Medida", "Marca", "Modelo", "Cantidad"]]))).toBe("own-quote");
    expect(detectQuoteInText("COTIZACIÓN 123\nCliente: Transportes ABC\nAtención: Sr. Pérez\n11R22.5 x4 $ 400")).toBe("quote");
    expect(detectQuoteInText("COTIZACIÓN 123\nSeñores: PROFESSIONAL TYRES SAC\nAtención: Frank\n11R22.5 Michelin $ 400")).toBeNull();
    expect(detectQuoteInText("Nombre de Archivo: 151026-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-451\nCOTIZACIÓN PROVEEDORES")).toBe("prosegur");
    expect(detectQuoteInText("LISTA DE PRECIOS\nMARCA MEDIDA PRECIO\nMICHELIN 11R22.5 400")).toBeNull();
  });
});
