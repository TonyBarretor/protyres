/**
 * Enlaces "Agregar a Outlook web" y "Agregar a Google Calendar" (corrida J, punto 4): opcionales y apagados por defecto,
 * por usuario (`users.calendar_links`), para quien sí tenga calendario en la nube. No sirven para Outlook clásico con
 * calendario "Solo este PC" (para eso está la invitación por correo).
 *
 * Formatos (ninguno de los dos tiene documentación oficial publicada por Google o Microsoft; son los de las referencias
 * de terceros y los foros de Microsoft consultados en nov. 2026; no se probaron con una cuenta real):
 *   - Google: https://calendar.google.com/calendar/render?action=TEMPLATE&text=…&dates=YYYYMMDDTHHMMSSZ/YYYYMMDDTHHMMSSZ
 *     &details=…&location=…&ctz=America/Lima (fechas en UTC; ctz solo elige la zona en que se muestran).
 *   - Outlook web (cuentas de trabajo/escuela): https://outlook.office.com/calendar/action/compose?rru=addevent&subject=…
 *     &startdt=ISO&enddt=ISO&body=…&location=… (ISO en UTC con Z: un "+hh:mm" en la URL llega como espacio). El camino
 *     /calendar/0/deeplink/compose dejó de cargar en 2023; /calendar/action/compose es el vigente.
 */
import { icsUtc } from "../bot/ics";
import { LIMA_TZ } from "../ui/time";

export interface CalendarLinkEvent {
  start: Date;
  durationMinutes: number;
  summary: string;
  location?: string | null;
  description?: string | null;
}

const isoZ = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const endOf = (ev: CalendarLinkEvent) => new Date(ev.start.getTime() + ev.durationMinutes * 60_000);

export function googleCalendarUrl(ev: CalendarLinkEvent): string {
  const p = new URLSearchParams({ action: "TEMPLATE", text: ev.summary, dates: `${icsUtc(ev.start)}/${icsUtc(endOf(ev))}`, ctz: LIMA_TZ });
  if (ev.description) p.set("details", ev.description);
  if (ev.location) p.set("location", ev.location);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

export function outlookWebUrl(ev: CalendarLinkEvent): string {
  const p = new URLSearchParams({ path: "/calendar/action/compose", rru: "addevent", subject: ev.summary, startdt: isoZ(ev.start), enddt: isoZ(endOf(ev)) });
  if (ev.description) p.set("body", ev.description);
  if (ev.location) p.set("location", ev.location);
  return `https://outlook.office.com/calendar/action/compose?${p.toString()}`;
}
