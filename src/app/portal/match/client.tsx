"use client";
/**
 * Piezas con JavaScript de Match Venta (todo funciona sin él, salvo copiar): copiar al portapapeles, la barra de
 * "Planificar visitas" con el número de empresas marcadas y el selector de departamento que filtra al elegir.
 */
import { useEffect, useRef, useState } from "react";

/** Botón "Copiar" (RUC, texto para el bot). Sin portapapeles disponible, selecciona el texto para copiarlo a mano. */
export function CopyButton({ text, label = "Copiar", className = "pt-btn pt-btn-sm" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      aria-label={`${label}: ${text}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          window.prompt("Copia el texto:", text);
        }
      }}
    >
      {done ? "✓ Copiado" : label}
    </button>
  );
}

/**
 * Barra fija de "Planificar visitas": cuenta las casillas del formulario `formId` (están en cada tarjeta, fuera del
 * formulario, con el atributo form) y solo deja enviar con al menos una marcada.
 */
export function PlanBar({ formId, max }: { formId: string; max: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const count = () => setN(document.querySelectorAll(`input[type="checkbox"][form="${formId}"]:checked`).length);
    count();
    document.addEventListener("change", count);
    return () => document.removeEventListener("change", count);
  }, [formId]);
  if (n === 0) return null;
  return (
    <div className="mv-planbar" role="region" aria-label="Planificar visitas">
      <span>
        <strong>{n}</strong> {n === 1 ? "empresa marcada" : "empresas marcadas"}
        {n > max ? ` (se planifican las primeras ${max})` : ""}
      </span>
      <span className="pt-row" style={{ gap: "0.4rem" }}>
        <button
          type="button"
          className="pt-btn pt-btn-sm"
          onClick={() => {
            document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][form="${formId}"]:checked`).forEach((i) => (i.checked = false));
            setN(0);
          }}
        >
          Quitar marcas
        </button>
        <button type="submit" form={formId} className="pt-btn pt-btn-primary pt-btn-sm">
          Planificar visitas
        </button>
      </span>
    </div>
  );
}

/** Selector que envía su formulario GET al cambiar (sin JavaScript, el botón "Ver" lo envía). */
export function AutoSubmitSelect({ name, value, options, label, hidden }: { name: string; value: string; options: { value: string; label: string }[]; label: string; hidden: Record<string, string> }) {
  const ref = useRef<HTMLFormElement>(null);
  const [js, setJs] = useState(false);
  useEffect(() => setJs(true), []);
  return (
    <form ref={ref} method="get" className={`mv-chip-select${value ? " mv-chip-on" : ""}`}>
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <label>
        <span className="pt-sr-only">{label}</span>
        <select name={name} defaultValue={value} onChange={() => ref.current?.requestSubmit()} aria-label={label}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {!js && (
        <button type="submit" className="pt-btn pt-btn-sm">
          Ver
        </button>
      )}
    </form>
  );
}
