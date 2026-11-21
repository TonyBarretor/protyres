"use client";
/**
 * Formulario de "Subir ventas": guarda el archivo elegido en el navegador, pide la vista previa al servidor y, al
 * confirmar, vuelve a mandar el mismo archivo con el hash de la vista previa (ver ./actions.ts).
 */
import { useState, useTransition } from "react";
import { LINE_TYPE_LABELS } from "@/lib/portal/sales/classify";
import { countRows, fmtIsoDate, serviceRows, totalsCheck, vendorSummary } from "@/lib/portal/ui/ventas-preview";
import { confirmSales, previewSales } from "./actions";
import { MAX_UPLOAD_BYTES, type ConfirmResult, type OdooSalesPreview, type PreviewResult } from "./types";

const nf = new Intl.NumberFormat("es-PE");
const money = new Intl.NumberFormat("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="pt-kpi">
      <div className="pt-kpi-label">{label}</div>
      <div className="pt-kpi-value">{value}</div>
      {sub && <div className="pt-kpi-sub">{sub}</div>}
    </div>
  );
}

/** ventas-odoo, punto 11: lo que se va a guardar del reporte de Odoo, antes de confirmar. */
function OdooPreview({ preview, pending, onConfirm }: { preview: OdooSalesPreview; pending: boolean; onConfirm: () => void }) {
  const st = preview.stats;
  const nc = st.notasCredito;
  const totals = totalsCheck(st);
  const servicios = serviceRows(st);
  const excl = countRows(st.excluidas.porMotivo);
  const vend = vendorSummary(st);
  const guardar = st.lineasNuevas + st.lineasExistentes;
  return (
    <section className="pt-card pt-stack" aria-labelledby="preview-title">
      <div className="pt-section-head">
        <h2 id="preview-title" style={{ overflowWrap: "anywhere" }}>
          Vista previa: {preview.fileName}
        </h2>
        <span className="pt-small pt-muted">Reporte de ventas de Odoo · encabezados en la fila {preview.headerRow ?? "—"}</span>
      </div>

      <p style={{ margin: 0 }}>
        Del <strong>{fmtIsoDate(st.desde)}</strong> al <strong>{fmtIsoDate(st.hasta)}</strong> · {nf.format(st.lineas)} líneas leídas
      </p>

      <div className="pt-kpis">
        <Kpi label={LINE_TYPE_LABELS.neumatico} value={nf.format(st.porTipo.neumatico ?? 0)} sub="líneas" />
        <Kpi label={LINE_TYPE_LABELS.servicio} value={nf.format(st.porTipo.servicio ?? 0)} sub="líneas" />
        <Kpi label={LINE_TYPE_LABELS.otro} value={nf.format(st.porTipo.otro ?? 0)} sub="líneas" />
        <Kpi label="Neumáticos netos" value={nf.format(st.neumaticosNetos)} sub={`${nf.format(st.neumaticosVendidos)} vendidos menos notas de crédito`} />
      </div>

      <div className="pt-kpis">
        <Kpi label="Líneas nuevas" value={nf.format(st.lineasNuevas)} />
        <Kpi label="Ya guardadas (se actualizan)" value={nf.format(st.lineasExistentes)} />
        <Kpi label="Empresas en el padrón" value={nf.format(st.empresas.enPadron)} sub={`${nf.format(st.empresas.fueraDelPadron)} fuera del padrón`} />
        <Kpi label="Personas naturales" value={nf.format(st.personasNaturales.lineas)} sub={`líneas · ${nf.format(st.personasNaturales.neumaticos)} neumáticos`} />
      </div>

      <div>
        <h3>Cuadre con el archivo</h3>
        {totals.estado === "sin_totales" ? (
          <p className="pt-small" style={{ margin: 0 }}>
            El archivo no trae la fila TOTALES. Suma de TOTAL VTA S/: S/ {money.format(totals.suma)}.
          </p>
        ) : (
          <p className="pt-small" style={{ margin: 0 }}>
            Suma de TOTAL VTA S/ de las líneas: S/ {money.format(totals.suma)} · fila TOTALES: S/ {money.format(totals.archivo)} ·{" "}
            {totals.estado === "cuadra" ? (
              <span className="pt-ok-text">cuadra</span>
            ) : (
              <span className="pt-overdue">no cuadra (diferencia S/ {money.format(totals.diferencia)})</span>
            )}
          </p>
        )}
      </div>

      <div>
        <h3>Notas de crédito y débito</h3>
        <ul className="pt-small" style={{ margin: 0, paddingLeft: "1.1rem" }}>
          <li>
            Notas de crédito aplicadas: {nf.format(nc.documentos)} documentos, {nf.format(nc.lineas)} líneas, {nf.format(nc.neumaticos)} neumáticos restados · S/{" "}
            {money.format(nc.totalSoles)} y US$ {money.format(nc.totalUsd)}.
            {nc.soloMonto > 0 && ` ${nf.format(nc.soloMonto)} solo corrigen el monto (no restan neumáticos).`}
          </li>
          <li>
            Notas de débito: {nf.format(st.notasDebito.documentos)} documentos, {nf.format(st.notasDebito.lineas)} líneas (no suman neumáticos).
          </li>
          <li>
            Ventas anuladas (según ESTADO SUNAT o tipo de documento): {nf.format(st.excluidas.lineas)}
            {excl.length > 0 && ` (${excl.map(([k, n]) => `${k}: ${nf.format(n)}`).join(", ")})`} · {nf.format(st.excluidas.neumaticos)} neumáticos. Se guardan, pero no
            cuentan. El STATUS es del lado de compra: no excluye ventas.
          </li>
          {st.montosCalculados.lineas > 0 && (
            <li>
              Montos en soles calculados con el T.C. de la línea (venían en S/ 0 con monto en dólares): {nf.format(st.montosCalculados.lineas)} líneas · S/{" "}
              {money.format(st.montosCalculados.totalSoles)}. Se guarda también el valor original.
            </li>
          )}
          <li>
            Total neto (lo que cuenta, notas de crédito restando): S/ {money.format(st.totalesNetos.soles)} y US$ {money.format(st.totalesNetos.usd)}.
          </li>
        </ul>
      </div>

      {servicios.length > 0 && (
        <div>
          <h3>Servicios por tipo</h3>
          <div className="pt-table-wrap">
            <table className="pt-table">
              <thead>
                <tr>
                  <th>Servicio</th>
                  <th className="pt-num">Líneas</th>
                </tr>
              </thead>
              <tbody>
                {servicios.map((r) => (
                  <tr key={r.tipo}>
                    <td>{r.label}</td>
                    <td className="pt-num">{nf.format(r.lineas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <h3>Vendedores</h3>
        <p className="pt-small" style={{ margin: 0 }}>
          Reconocidos: {vend.reconocidos.length ? vend.reconocidos.map((v) => `${v.nombre} (${nf.format(v.lineas)})`).join(", ") : "ninguno"}.
        </p>
        {vend.sinDueno.length > 0 && (
          <p className="pt-small pt-muted" style={{ margin: "0.2rem 0 0" }}>
            Quedan como texto, sin usuario del portal: {vend.sinDueno.map((v) => `${v.nombre} (${nf.format(v.lineas)})`).join(", ")}.
          </p>
        )}
      </div>

      {st.fueraDelPadron.length > 0 && (
        <details>
          <summary>
            <strong>RUC fuera del padrón ({nf.format(st.fueraDelPadron.length)})</strong> <span className="pt-small pt-muted">se guardan igual</span>
          </summary>
          <ul className="pt-small" style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
            {st.fueraDelPadron.map((c) => (
              <li key={c.ruc} style={{ overflowWrap: "anywhere" }}>
                <span className="pt-mono">{c.ruc}</span> {c.razonSocial ?? "—"} · {nf.format(c.neumaticos)} neumáticos · {nf.format(c.lineas)} líneas
              </li>
            ))}
          </ul>
        </details>
      )}

      {st.dudosas.length > 0 && (
        <details>
          <summary>
            <strong>No se pudo clasificar con seguridad ({nf.format(st.dudosas.length)})</strong>
          </summary>
          <ul className="pt-small" style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
            {st.dudosas.map((d) => (
              <li key={d.descripcion} style={{ overflowWrap: "anywhere" }}>
                {d.descripcion} → {LINE_TYPE_LABELS[d.tipo]}
                {d.detalle ? ` (${d.detalle})` : ""} · {nf.format(d.lineas)} línea{d.lineas === 1 ? "" : "s"}
                {d.nota && <span className="pt-muted"> · {d.nota}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {st.advertencias.length > 0 && (
        <details>
          <summary>
            <strong>Filas con advertencia ({nf.format(st.advertencias.length)})</strong>
          </summary>
          <ul className="pt-small" style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
            {st.advertencias.map((w, i) => (
              <li key={`${w.row}-${i}`} style={{ overflowWrap: "anywhere" }}>
                Fila {w.row}
                {w.documento ? ` (${w.documento})` : ""}: {w.mensaje}
              </li>
            ))}
          </ul>
        </details>
      )}

      {preview.errors.length > 0 && (
        <details>
          <summary>
            <strong>Filas que no se guardan ({nf.format(preview.errorCount)})</strong>
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

      <div className="pt-row">
        <button className="pt-btn pt-btn-primary" type="button" onClick={onConfirm} disabled={pending || guardar === 0}>
          {pending ? "Guardando…" : `2. Confirmar y guardar ${nf.format(guardar)} líneas`}
        </button>
        <span className="pt-small pt-muted">Las líneas ya guardadas se actualizan, no se duplican.</span>
      </div>
    </section>
  );
}

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
      setPreview({ ok: false, error: "El archivo pesa más de 4 MB. Divídelo en partes (por ejemplo, por mes)." });
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
          Reporte de ventas de Odoo en Excel (.xlsx, máx. 4 MB)
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
          {done.formato === "odoo"
            ? `Listo: ${nf.format(done.inserted)} líneas nuevas y ${nf.format(done.updated)} actualizadas. Puntaje recalculado en ${nf.format(done.empresasRecalculadas)} empresas.${done.adminAvisado ? " Se avisó al administrador." : ""}`
            : `Se guardaron ${nf.format(done.inserted)} ventas.`}
          {done.skippedErrors ? ` ${nf.format(done.skippedErrors)} filas con errores se omitieron.` : ""}
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

      {preview?.ok && preview.formato === "odoo" && <OdooPreview preview={preview} pending={pending} onConfirm={runConfirm} />}

      {preview?.ok && preview.formato === "simple" && (
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
