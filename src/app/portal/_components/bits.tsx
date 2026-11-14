/** Piezas pequeñas de la UI del portal (componentes de servidor). */
import type { Temperatura } from "@/lib/portal/store/types";
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

/** Mensaje de resultado que llega por ?aviso=... / ?error=... tras una server action. */
export function Flash({ aviso, error }: { aviso?: string; error?: string }) {
  if (error) return <p className="pt-notice pt-error" role="alert">{error}</p>;
  if (aviso) return <p className="pt-notice pt-success" role="status">{aviso}</p>;
  return null;
}

export const MTC_LEGEND = "Unidades, ejes y llantas: padrón MTC. Medida: estimación a confirmar en inspección.";
