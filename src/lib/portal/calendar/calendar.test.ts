import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildIcs, parseIcsLines } from "../bot/ics";
import { googleCalendarUrl, outlookWebUrl } from "./links";
import { buildInviteMime, calendarEmailStatus, configureCalendarMailer, parseFromAddress, sendCalendarInvite, type CalendarInviteMail } from "./mail";
import { smtpSend } from "./smtp";

const START = new Date("2026-11-17T15:00:00Z"); // martes 17/11 10:00 Lima
const READY_ENV = { RESEND_API_KEY: "re_test_x", EMAIL_FROM: "Cotizaciones <cotizaciones@mail.ejemplo-verificado.pe>" };

function ics(method: "REQUEST" | "CANCEL" = "REQUEST"): string {
  return buildIcs({
    uid: "cita-7-20999000011@portal.360tyres",
    start: START,
    durationMinutes: 60,
    summary: "Visita: TRANSPORTES ANDES DEL PERU S.A.C.",
    stamp: new Date("2026-11-11T14:00:00Z"),
    method,
    organizer: { email: "cotizaciones@mail.ejemplo-verificado.pe", name: "Cotizaciones" },
    attendees: [{ email: "frank@example.pe", name: "Frank Rodríguez" }],
  });
}

function mail(over: Partial<CalendarInviteMail> = {}): CalendarInviteMail {
  return {
    from: READY_ENV.EMAIL_FROM,
    to: ["frank@example.pe"],
    subject: "Cita: Visita a TRANSPORTES ANDES DEL PERÚ — martes 17/11 10:00",
    text: "Visita a TRANSPORTES ANDES DEL PERÚ.\nÁbrela en Outlook y pulsa Aceptar.",
    ics: ics(),
    method: "REQUEST",
    fileName: "cita-transportes-andes-20261117.ics",
    ...over,
  };
}

/** Partes de un MIME (cabeceras + cuerpo decodificado) para revisar la estructura. */
function mimeParts(raw: string): { headers: string; body: string }[] {
  const out: { headers: string; body: string }[] = [];
  const walk = (chunk: string) => {
    const [headers, ...rest] = chunk.split("\r\n\r\n");
    const body = rest.join("\r\n\r\n");
    const b = /boundary="([^"]+)"/i.exec(headers);
    if (b && /multipart\//i.test(headers)) {
      for (const part of body.split(`--${b[1]}`).slice(1)) {
        if (part.startsWith("--")) break;
        walk(part.replace(/^\r\n/, "").replace(/\r\n$/, ""));
      }
      return;
    }
    const decoded = /content-transfer-encoding:\s*base64/i.test(headers) ? Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8") : body;
    out.push({ headers, body: decoded });
  };
  walk(raw);
  return out;
}

afterEach(() => configureCalendarMailer(null));

describe("remitente", () => {
  it("lee nombre y dirección de EMAIL_FROM", () => {
    expect(parseFromAddress("Cotizaciones <cotizaciones@mail.x.pe>")).toEqual({ name: "Cotizaciones", email: "cotizaciones@mail.x.pe" });
    expect(parseFromAddress("citas@mail.x.pe")).toEqual({ name: null, email: "citas@mail.x.pe" });
    expect(parseFromAddress('"360 Tyres" <a@b.pe>')).toEqual({ name: "360 Tyres", email: "a@b.pe" });
    expect(parseFromAddress("no es correo")).toBeNull();
  });

  it("apagado sin clave, sin EMAIL_FROM, con el de ejemplo / resend.dev, o desde @360tyres.pe (SPF estricto)", () => {
    expect(calendarEmailStatus({})).toMatchObject({ ready: false });
    expect(calendarEmailStatus({ RESEND_API_KEY: "re_x" })).toMatchObject({ ready: false, reason: expect.stringMatching(/EMAIL_FROM/) });
    expect(calendarEmailStatus({ RESEND_API_KEY: "re_x", EMAIL_FROM: "Cotizaciones <cotizaciones@example.com>" })).toMatchObject({ ready: false });
    expect(calendarEmailStatus({ RESEND_API_KEY: "re_x", EMAIL_FROM: "onboarding@resend.dev" })).toMatchObject({ ready: false });
    expect(calendarEmailStatus({ RESEND_API_KEY: "re_x", EMAIL_FROM: "Citas <citas@360tyres.pe>" })).toMatchObject({ ready: false, reason: expect.stringMatching(/360tyres\.pe/) });
    expect(calendarEmailStatus(READY_ENV)).toEqual({ ready: true, from: READY_ENV.EMAIL_FROM, organizer: { name: "Cotizaciones", email: "cotizaciones@mail.ejemplo-verificado.pe" } });
  });
});

describe("correo de invitación (MIME)", () => {
  it("multipart/mixed: texto + text/calendar; method=REQUEST en la alternativa, y el .ics adjunto", () => {
    const raw = buildInviteMime(mail(), { date: new Date("2026-11-11T14:00:00Z"), messageId: "<x1@mail.ejemplo-verificado.pe>" });
    expect(/[^\r]\n/.test(raw)).toBe(false); // solo CRLF
    for (const line of raw.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    const head = raw.split("\r\n\r\n")[0];
    expect(head).toContain("From: Cotizaciones <cotizaciones@mail.ejemplo-verificado.pe>");
    expect(head).toContain("To: frank@example.pe");
    expect(head).toContain("MIME-Version: 1.0");
    expect(head).toContain("Message-ID: <x1@mail.ejemplo-verificado.pe>");
    expect(head).toMatch(/Content-Type: multipart\/mixed; boundary="/);
    expect(head).toMatch(/Subject: =\?UTF-8\?B\?/); // tildes codificadas (RFC 2047)
    const parts = mimeParts(raw);
    expect(parts).toHaveLength(3);
    expect(parts[0].headers).toMatch(/Content-Type: text\/plain; charset=UTF-8/);
    expect(parts[0].body).toContain("pulsa Aceptar");
    expect(parts[1].headers).toMatch(/Content-Type: text\/calendar; charset=UTF-8; method=REQUEST/);
    expect(parts[1].body).toBe(mail().ics);
    expect(parts[2].headers).toMatch(/Content-Type: application\/ics; name="cita-transportes-andes-20261117\.ics"/);
    expect(parts[2].headers).toMatch(/Content-Disposition: attachment; filename="cita-transportes-andes-20261117\.ics"/);
    expect(parts[2].body).toBe(mail().ics);
    // la parte de calendario está dentro de multipart/alternative (así la reconoce Outlook como reunión)
    expect(raw).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"\r\n\r\n--[^\r]+\r\nContent-Type: text\/plain/);
  });

  it("cancelación: method=CANCEL en la parte de calendario", () => {
    const raw = buildInviteMime(mail({ method: "CANCEL", ics: ics("CANCEL") }));
    const cal = mimeParts(raw).find((p) => /text\/calendar/.test(p.headers))!;
    expect(cal.headers).toContain("method=CANCEL");
    expect(parseIcsLines(cal.body).find((l) => l.name === "STATUS")!.value).toBe("CANCELLED");
  });

  it("cabeceras sin inyección: un asunto o nombre de archivo con saltos de línea no abre otra cabecera", () => {
    const raw = buildInviteMime(mail({ subject: "Cita\r\nBcc: x@hacker.example", fileName: 'a"\r\nb.ics' }));
    const head = raw.split("\r\n\r\n")[0];
    expect(head).not.toMatch(/^Bcc:/m);
    expect(raw).not.toMatch(/\r\nb\.ics/);
  });
});

describe("envío", () => {
  it("apagado: no envía y dice por qué; la llamada nunca lanza", async () => {
    const r = await sendCalendarInvite(mail(), { RESEND_API_KEY: "re_x" });
    expect(r).toMatchObject({ sent: false, configured: false });
    expect(r.error).toMatch(/EMAIL_FROM/);
  });

  it("simulado (configureCalendarMailer): recibe el correo armado; EMAIL_REDIRECT_TO desvía a los destinatarios", async () => {
    const got: CalendarInviteMail[] = [];
    configureCalendarMailer(async (m) => (got.push(m), { sent: true, id: "sim-1" }));
    const r = await sendCalendarInvite(mail({ to: ["frank@example.pe", "danyer@example.pe"] }), { ...READY_ENV, EMAIL_REDIRECT_TO: "pruebas@example.pe" });
    expect(r).toMatchObject({ sent: true, configured: true, to: ["pruebas@example.pe"], id: "sim-1" });
    expect(got[0].to).toEqual(["pruebas@example.pe"]);
  });

  it("un fallo del envío (excepción o error) vuelve como sent:false con el motivo", async () => {
    configureCalendarMailer(async () => {
      throw new Error("ECONNREFUSED smtp.resend.com:465");
    });
    expect(await sendCalendarInvite(mail(), READY_ENV)).toMatchObject({ sent: false, configured: true, error: expect.stringContaining("ECONNREFUSED") });
    configureCalendarMailer(async () => ({ sent: false, error: "domain not verified" }));
    expect(await sendCalendarInvite(mail(), READY_ENV)).toMatchObject({ sent: false, error: "domain not verified" });
  });

  it("sin destinatarios no envía", async () => {
    const r = await sendCalendarInvite(mail({ to: [] }), READY_ENV);
    expect(r).toMatchObject({ sent: false });
  });
});

describe("cliente SMTP (contra un servidor de prueba local)", () => {
  async function fakeServer(opts: { failRcpt?: boolean } = {}) {
    const log: string[] = [];
    let data = "";
    const server = net.createServer((sock) => {
      sock.setEncoding("utf8");
      let inData = false;
      let buf = "";
      sock.write("220 fake ESMTP\r\n");
      sock.on("data", (chunk: string) => {
        buf += chunk;
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          sock.write("250 OK id=fake-123\r\n");
        }
        let i: number;
        while (!inData && (i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          log.push(line);
          if (/^EHLO/i.test(line)) sock.write("250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
          else if (/^AUTH PLAIN/i.test(line)) sock.write("235 ok\r\n");
          else if (/^MAIL FROM/i.test(line)) sock.write("250 ok\r\n");
          else if (/^RCPT TO/i.test(line)) sock.write(opts.failRcpt ? "550 5.7.1 domain not verified\r\n" : "250 ok\r\n");
          else if (/^DATA/i.test(line)) {
            sock.write("354 go\r\n");
            inData = true;
            const end = buf.indexOf("\r\n.\r\n");
            if (end >= 0) {
              data = buf.slice(0, end);
              buf = buf.slice(end + 5);
              inData = false;
              sock.write("250 OK id=fake-123\r\n");
            }
          } else if (/^QUIT/i.test(line)) sock.end("221 bye\r\n");
          else sock.write("502 ?\r\n");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    return { port, log, data: () => data, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it("EHLO, AUTH PLAIN (usuario resend + clave), MAIL FROM, RCPT TO por destinatario, DATA con punto escapado", async () => {
    const srv = await fakeServer();
    try {
      const raw = "Subject: x\r\n\r\nhola\r\n.línea con punto\r\nfin";
      const reply = await smtpSend({ host: "127.0.0.1", port: srv.port, secure: false, allowInsecureAuth: true, user: "resend", pass: "re_test_x" }, { from: "a@b.pe", to: ["c@d.pe", "e@f.pe"] }, raw);
      expect(reply).toContain("fake-123");
      expect(srv.log[0]).toMatch(/^EHLO /);
      expect(srv.log[1]).toBe(`AUTH PLAIN ${Buffer.from("\0resend\0re_test_x").toString("base64")}`);
      expect(srv.log.slice(2, 5)).toEqual(["MAIL FROM:<a@b.pe>", "RCPT TO:<c@d.pe>", "RCPT TO:<e@f.pe>"]);
      expect(srv.data()).toBe("Subject: x\r\n\r\nhola\r\n..línea con punto\r\nfin");
    } finally {
      await srv.close();
    }
  });

  it("un rechazo del servidor se vuelve error con el código", async () => {
    const srv = await fakeServer({ failRcpt: true });
    try {
      await expect(smtpSend({ host: "127.0.0.1", port: srv.port, secure: false, allowInsecureAuth: true, user: "resend", pass: "k" }, { from: "a@b.pe", to: ["c@d.pe"] }, "x")).rejects.toThrow(/550/);
    } finally {
      await srv.close();
    }
  });

  it("sin TLS no manda la clave salvo que se permita (solo pruebas)", async () => {
    await expect(smtpSend({ host: "127.0.0.1", port: 1, secure: false, user: "resend", pass: "k" }, { from: "a@b.pe", to: ["c@d.pe"] }, "x")).rejects.toThrow(/TLS/);
  });
});

describe("enlaces a calendarios en la nube (opcionales)", () => {
  const ev = { start: START, durationMinutes: 60, summary: "Visita: ANDES & CÍA", location: "Base de Ate", description: "Contacto: Carlos" };

  it("Google Calendar: action=TEMPLATE, dates en UTC inicio/fin, ctz America/Lima", () => {
    const u = new URL(googleCalendarUrl(ev));
    expect(`${u.origin}${u.pathname}`).toBe("https://calendar.google.com/calendar/render");
    expect(u.searchParams.get("action")).toBe("TEMPLATE");
    expect(u.searchParams.get("text")).toBe("Visita: ANDES & CÍA");
    expect(u.searchParams.get("dates")).toBe("20261117T150000Z/20261117T160000Z");
    expect(u.searchParams.get("ctz")).toBe("America/Lima");
    expect(u.searchParams.get("location")).toBe("Base de Ate");
    expect(u.searchParams.get("details")).toBe("Contacto: Carlos");
  });

  it("Outlook web: compose con rru=addevent, startdt/enddt en ISO UTC", () => {
    const u = new URL(outlookWebUrl(ev));
    expect(`${u.origin}${u.pathname}`).toBe("https://outlook.office.com/calendar/action/compose");
    expect(u.searchParams.get("rru")).toBe("addevent");
    expect(u.searchParams.get("subject")).toBe("Visita: ANDES & CÍA");
    expect(u.searchParams.get("startdt")).toBe("2026-11-17T15:00:00Z");
    expect(u.searchParams.get("enddt")).toBe("2026-11-17T16:00:00Z");
    expect(u.searchParams.get("location")).toBe("Base de Ate");
    expect(u.searchParams.get("body")).toBe("Contacto: Carlos");
  });
});
