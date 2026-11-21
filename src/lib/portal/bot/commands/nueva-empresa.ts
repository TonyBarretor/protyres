/**
 * `nueva empresa [datos]` (corrida J): alta de una empresa que no está en el padrón del MTC, por texto o por voz.
 *
 *  - Pide, una cosa a la vez, lo que falte de RUC (11 dígitos, validado con el dígito verificador), razón social, sector
 *    (botones Carga / Pasajeros / Mixto) y departamento; unidades y contacto son opcionales (se pueden escribir en el
 *    resumen: *15 unidades*, *contacto Juan Pérez, jefe de flota, 987654321*). Los datos pueden venir en el mismo mensaje
 *    (`nueva empresa 20600000013 Transportes Sol SAC, carga, Lima`) o dictados.
 *  - Si el RUC ya existe en el portal, muestra esa empresa en vez de duplicarla (y el flujo de origen sigue con ella).
 *  - Al confirmar (*Crear empresa*): origen "manual", asignada a quien la crea, oportunidad en Prospecto
 *    (companies/manual.ts).
 *  - Continuación: si se llegó desde "No encontré «X»" (*Crear empresa nueva*) en el reporte de visita, en `oc` o en
 *    `enlazar`, lo buscado entra como razón social (o RUC) y, creada la empresa, ese flujo sigue sin perder lo dictado.
 *    routePortal no deja en pausa esos pasos cuando llega este comando (offersNewCompany).
 *
 * Con el cotizador revisando una cotización ya guardada, ese paso se cierra (como `oc`); con una a medio armar, se pide
 * terminarla. Técnico: no crea empresas.
 */
import { createCompany, EMPTY_COMPANY, findRuc, formatNewCompany, matchDepartamento, matchSector, missingField, parseCompanyText, cleanRazonSocial, rucProblem, type CompanyField, type NewCompanyData } from "../../companies/manual";
import { isConfirmation, isRejection } from "../../report/draft";
import type { Company } from "../../store/types";
import { companyUrl, formatFicha, shortName } from "../companies";
import { freeQuoter, getCompanyAction, registerPausable, registerPendingHandler, registerPortalCommand, replyButtons, type PortalContext } from "../registry";
import { continueReportWithCompany, transcribeVoice } from "../report";
import { clearPending, getPending, setPending, type CompanyNotFoundStep, type PendingStep, type ReportDraftStep } from "../state";

export const NEW_COMPANY_STEP = "new_company";

/** Qué sigue después del alta: la acción por empresa de donde se vino (`oc`, `enlazar`…) o el reporte en borrador. */
export type NewCompanyThen = { kind: "action"; action: string; args: Record<string, unknown> } | { kind: "report"; step: ReportDraftStep };

/** El paso sin su fecha (lo que se guarda con setPending). */
export interface NewCompanyDraft {
  [key: string]: unknown;
  kind: typeof NEW_COMPANY_STEP;
  data: NewCompanyData;
  /** Lo que se preguntó (null = se mostró el resumen y se espera *Crear empresa* o una corrección). */
  field: CompanyField | null;
  then: NewCompanyThen | null;
  canal: "whatsapp" | "voz";
  /** Se pidió corregir: el texto siguiente es la corrección. */
  correcting?: boolean;
}

export type NewCompanyStep = PendingStep & NewCompanyDraft;

export const NEW_COMPANY_BUTTONS = [
  { id: "sí", title: "Crear empresa" },
  { id: "corregir", title: "Corregir" },
  { id: "no", title: "No crear" },
];
export const SECTOR_BUTTONS = [
  { id: "carga", title: "Carga" },
  { id: "pasajeros", title: "Pasajeros" },
  { id: "mixto", title: "Mixto" },
];

const QUESTION: Record<CompanyField, string> = {
  ruc: "¿Cuál es el *RUC*? (11 dígitos)",
  razonSocial: "¿Cuál es la *razón social*?",
  sector: "¿De qué *sector*? *Carga*, *pasajeros* o *mixto*.",
  departamento: "¿En qué *departamento*? (p. ej. Lima, Arequipa, La Libertad)",
};
const OPTIONAL_HINT = "_Opcional: escribe *15 unidades* o *contacto: Juan Pérez, jefe de flota, 987654321* para añadirlos._";
const CORRECT_PROMPT = "¿Qué corrijo? Escribe el dato: *RUC 20…*, *razón social …*, *sector carga*, *departamento Lima*, *15 unidades* o *contacto: …*.";
const CORRECT_WORD = /^(?:corregir|corrige|corrijo|quiero corregir)[.!]*$/i;
/** "créala", "sí, créala", "crear empresa", "dale, créala" (también dictado). */
const CREATE_WORDS = /^(?:(?:si|ok|dale|listo|ya)\s+)*(?:cr[eé]a(?:la|lo)?|cr[eé]ala|crear(?:la)?(?:\s+(?:la\s+)?empresa)?|registrala|reg[ií]strala|guardala)(?:\s+por\s+favor)?$/;

function confirmsCreate(text: string): boolean {
  if (isConfirmation(text)) return true;
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim();
  return CREATE_WORDS.test(t);
}

/** Lo buscado y no encontrado como dato inicial: un RUC, o la razón social. */
function seedFrom(query: string | null | undefined): Partial<NewCompanyData> {
  const q = (query ?? "").trim();
  if (!q) return {};
  const ruc = findRuc(q);
  if (ruc && q.replace(/[\s.-]/g, "") === ruc.ruc) return { ruc: ruc.ruc };
  const name = cleanRazonSocial(q);
  return /\p{L}{3}/u.test(name) ? { razonSocial: name } : {};
}

/** Une lo nuevo con lo que había (lo que no viene no se toca). */
function merge(d: NewCompanyData, p: Partial<NewCompanyData>): NewCompanyData {
  const out = { ...d };
  for (const [k, v] of Object.entries(p) as [keyof NewCompanyData, unknown][]) if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
  return out;
}

async function save(ctx: PortalContext, s: NewCompanyDraft): Promise<void> {
  await setPending(ctx.store, ctx.from, { ...s }, ctx.now);
}

/** La pregunta que toca, o el resumen con *Crear empresa* / *Corregir* / *No crear*. */
async function ask(ctx: PortalContext, s: NewCompanyDraft, head = ""): Promise<void> {
  const field = missingField(s.data);
  const next = { ...s, field, correcting: false };
  await save(ctx, next);
  const pre = head ? `${head}\n` : "";
  if (field === "sector") {
    const body = `${pre}${QUESTION.sector}`;
    await replyButtons(ctx, body, SECTOR_BUTTONS, { fallback: body });
    return;
  }
  if (field) {
    await ctx.reply(`${pre}${field === "ruc" && s.data.ruc ? `${rucProblem(s.data.ruc) ?? ""} ` : ""}${QUESTION[field]}`.trim());
    return;
  }
  const body = `${pre}*Empresa nueva* (no está en el padrón del MTC):\n${formatNewCompany(s.data)}\n\n${OPTIONAL_HINT}\n¿La creo?`;
  await replyButtons(ctx, body, NEW_COMPANY_BUTTONS, { fallback: `${body} Responde *sí*, *corregir* o *no*.` });
}

/** Sigue el flujo de origen con la empresa (creada o la que ya existía). */
async function continueWith(ctx: PortalContext, then: NewCompanyThen | null, company: Company): Promise<void> {
  if (!then) return;
  if (then.kind === "report") {
    await continueReportWithCompany(ctx, then.step, company, "Sigo con tu reporte:");
    return;
  }
  const handler = getCompanyAction(then.action);
  if (handler) await handler(ctx, company, then.args ?? {});
}

/** El RUC ya está en el portal: se muestra esa empresa (sin duplicar) y el flujo de origen sigue con ella. */
async function showExisting(ctx: PortalContext, company: Company, then: NewCompanyThen | null): Promise<void> {
  await clearPending(ctx.store, ctx.from);
  const ficha = await formatFicha(ctx.store, company, { full: false, env: ctx.env, now: ctx.now });
  await ctx.reply(`Ese RUC ya está en el portal: no la dupliqué.\n\n${ficha}`);
  await continueWith(ctx, then, company);
}

async function create(ctx: PortalContext, s: NewCompanyStep): Promise<void> {
  const r = await createCompany(ctx.store, ctx.user, s.data, { canal: s.canal, now: ctx.now, prices: null, log: ctx.log });
  if (!r.ok) {
    await ask(ctx, s, `⚠️ ${r.error}`);
    return;
  }
  if (!r.created) {
    await showExisting(ctx, r.company, s.then);
    return;
  }
  await clearPending(ctx.store, ctx.from);
  const c = r.company;
  const lines = [`✔ Empresa creada y asignada a ti: *${c.razonSocial}* (RUC ${c.ruc}).`, "• Oportunidad nueva en *Prospecto*"];
  if (s.data.contacto) lines.push(`• Contacto: ${s.data.contacto.nombre}${s.data.contacto.cargo ? ` (${s.data.contacto.cargo})` : ""}`);
  lines.push("_No está en el padrón del MTC: su flota no viene del MTC; puedes cargar sus vehículos a mano en la ficha._");
  lines.push(`Ficha: ${companyUrl(c.id, ctx.env)}`);
  await ctx.reply(lines.join("\n"));
  await ctx.store.flush();
  await continueWith(ctx, s.then, c);
}

/** RUC dado (11 dígitos): si ya existe en el portal, esa empresa (aunque no cuadre el dígito verificador); si no, null. */
async function existingByRuc(ctx: PortalContext, data: NewCompanyData): Promise<Company | null> {
  if (!data.ruc || !/^\d{11}$/.test(data.ruc)) return null;
  return ctx.store.getCompanyByRuc(data.ruc);
}

/** Empieza el alta (comando, botón *Crear empresa nueva* o dictado), siguiendo el paso en curso si la empresa no se encontró. */
export async function startNewCompany(ctx: PortalContext, args: string): Promise<void> {
  if (ctx.user.rol === "tecnico") {
    await ctx.reply("Tu rol no puede crear empresas. Pídeselo a un vendedor o al supervisor.");
    return;
  }
  const busy = await freeQuoter(ctx, "nueva empresa");
  if (busy) {
    await ctx.reply(busy);
    return;
  }
  const live = await getPending(ctx.store, ctx.from, ctx.now);
  let then: NewCompanyThen | null = null;
  let seed: Partial<NewCompanyData> = {};
  if (live && (live.kind === "company_not_found" || live.kind === "company_search")) {
    const nf = live as CompanyNotFoundStep;
    then = { kind: "action", action: nf.action, args: nf.args ?? {} };
    seed = seedFrom(nf.query);
  } else if (live?.kind === "report_draft" && (live as ReportDraftStep).draft && (live as ReportDraftStep).field === "empresa") {
    const rd = live as ReportDraftStep;
    then = { kind: "report", step: rd };
    seed = seedFrom(rd.notFound ?? rd.draft?.empresa?.ruc ?? rd.draft?.empresa?.nombre);
  }
  const canal = ctx.msg.type === "audio" ? "voz" : "whatsapp";
  const data = merge(merge({ ...EMPTY_COMPANY }, seed), parseCompanyText(args));
  const existing = await existingByRuc(ctx, data);
  if (existing) {
    await showExisting(ctx, existing, then);
    return;
  }
  const head = then ? "Creemos la empresa; luego sigo con lo que estabas haciendo." : "";
  await ask(ctx, { kind: NEW_COMPANY_STEP, data, field: null, then, canal }, head);
}

registerPortalCommand("nueva_empresa", startNewCompany);

/** Respuesta a una pregunta del alta, a *Crear empresa* / *Corregir* / *No crear*, o una corrección (también por voz). */
registerPendingHandler(NEW_COMPANY_STEP, async (ctx, step, rawText) => {
  const s = step as NewCompanyStep;
  let text = rawText.trim();
  if (ctx.msg.type === "audio" && ctx.msg.media) {
    const t = await transcribeVoice(ctx, { id: ctx.msg.media.id, mimeType: ctx.msg.media.mimeType });
    if (t === null) return true;
    text = t.trim().replace(/[.!?]+$/, "");
  }
  if (!text) return false;
  if (isRejection(text)) {
    await clearPending(ctx.store, ctx.from);
    if (s.then?.kind === "report") {
      await continueReportPending(ctx, s.then.step, "No creé la empresa.");
      return true;
    }
    await ctx.reply("Listo, no creé la empresa.");
    return true;
  }
  const field = s.field;
  if (!field && !s.correcting && confirmsCreate(text)) {
    await create(ctx, s);
    return true;
  }
  if (!field && CORRECT_WORD.test(text)) {
    await save(ctx, { ...s, correcting: true });
    await ctx.reply(CORRECT_PROMPT);
    return true;
  }
  let data = s.data;
  if (field === "ruc") {
    const r = findRuc(text);
    const digitsOnly = text.replace(/[\s.-]/g, "");
    const ruc = r?.ruc ?? (/^\d+$/.test(digitsOnly) ? digitsOnly : null);
    if (!ruc) {
      // un mensaje largo sin RUC es otra cosa (un reporte, un pedido): routePortal lo clasifica y el alta queda en pausa
      if (text.split(/\s+/).length > 4) return false;
      await ctx.reply(`No veo un RUC en «${text.slice(0, 60)}». ${QUESTION.ruc}`);
      return true;
    }
    data = merge(data, { ...parseCompanyText(text), ruc });
    const known = await existingByRuc(ctx, data);
    if (known) {
      await showExisting(ctx, known, s.then);
      return true;
    }
    const bad = rucProblem(ruc);
    if (bad) {
      await save(ctx, { ...s, data });
      await ctx.reply(`${bad} ${QUESTION.ruc}`);
      return true;
    }
  } else if (field === "razonSocial") {
    // la razón social es todo el texto ("Transportes de Carga Norte" no es sector carga)
    const name = cleanRazonSocial(text.replace(/^(?:la\s+)?(?:raz[oó]n\s+social|empresa|nombre)\s*:?\s+/i, ""));
    if (!/\p{L}{2}/u.test(name)) {
      await ctx.reply(QUESTION.razonSocial);
      return true;
    }
    data = { ...data, razonSocial: name };
  } else if (field === "sector") {
    const sector = matchSector(text);
    if (!sector) {
      const body = `No reconozco «${text.slice(0, 40)}» como sector. ${QUESTION.sector}`;
      await replyButtons(ctx, body, SECTOR_BUTTONS, { fallback: body });
      return true;
    }
    data = { ...data, sector };
  } else if (field === "departamento") {
    const dep = matchDepartamento(text) ?? parseCompanyText(text).departamento ?? null;
    if (!dep) {
      await ctx.reply(`No reconozco «${text.slice(0, 40)}» como departamento. ${QUESTION.departamento}`);
      return true;
    }
    data = { ...data, departamento: dep };
  } else {
    // resumen a la vista: una corrección o un dato opcional
    const named = /^(?:la\s+)?(?:raz[oó]n\s+social|nombre)\s*:?\s+(.+)$/i.exec(text);
    if (named) data = { ...data, razonSocial: cleanRazonSocial(named[1]) };
    else {
      const p = parseCompanyText(text);
      const { razonSocial, ...rest } = p;
      const others = Object.values(rest).some((v) => v !== undefined);
      if (others) data = merge(data, rest);
      else if (razonSocial && s.correcting) data = { ...data, razonSocial };
      else if (confirmsCreate(text) && s.correcting) {
        await create(ctx, s);
        return true;
      } else {
        await ctx.reply(`No entendí «${text.slice(0, 60)}». ${CORRECT_PROMPT}`);
        return true;
      }
    }
  }
  const existing = data.ruc !== s.data.ruc ? await existingByRuc(ctx, data) : null;
  if (existing) {
    await showExisting(ctx, existing, s.then);
    return true;
  }
  await ask(ctx, { ...s, data });
  return true;
});

/** El reporte de donde se vino vuelve a quedar pendiente con su pregunta de la empresa. */
async function continueReportPending(ctx: PortalContext, step: ReportDraftStep, head: string): Promise<void> {
  const { createdAt: _c, ...rest } = step;
  await setPending(ctx.store, ctx.from, { ...rest, notFound: null }, ctx.now);
  await ctx.reply(`${head} Sigo con tu reporte: ¿con qué empresa fue? Escribe el nombre o el RUC.`);
}

/** Qué falta, para el recordatorio de la pausa. */
const FIELD_LABEL: Record<CompanyField, string> = { ruc: "falta el RUC", razonSocial: "falta la razón social", sector: "falta el sector", departamento: "falta el departamento" };

registerPausable(NEW_COMPANY_STEP, {
  async describe(_ctx, step) {
    const s = step as NewCompanyStep;
    const name = s.data.razonSocial ? ` ${shortName(s.data.razonSocial)}` : "";
    return { companyId: null, label: `alta de la empresa${name}`, missing: s.field ? FIELD_LABEL[s.field] : "falta confirmar" };
  },
  async resume(ctx, step, prefix) {
    const { createdAt: _c, ...s } = step as NewCompanyStep;
    await ask(ctx, s, prefix);
  },
});
