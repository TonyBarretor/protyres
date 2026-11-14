import { describe, expect, it } from "vitest";
import { audioDurationSec, BYTES_PER_SECOND_FALLBACK, oggDurationSec } from "./duration";

/** Página OGG sintética (sin CRC válido: no hace falta para leer la duración). */
function oggPage(granule: bigint, payload: Buffer, headerType = 0): Buffer {
  const head = Buffer.alloc(27);
  head.write("OggS", 0, "latin1");
  head[4] = 0;
  head[5] = headerType;
  head.writeBigInt64LE(granule, 6);
  head.writeUInt32LE(1234, 14);
  head[26] = 1;
  return Buffer.concat([head, Buffer.from([payload.length]), payload]);
}

function opusHead(preSkip = 312): Buffer {
  const b = Buffer.alloc(19);
  b.write("OpusHead", 0, "latin1");
  b[8] = 1;
  b[9] = 1;
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(48000, 12);
  return b;
}

/** Nota de voz Opus sintética de `seconds` segundos (varias páginas de audio; la última con el granule final). */
function opusNote(seconds: number, opts: { trailingNoGranule?: boolean } = {}): Buffer {
  const preSkip = 312;
  const pages = [oggPage(BigInt(0), opusHead(preSkip), 2), oggPage(BigInt(0), Buffer.from("OpusTags-------"))];
  const total = Math.round(seconds * 48000) + preSkip;
  for (let i = 1; i <= 4; i++) pages.push(oggPage(BigInt(Math.round((total * i) / 4)), Buffer.alloc(100, i)));
  if (opts.trailingNoGranule) pages.push(oggPage(BigInt(-1), Buffer.alloc(50, 9)));
  return Buffer.concat(pages);
}

describe("duración de la nota de voz antes de Deepgram", () => {
  it("lee la duración exacta de un OGG/Opus por el último granule (menos el pre-skip)", () => {
    expect(oggDurationSec(opusNote(12.5))).toBeCloseTo(12.5, 3);
    expect(oggDurationSec(opusNote(600))).toBeCloseTo(600, 3);
    expect(audioDurationSec(opusNote(181), "audio/ogg; codecs=opus")).toEqual({ seconds: expect.closeTo(181, 3), exact: true });
  });

  it("salta la página final sin granule (-1) y usa la anterior", () => {
    expect(oggDurationSec(opusNote(45, { trailingNoGranule: true }))).toBeCloseTo(45, 3);
  });

  it("Vorbis: usa la tasa de su cabecera", () => {
    const id = Buffer.alloc(30);
    id[0] = 1;
    id.write("vorbis", 1, "latin1");
    id.writeUInt32LE(16000, 12);
    const buf = Buffer.concat([oggPage(BigInt(0), id, 2), oggPage(BigInt(16000 * 30), Buffer.alloc(80, 1))]);
    expect(oggDurationSec(buf)).toBeCloseTo(30, 3);
  });

  it("OGG ilegible u otro formato: cota por bytes a 64 kbps", () => {
    expect(oggDurationSec(Buffer.from("OggS-simulado"))).toBeNull();
    expect(audioDurationSec(Buffer.from("OggS-simulado"), "audio/ogg")).toEqual({ seconds: 13 / BYTES_PER_SECOND_FALLBACK, exact: false });
    const mp3 = Buffer.alloc(BYTES_PER_SECOND_FALLBACK * 200);
    expect(audioDurationSec(mp3, "audio/mpeg")).toEqual({ seconds: 200, exact: false });
  });
});
