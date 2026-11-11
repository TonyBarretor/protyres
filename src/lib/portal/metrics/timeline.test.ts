import { describe, expect, it } from "vitest";
import { isAssignment, opportunityTimeline, type TimelineActivity, type TimelineHistory } from "./timeline";

const d = (s: string) => new Date(s);
const act = (tipo: string, at: string, extra: Partial<TimelineActivity> = {}): TimelineActivity => ({ tipo, texto: "", data: null, occurredAt: d(at), ...extra });

describe("opportunityTimeline", () => {
  const history: TimelineHistory[] = [
    { etapa: "prospecto", enteredAt: d("2026-11-01T15:00:00Z"), leftAt: d("2026-11-03T15:00:00Z") },
    { etapa: "cita_agendada", enteredAt: d("2026-11-03T15:00:00Z"), leftAt: d("2026-11-05T03:00:00Z") },
    { etapa: "visita_realizada", enteredAt: d("2026-11-05T03:00:00Z"), leftAt: null },
  ];
  const activities: TimelineActivity[] = [
    act("nota", "2026-11-01T15:00:00Z", { texto: "Frank se asignó la empresa.", data: { evento: "asignacion" } }),
    act("llamada", "2026-11-02T15:00:00Z"),
    act("llamada", "2026-11-04T15:00:00Z"),
    act("cita", "2026-11-03T15:00:00Z"),
    act("visita", "2026-11-04T15:00:00Z"),
  ];

  it("días por etapa (la abierta hasta ahora) y días desde la asignación a cada hito", () => {
    const t = opportunityTimeline(history, activities, d("2026-11-06T03:00:00Z"));
    expect(t.diasPorEtapa).toEqual({ prospecto: 2, cita_agendada: 1.5, visita_realizada: 1 });
    expect(t.asignacionAPrimeraLlamada).toBe(1);
    expect(t.asignacionACita).toBe(2);
    expect(t.asignacionAVisita).toBe(3); // la actividad de visita (occurred_at) es anterior a la entrada en la etapa
    expect(t.asignacionACotizacion).toBeNull();
    expect(t.hitos.primeraLlamada).toEqual(d("2026-11-02T15:00:00Z"));
  });

  it("cotización por historial; sin actividad de asignación se usa la primera etapa; reentradas suman", () => {
    const h: TimelineHistory[] = [
      { etapa: "prospecto", enteredAt: d("2026-11-01T00:00:00Z"), leftAt: d("2026-11-02T00:00:00Z") },
      { etapa: "cotizacion_enviada", enteredAt: d("2026-11-02T00:00:00Z"), leftAt: d("2026-11-03T00:00:00Z") },
      { etapa: "negociacion", enteredAt: d("2026-11-03T00:00:00Z"), leftAt: d("2026-11-04T00:00:00Z") },
      { etapa: "cotizacion_enviada", enteredAt: d("2026-11-04T00:00:00Z"), leftAt: d("2026-11-04T12:00:00Z") },
    ];
    const t = opportunityTimeline(h, []);
    expect(t.diasPorEtapa.cotizacion_enviada).toBe(1.5);
    expect(t.asignacionACotizacion).toBe(1);
    expect(t.asignacionAPrimeraLlamada).toBeNull();
  });

  it("reconoce la asignación del portal por el texto", () => {
    expect(isAssignment(act("nota", "2026-11-01T00:00:00Z", { texto: "Juan asignó la empresa a Frank." }))).toBe(true);
    expect(isAssignment(act("nota", "2026-11-01T00:00:00Z", { texto: "Nuevo contacto: Ana." }))).toBe(false);
  });
});
