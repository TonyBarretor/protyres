/**
 * Corrida J: "Agregar empresa" — alta de una empresa que no está en el padrón del MTC (el import solo trae flotas de 10
 * unidades o más). Mismos datos que `nueva empresa` en el bot: RUC, razón social, sector y departamento; unidades y
 * contacto opcionales. Queda asignada a quien la crea, con su oportunidad en Prospecto; si el RUC ya existe, se va a esa.
 */
import Link from "next/link";
import { requireUser } from "@/lib/portal/auth/session";
import { DEPARTAMENTOS, departamentoLabel } from "@/lib/portal/companies/manual";
import { canCreateCompany } from "@/lib/portal/ui/empresa-nueva";
import { SECTORS } from "@/lib/portal/ui/filters";
import { Flash } from "../../_components/bits";
import { createCompanyAction } from "./actions";

export const metadata = { title: "Agregar empresa · Portal 360 Tyres" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function NuevaEmpresaPage({ searchParams }: Props) {
  const user = await requireUser();
  const sp = await searchParams;
  const v = (k: string) => str(sp[k]).slice(0, 160);
  if (!canCreateCompany(user)) {
    return (
      <div className="pt-stack">
        <h1>Agregar empresa</h1>
        <p className="pt-card pt-muted">Tu rol no puede crear empresas. Pídeselo a un vendedor o al supervisor.</p>
      </div>
    );
  }
  return (
    <div className="pt-stack">
      <div>
        <Link href="/portal" className="pt-small pt-muted">
          ← Prospectos
        </Link>
        <h1 style={{ marginTop: "0.4rem" }}>Agregar empresa</h1>
        <p className="pt-muted pt-small">
          Para una empresa que no está en el padrón del MTC (el padrón solo trae flotas de 10 unidades o más). Queda asignada a ti, con su oportunidad en Prospecto. Si el RUC ya está en el
          portal, te llevamos a esa empresa.
        </p>
      </div>

      <Flash error={v("error") || undefined} />

      <form action={createCompanyAction} className="pt-card pt-stack" style={{ gap: "0.8rem" }}>
        <div className="pt-form-grid">
          <label className="pt-field">
            RUC *
            <input type="text" name="ruc" required inputMode="numeric" maxLength={14} placeholder="11 dígitos" defaultValue={v("ruc")} autoComplete="off" />
          </label>
          <label className="pt-field" style={{ gridColumn: "1 / -1" }}>
            Razón social *
            <input type="text" name="razonSocial" required maxLength={160} defaultValue={v("razonSocial")} />
          </label>
          <label className="pt-field">
            Sector *
            <select name="sector" required defaultValue={v("sector")}>
              <option value="" disabled>
                Elegir…
              </option>
              {SECTORS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="pt-field">
            Departamento *
            <select name="departamento" required defaultValue={v("departamento")}>
              <option value="" disabled>
                Elegir…
              </option>
              {DEPARTAMENTOS.map((d) => (
                <option key={d} value={d}>
                  {departamentoLabel(d)}
                </option>
              ))}
            </select>
          </label>
          <label className="pt-field">
            Unidades (opcional)
            <input type="number" name="unidades" min={0} max={100000} inputMode="numeric" defaultValue={v("unidades")} />
          </label>
        </div>
        <fieldset className="pt-stack" style={{ gap: "0.5rem", border: 0, padding: 0, margin: 0 }}>
          <legend className="pt-small pt-muted">Contacto (opcional)</legend>
          <div className="pt-form-grid">
            <label className="pt-field">
              Nombre
              <input type="text" name="contactoNombre" maxLength={120} defaultValue={v("contactoNombre")} />
            </label>
            <label className="pt-field">
              Cargo
              <input type="text" name="contactoCargo" maxLength={120} defaultValue={v("contactoCargo")} />
            </label>
            <label className="pt-field">
              Teléfono
              <input type="tel" name="contactoTelefono" maxLength={40} defaultValue={v("contactoTelefono")} />
            </label>
          </div>
        </fieldset>
        <div className="pt-row">
          <button className="pt-btn pt-btn-primary" type="submit">
            Crear empresa
          </button>
          <Link className="pt-btn" href="/portal">
            Cancelar
          </Link>
        </div>
      </form>
    </div>
  );
}
