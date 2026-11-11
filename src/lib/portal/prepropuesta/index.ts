/**
 * Pre-propuesta: datos (data.ts) -> PDF (pdf.tsx) -> nombre de archivo, y la actividad `prepropuesta` en la empresa.
 * La usan el bot (`prepropuesta <empresa>`), la ficha del portal (botón "Generar pre-propuesta") y el CLI.
 */
import type { PortalStore, PortalUser } from "../store/types";
import { loadPrepropuestaConfig } from "./config";
import { buildPrepropuestaData, type BuildOptions, type PrepropuestaData } from "./data";
import { countPdfPages, prepropuestaFileName, renderPrepropuestaPdf, type RenderOptions } from "./pdf";

export { PrepropuestaError, validatePrepropuesta } from "./data";
export type { PrepropuestaData } from "./data";

export interface GeneratedPrepropuesta {
  pdf: Buffer;
  fileName: string;
  pages: number;
  data: PrepropuestaData;
}

export async function generatePrepropuesta(
  store: PortalStore,
  companyId: number,
  user: PortalUser,
  now: Date,
  opts: BuildOptions & RenderOptions = {},
): Promise<GeneratedPrepropuesta> {
  const cfg = opts.cfg ?? loadPrepropuestaConfig();
  const data = await buildPrepropuestaData(store, companyId, user, now, opts);
  const pdf = await renderPrepropuestaPdf(data, { ...opts, cfg });
  return { pdf, fileName: prepropuestaFileName(data, cfg.documento.titulo), pages: countPdfPages(pdf), data };
}

/** Actividad `prepropuesta` en la empresa (bot: canal whatsapp; ficha: canal portal). */
export async function logPrepropuesta(store: PortalStore, gen: GeneratedPrepropuesta, user: PortalUser, canal: "whatsapp" | "portal", now: Date): Promise<void> {
  const opp = await store.getOpenOpportunity(gen.data.empresa.id);
  await store.addActivity({
    companyId: gen.data.empresa.id,
    opportunityId: opp?.id ?? null,
    userId: user.id,
    tipo: "prepropuesta",
    texto: `Pre-propuesta generada (${gen.pages} páginas, PDF).`,
    canal,
    occurredAt: now,
    data: { fileName: gen.fileName, pages: gen.pages, bytes: gen.pdf.length },
  });
}
