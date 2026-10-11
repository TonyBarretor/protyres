/**
 * Quote PDF in the client's own layout (landscape, black/yellow 360° Tyres bands):
 *   header band (logo + "COTIZACIÓN") · yellow band with the quote number · two info boxes ·
 *   items table (ITEM, MEDIDA, MARCA, MODELO, APLICACIÓN, ORIGEN, CANTIDAD, PRECIO UNIT., PRECIO TOTAL) ·
 *   TOTAL row · notes · signature block over the footer band.
 */
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { Settings } from "../settings";
import { displayTotal, displayUnit } from "./build";
import { loadImage } from "./photos";
import { fmtMoney } from "./pricing";
import type { Quote } from "./types";

/** Pre-fetched images for the "Fotos" page, keyed by item index. */
export interface PhotoAssets {
  [itemIndex: number]: { photo?: Buffer; sheet?: Buffer };
}

const yellow = "#F5B400";
const dark = "#2b2b2b";
const grey = "#555555";
const line = "#8a8a8a";
const red = "#c00000";

const PAGE_W = 841.89; // A4 landscape
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;

const st = StyleSheet.create({
  page: { paddingTop: 0, paddingBottom: 110, paddingHorizontal: MARGIN, fontSize: 8.5, fontFamily: "Helvetica", color: "#111" },
  headerImg: { width: CONTENT_W, marginTop: 18 },
  headerFallback: { marginTop: 24, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 30, fontFamily: "Helvetica-Bold", letterSpacing: 2, color: dark },
  numberBand: { backgroundColor: yellow, paddingVertical: 4, marginTop: 6, alignItems: "center" },
  numberText: { fontSize: 11, fontFamily: "Helvetica-Bold", color: "#111" },
  boxes: { flexDirection: "row", marginTop: 10 },
  box: { flex: 1, borderWidth: 1, borderColor: dark, paddingVertical: 4, paddingHorizontal: 6 },
  kv: { flexDirection: "row", marginBottom: 1.5 },
  k: { width: 92, fontFamily: "Helvetica-Bold" },
  v: { flex: 1 },
  tableHead: { flexDirection: "row", backgroundColor: "#3b3b3b", color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 7.5, marginTop: 12, borderWidth: 1, borderColor: dark },
  th: { paddingVertical: 5, paddingHorizontal: 3, textAlign: "center", borderRightWidth: 0.6, borderRightColor: "#777" },
  row: { flexDirection: "row", borderLeftWidth: 1, borderRightWidth: 1, borderBottomWidth: 0.6, borderColor: line, minHeight: 15 },
  td: { paddingVertical: 3, paddingHorizontal: 3, textAlign: "center", borderRightWidth: 0.6, borderRightColor: line, fontSize: 7.5 },
  totalRow: { flexDirection: "row", borderLeftWidth: 1, borderRightWidth: 1, borderBottomWidth: 1, borderColor: line },
  totalLabel: { backgroundColor: yellow, fontFamily: "Helvetica-Bold", textAlign: "center", paddingVertical: 4, fontSize: 8 },
  totalValue: { backgroundColor: yellow, fontFamily: "Helvetica-Bold", textAlign: "right", paddingVertical: 4, paddingHorizontal: 4, fontSize: 8.5 },
  notes: { marginTop: 10, fontSize: 8, color: grey, lineHeight: 1.4 },
  footerImg: { position: "absolute", bottom: 0, left: MARGIN, right: MARGIN, width: CONTENT_W },
  signature: { position: "absolute", bottom: 14, left: MARGIN + 12, width: 330, fontSize: 7.5, lineHeight: 1.35, color: "#111" },
  sigName: { fontFamily: "Helvetica-Bold", fontSize: 8.5 },
  sigCompany: { fontFamily: "Helvetica-Bold" },
  logoSmall: { height: 48, objectFit: "contain" as const },
  photosTitle: { marginTop: 10, fontSize: 12, fontFamily: "Helvetica-Bold", color: dark },
  photoGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 6 },
  photoCard: { width: "33.33%", paddingRight: 10, paddingBottom: 10 },
  photoBox: { borderWidth: 1, borderColor: line, padding: 6, height: 215 },
  photoCaption: { fontFamily: "Helvetica-Bold", fontSize: 8, marginBottom: 4 },
  photoRow: { flexDirection: "row", height: 170 },
  photoImg: { flex: 1, objectFit: "contain" as const },
  photoSrc: { fontSize: 6.5, color: grey, marginTop: 3 },
});

// column widths (fractions of the table width)
const COLS = { item: 0.05, size: 0.17, brand: 0.11, model: 0.17, app: 0.12, origin: 0.12, qty: 0.07, unit: 0.095, total: 0.095 };

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${parseInt(d, 10)}/${parseInt(m, 10)}/${y}`;
}

function resolve(p: string): string | null {
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  return fs.existsSync(/* turbopackIgnore: true */ abs) ? abs : null;
}

export function QuoteDocument({ quote, settings, photos = {} }: { quote: Quote; settings: Settings; photos?: PhotoAssets }) {
  const c = settings.company;
  const cur = quote.currency;
  const curLabel = cur === "USD" ? "US $" : cur;
  const header = resolve(c.headerImagePath);
  const footer = resolve(c.footerImagePath);
  const logo = resolve(c.logoPath);
  const taxText = quote.pricesIncludeTax ? `INCLUIDOS - ${quote.taxLabel} ${quote.taxPct}%` : `NO INCLUIDOS - ${quote.taxLabel} ${quote.taxPct}%`;
  const money = (n: number) => fmtMoney(n, cur).replace(/^US\$\s?/, "$");
  const total = displayTotal(quote);
  const rows = [...quote.items];
  const blank = Math.max(0, 6 - rows.length);
  const w = (f: number) => ({ width: `${f * 100}%` });
  const sp = quote.salesperson;
  const photoItems = quote.items.map((it, i) => ({ it, i, a: photos[i] })).filter((x) => x.a?.photo || x.a?.sheet);

  return (
    <Document title={`Cotización ${quote.number}`} author={c.tradeName || c.name}>
      <Page size="A4" orientation="landscape" style={st.page}>
        {header ? (
          <Image src={header} style={st.headerImg} />
        ) : (
          <View style={st.headerFallback}>
            {logo ? <Image src={logo} style={st.logoSmall} /> : <Text style={{ fontFamily: "Helvetica-Bold", fontSize: 14 }}>{c.tradeName || c.name}</Text>}
            <Text style={st.title}>COTIZACIÓN</Text>
            <View style={{ width: 60 }} />
          </View>
        )}
        <View style={st.numberBand}>
          <Text style={st.numberText}>{quote.number}</Text>
        </View>

        <View style={st.boxes}>
          <View style={[st.box, { marginRight: 8 }]}>
            <View style={st.kv}>
              <Text style={st.k}>Fecha:</Text>
              <Text style={st.v}>{fmtDate(quote.date)}</Text>
            </View>
            <View style={st.kv}>
              <Text style={st.k}>Cliente:</Text>
              <Text style={[st.v, { fontFamily: "Helvetica-Bold" }]}>{quote.customer.company || quote.customer.name || "—"}</Text>
            </View>
            <View style={st.kv}>
              <Text style={st.k}>Atención:</Text>
              <Text style={st.v}>{quote.customer.attention || (quote.customer.company ? quote.customer.name : "") || "—"}</Text>
            </View>
            <View style={st.kv}>
              <Text style={st.k}>Dirección:</Text>
              <Text style={st.v}>{quote.customer.address || "—"}</Text>
            </View>
            <View style={st.kv}>
              <Text style={st.k}>Tipo de Pago:</Text>
              <Text style={st.v}>{quote.paymentType || "—"}</Text>
            </View>
            <View style={st.kv}>
              <Text style={st.k}>Plazo de Pago:</Text>
              <Text style={st.v}>{quote.paymentTerm || "—"}</Text>
            </View>
          </View>
          <View style={st.box}>
            <View style={st.kv}>
              <Text style={st.k}>Validez de la Oferta:</Text>
              <Text style={st.v}>{quote.validityDays} días</Text>
            </View>
            <View style={st.kv}>
              <Text style={st.k}>Plazo de Entrega:</Text>
              <Text style={st.v}>{quote.deliveryTerm || "—"}</Text>
            </View>
            <View style={st.kv}>
              <Text style={st.k}>Asesor Comercial:</Text>
              <Text style={st.v}>{sp.name || "—"}</Text>
            </View>
            <View style={st.kv}>
              <Text style={st.k}>Moneda:</Text>
              <Text style={st.v}>{cur === "USD" ? "Dólares Americanos" : cur === "PEN" ? "Soles" : cur}</Text>
            </View>
            <View style={st.kv}>
              <Text style={st.k}>Impuestos:</Text>
              <Text style={[st.v, { fontFamily: "Helvetica-Bold" }]}>{taxText}</Text>
            </View>
            {quote.exchangeRate ? (
              <View style={st.kv}>
                <Text style={st.k}>Tipo de cambio:</Text>
                <Text style={st.v}>S/. {quote.exchangeRate}</Text>
              </View>
            ) : null}
            {quote.customer.ref ? (
              <View style={st.kv}>
                <Text style={st.k}>Su referencia:</Text>
                <Text style={st.v}>{quote.customer.ref}</Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={st.tableHead}>
          <Text style={[st.th, w(COLS.item)]}>ITEM</Text>
          <Text style={[st.th, w(COLS.size)]}>MEDIDA</Text>
          <Text style={[st.th, w(COLS.brand)]}>MARCA</Text>
          <Text style={[st.th, w(COLS.model)]}>MODELO</Text>
          <Text style={[st.th, w(COLS.app)]}>APLICACIÓN</Text>
          <Text style={[st.th, w(COLS.origin)]}>ORIGEN</Text>
          <Text style={[st.th, w(COLS.qty)]}>CANTIDAD</Text>
          <Text style={[st.th, w(COLS.unit)]}>PRECIO UNIT.{"\n"}{curLabel}</Text>
          <Text style={[st.th, w(COLS.total), { borderRightWidth: 0 }]}>PRECIO TOTAL{"\n"}{curLabel}</Text>
        </View>
        {rows.map((it, i) => {
          const measure = it.size ? `${it.sizeDisplay}${it.ply ? ` ${it.ply}PR` : ""}${it.loadIndex && !it.ply ? ` ${it.loadIndex}${it.speedIndex ?? ""}` : ""}` : it.description;
          return (
            <View key={i} style={st.row} wrap={false}>
              <Text style={[st.td, w(COLS.item)]}>{i + 1}</Text>
              <Text style={[st.td, w(COLS.size), { textAlign: "left" }]}>{measure}</Text>
              <Text style={[st.td, w(COLS.brand)]}>{it.brand.toUpperCase()}</Text>
              <Text style={[st.td, w(COLS.model)]}>{it.model.toUpperCase()}</Text>
              <Text style={[st.td, w(COLS.app)]}>{it.application ?? ""}</Text>
              <Text style={[st.td, w(COLS.origin)]}>{it.countryOfOrigin ?? ""}</Text>
              <Text style={[st.td, w(COLS.qty)]}>{it.quantity}</Text>
              <Text style={[st.td, w(COLS.unit), { textAlign: "right", color: red, fontFamily: "Helvetica-Bold" }]}>{money(displayUnit(it, quote))}</Text>
              <Text style={[st.td, w(COLS.total), { textAlign: "right", borderRightWidth: 0 }]}>{money(displayUnit(it, quote) * it.quantity)}</Text>
            </View>
          );
        })}
        {Array.from({ length: blank }).map((_, i) => (
          <View key={`b${i}`} style={st.row}>
            {Object.values(COLS).map((f, j) => (
              <Text key={j} style={[st.td, w(f), j === 8 ? { borderRightWidth: 0 } : {}]}> </Text>
            ))}
          </View>
        ))}
        <View style={st.totalRow}>
          <Text style={{ width: `${(1 - COLS.unit - COLS.total) * 100}%` }}> </Text>
          <Text style={[st.totalLabel, w(COLS.unit)]}>TOTAL {curLabel}</Text>
          <Text style={[st.totalValue, w(COLS.total)]}>{money(total)}</Text>
        </View>
        {!quote.pricesIncludeTax ? (
          <View style={{ flexDirection: "row" }}>
            <Text style={{ width: `${(1 - COLS.unit - COLS.total) * 100}%` }}> </Text>
            <Text style={[st.totalLabel, { width: `${(COLS.unit + COLS.total) * 100}%`, fontSize: 7.5 }]}>NO INCLUYE - {quote.taxLabel} {quote.taxPct}%</Text>
          </View>
        ) : null}

        {quote.notes ? <Text style={st.notes}>{quote.notes}</Text> : null}

        {footer ? <Image src={footer} style={st.footerImg} fixed /> : null}
        <View style={st.signature} fixed>
          <Text style={st.sigName}>{sp.name}</Text>
          {sp.title ? <Text>{sp.title}</Text> : null}
          <Text style={st.sigCompany}>{c.signatureName || c.tradeName || c.name}</Text>
          {sp.address || c.address ? <Text>{sp.address || c.address}</Text> : null}
          {c.taxId ? <Text>{c.taxId}</Text> : null}
          {sp.phone ? <Text>Celular: {sp.phone}</Text> : null}
          {sp.email ? <Text>{sp.email}</Text> : null}
        </View>
      </Page>
      {photoItems.length > 0 ? (
        <Page size="A4" orientation="landscape" style={st.page}>
          {header ? <Image src={header} style={st.headerImg} /> : null}
          <View style={st.numberBand}>
            <Text style={st.numberText}>{quote.number} · FOTOS</Text>
          </View>
          <View style={st.photoGrid}>
            {photoItems.map(({ it, i, a }) => (
              <View key={i} style={st.photoCard} wrap={false}>
                <View style={st.photoBox}>
                  <Text style={st.photoCaption}>
                    {i + 1}. {[it.brand, it.model].filter(Boolean).join(" ").toUpperCase()} {it.sizeDisplay}
                    {it.ply ? ` ${it.ply}PR` : ""}
                  </Text>
                  <View style={st.photoRow}>
                    {a?.photo ? <Image src={a.photo} style={st.photoImg} /> : null}
                    {a?.sheet ? <Image src={a.sheet} style={[st.photoImg, { marginLeft: 6 }]} /> : null}
                  </View>
                  {it.photoSource ? <Text style={st.photoSrc}>Foto: {it.photoSource}</Text> : null}
                </View>
              </View>
            ))}
          </View>
          {footer ? <Image src={footer} style={st.footerImg} fixed /> : null}
          <View style={st.signature} fixed>
            <Text style={st.sigName}>{sp.name}</Text>
            <Text style={st.sigCompany}>{c.signatureName || c.tradeName || c.name}</Text>
          </View>
        </Page>
      ) : null}
    </Document>
  );
}

/** Download every item photo / sheet (in parallel, failures skipped) so the PDF never depends on the network mid-render. */
export async function fetchPhotoAssets(quote: Quote): Promise<PhotoAssets> {
  const out: PhotoAssets = {};
  await Promise.all(
    quote.items.map(async (it, i) => {
      if (!it.photoUrl && !it.sheetUrl) return;
      const [photo, sheet] = await Promise.all([it.photoUrl ? loadImage(it.photoUrl) : null, it.sheetUrl ? loadImage(it.sheetUrl) : null]);
      if (photo || sheet) out[i] = { photo: photo?.data, sheet: sheet?.data };
    }),
  );
  return out;
}

export async function renderQuotePdf(quote: Quote, settings: Settings, opts: { photos?: boolean | PhotoAssets } = {}): Promise<Buffer> {
  const photos = opts.photos === false ? {} : opts.photos === true || opts.photos === undefined ? await fetchPhotoAssets(quote) : opts.photos;
  const buf = await renderToBuffer(<QuoteDocument quote={quote} settings={settings} photos={photos} />);
  return Buffer.from(buf);
}
