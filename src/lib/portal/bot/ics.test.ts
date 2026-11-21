import { describe, expect, it } from "vitest";
import { buildIcs, escapeText, foldLine, icsLima, icsUtc, parseIcsLines } from "./ics";

const START = new Date("2026-11-17T15:00:00Z"); // martes 17/11 10:00 Lima
const STAMP = new Date("2026-11-11T14:03:07Z");

function sample(over: Partial<Parameters<typeof buildIcs>[0]> = {}): string {
  return buildIcs({
    uid: "cita-7-20999000011@portal.360tyres",
    start: START,
    durationMinutes: 60,
    summary: "Visita: TRANSPORTES ANDES DEL PERU S.A.C.",
    location: "Base de Ate, Av. Los Frutales 123; puerta 2",
    description: "Visita a TRANSPORTES ANDES DEL PERU S.A.C. (RUC 20999000011)\nContacto: Carlos Quispe (jefe de flota) · 987654321\nFicha: https://portal.example.pe/portal/empresas/1",
    url: "https://portal.example.pe/portal/empresas/1",
    stamp: STAMP,
    alarmMinutes: 30,
    ...over,
  });
}

/** Validación estructural mínima de RFC 5545 sobre el texto. */
function assertValid(ics: string): void {
  expect(ics.endsWith("\r\n")).toBe(true);
  expect(/[^\r]\n/.test(ics)).toBe(false); // solo CRLF
  for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
  const names = parseIcsLines(ics).map((l) => l.name);
  const stack: string[] = [];
  for (const l of parseIcsLines(ics)) {
    if (l.name === "BEGIN") stack.push(l.value);
    if (l.name === "END") expect(stack.pop()).toBe(l.value);
  }
  expect(stack).toEqual([]);
  expect(names[0]).toBe("BEGIN");
  for (const req of ["VERSION", "PRODID", "UID", "DTSTAMP", "DTSTART"]) expect(names).toContain(req);
}

describe("ics", () => {
  it("VCALENDAR/VEVENT válido con TZID America/Lima + VTIMEZONE", () => {
    const ics = sample();
    assertValid(ics);
    const lines = parseIcsLines(ics);
    const vevent = lines.slice(lines.findIndex((l) => l.name === "BEGIN" && l.value === "VEVENT"));
    const get = (n: string) => (["TZID", "TZOFFSETTO", "VERSION", "METHOD"].includes(n) ? lines : vevent).find((l) => l.name === n)!;
    expect(get("VERSION").value).toBe("2.0");
    expect(get("METHOD").value).toBe("PUBLISH");
    expect(lines.filter((l) => l.name === "BEGIN").map((l) => l.value)).toEqual(["VCALENDAR", "VTIMEZONE", "STANDARD", "VEVENT", "VALARM"]);
    expect(get("TZID").value).toBe("America/Lima");
    expect(get("TZOFFSETTO").value).toBe("-0500");
    expect(get("UID").value).toBe("cita-7-20999000011@portal.360tyres");
    expect(get("DTSTAMP").value).toBe("20261111T140307Z");
    expect(get("DTSTART")).toEqual({ name: "DTSTART", params: { TZID: "America/Lima" }, value: "20261117T100000" });
    expect(get("DTEND")).toEqual({ name: "DTEND", params: { TZID: "America/Lima" }, value: "20261117T110000" });
    expect(get("SUMMARY").value).toBe("Visita: TRANSPORTES ANDES DEL PERU S.A.C.");
    expect(get("LOCATION").value).toBe("Base de Ate, Av. Los Frutales 123; puerta 2");
    expect(get("DESCRIPTION").value).toContain("Contacto: Carlos Quispe (jefe de flota) · 987654321\nFicha: https://portal.example.pe/portal/empresas/1");
    expect(get("URL").value).toBe("https://portal.example.pe/portal/empresas/1");
    expect(get("TRIGGER").value).toBe("-PT30M");
  });

  it("duración configurable y sin aviso", () => {
    const ics = sample({ durationMinutes: 90, alarmMinutes: 0, location: null });
    assertValid(ics);
    const lines = parseIcsLines(ics);
    expect(lines.find((l) => l.name === "DTEND")!.value).toBe("20261117T113000");
    expect(lines.some((l) => l.name === "VALARM" || l.value === "VALARM")).toBe(false);
    expect(lines.some((l) => l.name === "LOCATION")).toBe(false);
  });

  it("UID estable: misma cita, mismo UID", () => {
    expect(sample()).toBe(sample());
  });

  it("escape de \\ ; , y saltos de línea", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const raw = sample();
    expect(raw).toContain("LOCATION:Base de Ate\\, Av. Los Frutales 123\\; puerta 2");
  });

  it("plegado a 75 octetos sin partir caracteres UTF-8", () => {
    const long = `DESCRIPTION:${"ñandú áéíóú ".repeat(20)}`;
    const folded = foldLine(long);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const [i, p] of parts.entries()) {
      expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(75);
      if (i > 0) expect(p.startsWith(" ")).toBe(true);
      expect(p.includes("�")).toBe(false);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(long);
    expect(foldLine("SHORT:x")).toBe("SHORT:x");
  });

  it("fechas: UTC y hora local de Lima", () => {
    expect(icsUtc(START)).toBe("20261117T150000Z");
    expect(icsLima(START)).toBe("20261117T100000");
    expect(icsLima(new Date("2027-01-01T03:30:00Z"))).toBe("20261231T223000");
  });
});

// corrida E, punto 3: un nombre de empresa o una nota con un CR suelto / caracteres de control no abre una línea nueva
describe("inyección en el .ics", () => {
  it("CR solo, U+2028 y controles no crean propiedades nuevas", () => {
    expect(escapeText("a\rEND:VEVENT")).toBe("a\\nEND:VEVENT");
    expect(escapeText("a b\u0000c\u0007d")).toBe("a\\nbcd");
    const ics = sample({ summary: "Visita: ACME\rATTENDEE:mailto:x@hacker.example\r\nEND:VEVENT", location: "Lima\u000bX" });
    const names = parseIcsLines(ics).map((l) => l.name);
    expect(names).not.toContain("ATTENDEE");
    expect(names.filter((n) => n === "END:VEVENT" || n === "END")).toHaveLength(names.filter((n) => n === "BEGIN").length);
    expect(ics.split("\r\n").some((l) => l.startsWith("ATTENDEE"))).toBe(false);
  });
});

// corrida J, punto 4: invitación por correo (iTIP, RFC 5546) que Outlook clásico muestra con Aceptar y guarda en su
// calendario local. Crear y reprogramar = METHOD:REQUEST con el mismo UID y SEQUENCE mayor; cancelar = METHOD:CANCEL.
describe("invitación iTIP (REQUEST / CANCEL)", () => {
  const ORGANIZER = { email: "citas@mail.example.pe", name: "360 Tyres · Citas" };
  const FRANK = { email: "frank@example.pe", name: "Frank Rodríguez" };
  const DANYER = { email: "danyer@example.pe", name: "Danyer Saavedra" };
  const vevent = (ics: string) => {
    const lines = parseIcsLines(ics);
    return lines.slice(lines.findIndex((l) => l.name === "BEGIN" && l.value === "VEVENT"));
  };
  const calProp = (ics: string, n: string) => parseIcsLines(ics).find((l) => l.name === n);

  it("crear: METHOD:REQUEST, ORGANIZER (el remitente del bot) y ATTENDEE por invitado interno", () => {
    const ics = sample({ method: "REQUEST", organizer: ORGANIZER, attendees: [FRANK, DANYER] });
    assertValid(ics);
    expect(calProp(ics, "METHOD")!.value).toBe("REQUEST");
    const ev = vevent(ics);
    expect(ev.find((l) => l.name === "ORGANIZER")).toEqual({ name: "ORGANIZER", params: { CN: "360 Tyres · Citas" }, value: "mailto:citas@mail.example.pe" });
    const att = ev.filter((l) => l.name === "ATTENDEE");
    expect(att.map((a) => a.value)).toEqual(["mailto:frank@example.pe", "mailto:danyer@example.pe"]);
    expect(att[0].params).toMatchObject({ CN: "Frank Rodríguez", ROLE: "REQ-PARTICIPANT", PARTSTAT: "NEEDS-ACTION", RSVP: "FALSE", CUTYPE: "INDIVIDUAL" });
    expect(ev.find((l) => l.name === "STATUS")!.value).toBe("CONFIRMED");
    expect(ev.find((l) => l.name === "SEQUENCE")!.value).toBe("0");
    expect(ev.find((l) => l.name === "UID")!.value).toBe("cita-7-20999000011@portal.360tyres");
    expect(ev.some((l) => l.name === "BEGIN" && l.value === "VALARM")).toBe(true);
  });

  it("reprogramar: mismo UID, SEQUENCE mayor, DTSTAMP nuevo, sigue siendo REQUEST", () => {
    const first = sample({ method: "REQUEST", organizer: ORGANIZER, attendees: [FRANK] });
    const later = new Date(START.getTime() + 2 * 86_400_000);
    const upd = sample({ method: "REQUEST", organizer: ORGANIZER, attendees: [FRANK], start: later, sequence: 61, stamp: new Date(STAMP.getTime() + 61_000) });
    assertValid(upd);
    const v = (ics: string, n: string) => vevent(ics).find((l) => l.name === n)!.value;
    expect(v(upd, "UID")).toBe(v(first, "UID"));
    expect(Number(v(upd, "SEQUENCE"))).toBeGreaterThan(Number(v(first, "SEQUENCE")));
    expect(v(upd, "DTSTAMP") > v(first, "DTSTAMP")).toBe(true);
    expect(v(upd, "DTSTART")).toBe("20261119T100000");
    expect(v(upd, "ORGANIZER")).toBe(v(first, "ORGANIZER")); // mismo organizador: Outlook actualiza, no duplica
    expect(calProp(upd, "METHOD")!.value).toBe("REQUEST");
  });

  it("cancelar: METHOD:CANCEL, STATUS:CANCELLED, mismo UID, ORGANIZER y ATTENDEE, sin alarma", () => {
    const ics = sample({ method: "CANCEL", organizer: ORGANIZER, attendees: [FRANK], sequence: 120 });
    assertValid(ics);
    expect(calProp(ics, "METHOD")!.value).toBe("CANCEL");
    const ev = vevent(ics);
    expect(ev.find((l) => l.name === "STATUS")!.value).toBe("CANCELLED");
    expect(ev.find((l) => l.name === "SEQUENCE")!.value).toBe("120");
    expect(ev.find((l) => l.name === "UID")!.value).toBe("cita-7-20999000011@portal.360tyres");
    expect(ev.find((l) => l.name === "ORGANIZER")!.value).toBe("mailto:citas@mail.example.pe");
    expect(ev.filter((l) => l.name === "ATTENDEE").map((a) => a.value)).toEqual(["mailto:frank@example.pe"]);
    expect(ev.some((l) => l.value === "VALARM")).toBe(false);
  });

  it("REQUEST/CANCEL sin organizador o sin invitados: error (Outlook no la trataría como reunión)", () => {
    expect(() => sample({ method: "REQUEST", attendees: [FRANK] })).toThrow(/ORGANIZER/);
    expect(() => sample({ method: "CANCEL", organizer: ORGANIZER, attendees: [] })).toThrow(/ATTENDEE/);
  });

  it("nombres y correos no inyectan parámetros ni líneas", () => {
    const ics = sample({
      method: "REQUEST",
      organizer: { email: "citas@mail.example.pe", name: 'Citas "360"; ROLE=CHAIR:x' },
      attendees: [{ email: "frank@example.pe", name: "Frank\r\nATTENDEE:mailto:x@hacker.example" }],
    });
    assertValid(ics);
    const ev = vevent(ics);
    expect(ev.filter((l) => l.name === "ATTENDEE")).toHaveLength(1);
    expect(ev.find((l) => l.name === "ORGANIZER")!.params).toEqual({ CN: "Citas 360 ROLE CHAIR x" });
    expect(() => sample({ method: "REQUEST", organizer: ORGANIZER, attendees: [{ email: "x@y.pe\r\nATTENDEE:mailto:z@h.example" }] })).toThrow(/correo/);
  });

  it("sin method sigue siendo el archivo de siempre (PUBLISH, sin ORGANIZER ni ATTENDEE)", () => {
    const ics = sample();
    expect(calProp(ics, "METHOD")!.value).toBe("PUBLISH");
    expect(parseIcsLines(ics).some((l) => l.name === "ORGANIZER" || l.name === "ATTENDEE")).toBe(false);
  });
});
