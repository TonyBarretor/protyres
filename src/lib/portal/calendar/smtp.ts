/**
 * Cliente SMTP mínimo (RFC 5321) para mandar un mensaje MIME ya armado: la invitación de calendario necesita una parte
 * `text/calendar; method=REQUEST` dentro de multipart/alternative, y la API JSON de Resend solo arma texto/HTML +
 * adjuntos. El SMTP de Resend (smtp.resend.com, usuario `resend`, la misma RESEND_API_KEY como clave) acepta el MIME
 * tal cual. Sin dependencias: node:tls (TLS implícito, puerto 465) y node:net solo para el servidor falso de las pruebas.
 *
 *   await smtpSend({ host: "smtp.resend.com", port: 465, secure: true, user: "resend", pass: key }, { from, to }, raw);
 */
import net from "node:net";
import os from "node:os";
import tls from "node:tls";

export interface SmtpOptions {
  host: string;
  port: number;
  /** TLS implícito (465 / 2465). Sin TLS la clave no se manda, salvo `allowInsecureAuth` (solo pruebas locales). */
  secure: boolean;
  user: string;
  pass: string;
  allowInsecureAuth?: boolean;
  timeoutMs?: number;
}

export interface SmtpEnvelope {
  from: string;
  to: string[];
}

interface Reply {
  code: number;
  text: string;
}

const ADDR_RE = /^[^\s<>@]+@[^\s<>@]+$/;

/** Manda `raw` (CRLF) y devuelve la respuesta final del servidor ("250 OK id=…"). Lanza con el código si algo falla. */
export async function smtpSend(opts: SmtpOptions, envelope: SmtpEnvelope, raw: string): Promise<string> {
  if (!opts.secure && !opts.allowInsecureAuth) throw new Error("SMTP sin TLS: no mando la clave por un canal sin cifrar");
  for (const a of [envelope.from, ...envelope.to]) if (!ADDR_RE.test(a)) throw new Error("SMTP: dirección no válida");
  if (!envelope.to.length) throw new Error("SMTP: sin destinatarios");
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const socket: net.Socket = opts.secure ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host }) : net.connect({ host: opts.host, port: opts.port });
  socket.setEncoding("utf8");
  socket.setTimeout(timeoutMs);

  const replies: Reply[] = [];
  const waiters: { resolve: (r: Reply) => void; reject: (e: Error) => void }[] = [];
  let failure: Error | null = null;
  let buf = "";
  let lines: string[] = [];
  const fail = (e: Error) => {
    if (!failure) failure = e;
    while (waiters.length) waiters.shift()!.reject(failure);
  };
  socket.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      lines.push(line);
      // respuesta multilínea: "250-…" sigue, "250 …" (o "250" solo) termina
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: lines.join("\n") };
        lines = [];
        const w = waiters.shift();
        if (w) w.resolve(reply);
        else replies.push(reply);
      }
    }
  });
  socket.on("timeout", () => {
    fail(new Error(`SMTP: sin respuesta de ${opts.host}:${opts.port} en ${Math.round(timeoutMs / 1000)} s`));
    socket.destroy();
  });
  socket.on("error", (e) => fail(e));
  socket.on("close", () => fail(new Error("SMTP: el servidor cerró la conexión")));

  const read = (): Promise<Reply> => {
    if (replies.length) return Promise.resolve(replies.shift()!);
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
  const expectCode = async (what: string, ok: number[]): Promise<Reply> => {
    const r = await read();
    if (!ok.includes(r.code)) throw new Error(`SMTP ${what}: ${r.text.replace(/\s+/g, " ").slice(0, 200)}`);
    return r;
  };
  const cmd = async (line: string, what: string, ok: number[]): Promise<Reply> => {
    socket.write(`${line}\r\n`);
    return expectCode(what, ok);
  };

  try {
    await expectCode("saludo", [220]);
    await cmd(`EHLO ${os.hostname().replace(/[^A-Za-z0-9.-]/g, "") || "localhost"}`, "EHLO", [250]);
    await cmd(`AUTH PLAIN ${Buffer.from(`\0${opts.user}\0${opts.pass}`).toString("base64")}`, "AUTH", [235]);
    await cmd(`MAIL FROM:<${envelope.from}>`, "MAIL FROM", [250]);
    for (const to of envelope.to) await cmd(`RCPT TO:<${to}>`, "RCPT TO", [250, 251]);
    await cmd("DATA", "DATA", [354]);
    // CRLF en todo el mensaje y "transparencia" (RFC 5321 §4.5.2): una línea que empieza con "." lleva otro "."
    const body = raw.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    socket.write(`${body}${body.endsWith("\r\n") ? "" : "\r\n"}.\r\n`);
    const done = await expectCode("envío", [250]);
    socket.write("QUIT\r\n");
    socket.end();
    return done.text;
  } catch (e) {
    socket.destroy();
    throw e;
  }
}
