/**
 * Corrida J, punto 9: la placa de cada línea de la cotización contra la flota del padrón (fleet_vehicles).
 *
 *  - Si la placa está en la flota del cliente: una línea con el vehículo ("🚗 *ABC-123*: VOLVO · 2019 · 10 llantas").
 *  - Si es de otra empresa, o no está en el padrón: un aviso de una línea. Nunca bloquea: la placa queda como se escribió.
 *
 * El cliente se identifica como en la referencia de la última venta (link.ts): RUC escrito en el pedido, un cliente que
 * el vendedor ya enlazó antes o su razón social exacta. Sin cliente identificado, solo se dice de quién es la placa.
 * Solo para usuarios activos del portal; [] fuera del portal, sin placas o si el store falla (el cotizador sigue igual).
 */
import { shortName } from "../bot/companies";
import type { Company, FleetVehicle } from "../store/types";
import { companyByExactName, companyByRuc, customerKeyOf, previouslyLinked, rucsIn, safely, type HookOptions } from "./link";
import { plateKey } from "../../quote/line-refs";

/** Como mucho tantas placas por mensaje (una línea cada una). */
const MAX_PLATES = 6;

export interface PlateNotesInput extends HookOptions {
  from: string;
  /** El texto del pedido (para un RUC escrito en él). */
  text: string;
  customer: { company?: string; name?: string; email?: string; ref?: string };
  /** Placas normalizadas ("ABC-123"), en el orden de las líneas; las repetidas se dicen una vez. */
  plates: string[];
}

/** "VOLVO · 2019 · 10 llantas" (lo que se sepa). */
export function vehicleLine(v: Pick<FleetVehicle, "marca" | "anio" | "llantas">): string {
  return [v.marca?.trim().toUpperCase(), v.anio ? String(v.anio) : "", v.llantas ? `${v.llantas} llantas` : ""].filter(Boolean).join(" · ") || "sin datos del vehículo";
}

/** Las líneas para el vendedor (una por placa distinta), sin store: lo que encontró el padrón y el cliente. */
export function plateNotes(plates: string[], found: FleetVehicle[], customer: Company | null, owners: Map<number, Company>): string[] {
  const out: string[] = [];
  const unique = [...new Set(plates)].slice(0, MAX_PLATES);
  for (const plate of unique) {
    const hits = found.filter((v) => plateKey(v.placa) === plateKey(plate));
    const own = customer ? hits.find((v) => v.companyId === customer.id) : undefined;
    if (own) {
      out.push(`🚗 *${plate}*: ${vehicleLine(own)} (flota de ${shortName(customer!.razonSocial)})`);
      continue;
    }
    const other = hits[0];
    const owner = other ? owners.get(other.companyId) : undefined;
    if (other && customer) out.push(`⚠️ *${plate}* figura en la flota de *${owner ? shortName(owner.razonSocial) : "otra empresa"}*, no de ${shortName(customer.razonSocial)}: la dejo igual, revísala.`);
    else if (other) out.push(`🚗 *${plate}*: ${vehicleLine(other)} (flota de ${owner ? shortName(owner.razonSocial) : "otra empresa"})`);
    else if (customer) out.push(`⚠️ *${plate}* no está en la flota de ${shortName(customer.razonSocial)} en el padrón: la dejo igual, revísala.`);
    else out.push(`⚠️ *${plate}* no está en el padrón de flota: la dejo igual, revísala.`);
  }
  return out;
}

/** Las placas contra el padrón para el vendedor del portal (ver la cabecera). */
export async function portalPlateNotes(input: PlateNotesInput): Promise<string[]> {
  const plates = input.plates.filter(Boolean);
  if (!plates.length) return [];
  const out = await safely("contrastar las placas con el padrón", input.from, input, async (store, user) => {
    const rucs = rucsIn(input.text, input.customer.ref);
    const key = customerKeyOf({ company: input.customer.company, name: input.customer.name });
    const email = input.customer.email?.trim() || null;
    const customer = (await companyByRuc(store, rucs)) ?? (key || email ? await previouslyLinked(store, user.id, { key, email }) : null) ?? (await companyByExactName(store, input.customer.company ?? input.customer.name));
    const found = await store.findFleetByPlacas([...new Set(plates)].slice(0, MAX_PLATES));
    const owners = new Map<number, Company>();
    for (const id of new Set(found.map((v) => v.companyId))) {
      if (customer && id === customer.id) continue;
      const c = await store.getCompany(id);
      if (c) owners.set(id, c);
    }
    return plateNotes(plates, found, customer, owners);
  });
  return out ?? [];
}
