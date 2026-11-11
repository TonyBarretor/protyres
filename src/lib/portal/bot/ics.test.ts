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
