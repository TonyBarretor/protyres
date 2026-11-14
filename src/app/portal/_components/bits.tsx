/** Piezas pequeñas de la UI del portal (componentes de servidor). */
import { ESTIMATE_NOTE, NIVEL_LABEL } from "@/lib/portal/scoring/explain";
import type { Nivel, Temperatura } from "@/lib/portal/store/types";
import { temperaturaLabel } from "@/lib/portal/ui/labels";

export function TempChip({ t }: { t: Temperatura | null | undefined }) {
  return <span className={`pt-chip ${t ? `pt-chip-${t}` : "pt-chip-none"}`}>{t ? temperaturaLabel(t) : "—"}</span>;
}

export function DemoTag() {
  return (
    <span className="pt-tag pt-tag-demo" title="Incluye ventas de demostración (para borrarlas, contacta al administrador)">
      DEMO
    </span>
  );
}

export function MtcTag({ label = "MTC" }: { label?: string }) {
  return (
    <span className="pt-tag pt-tag-mtc" title="Dato del padrón vehicular del MTC">
      {label}
    </span>
  );
}

export function InferidaTag() {
  return (
    <span className="pt-tag pt-tag-inf" title="Estimación según clase, ejes, llantas y peso (config/tyre-inference.json); confirmar en inspección">
      inferida
    </span>
  );
}

/** Nivel del puntaje de atractivo (corrida G), siempre como estimación; "sin nivel" si aún no se calculó. */
export function NivelBadge({ nivel }: { nivel: Nivel | null | undefined }) {
  if (!nivel) {
    return (
      <span className="pt-nivel pt-nivel-none" title="El nivel de esta empresa aún no se ha calculado.">
        sin nivel
      </span>
    );
  }
  return (
    <span className={`pt-nivel pt-nivel-${nivel.toLowerCase()}`} title={ESTIMATE_NOTE}>
      {NIVEL_LABEL[nivel]} <span className="pt-nivel-est">· estimación</span>
    </span>
  );
}

/** La explicación de una línea del nivel (explainLine); nada si no hay. */
export function ExplainLine({ text }: { text: string }) {
  return text ? <div className="pt-explain">{text}</div> : null;
}

/** Mensaje de resultado que llega por ?aviso=... / ?error=... tras una server action. */
export function Flash({ aviso, error }: { aviso?: string; error?: string }) {
  if (error) return <p className="pt-notice pt-error" role="alert">{error}</p>;
  if (aviso) return <p className="pt-notice pt-success" role="status">{aviso}</p>;
  return null;
}

export const MTC_LEGEND = "Unidades, ejes y llantas: padrón MTC. Medida: estimación a confirmar en inspección.";
