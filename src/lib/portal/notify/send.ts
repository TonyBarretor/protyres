/**
 * Envío del resumen diario (bloque B6): a cada usuario activo vendedor/supervisor con algo que contar, por WhatsApp.
 *
 * WhatsApp solo deja mandar mensajes libres dentro de las 24 h desde el último mensaje del usuario (error 131047,
 * "Re-engagement message"). No se usan plantillas: si el envío falla por la ventana, se registra y el resumen queda como
 * aviso pendiente en el estado del portal del usuario; routePortal se lo muestra la próxima vez que escriba.
 *
 * Recordatorios de cotización: una vez entregado el resumen (o guardado como aviso pendiente) se registra cada uno con
 * recordQuoteFollowUp, una sola vez por cotización (no se vuelven a seleccionar). Con otro error no se registran: salen
 * de nuevo mañana.
 *
 * Un mismo día de Lima no se manda dos veces al mismo usuario (Vercel puede repetir la llamada al cron): se anota el día
 * en el estado del portal (`dailyDigestDay`); `force` lo ignora.
 *
 * Ojo: si Meta acepta el mensaje y lo rechaza después (llega como estado "failed" al webhook), aquí no se ve.
 */
import { isWindowError } from "../bot/commands/cita";
import { addNotice, type PortalConvState } from "../bot/state";
import { recordQuoteFollowUp } from "../quotes/reminders";
import type { PortalStore, PortalUser } from "../store/types";
import { limaDateKey } from "../ui/time";
import type { WhatsAppClient } from "../../whatsapp/client";
import { buildDailyDigest, type DigestOptions, type UserDay } from "./daily";

export const DIGEST_NOTICE_KIND = "resumen_diario";
const DAY_KEY = "dailyDigestDay";

export interface RunDailyDigestInput extends Omit<DigestOptions, "cache"> {
  store: PortalStore;
  /** Puede faltar con dryRun. */
  client?: Pick<WhatsAppClient, "sendText"> | null;
  now?: Date;
  /** true: no envía ni registra nada; devuelve los textos. */
  dryRun?: boolean;
  /** Manda aunque ya se haya mandado hoy. */
  force?: boolean;
  log?: (msg: string) => void;
}

export type DigestOutcome = "enviado" | "sin_nada" | "fuera_de_ventana" | "error" | "ya_enviado" | "simulado";

export interface DigestResult {
  userId: number;
  nombre: string;
  to: string;
  status: DigestOutcome;
  text?: string;
  error?: string;
}

export interface DailyDigestReport {
  enviados: number;
  sinNada: number;
  fueraDeVentana: number;
  errores: number;
  yaEnviados: number;
  dryRun: boolean;
  resultados: DigestResult[];
}

/** Destinatarios: activos, vendedor o supervisor, con WhatsApp. */
export function digestRecipients(users: PortalUser[]): PortalUser[] {
  return users.filter((u) => u.activo && (u.rol === "vendedor" || u.rol === "supervisor") && !!u.whatsapp);
}

async function markSent(store: PortalStore, phone: string, day: string): Promise<void> {
  const conv = await store.getPortalConversation(phone);
  await store.setPortalConversation(phone, { ...((conv?.state as PortalConvState) ?? {}), [DAY_KEY]: day });
}

export async function runDailyDigest(input: RunDailyDigestInput): Promise<DailyDigestReport> {
  const { store, dryRun = false, force = false } = input;
  const now = input.now ?? new Date();
  const log = input.log ?? (() => undefined);
  const day = limaDateKey(now);
  const cache = new Map<number, UserDay>();
  const report: DailyDigestReport = { enviados: 0, sinNada: 0, fueraDeVentana: 0, errores: 0, yaEnviados: 0, dryRun, resultados: [] };
  if (!dryRun && !input.client) throw new Error("runDailyDigest: falta el cliente de WhatsApp");
  const recorded = new Set<string>();

  for (const user of digestRecipients(await store.listUsers())) {
    const to = user.whatsapp!;
    const base = { userId: user.id, nombre: user.nombre, to };
    try {
      if (!dryRun && !force) {
        const state = (await store.getPortalConversation(to))?.state as PortalConvState | undefined;
        if (state?.[DAY_KEY] === day) {
          report.yaEnviados++;
          report.resultados.push({ ...base, status: "ya_enviado" });
          continue;
        }
      }
      const digest = await buildDailyDigest(store, user, now, { businessDays: input.businessDays, holidays: input.holidays, env: input.env, cache });
      if (!digest) {
        report.sinNada++;
        report.resultados.push({ ...base, status: "sin_nada" });
        continue;
      }
      if (dryRun) {
        report.resultados.push({ ...base, status: "simulado", text: digest.text });
        continue;
      }
      let status: DigestOutcome;
      try {
        await input.client!.sendText(to, digest.text);
        status = "enviado";
        report.enviados++;
      } catch (err) {
        if (!isWindowError(err)) throw err;
        log(`resumen diario: ${user.nombre} (${to}) fuera de la ventana de 24 h; queda como aviso pendiente`);
        await addNotice(store, to, { text: digest.text, createdAt: now.toISOString(), kind: DIGEST_NOTICE_KIND });
        status = "fuera_de_ventana";
        report.fueraDeVentana++;
      }
      report.resultados.push({ ...base, status, text: digest.text });
      // ya entregado (o guardado): un fallo al anotarlo se registra, pero no cuenta como error de envío
      try {
        for (const f of digest.followUps) {
          const key = `${f.opportunityId}:${f.quoteNumber}`;
          if (recorded.has(key)) continue;
          recorded.add(key);
          await recordQuoteFollowUp(store, f, now);
        }
        await markSent(store, to, day);
      } catch (err) {
        log(`resumen diario: enviado a ${user.nombre} (${to}) pero no pude anotarlo: ${(err as Error).message}`);
      }
    } catch (err) {
      const msg = (err as Error).message;
      log(`resumen diario: no pude enviar a ${user.nombre} (${to}): ${msg}`);
      report.errores++;
      report.resultados.push({ ...base, status: "error", error: msg });
    }
  }
  return report;
}
