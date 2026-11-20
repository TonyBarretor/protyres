/**
 * Subir ventas: el reporte de ventas de Odoo exportado a Excel (o el .xlsx simple con mapeo de columnas de
 * config/portal.json). Quién sube: config/portal.json → sales.uploadRoles. Muestra cuántas ventas demo hay.
 * ventas-odoo: historial de cargas, clientes que compran y no están en el padrón, y facturas de leasing por asignar
 * cliente final (vendedor, supervisor y admin).
 */
import Link from "next/link";
import { requireUser } from "@/lib/portal/auth/session";
import { loadSalesSettings } from "@/lib/portal/sales/config";
import { fmtFecha, leasingPending } from "@/lib/portal/sales/history";
import { getPortalStore } from "@/lib/portal/store";
import { digits } from "@/lib/portal/store/shared";
import type { UserRole } from "@/lib/portal/store/types";
import { fmtInt, rolLabel } from "@/lib/portal/ui/labels";
import { canSeeSalesHistory, canUploadSales } from "@/lib/portal/ui/permissions";
import { formatLimaShort, formatLimaTime } from "@/lib/portal/ui/time";
import { clientsOutsidePadron } from "@/lib/portal/ui/ventas";
import { DemoTag } from "../_components/bits";
import { UploadForm } from "./UploadForm";

export const metadata = { title: "Subir ventas · Portal 360 Tyres" };

const OUTSIDE_SHOWN = 30;
const PENDING_SHOWN = 50;

const ROLE_NAMES: Record<UserRole, string> = { admin: "el administrador", supervisor: "el supervisor", vendedor: "los vendedores", tecnico: "los técnicos" };

/** "el administrador, el supervisor y los vendedores". */
function rolesText(roles: readonly UserRole[]): string {
  const names = roles.map((r) => ROLE_NAMES[r]);
  return names.length <= 1 ? (names[0] ?? "nadie") : `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`;
}

export default async function VentasPage() {
  const user = await requireUser();
  const store = await getPortalStore();
  const counts = await store.countSales();
  const reales = counts.total - counts.demo;
  const roles = loadSalesSettings().uploadRoles;
  const canSee = canSeeSalesHistory(user);
  const [uploads, outside, pending] = canSee ? await Promise.all([store.listSalesUploads(10), clientsOutsidePadron(store), leasingPending(store)]) : [[], [], []];
  const morePending = pending.length - PENDING_SHOWN;
  const banks = new Map((await store.getCompaniesByRucs([...new Set(pending.map((p) => p.bankRuc))])).map((c) => [digits(c.ruc), c.id]));

  return (
    <div className="pt-stack">
      <div className="pt-page-head" style={{ marginBottom: 0 }}>
        <h1>Subir ventas</h1>
        <span className="pt-muted pt-small">
          {fmtInt(reales)} ventas reales · {fmtInt(counts.demo)} demo
        </span>
      </div>

      {counts.demo > 0 && (
        <p className="pt-notice">
          <DemoTag /> Hay <strong>{fmtInt(counts.demo)} ventas de demostración</strong>. Toda cifra que las incluya lleva la etiqueta DEMO. Para borrarlas,
          contacta al administrador (las ventas reales no se tocan).
        </p>
      )}

      <section className="pt-card">
        <h2>Cómo funciona</h2>
        <ol className="pt-small" style={{ margin: 0, paddingLeft: "1.1rem" }}>
          <li>
            En Odoo, abre el <strong>Reporte de Ventas</strong> del periodo y expórtalo a Excel (.xlsx). Se reconoce solo. También sirve un Excel simple con fecha, RUC y
            cantidad (opcionales: razón social, medida, marca, diseño, precio unitario, total y vendedor).
          </li>
          <li>Pulsa «Vista previa»: verás el rango de fechas, las líneas por tipo, las notas de crédito, las empresas enlazadas y lo que no se pudo clasificar. No se guarda nada.</li>
          <li>
            Si todo está bien, «Confirmar» guarda las líneas. Volver a subir el reporte (o uno más reciente que incluya el periodo anterior) actualiza sin duplicar y no borra el
            cliente final ya asignado.
          </li>
        </ol>
        <p className="pt-small pt-muted" style={{ margin: "0.5rem 0 0" }}>
          Pueden subir ventas {rolesText(roles)}.{roles.includes("vendedor") ? " Si sube un vendedor, se avisa al administrador." : ""}
        </p>
      </section>

      {canUploadSales(user) ? (
        <UploadForm />
      ) : (
        <p className="pt-notice">Tu rol no puede subir ventas. Si tienes un reporte nuevo, envíaselo a {rolesText(roles)}.</p>
      )}

      {canSee && (
        <section className="pt-card" aria-labelledby="pendientes-title" id="por-asignar">
          <div className="pt-section-head">
            <h2 id="pendientes-title">Por asignar cliente final</h2>
            <span className="pt-small pt-muted">{fmtInt(pending.length)} facturas de leasing</span>
          </div>
          {pending.length === 0 ? (
            <p className="pt-muted" style={{ margin: 0 }}>
              Ninguna factura de banco sin cliente final.
            </p>
          ) : (
            <ul className="pt-list">
              {pending.slice(0, PENDING_SHOWN).map((p) => {
                const bankId = banks.get(p.bankRuc);
                return (
                  <li key={`${p.bankRuc}|${p.documento}`}>
                    <div>
                      <strong className="pt-mono">{p.documento}</strong> · {fmtInt(p.neumaticos)} neumático{p.neumaticos === 1 ? "" : "s"} ·{" "}
                      <Link href={bankId ? `/portal/empresas/${bankId}#cliente-final` : `/portal/ventas/leasing/${p.bankRuc}#cliente-final`}>{p.bankName ?? p.bankRuc}</Link>
                    </div>
                    <div className="pt-small pt-muted">
                      {fmtFecha(p.fecha)} · {p.productos.slice(0, 2).join(", ")}
                      {p.productos.length > 2 ? "…" : ""}
                      {p.vendedor ? ` · ${p.vendedor}` : ""}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {morePending > 0 && <p className="pt-small pt-muted">Y {fmtInt(morePending)} más en la página de cada banco.</p>}
        </section>
      )}

      {canSee && (
        <section className="pt-card" aria-labelledby="cargas-title">
          <h2 id="cargas-title">Últimas cargas</h2>
          {uploads.length === 0 ? (
            <p className="pt-muted" style={{ margin: 0 }}>
              Todavía no se ha subido ningún reporte.
            </p>
          ) : (
            <ul className="pt-list">
              {uploads.map((u) => (
                <li key={u.id}>
                  <div style={{ overflowWrap: "anywhere" }}>
                    <strong>{u.fileName}</strong>
                  </div>
                  <div className="pt-small pt-muted">
                    {formatLimaShort(u.createdAt)} {formatLimaTime(u.createdAt)} · {u.userName ?? "—"}
                    {u.userRol ? ` (${rolLabel(u.userRol as UserRole)})` : ""} · {fmtInt(u.inserted)} nuevas · {fmtInt(u.updated)} actualizadas
                    {u.formato === "simple" ? " · formato simple" : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {canSee && (
        <section className="pt-card" aria-labelledby="fuera-title">
          <div className="pt-section-head">
            <h2 id="fuera-title">Clientes fuera del padrón</h2>
            <span className="pt-small pt-muted">{fmtInt(outside.length)} RUC</span>
          </div>
          <p className="pt-small pt-muted" style={{ marginTop: 0 }}>
            Compran, pero su RUC no está en el padrón MTC (sin flota registrada). Sus ventas se guardan igual.
          </p>
          {outside.length === 0 ? (
            <p className="pt-muted" style={{ margin: 0 }}>
              Ninguno.
            </p>
          ) : (
            <details open={outside.length <= 10}>
              <summary>
                <strong>Ver {outside.length > OUTSIDE_SHOWN ? `los ${OUTSIDE_SHOWN} que más compran` : "la lista"}</strong>
              </summary>
              <ul className="pt-list" style={{ marginTop: "0.6rem" }}>
                {outside.slice(0, OUTSIDE_SHOWN).map((r) => (
                  <li key={r.ruc}>
                    <div style={{ overflowWrap: "anywhere" }}>
                      <strong>{r.razonSocial ?? "—"}</strong> <span className="pt-small pt-muted pt-mono">RUC {r.ruc}</span>
                    </div>
                    <div className="pt-small pt-muted">
                      {fmtInt(r.neumaticos)} neumáticos netos · última venta {r.ultimaVenta}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
