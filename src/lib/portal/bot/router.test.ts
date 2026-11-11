import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyIntent, isCancel, isQuoterCommand, mediaAccepted, parsePortalCommand, type ClassifyInput } from "./router";

const user = (text: string, extra: Partial<ClassifyInput> = {}): ClassifyInput => ({ text, state: { step: "idle" }, isPortalUser: true, ...extra });
const stranger = (text: string, extra: Partial<ClassifyInput> = {}): ClassifyInput => ({ text, state: { step: "idle" }, isPortalUser: false, ...extra });

/** Todos los textos que handler.test.ts manda al cotizador. */
function handlerTestTexts(): string[] {
  const src = fs.readFileSync(path.resolve(process.cwd(), "src/lib/whatsapp/handler.test.ts"), "utf8");
  return [...new Set([...src.matchAll(/text\("((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string))];
}

const QUOTE_STEPS = ["choose", "need_provider", "review_quote", "need_email", "need_fields", "need_application", "confirm_new", "profile"];

describe("parsePortalCommand", () => {
  it("reconoce los comandos al inicio, sin importar mayúsculas ni tildes", () => {
    expect(parsePortalCommand("Pórtal")).toEqual({ name: "portal", args: "" });
    expect(parsePortalCommand("EMPRESA zbuss sac")).toEqual({ name: "empresa", args: "zbuss sac" });
    expect(parsePortalCommand("asignarme 20602221505")).toEqual({ name: "asignarme", args: "20602221505" });
    expect(parsePortalCommand("Asígnarme Movil Bus")?.name).toBe("asignarme");
    expect(parsePortalCommand("contacto ZBUSS: Juan, jefe, 999888777")).toEqual({ name: "contacto", args: "ZBUSS: Juan, jefe, 999888777" });
    expect(parsePortalCommand("hoy")?.name).toBe("hoy");
    expect(parsePortalCommand("Hoy")?.name).toBe("hoy");
    expect(parsePortalCommand("ayuda portal")?.name).toBe("ayuda_portal");
    expect(parsePortalCommand("cita zbuss martes 10am")?.name).toBe("cita");
    expect(parsePortalCommand("OC zbuss 4500123")).toEqual({ name: "oc", args: "zbuss 4500123" });
    expect(parsePortalCommand("oc")?.name).toBe("oc");
    expect(parsePortalCommand("avance")?.name).toBe("avance");
    expect(parsePortalCommand("prepropuesta zbuss")?.name).toBe("prepropuesta");
    expect(parsePortalCommand("pre-propuesta zbuss")?.args).toBe("zbuss");
    expect(parsePortalCommand("aprende flama = Flama 77")).toEqual({ name: "aprende", args: "flama = Flama 77" });
  });

  it("no confunde campos ni textos del cotizador", () => {
    expect(parsePortalCommand("empresa: Transportes ABC")).toBeNull(); // línea de campo del cotizador
    expect(parsePortalCommand("contacto: Juan")).toBeNull();
    expect(parsePortalCommand("portal de clientes")).toBeNull();
    expect(parsePortalCommand("ayuda")).toBeNull();
    expect(parsePortalCommand("empresa")).toBeNull();
    expect(parsePortalCommand("hoy me pidieron 295/80R22.5 x4")).toBeNull();
    expect(parsePortalCommand("aprende algo")).toBeNull(); // sin "X = Y"
    expect(parsePortalCommand("ocho llantas")).toBeNull();
    expect(parsePortalCommand("cotizaciones")).toBeNull();
  });

  it("un comando es de una sola línea, sin medida de llanta ni forma de campo del cotizador", () => {
    expect(parsePortalCommand("Empresa Transportes ABC\n295/80R22.5 x4 Fenixway")).toBeNull();
    expect(parsePortalCommand("Contacto Juan Perez 987654321\n11R22.5 x4")).toBeNull();
    expect(parsePortalCommand("OC 4500123 Transportes ABC 295/80R22.5 x8 a 254")).toBeNull();
    expect(parsePortalCommand("contacto de: Juan")).toBeNull();
    expect(parsePortalCommand("Empresa del: ACME")).toBeNull();
    expect(parsePortalCommand("empresa zbuss\nhoy")).toBeNull();
    // los de siempre siguen siendo comandos
    expect(parsePortalCommand("contacto zbuss: Carlos Quispe, jefe de flota, 987 654 321")?.name).toBe("contacto");
    expect(parsePortalCommand("contacto de transportes abc: Juan")?.name).toBe("contacto");
    expect(parsePortalCommand("empresa 20602221505")?.name).toBe("empresa");
    expect(parsePortalCommand("oc zbuss 4500123")?.name).toBe("oc");
    // por el router: un pedido de varias líneas que empieza con "Empresa …" es una cotización
    expect(classifyIntent(user("Empresa Transportes ABC\n295/80R22.5 x4 Fenixway"))).toBe("quote");
    expect(classifyIntent(user("Contacto Juan Perez 987654321\n11R22.5 x4"))).toBe("quote");
    expect(classifyIntent(user("OC 4500123 Transportes ABC 295/80R22.5 x8 a 254"))).toBe("quote");
    expect(classifyIntent(stranger("Empresa Transportes ABC\n295/80R22.5 x4"))).toBe("quote");
  });

  it("con adjunto solo valen los comandos que lo aceptan (oc), con la leyenda de una línea", () => {
    expect(parsePortalCommand("oc zbuss 123", { withMedia: true })?.name).toBe("oc");
    expect(parsePortalCommand("OC 4500123 Transportes ABC", { withMedia: true })?.name).toBe("oc");
    expect(parsePortalCommand("oc zbuss 123\n295/80R22.5 x8", { withMedia: true })).toBeNull();
    expect(parsePortalCommand("empresa zbuss", { withMedia: true })).toBeNull();
  });
});

describe("classifyIntent", () => {
  it("comandos explícitos -> portal_command, aun con el cotizador a mitad de un flujo", () => {
    expect(classifyIntent(user("empresa zbuss"))).toBe("portal_command");
    expect(classifyIntent(user("hoy", { state: { step: "review_quote" } }))).toBe("portal_command");
    expect(classifyIntent(user("asignarme 20602221505", { state: "choose", pendingPortalStep: { kind: "choose_company" } }))).toBe("portal_command");
  });

  it("un número no registrado nunca entra al portal salvo con `portal`", () => {
    expect(classifyIntent(stranger("portal"))).toBe("portal_command");
    for (const t of ["empresa zbuss", "asignarme 20602221505", "hoy", "ayuda portal", "contacto zbuss: Juan, 999888777", "visité ZBUSS y hablé con el gerente", "llamé al jefe de flota"]) {
      expect(["quote", "passthrough"]).toContain(classifyIntent(stranger(t)));
    }
    expect(classifyIntent(stranger("", { hasMedia: true, mediaType: "audio" }))).toBe("passthrough");
    expect(classifyIntent(stranger("1", { pendingPortalStep: { kind: "choose_company" } }))).toBe("passthrough");
  });

  it("los mensajes de cotización de los tests del handler siguen al cotizador", () => {
    const texts = handlerTestTexts();
    expect(texts.length).toBeGreaterThan(100);
    for (const t of texts) {
      expect([t, classifyIntent(user(t))]).toEqual([t, expect.stringMatching(/^(quote|passthrough)$/)]);
      expect([t, classifyIntent(stranger(t))]).toEqual([t, expect.stringMatching(/^(quote|passthrough)$/)]);
    }
    expect(classifyIntent(user("Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com"))).toBe("quote");
    expect(classifyIntent(user("FALKEN 295/80R22.5 MIXTA X 6, MARGEN 10% CLIENTE MOVIL BUS S.A.C. , ATENCION A: SR. JONATAHAN MATTA, DIRECCION: LIMA"))).toBe("quote");
  });

  it("con el cotizador a mitad de un flujo todo lo que no es comando del portal va al cotizador", () => {
    for (const step of QUOTE_STEPS) {
      for (const t of ["sí", "si", "ok", "1b", "2", "enviar", "dale", "listo", "precio 480", "visité ZBUSS y hablé con el gerente", "Juan Pérez"]) {
        expect([step, t, classifyIntent(user(t, { state: { step } }))]).toEqual([step, t, "passthrough"]);
      }
    }
    // sí/ok en review_quote: cotizador aunque haya un paso del portal guardado
    expect(classifyIntent(user("sí", { state: "review_quote", pendingPortalStep: { kind: "report_confirm" } }))).toBe("passthrough");
    expect(classifyIntent(user("ok", { state: "review_quote", pendingPortalStep: "intent_choice" }))).toBe("passthrough");
  });

  it("cancelar siempre va al cotizador (quien llama limpia el paso del portal)", () => {
    expect(isCancel("Cancelar")).toBe(true);
    expect(classifyIntent(user("cancelar", { pendingPortalStep: { kind: "choose_company" } }))).toBe("passthrough");
    expect(classifyIntent(user("salir", { state: "review_quote" }))).toBe("passthrough");
  });

  it("paso pendiente del portal (cotizador idle): respuestas cortas al portal; pedidos y comandos del cotizador no", () => {
    const p = { kind: "choose_company" };
    for (const t of ["2", "la 3", "sí", "no", "ok", "cotización", "reporte", "fue con el gerente"]) {
      expect([t, classifyIntent(user(t, { pendingPortalStep: p }))]).toEqual([t, "portal_flow"]);
    }
    expect(classifyIntent(user("Michelin 11R22.5 XZE2+ x4 para Transportes ABC, juan@abc.com", { pendingPortalStep: p }))).toBe("quote");
    expect(classifyIntent(user("295/80R22.5", { pendingPortalStep: p }))).toBe("quote");
    expect(classifyIntent(user("proveedores", { pendingPortalStep: p }))).toBe("passthrough");
    expect(classifyIntent(user("ayuda", { pendingPortalStep: p }))).toBe("passthrough");
    expect(isQuoterCommand("cotizaciones Prosegur")).toBe(true);
  });

  it("idle: reporte, cotización o ambiguo según las señales", () => {
    expect(classifyIntent(user("Visité ZBUSS, me atendió el jefe de flota, quedamos en llamar el lunes"))).toBe("report");
    expect(classifyIntent(user("llamé a Juan de Transportes ABC, dice que mañana confirma"))).toBe("report");
    expect(classifyIntent(user("me reuní con el gerente de Movil Bus"))).toBe("report");
    expect(classifyIntent(user("el gerente está interesado en Fenixway"))).toBe("ambiguous"); // reporte débil + marca
    expect(classifyIntent(user("el jefe de mantenimiento no contestó"))).toBe("report");
    expect(classifyIntent(user("Visité Transportes ABC, necesitan 295/80R22.5 x4"))).toBe("ambiguous");
    expect(classifyIntent(user("hablé con compras, cotízame 11R22.5 x10 para ZBUSS"))).toBe("ambiguous");
    expect(classifyIntent(user("295/80R22.5 x4 para ABC, el gerente dice que urge"))).toBe("quote"); // reporte débil no basta
    // la palabra "cotización" sola, con un verbo de reporte, es un reporte; con medida, cantidad o correo sigue ambiguo
    expect(classifyIntent(user("Visité ZBUSS, quedamos en mandarle la cotización el jueves"))).toBe("report");
    expect(classifyIntent(user("Llamé a ZBUSS, mándales cotización a compras@zbuss.pe"))).toBe("ambiguous");
    expect(classifyIntent(user("cotización para ZBUSS"))).toBe("quote");
    expect(classifyIntent(stranger("Visité ZBUSS, quedamos en mandarle la cotización el jueves"))).toBe("quote");
    expect(classifyIntent(user("ZBUSS"))).toBe("passthrough");
    expect(classifyIntent(user("ZBUSS", { mentionsKnownCompany: true }))).toBe("report");
    expect(classifyIntent(user("ZBUSS quiere Fenixway", { mentionsKnownCompany: true }))).toBe("ambiguous");
    expect(classifyIntent(user("gracias"))).toBe("passthrough");
    expect(classifyIntent(user("hola"))).toBe("passthrough");
    expect(classifyIntent(user(""))).toBe("passthrough");
    // un no usuario con las mismas palabras: cotizador
    expect(classifyIntent(stranger("Visité Transportes ABC, necesitan 295/80R22.5 x4"))).toBe("quote");
    expect(classifyIntent(stranger("ZBUSS", { mentionsKnownCompany: true }))).toBe("passthrough");
  });

  it("audio: reporte para usuarios del portal; cotizador (no leo audios) para otros; otros adjuntos al cotizador", () => {
    expect(classifyIntent(user("", { hasMedia: true, mediaType: "audio" }))).toBe("report");
    // con el cotizador a mitad de un flujo la nota de voz es del cotizador (el "sí" siguiente no confirma un borrador)
    for (const step of QUOTE_STEPS) expect([step, classifyIntent(user("", { hasMedia: true, mediaType: "audio", state: step }))]).toEqual([step, "passthrough"]);
    expect(classifyIntent(user("", { hasMedia: true, mediaType: "audio", state: "review_quote", pendingPortalStep: { kind: "report_draft" } }))).toBe("passthrough");
    expect(classifyIntent(user("", { hasMedia: true, mediaType: "audio", pendingPortalStep: { kind: "order_question" } }))).toBe("portal_flow");
    expect(classifyIntent(stranger("", { hasMedia: true, mediaType: "audio" }))).toBe("passthrough");
    expect(classifyIntent(user("lista de precios", { hasMedia: true, mediaType: "document" }))).toBe("passthrough");
    expect(classifyIntent(user("foto Michelin XZE2+", { hasMedia: true, mediaType: "image" }))).toBe("passthrough");
    expect(classifyIntent(user("oc zbuss 4500123", { hasMedia: true, mediaType: "document" }))).toBe("portal_command");
  });

  it("pasos del pedido de oc: captureText (ítems) y keepText (preguntas)", () => {
    const items = { kind: "oc_pedido", captureText: true, keepText: false };
    const questions = { kind: "oc_pedido", captureText: false, keepText: true };
    // ítems: todo es del paso, salvo los comandos del cotizador
    expect(classifyIntent(user("8 x Fenixway Flama 77 315/80R22.5 a 254", { pendingPortalStep: items }))).toBe("portal_flow");
    expect(classifyIntent(user("proveedores", { pendingPortalStep: items }))).toBe("passthrough");
    expect(classifyIntent(user("ayuda", { pendingPortalStep: items }))).toBe("passthrough");
    // preguntas: las respuestas son del paso aunque parezcan campos; una medida es un pedido nuevo
    for (const t of ["entrega: Av. Nueva 500, Callao", "360, 20 soles x llanta", "48 h post OC", "sí", "igual", "Andeskar, Luis Pérez 987 654 321"]) {
      expect([t, classifyIntent(user(t, { pendingPortalStep: questions }))]).toEqual([t, "portal_flow"]);
    }
    expect(classifyIntent(user("Fenixway 295/80R22.5 x4 para Transportes ABC", { pendingPortalStep: questions }))).toBe("quote");
    expect(classifyIntent(user("11R22.5", { pendingPortalStep: questions }))).toBe("quote");
    expect(classifyIntent(user("proveedores", { pendingPortalStep: questions }))).toBe("passthrough");
    expect(classifyIntent(user("ayuda", { pendingPortalStep: questions }))).toBe("passthrough");
  });

  it("adjuntos para un paso pendiente: dentro de mediaUntil y sin leyenda de otra cosa", () => {
    const now = new Date("2026-11-11T15:00:00Z");
    const step = { kind: "oc_pedido", acceptsMedia: true, mediaUntil: "2026-11-11T15:05:00Z" };
    const doc = (text: string, extra: Partial<ClassifyInput> = {}) => user(text, { hasMedia: true, mediaType: "document", pendingPortalStep: step, now, ...extra });
    expect(classifyIntent(doc(""))).toBe("portal_flow");
    expect(classifyIntent(doc("la OC firmada"))).toBe("portal_flow");
    expect(classifyIntent(doc("orden de compra"))).toBe("portal_flow");
    expect(classifyIntent(doc("foto Michelin XZE2+", { mediaType: "image" }))).toBe("passthrough");
    expect(classifyIntent(doc("lista de precios Llantas del Sur"))).toBe("passthrough");
    expect(classifyIntent(doc("", { now: new Date("2026-11-11T15:06:00Z") }))).toBe("passthrough"); // pasados los 10 min
    expect(classifyIntent(doc("", { state: "review_quote" }))).toBe("passthrough");
    expect(mediaAccepted({ kind: "x", acceptsMedia: true }, "", now)).toBe(true); // sin mediaUntil: sin límite
    expect(mediaAccepted({ kind: "x" }, "", now)).toBe(false);
  });

  it("mensajes reenviados: siempre al cotizador", () => {
    expect(classifyIntent(user("visité ZBUSS", { forwarded: true }))).toBe("passthrough");
    expect(classifyIntent(user("empresa zbuss", { forwarded: true }))).toBe("passthrough");
  });
});
