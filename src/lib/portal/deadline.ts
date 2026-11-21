/**
 * Tiempo límite de verdad para el trabajo del portal que corre dentro de un mensaje del cotizador (corrida J, punto 6).
 *
 * `withTimeout` solo deja de esperar: la promesa sigue en marcha. Si ese trabajo escribe o responde, lo hace tarde y
 * fuera de orden (la pregunta "¿La cotización … es para …?" llegaba en la respuesta del mensaje siguiente; los avisos
 * pendientes se mandaban en medio del cotizador y se borraban mientras el router seguía con la conversación de antes).
 * `withDeadline` le da al trabajo un interruptor: al vencer, el store que recibe rechaza toda llamada nueva y las
 * funciones que responden al vendedor no mandan nada. Lo que ya estaba en vuelo (una consulta) termina, nada más.
 */
import type { PortalStore } from "./store/types";

export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`el portal no respondió en ${ms} ms`));
    }, ms);
    (t as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export interface Deadline {
  /** false desde que venció el límite. */
  alive: () => boolean;
  /** El store, que deja de funcionar al vencer el límite. */
  store: (store: PortalStore) => PortalStore;
  /** El objeto con sus funciones de respuesta (`reply`, `replyInteractive`, `sendDocument`, `sendTextTo`) que no mandan nada al vencer. */
  quiet: <I extends object>(input: I) => I;
}

const SENDERS = ["reply", "replyInteractive", "sendDocument", "sendTextTo"] as const;

/** Corre `run` con tiempo límite; al vencer rechaza (como withTimeout) y apaga el store y las respuestas de `run`. */
export function withDeadline<T>(ms: number, run: (d: Deadline) => Promise<T>): Promise<T> {
  let aborted = false;
  const alive = () => !aborted;
  const d: Deadline = {
    alive,
    store: (store) => guardStore(store, alive),
    quiet: (input) => {
      const out = { ...input } as Record<string, unknown>;
      for (const k of SENDERS) {
        const f = out[k];
        if (typeof f === "function") out[k] = async (...args: unknown[]) => (alive() ? (f as (...a: unknown[]) => unknown).apply(input, args) : undefined);
      }
      return out as typeof input;
    },
  };
  return withTimeout(run(d), ms, () => void (aborted = true));
}

/** El store con un interruptor: cuando `alive()` es false, cualquier método falla sin tocar los datos. */
export function guardStore(store: PortalStore, alive: () => boolean): PortalStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (!alive()) return Promise.reject(new Error("tiempo límite vencido: no se escribe ni se lee más"));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
