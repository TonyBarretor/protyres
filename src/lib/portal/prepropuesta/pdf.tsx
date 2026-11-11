/**
 * Pre-propuesta en PDF (A4 vertical, 4 páginas, identidad del cotizador: bandas negro/amarillo, logo y pie de
 * config/branding/). Cuenta una historia:
 *   1. Quiénes somos (presentación institucional) · 2. Un caso con cifras (ANCRO) y uno breve (Ultraseal en Innova) ·
 *   3. Su flota hoy (padrón MTC + medida inferida) · 4. Qué proponemos + contacto del vendedor que la genera.
 * Textos fijos y cifras de los casos: config/prepropuesta.json. Datos variables: data.ts. Nada vacío llega al PDF: un
 * dato opcional que falta omite su bloque; uno obligatorio corta antes de dibujar (assertPrepropuesta).
 */
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { loadSettings, type Settings } from "../../settings";
import { fmtInt } from "../ui/labels";
import { fillText, loadPrepropuestaConfig, type CasoConfig, type Fuente, type PrepropuestaConfig } from "./config";
import { assertPrepropuesta, type PrepropuestaData } from "./data";

export const MAX_PAGES = 4;

const yellow = "#F5B400";
const dark = "#2b2b2b";
const black = "#111111";
const grey = "#555555";
const light = "#f3f3f3";
const line = "#cfcfcf";
const barGrey = "#8a8a8a";

const PAGE_W = 595.28; // A4 vertical
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER_H = (PAGE_W * 230) / 1841; // footer.png: 1841 x 230

/**
 * Las fuentes estándar del PDF (Helvetica, WinAnsi) no tienen el signo menos tipográfico ni flechas: se escriben con
 * guion y "a". Se aplica a todo texto que se dibuja (y los tests comparan contra este mismo texto).
 */
export function pdfText(s: string): string {
  return s
    .replace(/−/g, "-")
    .replace(/\s*(?:→|->)\s*/g, " a ")
    .replace(/[  ]/g, " ");
}

const st = StyleSheet.create({
  page: { paddingTop: 100, paddingBottom: FOOTER_H + 12, paddingHorizontal: MARGIN, fontSize: 9, fontFamily: "Helvetica", color: black },
  bandBlack: { position: "absolute", top: 0, left: 0, right: 0, height: 12, backgroundColor: black },
  bandYellow: { position: "absolute", top: 12, left: 0, width: 230, height: 5, backgroundColor: yellow },
  bandGrey: { position: "absolute", top: 12, left: 230, right: 0, height: 5, backgroundColor: "#3b3b3b" },
  // logo.png trae una raya gris en el borde superior: se recorta con un marco sin desborde
  logoBox: { position: "absolute", top: 26, left: MARGIN, height: 53, width: (60 * 280) / 212, overflow: "hidden" },
  logo: { marginTop: -7, height: 60, width: (60 * 280) / 212, objectFit: "contain" as const },
  headRight: { position: "absolute", top: 34, right: MARGIN, width: 330, alignItems: "flex-end" },
  kicker: { fontSize: 7.5, color: grey, letterSpacing: 1, textAlign: "right" },
  pageTitle: { fontSize: 20, fontFamily: "Helvetica-Bold", color: dark, textAlign: "right", marginTop: 2, lineHeight: 1.15 },
  headRule: { position: "absolute", top: 88, left: MARGIN, right: MARGIN, height: 2, backgroundColor: yellow },
  footerImg: { position: "absolute", bottom: 0, left: 0, width: PAGE_W, height: FOOTER_H },
  footerText: { position: "absolute", bottom: FOOTER_H * 0.3 + 10, right: MARGIN, width: 320, fontSize: 6.8, color: grey, textAlign: "right", lineHeight: 1.45 },
  // sin lineHeight: en react-pdf 4.9 un Text con `render` y lineHeight no se dibuja
  footerPage: { position: "absolute", bottom: FOOTER_H * 0.3, right: MARGIN, width: 320, fontSize: 6.8, color: grey, textAlign: "right" },
  h2: { fontSize: 12.5, fontFamily: "Helvetica-Bold", color: dark, marginBottom: 6 },
  h2Wrap: { flexDirection: "row", alignItems: "center", marginTop: 12, marginBottom: 6 },
  h2Bar: { width: 4, height: 14, backgroundColor: yellow, marginRight: 6 },
  h2Text: { fontSize: 12.5, fontFamily: "Helvetica-Bold", color: dark },
  para: { fontSize: 9.2, lineHeight: 1.45 },
  small: { fontSize: 7.2, color: grey, lineHeight: 1.35 },
  coverFor: { fontSize: 8.5, color: grey, letterSpacing: 1 },
  coverName: { fontSize: 18, fontFamily: "Helvetica-Bold", color: dark, marginTop: 2, lineHeight: 1.15 },
  coverMeta: { fontSize: 8.5, color: grey, marginTop: 2 },
  tileGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -3 },
  tile: { backgroundColor: light, borderTopWidth: 3, borderTopColor: yellow, paddingVertical: 6, paddingHorizontal: 7, margin: 3 },
  tileBig: { fontSize: 11, fontFamily: "Helvetica-Bold", color: dark, marginBottom: 2, lineHeight: 1.15 },
  tileValue: { fontSize: 16, fontFamily: "Helvetica-Bold", color: dark, lineHeight: 1.15, marginBottom: 1 },
  tileText: { fontSize: 7.8, color: "#333", lineHeight: 1.35 },
  bulletRow: { flexDirection: "row", alignItems: "flex-start", width: "50%", paddingRight: 8, marginBottom: 2.5 },
  bullet: { width: 4, height: 4, backgroundColor: yellow, marginTop: 4, marginRight: 5 },
  chip: { borderWidth: 1, borderColor: dark, paddingVertical: 2.5, paddingHorizontal: 7, marginRight: 5, marginBottom: 5, fontSize: 8, fontFamily: "Helvetica-Bold" },
  card: { borderWidth: 1, borderColor: line, marginTop: 8 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: black, paddingVertical: 5, paddingHorizontal: 8 },
  cardClient: { color: yellow, fontFamily: "Helvetica-Bold", fontSize: 10 },
  cardTitle: { color: "#ffffff", fontSize: 8.5 },
  cardBody: { paddingVertical: 7, paddingHorizontal: 8 },
  chartBox: { width: (CONTENT_W - 16 - 10) / 2, borderWidth: 1, borderColor: line, paddingVertical: 6, paddingHorizontal: 8 },
  chartTitle: { fontSize: 8.5, fontFamily: "Helvetica-Bold", color: dark },
  chartArea: { flexDirection: "row", alignItems: "flex-end", height: 104, marginTop: 4 },
  barCol: { width: 62, alignItems: "center", marginRight: 10 },
  barValue: { fontSize: 8, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  barLabel: { fontSize: 6.8, color: grey, marginTop: 3, textAlign: "center" },
  badge: { backgroundColor: yellow, paddingVertical: 4, paddingHorizontal: 6, marginLeft: "auto", alignSelf: "center" },
  badgeText: { fontSize: 14, fontFamily: "Helvetica-Bold", color: black, lineHeight: 1.15 },
  table: { borderWidth: 1, borderColor: line },
  th: { flexDirection: "row", backgroundColor: "#3b3b3b" },
  thCell: { color: "#ffffff", fontFamily: "Helvetica-Bold", fontSize: 7.8, paddingVertical: 4, paddingHorizontal: 5 },
  tr: { flexDirection: "row", borderTopWidth: 0.6, borderTopColor: line, alignItems: "center" },
  td: { fontSize: 8.3, paddingVertical: 3.5, paddingHorizontal: 5 },
  num: { textAlign: "right" },
  noteBox: { flexDirection: "row", backgroundColor: "#fff6d6", borderLeftWidth: 3, borderLeftColor: yellow, paddingVertical: 5, paddingHorizontal: 7, marginTop: 10 },
  step: { flexDirection: "row", borderWidth: 1, borderColor: line, padding: 9, marginBottom: 8 },
  stepNum: { width: 26, height: 26, borderRadius: 13, backgroundColor: yellow, alignItems: "center", justifyContent: "center", marginRight: 10 },
  stepNumText: { fontSize: 13, fontFamily: "Helvetica-Bold", color: black },
  stepTitle: { fontSize: 10.5, fontFamily: "Helvetica-Bold", color: dark, marginBottom: 2, lineHeight: 1.2 },
  contact: { backgroundColor: black, paddingVertical: 12, paddingHorizontal: 14, marginTop: 12, flexDirection: "row", alignItems: "center" },
  contactKicker: { fontSize: 7.5, color: yellow, letterSpacing: 1 },
  contactName: { fontSize: 14, fontFamily: "Helvetica-Bold", color: "#ffffff", marginTop: 3, lineHeight: 1.2 },
  contactLine: { fontSize: 9, color: "#ffffff", marginTop: 2 },
  contactRole: { fontSize: 9, color: yellow, marginTop: 1 },
});

function resolve(p: string): string | null {
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  return fs.existsSync(/* turbopackIgnore: true */ abs) ? abs : null;
}

/** Texto ya normalizado para la fuente del PDF. */
function T({ children, style }: { children: string; style?: React.ComponentProps<typeof View>["style"] }) {
  return <Text style={style}>{pdfText(children)}</Text>;
}

/** Páginas "1-2", "3" -> [1, 2, 3]. */
function pages(p: string): number[] {
  const out: number[] = [];
  for (const part of p.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = a; i <= b && i - a < 50; i++) out.push(i);
  }
  return out;
}

/** "Fuente: Informe ejecutivo semestral ANCRO S.R.L., pp. 1 y 2." (todas las cifras del caso, por documento). */
export function fuentesText(caso: CasoConfig): string {
  const all: Fuente[] = [caso.contextoFuente, ...caso.comparativos.map((c) => c.fuente), ...caso.indicadores.map((i) => i.fuente), caso.detalleFuente, caso.notaFuente].filter(
    (f): f is Fuente => !!f,
  );
  const byFile = new Map<string, { documento: string; pages: Set<number> }>();
  for (const f of all) {
    const e = byFile.get(f.archivo) ?? { documento: f.documento, pages: new Set<number>() };
    for (const n of pages(f.pagina)) e.pages.add(n);
    byFile.set(f.archivo, e);
  }
  const parts = [...byFile.values()].map(({ documento, pages: ps }) => {
    const list = [...ps].sort((a, b) => a - b).map(String);
    if (!list.length) return documento;
    const joined = list.length === 1 ? `p. ${list[0]}` : `pp. ${list.slice(0, -1).join(", ")} y ${list.at(-1)}`;
    return `${documento}, ${joined}`;
  });
  return `Fuente: ${parts.join("; ")}.`;
}

interface Chrome {
  logo: string | null;
  footer: string | null;
  kicker: string;
  pie: string;
}

function PageFrame({ chrome, title, children }: { chrome: Chrome; title: string; children: React.ReactNode }) {
  return (
    <Page size="A4" style={st.page}>
      <View style={st.bandBlack} fixed />
      <View style={st.bandYellow} fixed />
      <View style={st.bandGrey} fixed />
      {chrome.logo ? (
        <View style={st.logoBox} fixed>
          <Image src={chrome.logo} style={st.logo} />
        </View>
      ) : null}
      <View style={st.headRight} fixed>
        <T style={st.kicker}>{chrome.kicker}</T>
        <T style={st.pageTitle}>{title.toUpperCase()}</T>
      </View>
      <View style={st.headRule} fixed />
      {children}
      {chrome.footer ? <Image src={chrome.footer} style={st.footerImg} fixed /> : null}
      <View style={st.footerText} fixed>
        <T>{chrome.pie}</T>
      </View>
      {/* total real de páginas (render prop de react-pdf); va como Text fijo directo en la página para que se dibuje */}
      <Text style={st.footerPage} fixed render={({ pageNumber, totalPages }) => `Página ${pageNumber} de ${totalPages}`} />
    </Page>
  );
}

function H2({ children }: { children: string }) {
  return (
    <View style={st.h2Wrap} wrap={false}>
      <View style={st.h2Bar} />
      <T style={st.h2Text}>{children}</T>
    </View>
  );
}

function BeforeAfter({ c }: { c: CasoConfig["comparativos"][number] }) {
  const max = Math.max(c.antes.valor, c.despues.valor);
  const MAX_H = 76;
  const h = (v: number) => Math.max(4, (v / max) * MAX_H);
  return (
    <View style={st.chartBox} wrap={false}>
      <T style={st.chartTitle}>{c.etiqueta}</T>
      <View style={st.chartArea}>
        {[
          { v: c.antes, color: barGrey },
          { v: c.despues, color: yellow },
        ].map(({ v, color }, i) => (
          <View key={i} style={st.barCol}>
            <T style={st.barValue}>{v.texto}</T>
            <View style={{ width: 34, height: h(v.valor), backgroundColor: color }} />
            <T style={st.barLabel}>{v.periodo}</T>
          </View>
        ))}
        <View style={st.badge}>
          <T style={st.badgeText}>{c.variacion}</T>
        </View>
      </View>
    </View>
  );
}

function Indicators({ items }: { items: CasoConfig["indicadores"] }) {
  const w = (CONTENT_W - 16) / items.length - 6;
  return (
    <View style={[st.tileGrid, { marginTop: 6 }]}>
      {items.map((it, i) => (
        <View key={i} style={[st.tile, { width: w }]} wrap={false}>
          <T style={st.tileValue}>{it.valor}</T>
          <T style={st.tileText}>{it.texto}</T>
        </View>
      ))}
    </View>
  );
}

function CaseCard({ n, caso, compact }: { n: number; caso: CasoConfig; compact?: boolean }) {
  return (
    <View style={st.card} wrap={false}>
      <View style={st.cardHead}>
        <T style={st.cardClient}>{`CASO ${n} · ${caso.cliente}`}</T>
        <T style={st.cardTitle}>{caso.titulo}</T>
      </View>
      <View style={st.cardBody}>
        <T style={[st.para, { fontSize: compact ? 8.6 : 9 }]}>{caso.contexto}</T>
        {caso.comparativos.length ? (
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 7 }}>
            {caso.comparativos.map((c, i) => (
              <BeforeAfter key={i} c={c} />
            ))}
          </View>
        ) : null}
        <Indicators items={caso.indicadores} />
        {caso.detalle ? <T style={[st.para, { fontSize: 8.4, marginTop: 5 }]}>{caso.detalle}</T> : null}
        {caso.nota ? <T style={[st.small, { marginTop: 4 }]}>{caso.nota}</T> : null}
        <T style={[st.small, { marginTop: 2 }]}>{fuentesText(caso)}</T>
      </View>
    </View>
  );
}

export function PrepropuestaDocument({ data, cfg, settings }: { data: PrepropuestaData; cfg: PrepropuestaConfig; settings: Settings }) {
  const e = data.empresa;
  const fill = (s: string) => fillText(s, { empresa: e.razonSocial });
  const c = settings.company;
  const chrome: Chrome = {
    logo: resolve(c.logoPath),
    footer: resolve(c.footerImagePath),
    kicker: `${cfg.documento.titulo.toUpperCase()} · ${e.razonSocial}`,
    pie: cfg.documento.pie,
  };
  const qs = cfg.quienesSomos;
  const fl = cfg.flota;
  const pr = cfg.propuesta;
  const v = data.vendedor;
  const maxUnits = Math.max(1, ...data.flota.filas.map((f) => f.unidades), data.flota.otras?.unidades ?? 0);
  const COLS = { marca: 0.27, clase: 0.18, anios: 0.15, unidades: 0.11, llantas: 0.11, bar: 0.18 };
  const w = (f: number) => ({ width: `${f * 100}%` });

  const kpis: { label: string; value: string; sub?: string }[] = [{ label: "Unidades", value: fmtInt(e.unidades), sub: "padrón MTC" }];
  if (e.llantasPiso !== null) kpis.push({ label: "Llantas en piso", value: fmtInt(e.llantasPiso), sub: "padrón MTC" });
  if (e.antiguedadMedia !== null) kpis.push({ label: "Antigüedad media", value: `${fmtInt(e.antiguedadMedia)} años`, sub: "padrón MTC" });
  if (data.participacion) kpis.push({ label: "Participación", value: fmtInt(data.participacion.cantidad), sub: fl.participacionTexto });
  const kpiW = (CONTENT_W + 6) / kpis.length - 6;
  const meta = [e.sector ? `Sector ${e.sector.toLowerCase()}` : null, e.departamento ? `Base principal: ${e.departamento}` : null].filter(Boolean).join(" · ");
  const resumen = [
    `Unidades: ${fmtInt(e.unidades)}`,
    e.llantasPiso !== null ? `llantas en piso: ${fmtInt(e.llantasPiso)}` : null,
    data.flota.medidas.length ? `medidas a confirmar: ${data.flota.medidas.map((m) => m.medida).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Document title={`${cfg.documento.titulo} - ${e.razonSocial}`} author={c.tradeName || c.name} subject={cfg.documento.subtitulo}>
      {/* 1. Quiénes somos */}
      <PageFrame chrome={chrome} title={qs.titulo}>
        <T style={st.coverFor}>{`${cfg.documento.titulo.toUpperCase()} PARA`}</T>
        <T style={st.coverName}>{e.razonSocial}</T>
        <T style={st.coverMeta}>{`RUC ${e.ruc} · Lima, ${data.fechaTexto}`}</T>
        {e.atencion ? <T style={st.coverMeta}>{`Atención: ${e.atencion}`}</T> : null}
        <T style={[st.para, { fontFamily: "Helvetica-Bold", marginTop: 10 }]}>{fill(cfg.documento.saludo)}</T>
        <T style={[st.para, { marginTop: 3 }]}>{fill(cfg.documento.introduccion)}</T>

        <H2>{qs.titulo}</H2>
        <View style={st.tileGrid}>
          {qs.puntos.map((p, i) => (
            <View key={i} style={[st.tile, { width: (CONTENT_W + 6) / 3 - 6, minHeight: 58 }]} wrap={false}>
              <T style={st.tileBig}>{p.destacado}</T>
              <T style={st.tileText}>{p.texto}</T>
            </View>
          ))}
        </View>

        <H2>{qs.serviciosTitulo}</H2>
        <T style={[st.para, { marginBottom: 4 }]}>{qs.serviciosIntro}</T>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {qs.servicios.map((s, i) => (
            <View key={i} style={st.bulletRow}>
              <View style={st.bullet} />
              <T style={{ fontSize: 8.6 }}>{s}</T>
            </View>
          ))}
        </View>
        <T style={[st.para, { marginTop: 4 }]}>{qs.productos}</T>

        <H2>{qs.marcasTitulo}</H2>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {qs.marcas.map((m, i) => (
            <T key={i} style={st.chip}>
              {m}
            </T>
          ))}
        </View>
      </PageFrame>

      {/* 2. Casos */}
      <PageFrame chrome={chrome} title={cfg.casos.titulo}>
        <CaseCard n={1} caso={cfg.casos.principal} />
        <CaseCard n={2} caso={cfg.casos.secundario} compact />
      </PageFrame>

      {/* 3. Su flota hoy */}
      <PageFrame chrome={chrome} title={fl.titulo}>
        <T style={st.para}>{fill(fl.intro)}</T>
        {meta ? <T style={[st.coverMeta, { marginTop: 2 }]}>{meta}</T> : null}
        <View style={[st.tileGrid, { marginTop: 8 }]}>
          {kpis.map((k, i) => (
            <View key={i} style={[st.tile, { width: kpiW }]} wrap={false}>
              <T style={st.tileText}>{k.label}</T>
              <T style={st.tileValue}>{k.value}</T>
              {k.sub ? <T style={st.tileText}>{k.sub}</T> : null}
            </View>
          ))}
        </View>

        {data.flota.filas.length ? (
          <>
            <H2>{fl.flotaTitulo}</H2>
            <View style={st.table} wrap={false}>
              <View style={st.th}>
                <T style={[st.thCell, w(COLS.marca)]}>Marca</T>
                <T style={[st.thCell, w(COLS.clase)]}>Clase</T>
                <T style={[st.thCell, w(COLS.anios)]}>Años</T>
                <T style={[st.thCell, w(COLS.unidades), st.num]}>Unidades</T>
                <T style={[st.thCell, w(COLS.llantas), st.num]}>Llantas</T>
                <T style={[st.thCell, w(COLS.bar)]}> </T>
              </View>
              {data.flota.filas.map((f, i) => (
                <View key={i} style={st.tr}>
                  <T style={[st.td, w(COLS.marca), { fontFamily: "Helvetica-Bold" }]}>{f.marca}</T>
                  <T style={[st.td, w(COLS.clase)]}>{f.clase}</T>
                  <T style={[st.td, w(COLS.anios)]}>{f.anios ?? " "}</T>
                  <T style={[st.td, w(COLS.unidades), st.num]}>{fmtInt(f.unidades)}</T>
                  <T style={[st.td, w(COLS.llantas), st.num]}>{f.llantas !== null ? fmtInt(f.llantas) : " "}</T>
                  <View style={[w(COLS.bar), { paddingHorizontal: 5 }]}>
                    <View style={{ height: 7, width: `${Math.max(3, (f.unidades / maxUnits) * 100)}%`, backgroundColor: yellow }} />
                  </View>
                </View>
              ))}
              {data.flota.otras ? (
                <View style={st.tr}>
                  <T style={[st.td, w(COLS.marca + COLS.clase + COLS.anios), { color: grey }]}>{`Otras (${fmtInt(data.flota.otras.grupos)} marca/clase)`}</T>
                  <T style={[st.td, w(COLS.unidades), st.num]}>{fmtInt(data.flota.otras.unidades)}</T>
                  <T style={[st.td, w(COLS.llantas), st.num]}>{data.flota.otras.llantas !== null ? fmtInt(data.flota.otras.llantas) : " "}</T>
                  <View style={[w(COLS.bar), { paddingHorizontal: 5 }]}>
                    <View style={{ height: 7, width: `${Math.max(3, (data.flota.otras.unidades / maxUnits) * 100)}%`, backgroundColor: barGrey }} />
                  </View>
                </View>
              ) : null}
            </View>
          </>
        ) : null}

        {data.flota.medidas.length ? (
          <>
            <H2>{fl.medidasTitulo}</H2>
            <View style={[st.table, { width: "70%" }]} wrap={false}>
              <View style={st.th}>
                <T style={[st.thCell, { width: "44%" }]}>Medida (estimada)</T>
                <T style={[st.thCell, { width: "24%" }, st.num]}>Unidades</T>
                <T style={[st.thCell, { width: "32%" }]}>Confianza</T>
              </View>
              {data.flota.medidas.map((m, i) => (
                <View key={i} style={st.tr}>
                  <T style={[st.td, { width: "44%", fontFamily: "Helvetica-Bold" }]}>{m.medida}</T>
                  <T style={[st.td, { width: "24%" }, st.num]}>{fmtInt(m.unidades)}</T>
                  <T style={[st.td, { width: "32%" }]}>{m.confianza ?? "por confirmar"}</T>
                </View>
              ))}
            </View>
          </>
        ) : null}

        <View style={st.noteBox} wrap={false}>
          <T style={{ fontSize: 8.4 }}>{fl.nota}</T>
        </View>
      </PageFrame>

      {/* 4. Qué proponemos */}
      <PageFrame chrome={chrome} title={pr.titulo}>
        <T style={[st.para, { marginBottom: 10 }]}>{fill(pr.intro)}</T>
        {pr.pasos.map((p, i) => (
          <View key={i} style={st.step} wrap={false}>
            <View style={st.stepNum}>
              <T style={st.stepNumText}>{String(i + 1)}</T>
            </View>
            <View style={{ flex: 1 }}>
              <T style={st.stepTitle}>{p.titulo}</T>
              <T style={st.para}>{p.texto}</T>
            </View>
          </View>
        ))}
        <View style={st.noteBox} wrap={false}>
          <T style={{ fontSize: 8.6 }}>{`${e.razonSocial} · ${resumen}`}</T>
        </View>
        <T style={[st.para, { marginTop: 12 }]}>{pr.cierre}</T>
        <View style={st.contact} wrap={false}>
          <View style={{ flex: 1 }}>
            <T style={st.contactKicker}>{pr.contactoTitulo.toUpperCase()}</T>
            <T style={st.contactName}>{v.nombre}</T>
            {v.cargo ? <T style={st.contactRole}>{v.cargo}</T> : null}
            <T style={[st.contactLine, { marginTop: 6 }]}>{`Celular: ${v.telefono}`}</T>
            <T style={st.contactLine}>{`Correo: ${v.email}`}</T>
            {v.direccion ? <T style={st.contactLine}>{v.direccion}</T> : null}
          </View>
          <T style={[st.contactKicker, { alignSelf: "flex-end" }]}>{pr.firma}</T>
        </View>
      </PageFrame>
    </Document>
  );
}

export interface RenderOptions {
  cfg?: PrepropuestaConfig;
  settings?: Settings;
}

/** PDF de la pre-propuesta. Lanza PrepropuestaError si falta un dato obligatorio (no se dibuja nada vacío). */
export async function renderPrepropuestaPdf(data: PrepropuestaData, opts: RenderOptions = {}): Promise<Buffer> {
  assertPrepropuesta(data);
  const cfg = opts.cfg ?? loadPrepropuestaConfig();
  const settings = opts.settings ?? loadSettings();
  const buf = await renderToBuffer(<PrepropuestaDocument data={data} cfg={cfg} settings={settings} />);
  return Buffer.from(buf);
}

/** Páginas de un PDF de react-pdf (objetos /Type /Page sin comprimir). */
export function countPdfPages(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

/** "Pre-propuesta - ZBUSS S.A.C. - 11-11-2026.pdf" (sin caracteres que rompan un nombre de archivo). */
export function prepropuestaFileName(data: Pick<PrepropuestaData, "empresa" | "fecha">, titulo = "Pre-propuesta"): string {
  const [y, m, d] = data.fecha.split("-");
  const empresa = data.empresa.razonSocial.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return `${titulo} - ${empresa} - ${d}-${m}-${y}.pdf`;
}
