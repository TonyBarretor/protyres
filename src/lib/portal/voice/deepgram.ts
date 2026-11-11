/**
 * Transcripción de notas de voz de WhatsApp con Deepgram (audio pregrabado, API REST, sin SDK).
 *
 *   POST https://api.deepgram.com/v1/listen?model=nova-3&language=es&smart_format=true&punctuate=true&keyterm=...&keyterm=...
 *   Authorization: Token <DEEPGRAM_API_KEY>
 *   Content-Type: <mime del audio> (WhatsApp manda "audio/ogg; codecs=opus")
 *   cuerpo: los bytes del audio
 *
 * Nova-3 usa `keyterm` (un parámetro por término; frases con espacios van codificadas en la URL). `keywords` es de
 * Nova-2 y anteriores y Nova-3 no lo acepta. Límite de Deepgram: 500 tokens en total entre todos los keyterms
 * (ver vocabulary.ts, que recorta la lista).
 *
 * Respuesta: results.channels[0].alternatives[0].{transcript, confidence} y metadata.duration (segundos).
 */

export const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
export const DEEPGRAM_MODEL = "nova-3";
export const DEEPGRAM_LANGUAGE = "es";

export interface TranscribeOptions {
  apiKey: string | null | undefined;
  keyterms?: string[];
  /** Para tests. */
  fetchImpl?: typeof fetch;
  /** Corte de la petición; por defecto 60 s. */
  timeoutMs?: number;
}

export interface Transcription {
  text: string;
  /** 0..1 según Deepgram (0 si no lo informa). */
  confidence: number;
  /** Duración del audio en segundos (0 si no lo informa). */
  durationSec: number;
}

/** No hay DEEPGRAM_API_KEY: el bot responde que la voz aún no está activa y pide texto. */
export class VoiceNotConfigured extends Error {
  readonly code = "VOICE_NOT_CONFIGURED";
  constructor() {
    super("La transcripción de voz no está configurada (falta DEEPGRAM_API_KEY)");
    this.name = "VoiceNotConfigured";
  }
}

/** Deepgram respondió con error o con algo que no se pudo leer. */
export class TranscriptionError extends Error {
  readonly code = "TRANSCRIPTION_FAILED";
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

/** Clave desde el entorno, o null. */
export function deepgramKeyFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  return env.DEEPGRAM_API_KEY?.trim() || null;
}

/** URL de /v1/listen con los parámetros de Nova-3 y un `keyterm` por término (sin vacíos ni repetidos). */
export function buildListenUrl(keyterms: string[] = []): string {
  const params = new URLSearchParams({ model: DEEPGRAM_MODEL, language: DEEPGRAM_LANGUAGE, smart_format: "true", punctuate: "true" });
  const seen = new Set<string>();
  for (const raw of keyterms) {
    const k = raw.trim().replace(/\s+/g, " ");
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    params.append("keyterm", k);
  }
  return `${DEEPGRAM_LISTEN_URL}?${params.toString()}`;
}

interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: { channels?: { alternatives?: { transcript?: string; confidence?: number }[] }[] };
}

export async function transcribe(audio: Buffer, mimeType: string, opts: TranscribeOptions): Promise<Transcription> {
  const apiKey = opts.apiKey?.trim();
  if (!apiKey) throw new VoiceNotConfigured();
  if (!audio || audio.length === 0) throw new TranscriptionError("El audio está vacío");
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  let res: Response;
  try {
    res = await doFetch(buildListenUrl(opts.keyterms ?? []), {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": mimeType || "application/octet-stream" },
      body: new Uint8Array(audio),
      signal: controller.signal,
    });
  } catch (e) {
    const msg = (e as Error)?.name === "AbortError" ? "tiempo de espera agotado" : ((e as Error)?.message ?? String(e));
    throw new TranscriptionError(`Deepgram no respondió: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.text();
      try {
        const j = JSON.parse(body) as { err_msg?: string; message?: string; reason?: string };
        detail = j.err_msg || j.message || j.reason || body;
      } catch {
        detail = body;
      }
    } catch {
      // sin cuerpo
    }
    throw new TranscriptionError(`Deepgram respondió ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`, res.status);
  }
  let json: DeepgramResponse;
  try {
    json = (await res.json()) as DeepgramResponse;
  } catch {
    throw new TranscriptionError("Respuesta de Deepgram no es JSON", res.status);
  }
  const alt = json.results?.channels?.[0]?.alternatives?.[0];
  if (!alt || typeof alt.transcript !== "string") throw new TranscriptionError("Respuesta de Deepgram sin transcripción", res.status);
  return {
    text: alt.transcript.trim(),
    confidence: typeof alt.confidence === "number" ? alt.confidence : 0,
    durationSec: typeof json.metadata?.duration === "number" ? json.metadata.duration : 0,
  };
}
