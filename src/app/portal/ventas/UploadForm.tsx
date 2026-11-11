"use client";
/**
 * Formulario de "Subir ventas": guarda el archivo elegido en el navegador, pide la vista previa al servidor y, al
 * confirmar, vuelve a mandar el mismo archivo con el hash de la vista previa (ver ./actions.ts).
 */
import { useState, useTransition } from "react";
import { confirmSales, previewSales } from "./actions";
import { MAX_UPLOAD_BYTES, type ConfirmResult, type PreviewResult } from "./types";

const nf = new Intl.NumberFormat("es-PE");

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [done, setDone] = useState<ConfirmResult | null>(null);
  const [pending, startTransition] = useTransition();

  function pick(f: File | null) {
    setFile(f);
    setPreview(null);
    setDone(null);
  }

  function runPreview(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setPreview({ ok: false, error: "El archivo pesa más de 7 MB. Divídelo en partes (por ejemplo, por mes)." });
      return;
    }
    const fd = new FormData();
    fd.set("file", file);
    setDone(null);
    startTransition(async () => {
      try {
        setPreview(await previewSales(fd));
      } catch {
        setPreview({ ok: false, error: "No se pudo procesar el archivo. Recarga la página e inténtalo de nuevo." });
      }
    });
  }

  function runConfirm() {
    if (!file || !preview?.ok) return;
    const fd = new FormData();
    fd.set("file", file);
    fd.set("hash", preview.hash);
    startTransition(async () => {
      try {
        const r = await confirmSales(fd);
        setDone(r);
        if (r.ok) setPreview(null);
      } catch {
        setDone({ ok: false, error: "No se pudieron guardar las ventas. Recarga la página e inténtalo de nuevo." });
      }
    });
  }

  return (
    <div className="pt-stack">
      <form className="pt-card pt-stack" onSubmit={runPreview} style={{ gap: "0.75rem" }}>
        <label className="pt-field">
          Archivo de ventas (.xlsx, máx. 7 MB)
          <input type="file" name="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        </label>
        <div className="pt-row">
          <button className="pt-btn pt-btn-dark" type="submit" disabled={!file || pending}>
            {pending && !preview ? "Leyendo…" : "1. Vista previa"}
          </button>
          <span className="pt-small pt-muted">Nada se guarda hasta confirmar.</span>
        </div>
      </form>

      {done && (done.ok ? (
        <p className="pt-notice pt-success" role="status">
          Se guardaron {nf.format(done.inserted)} ventas.{done.skippedErrors ? ` ${nf.format(done.skippedErrors)} filas con errores se omitieron.` : ""}
        </p>
      ) : (
        <p className="pt-notice pt-error" role="alert">
          {done.error}
        </p>
      ))}

      {preview && !preview.ok && (
        <p className="pt-notice pt-error" role="alert">
          {preview.error}
        </p>
      )}

      {preview?.ok && (
        <section className="pt-card pt-stack" aria-labelledby="preview-title">
          <div className="pt-section-head">
            <h2 id="preview-title">Vista previa: {preview.fileName}</h2>
            <span className="pt-small pt-muted">
              Hoja «{preview.sheet ?? "—"}» · encabezados en la fila {preview.headerRow ?? "—"}
            </span>
          </div>

          <div>
            <h3>Mapeo de columnas detectado</h3>
            <div className="pt-table-wrap">
              <table className="pt-table">
                <thead>
                  <tr>
                    <th>Campo</th>
                    <th>Columna del Excel</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.mapping.map((m) => (
                    <tr key={m.field}>
                      <td>
                        {m.label}
                        {m.required && " *"}
                      </td>
                      <td>{m.header ? `«${m.header}»` : <span className={m.required ? "pt-overdue" : "pt-muted"}>{m.required ? "falta (obligatoria)" : "no encontrada"}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="pt-small pt-muted" style={{ marginTop: "0.4rem" }}>
              Si una columna no se reconoce, agrega su encabezado en <code>config/portal.json</code> → <code>sales.columnMap</code>.
            </p>
          </div>

          <div className="pt-kpis">
            <div className="pt-kpi">
              <div className="pt-kpi-label">Filas válidas</div>
              <div className="pt-kpi-value">{nf.format(preview.validCount)}</div>
            </div>
            <div className="pt-kpi">
              <div className="pt-kpi-label">Neumáticos</div>
              <div className="pt-kpi-value">{nf.format(preview.totalCantidad)}</div>
            </div>
            <div className="pt-kpi">
              <div className="pt-kpi-label">RUC en el padrón</div>
              <div className="pt-kpi-value">
                {nf.format(preview.rucsEnPadron)} / {nf.format(preview.rucs)}
              </div>
            </div>
            <div className="pt-kpi">
              <div className="pt-kpi-label">Filas con error</div>
              <div className="pt-kpi-value">{nf.format(preview.errorCount)}</div>
            </div>
          </div>

          {preview.errors.length > 0 && (
            <details open={preview.validCount === 0}>
              <summary>
                <strong>Errores por fila</strong>
                {preview.errorCount > preview.errors.length && ` (primeros ${preview.errors.length} de ${nf.format(preview.errorCount)})`}
              </summary>
              <ul className="pt-small" style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
                {preview.errors.map((e, i) => (
                  <li key={`${e.row}-${i}`}>
                    {e.row ? `Fila ${e.row}: ` : ""}
                    {e.error}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {preview.sample.length > 0 && (
            <div>
              <h3>Primeras filas válidas</h3>
              <div className="pt-table-wrap">
                <table className="pt-table">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>RUC</th>
                      <th>Razón social</th>
                      <th>Medida</th>
                      <th>Marca</th>
                      <th className="pt-num">Cant.</th>
                      <th className="pt-num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample.map((s, i) => (
                      <tr key={i}>
                        <td className="pt-mono">{s.fecha}</td>
                        <td className="pt-mono">{s.ruc}</td>
                        <td>{s.razonSocial ?? "—"}</td>
                        <td>{s.medida ?? "—"}</td>
                        <td>{s.marca ?? "—"}</td>
                        <td className="pt-num">{nf.format(s.cantidad)}</td>
                        <td className="pt-num">{s.total === null || s.total === undefined ? "—" : nf.format(s.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="pt-row">
            <button className="pt-btn pt-btn-primary" type="button" onClick={runConfirm} disabled={pending || preview.validCount === 0}>
              {pending ? "Guardando…" : `2. Confirmar y guardar ${nf.format(preview.validCount)} ventas`}
            </button>
            <span className="pt-small pt-muted">Subir el mismo archivo dos veces duplica las ventas.</span>
          </div>
        </section>
      )}
    </div>
  );
}
