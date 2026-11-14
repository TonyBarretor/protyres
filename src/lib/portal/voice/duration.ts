/**
 * Duración de una nota de voz ANTES de pagar Deepgram (corrida E). WhatsApp no manda la duración en el webhook, pero la
 * descarga es gratis: con los bytes se calcula aquí y, si pasa del tope (limits.maxVoiceSeconds), no se transcribe.
 *
 * OGG (las notas de voz de WhatsApp: "audio/ogg; codecs=opus"): la duración exacta sale del granule position de la última
 * página OGG que lo trae (Opus cuenta siempre a 48 kHz; se descuenta el pre-skip de la cabecera OpusHead). Vorbis: la
 * tasa de su cabecera de identificación.
 *
 * Otros formatos (un audio reenviado .mp3 / .m4a): sin leer el contenedor, una cota por bytes a BYTES_PER_SECOND_FALLBACK
 * = 8000 B/s (64 kbps): la voz grabada en el teléfono (AAC mono de notas de voz, MP3 de voz) suele ir a 64 kbps o menos,
 * así que a esa tasa la duración estimada es igual o MAYOR que la real y un audio largo no pasa por error; uno de música
 * a 128 kbps se sobreestima el doble (un mp3 de 2 min se rechazaría), aceptable porque en el bot solo llegan notas de voz.
 */

export const OPUS_RATE = 48_000;
export const BYTES_PER_SECOND_FALLBACK = 8_000;

const OGG_MAGIC = Buffer.from("OggS", "latin1");

/** Duración en segundos de un OGG (Opus o Vorbis) por su último granule position; null si no se puede leer. */
export function oggDurationSec(buf: Buffer): number | null {
  if (buf.length < 28 || !buf.subarray(0, 4).equals(OGG_MAGIC)) return null;
  // cabecera del primer paquete (página 1): OpusHead (pre-skip) o identificación de Vorbis (tasa)
  const segs = buf[26];
  const first = 27 + segs;
  let rate = OPUS_RATE;
  let preSkip = 0;
  if (buf.length >= first + 19 && buf.subarray(first, first + 8).toString("latin1") === "OpusHead") {
    preSkip = buf.readUInt16LE(first + 10);
  } else if (buf.length >= first + 16 && buf[first] === 1 && buf.subarray(first + 1, first + 7).toString("latin1") === "vorbis") {
    rate = buf.readUInt32LE(first + 12) || OPUS_RATE;
  } else return null;
  // última página con granule válido (-1 = ningún paquete termina en esa página: se mira la anterior)
  for (let i = buf.length - 27; i >= 0; i--) {
    if (buf[i] !== 0x4f || buf[i + 1] !== 0x67 || buf[i + 2] !== 0x67 || buf[i + 3] !== 0x53 || buf[i + 4] !== 0) continue;
    const granule = buf.readBigInt64LE(i + 6);
    if (granule < BigInt(0)) continue;
    const samples = Number(granule) - preSkip;
    return samples > 0 ? samples / rate : 0;
  }
  return null;
}

/**
 * Duración (segundos) para decidir antes de transcribir: la exacta de un OGG, o la cota por bytes de cualquier otro audio
 * (o de un OGG que no se pudo leer).
 */
export function audioDurationSec(buf: Buffer, mimeType = ""): { seconds: number; exact: boolean } {
  const isOgg = /ogg|opus/i.test(mimeType) || buf.subarray(0, 4).equals(OGG_MAGIC);
  if (isOgg) {
    const s = oggDurationSec(buf);
    if (s !== null) return { seconds: s, exact: true };
  }
  return { seconds: buf.length / BYTES_PER_SECOND_FALLBACK, exact: false };
}
