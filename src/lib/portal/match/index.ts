/**
 * Match Venta (corrida K): a quién venderle el stock prioritario. Lógica y datos; la pantalla (/portal/match) y los
 * comandos del bot se construyen encima de esta API.
 *
 * Qué usar para cada cosa
 * ───────────────────────
 * Stock y productos
 *   - ownStockSource() (src/lib/store/own-stock.ts)  stock propio + descuentos por pedidos SIN getStore() (páginas).
 *     En el bot / CLI sirve el PriceStore (getStore()), que cumple OwnStockSource.
 *   - loadMatchStock({ store, prices })  -> { stock: MatchStockProduct[] } (disponible en Lima = San Luis + Callao −
 *     reserva − en pedidos; desglose en warehouses/reserved/committed). Sin `prices`: la foto del último cálculo.
 *   - productLabel(p) / productName(p)  "295/80R22.5 Fenixway Flama 66" / "Fenixway Flama 66".
 *   - resolveProduct("P0428" | "295 flama 66" | texto de voz, stock)  -> one | many | none (bot: `match P0433`,
 *     `prioridad 295 flama 66`).
 *   - setPriority(store, { code, on, user, stock })  prende/quita con registro (match_priority_log); después llamar
 *     recalcMatchSafely({ store, prices, why }) (o usar setPriorityAndRecalc).
 *   - store.setMatchApplication(code, texto, userId)  editar la aplicación; store.matchPriorityLog(code) quién y cuándo.
 *   - switchOffSoldOut  (lo corre el cálculo) apaga la prioridad al llegar a 0 y deja el aviso (avisos pendientes).
 *
 * Cálculo por lotes (nunca al abrir la página)
 *   - recalcMatch / recalcMatchSafely({ store, prices?, why })  siembra productos de config, stock, apagado, cruce y
 *     guarda (match_results + match_runs). Ya se llama al cargar stock (WhatsApp, Drive, `npm run ingest`), al subir
 *     ventas o asignar cliente final, al importar el padrón y desde `npm run portal:recalc-match`.
 *
 * Vistas (leen lo guardado; `viewer` = { id, rol }: un vendedor no ve empresas de otro vendedor)
 *   - matchOverview(store, viewer)  Vista 1: tarjetas por producto (disponible, aplicación, N empresas, X ya
 *     compraron, notas cuando el padrón no permite inferir la medida) + total "636 llantas · N empresas".
 *   - matchesForProduct(store, viewer, code, filters)  Vista 2: MatchCard[] (estado Cliente/Prospecto/Tuya/Sin dueño,
 *     pct "estimado" + detalle.desglose en una línea, compraTexto "Ya te compró…", migracionTexto, podriaLlevarTexto,
 *     avisoCredito, distrito/departamento/dirección, tamanoTexto) + soloVentas ("Clientes que ya compraron esta
 *     medida", sin %) + `vacio` (estado vacío con explicación).
 *   - matchesByCompany(store, viewer, filters)  "Ver por empresa": una vez cada empresa con todos sus matches.
 *   - companyMatchBlock(store, viewer, companyId)  ficha: "Match con tu stock".
 *   - todayMatchLine(store, viewer)  Hoy: "Tienes 636 llantas prioritarias: N empresas sin contactar hacen match".
 *   - parseMatchFilters(searchParams) / matchFiltersQuery(filters)  filtros en la dirección (chips).
 *   - sizeBuckets(cfg.cortesFlota)  etiquetas del filtro de tamaño de flota.
 *
 * Agenda
 *   - scheduleMatchVisit(store, { companyId, productCode, user, startsAt })  asigna si no tiene dueño (atómico), crea
 *     la oportunidad si falta, cita + etapa + próxima acción + actividad, y la liga al producto (match_visits) con el
 *     motivo. Ok con duplicate:true si ya había esa visita ese día.
 *   - proposeVisitPlan(empresas, { start, perDay: cfg.visitasPorDia, holidays })  reparto por día agrupando por
 *     departamento/provincia/distrito (sin rutas).
 *   - El reporte de visita (bot/report.ts) ya conserva el vínculo: pendingMatchVisits + markMatchVisitsReported.
 *
 * Avance
 *   - matchProgress(store, { stock, quotes })  por producto: disponible, cotizado (de las cotizaciones guardadas, sin
 *     tocar el cotizador), pedido, restante y visitas agendadas/hechas/con cotización/con pedido. progressText(rows).
 *
 * Ubicación: setCompanyDireccion (Agregar dirección, con permiso), directionsLink (Cómo llegar: exacta o búsqueda
 * aproximada), locationText ("Ate, Lima").
 *
 * Textos: purchaseText, visitReason, estadoLabel, podriaLlevarText (text.ts). Config: config/portal.json `match`
 * (config.ts). Análisis: analyzeFleets/formatAnalysis (`npm run match:analisis-flotas`). Equivalencias: sizes.ts
 * (`npm run match:equivalencias`).
 */
import { loadPortalConfig } from "../config";
import type { PortalStore, PortalUser } from "../store/types";
import { setPriority, type PriorityResult } from "./products";
import { loadMatchStock, recalcMatchSafely, type RecalcMatchResult } from "./recalc";
import type { OwnStockSource } from "./stock";
import type { MatchConfig } from "./config";

export * from "./config";
export * from "./stock";
export * from "./sizes";
export * from "./compute";
export * from "./text";
export * from "./products";
export * from "./resolve";
export * from "./recalc";
export * from "./read";
export * from "./schedule";
export * from "./progress";
export * from "./analysis";
export * from "./company";

/**
 * Prender/quitar la prioridad y recalcular en un paso (portal y bot). Con `prices` el stock es el vivo; sin él, la foto
 * del último cálculo (prender exige disponible > 0 en esa foto).
 */
export async function setPriorityAndRecalc(
  store: PortalStore,
  input: { code: string; on: boolean; user: Pick<PortalUser, "id" | "nombre" | "rol">; prices?: OwnStockSource | null; now?: Date; log?: (m: string) => void; cfg?: MatchConfig },
): Promise<PriorityResult & { recalc?: RecalcMatchResult | null }> {
  const cfg = input.cfg ?? loadPortalConfig().match;
  const { stock } = await loadMatchStock({ store, prices: input.prices ?? null, cfg });
  const r = await setPriority(store, { code: input.code, on: input.on, user: input.user, stock, now: input.now });
  if (!r.ok || !r.changed) return r;
  const recalc = await recalcMatchSafely({ store, prices: input.prices ?? null, cfg, now: input.now, why: `prioridad ${input.on ? "activada" : "quitada"} ${r.product.code}`, log: input.log });
  return { ...r, recalc };
}
