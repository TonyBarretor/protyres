/**
 * Corrida L — `direccion <empresa>` (también "dirección de ZBUSS", "¿dónde queda ZBUSS?", "cómo llego a ZBUSS", escrito o
 * dictado): la dirección de operación si el vendedor la anotó (manda, y se dice), el domicilio fiscal de SUNAT con
 * "Según SUNAT al <fecha>" y el aviso de que puede no ser donde opera la flota, el estado de alerta si aplica, los locales
 * anexos (los del departamento de la flota primero y destacados; resumidos si son muchos) y el enlace de mapas.
 */
import { loadPortalConfig } from "../../config";
import { directionsLink, mapsUrl } from "../../match/company";
import type { SunatConfig } from "../../sunat/config";
import { AVISO_DOMICILIO_FISCAL, fechaSunat, sunatAviso } from "../../sunat/ubicacion";
import { foldPlace, lookupUbigeo, sameDepartamento } from "../../sunat/ubigeo";
import type { Company, PortalStore, SunatBrief, SunatLocal } from "../../store/types";
import { resolveCompany, splitCompany, unusedNote } from "../companies";
import { registerCompanyAction, registerPortalCommand, type PortalContext } from "../registry";

/** Locales con los del departamento de la empresa primero (el resto en su orden). */
export function localesOrdenados(locales: SunatLocal[], departamento: string | null): { local: SunatLocal; mismoDepartamento: boolean }[] {
  const tagged = locales.map((l) => ({ local: l, mismoDepartamento: !!departamento && sameDepartamento(l.departamento, departamento) }));
  return [...tagged.filter((t) => t.mismoDepartamento), ...tagged.filter((t) => !t.mismoDepartamento)];
}

/** "3 en Arequipa, 2 en Piura" de los locales que no se listan. */
function resumenPorDepartamento(rest: SunatLocal[]): string {
  const m = new Map<string, number>();
  for (const l of rest) {
    const dep = lookupUbigeo(l.ubigeo)?.departamento ?? (l.departamento ? foldPlace(l.departamento) : "sin ubigeo");
    m.set(dep, (m.get(dep) ?? 0) + 1);
  }
  return [...m]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "es"))
    .map(([d, n]) => `${n} en ${d}`)
    .join(", ");
}

/** Las líneas de la dirección para la ficha de `empresa` (una o dos). */
export function fichaDireccionLines(company: Company, sunat: SunatBrief | null, cfg: SunatConfig): string[] {
  const out: string[] = [];
  if (company.direccion) out.push(`📍 ${company.direccion} _(de operación)_`);
  else if (sunat?.direccion) out.push(`📍 ${sunat.direccion} _(domicilio fiscal, SUNAT al ${fechaSunat(sunat.fecha)})_`);
  const aviso = sunatAviso(sunat, { estados: cfg.estadosAlerta, condiciones: cfg.condicionesAlerta, condicionesAviso: cfg.condicionesAviso });
  if (aviso) out.push(`${aviso.nivel === "alerta" ? "⛔" : "⚠️"} SUNAT: ${aviso.texto}`);
  return out;
}

/** El mensaje de `direccion`. */
export async function direccionText(store: PortalStore, company: Company, cfg: SunatConfig = loadPortalConfig().sunat): Promise<string> {
  const sunat = await store.getSunat(company.ruc);
  const lines: string[] = [`📍 *${company.razonSocial}*`];
  if (company.direccion) lines.push(`Dirección de operación (la anotó el vendedor): ${company.direccion}`);
  if (sunat?.direccion) {
    lines.push(`Domicilio fiscal: ${sunat.direccion}`);
    lines.push(`_Según SUNAT al ${fechaSunat(sunat.fecha)}. ${AVISO_DOMICILIO_FISCAL}._`);
  } else if (sunat && !sunat.encontrado) {
    lines.push(`No aparece en el padrón de SUNAT al ${fechaSunat(sunat.fecha)}.`);
  } else {
    lines.push(sunat ? "SUNAT no tiene su domicilio fiscal (todo en blanco en el padrón)." : "No tengo su domicilio fiscal de SUNAT (aún no se importó el padrón para este RUC).");
  }
  if (sunat?.razonSocial) lines.push(`En SUNAT figura como: ${sunat.razonSocial}`);
  const aviso = sunatAviso(sunat, { estados: cfg.estadosAlerta, condiciones: cfg.condicionesAlerta, condicionesAviso: cfg.condicionesAviso });
  if (aviso) lines.push(`${aviso.nivel === "alerta" ? "⛔" : "⚠️"} SUNAT: ${aviso.texto}`);
  const link = directionsLink(company, sunat);
  lines.push(link.aproximada ? `Cómo llegar (búsqueda aproximada por nombre, sin dirección): ${link.url}` : `Cómo llegar: ${link.url}`);
  const locales = await store.listSunatLocales(company.ruc);
  if (locales.length) {
    lines.push("");
    lines.push(`Locales anexos (${locales.length}):`);
    const ordered = localesOrdenados(locales, company.departamento);
    const shown = ordered.slice(0, cfg.anexosEnBot);
    for (const { local, mismoDepartamento } of shown) {
      const dir = local.direccion ?? lookupUbigeo(local.ubigeo)?.distrito ?? "sin dirección";
      lines.push(`• ${dir}${mismoDepartamento ? ` — *en ${foldPlace(company.departamento)}*` : ""} ${mapsUrl(`${dir}, Perú`)}`);
    }
    const rest = ordered.slice(cfg.anexosEnBot).map((t) => t.local);
    if (rest.length) lines.push(`…y ${rest.length} más (${resumenPorDepartamento(rest)}). Todos en la ficha del portal.`);
  }
  return lines.join("\n");
}

async function show(ctx: PortalContext, company: Company, note = ""): Promise<void> {
  const body = await direccionText(ctx.store, company);
  await ctx.reply(`${note ? `${note}\n` : ""}${body}`);
}

registerCompanyAction("direccion", (ctx, company) => show(ctx, company));

registerPortalCommand("direccion", async (ctx, args) => {
  const split = await splitCompany(ctx.store, args.replace(/[?¿!¡.]+$/g, "").trim());
  const note = split ? unusedNote(split.rest) : "";
  const company = await resolveCompany(ctx, split?.query ?? args, "direccion", {}, { note });
  if (company) await show(ctx, company, note);
});
