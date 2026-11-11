import { describe, expect, it } from "vitest";
import { atLimaTime, formatCitaDate, parseSpanishDateTime, parseTimeOfDay } from "./dates";

// miércoles 11/11/2026 09:00 en Lima (14:00 UTC)
const NOW = new Date("2026-11-11T14:00:00Z");

/** "AAAA-MM-DD HH:mm" en hora de Lima. */
function lima(d: Date): string {
  return new Date(d.getTime() - 5 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
}

function p(text: string, now = NOW) {
  const r = parseSpanishDateTime(text, now);
  return r ? { at: lima(r.date), text: r.text, allDay: !!r.allDay, timeOnly: !!r.timeOnly, before: r.before, after: r.after, rest: r.rest } : null;
}

describe("parseSpanishDateTime", () => {
  it.each([
    ["martes 10am", "2026-11-17 10:00"],
    ["el martes a las 10", "2026-11-17 10:00"],
    ["mañana 3pm", "2026-11-12 15:00"],
    ["manana 3 pm", "2026-11-12 15:00"],
    ["pasado mañana 9:30", "2026-11-13 09:30"],
    ["hoy 16:00", "2026-11-11 16:00"],
    ["15/11 9:00", "2026-11-15 09:00"],
    ["15/11/2026 9h", "2026-11-15 09:00"],
    ["15-11-26 9h30", "2026-11-15 09:30"],
    ["15 de noviembre 10 am", "2026-11-15 10:00"],
    ["15 nov 10:00", "2026-11-15 10:00"],
    ["lunes 3 y media", "2026-11-16 15:30"],
    ["lunes 10 y cuarto", "2026-11-16 10:15"],
    ["viernes al mediodía", "2026-11-13 12:00"],
    ["Viernes al Mediodia", "2026-11-13 12:00"],
    ["jueves 4 de la tarde", "2026-11-12 16:00"],
    ["jueves 8 de la noche", "2026-11-12 20:00"],
    ["sábado 9 de la mañana", "2026-11-14 09:00"],
    ["a las 10 el jueves", "2026-11-12 10:00"],
    ["10 de la mañana del viernes", "2026-11-13 10:00"],
    ["el próximo lunes 11:00", "2026-11-16 11:00"],
    ["miércoles 10", "2026-11-18 10:00"], // hoy es miércoles -> el de la semana siguiente
    ["hoy a las 5", "2026-11-11 17:00"], // 1..6 sin am/pm -> tarde
    ["mañana 12am", "2026-11-12 00:00"],
    ["mañana 12pm", "2026-11-12 12:00"],
    ["martes 10 a.m.", "2026-11-17 10:00"],
    ["martes 3 p. m.", "2026-11-17 15:00"],
    ["martes 18/11 10am", "2026-11-18 10:00"], // la fecha explícita manda sobre el día de semana
  ])("%s -> %s", (text, at) => {
    expect(p(text)?.at).toBe(at);
  });

  it("solo hora: hoy si no pasó, si no mañana", () => {
    expect(p("10:30 am")).toMatchObject({ at: "2026-11-11 10:30", timeOnly: true });
    expect(p("3pm")).toMatchObject({ at: "2026-11-11 15:00", timeOnly: true });
    expect(p("8am")).toMatchObject({ at: "2026-11-12 08:00", timeOnly: true });
    expect(p("9:00")).toMatchObject({ at: "2026-11-12 09:00" }); // exactamente ahora ya pasó
    expect(p("a las 10")).toMatchObject({ at: "2026-11-11 10:00" });
  });

  it("día de semana = el próximo (hoy solo si dice hoy)", () => {
    expect(p("miércoles 10am")?.at).toBe("2026-11-18 10:00");
    expect(p("jueves 10am")?.at).toBe("2026-11-12 10:00");
    expect(p("domingo 10am")?.at).toBe("2026-11-15 10:00");
    expect(p("martes 10am")?.at).toBe("2026-11-17 10:00");
    expect(p("hoy 10am")?.at).toBe("2026-11-11 10:00");
  });

  it("fechas sin año: la próxima ocurrencia; con año: tal cual", () => {
    expect(p("9 de enero 11:00")?.at).toBe("2027-01-09 11:00");
    expect(p("10/11 10am")?.at).toBe("2027-11-10 10:00"); // ayer -> el año siguiente
    expect(p("11/11 10am")?.at).toBe("2026-11-11 10:00"); // hoy sigue siendo hoy
    expect(p("10/11/2026 10am")?.at).toBe("2026-11-10 10:00");
    expect(p("29/02 10am")?.at).toBe("2028-02-29 10:00");
    expect(p("1 de enero de 2027 9am")?.at).toBe("2027-01-01 09:00");
  });

  it("fin de año y medianoche de Lima (servidor en UTC)", () => {
    const dic31Night = new Date("2027-01-01T03:30:00Z"); // 31/12/2026 22:30 Lima, ya 1/1 en UTC
    expect(p("mañana 9am", dic31Night)?.at).toBe("2027-01-01 09:00");
    expect(p("hoy 23:00", dic31Night)?.at).toBe("2026-12-31 23:00");
    expect(p("viernes 10am", dic31Night)?.at).toBe("2027-01-01 10:00"); // 31/12/2026 es jueves
    expect(p("5/1 10am", dic31Night)?.at).toBe("2027-01-05 10:00");
  });

  it("sin hora -> allDay (medianoche de Lima) para que se pida la hora", () => {
    expect(p("martes")).toMatchObject({ at: "2026-11-17 00:00", allDay: true });
    expect(p("15 de noviembre")).toMatchObject({ at: "2026-11-15 00:00", allDay: true });
    expect(p("mañana")).toMatchObject({ at: "2026-11-12 00:00", allDay: true });
    const r = parseSpanishDateTime("martes", NOW)!;
    expect(r.date.toISOString()).toBe("2026-11-17T05:00:00.000Z");
  });

  it("separa lo consumido del resto del texto", () => {
    expect(p("zbuss martes 10am en su base de Ate")).toMatchObject({ text: "martes 10am", before: "zbuss", after: "en su base de Ate", rest: "zbuss en su base de Ate" });
    expect(p("Transportes Andes el martes a las 10, en Lurín")).toMatchObject({ text: "el martes a las 10", before: "Transportes Andes", after: ", en Lurín" });
    expect(p("andes martes en su base 10am")).toMatchObject({ at: "2026-11-17 10:00", text: "martes 10am", before: "andes", after: "en su base" });
    expect(p("ZBUSS mañana 3pm")).toMatchObject({ text: "mañana 3pm", before: "ZBUSS", after: "" });
  });

  it("no confunde RUC, teléfonos ni números sueltos con fechas", () => {
    expect(p("20602221505 martes 10am")).toMatchObject({ before: "20602221505", at: "2026-11-17 10:00" });
    expect(p("transportes 2000 jueves 9am")).toMatchObject({ before: "transportes 2000", at: "2026-11-12 09:00" });
    expect(p("andes 987-654-321")).toBeNull();
    expect(p("andes")).toBeNull();
    expect(p("andes 10")).toBeNull(); // número suelto sin día no es hora
    expect(p("")).toBeNull();
  });

  it("fechas u horas imposibles -> null", () => {
    expect(p("31/02 10am")).toBeNull();
    expect(p("31 de abril 10am")).toBeNull();
    expect(p("martes 25:00")?.allDay).toBe(true); // hora imposible: queda el día y se pide la hora
  });
});

describe("parseTimeOfDay", () => {
  it("solo hora, el texto entero", () => {
    expect(parseTimeOfDay("10")).toEqual({ hour: 10, minute: 0 });
    expect(parseTimeOfDay("10am")).toEqual({ hour: 10, minute: 0 });
    expect(parseTimeOfDay("a las 3 y media")).toEqual({ hour: 15, minute: 30 });
    expect(parseTimeOfDay("15:30")).toEqual({ hour: 15, minute: 30 });
    expect(parseTimeOfDay("mediodía")).toEqual({ hour: 12, minute: 0 });
    expect(parseTimeOfDay("9h")).toEqual({ hour: 9, minute: 0 });
    expect(parseTimeOfDay("10am con Carlos")).toBeNull();
    expect(parseTimeOfDay("sí")).toBeNull();
  });

  it("atLimaTime y formatCitaDate", () => {
    const d = atLimaTime(new Date("2026-11-17T05:00:00Z"), { hour: 10, minute: 0 });
    expect(d.toISOString()).toBe("2026-11-17T15:00:00.000Z");
    expect(formatCitaDate(d)).toBe("martes 17/11 10:00");
    expect(formatCitaDate(new Date("2026-11-18T05:00:00Z"), true)).toBe("miércoles 18/11");
  });
});
