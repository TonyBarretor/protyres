/**
 * ventas-odoo, punto 9: cliente final de las facturas de un banco de leasing que no está en el padrón (los bancos no
 * tienen flota en el MTC, así que en la base real no tienen ficha). Si el banco sí está en el padrón, se va a su ficha.
 * Vendedor, supervisor y admin (canAssignClienteFinal).
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/portal/auth/session";
import { getPortalStore } from "@/lib/portal/store";
import { canAssignClienteFinal } from "@/lib/portal/ui/permissions";
import { leasingBankView } from "@/lib/portal/ui/ventas";
import { ClienteFinalBlock, loadClienteFinalSearch, type SP } from "../../../empresas/[id]/SalesHistory";

type Props = { params: Promise<{ ruc: string }>; searchParams: Promise<SP> };

export const metadata = { title: "Cliente final · Portal 360 Tyres" };

export default async function LeasingPage({ params, searchParams }: Props) {
  const user = await requireUser();
  const ruc = (await params).ruc;
  if (!/^\d{11}$/.test(ruc)) notFound();
  if (!canAssignClienteFinal(user)) {
    return <p className="pt-notice">Tu rol no puede asignar el cliente final. Pídeselo a un vendedor o al supervisor.</p>;
  }
  const store = await getPortalStore();
  const bank = await leasingBankView(store, ruc);
  if (!bank) notFound();
  const sp = await searchParams;
  if (bank.companyId) {
    const q = new URLSearchParams();
    for (const k of ["cf", "cfaviso", "cferror"]) {
      const v = sp[k];
      if (typeof v === "string") q.set(k, v);
    }
    redirect(`/portal/empresas/${bank.companyId}${q.size ? `?${q.toString()}` : ""}#cliente-final`);
  }
  const search = await loadClienteFinalSearch(store, ruc, sp);
  return (
    <div className="pt-stack">
      <div>
        <Link href="/portal/ventas#por-asignar" className="pt-small pt-muted">
          ← Subir ventas
        </Link>
        <div className="pt-page-head" style={{ marginTop: "0.4rem", marginBottom: 0 }}>
          <div>
            <h1 style={{ overflowWrap: "anywhere" }}>{bank.nombre}</h1>
            <div className="pt-muted pt-small pt-mono">
              RUC {bank.ruc} · {bank.esLeasing ? "entidad de leasing" : "facturas con cliente final"} · no está en el padrón
            </div>
          </div>
        </div>
      </div>
      <ClienteFinalBlock bankRuc={bank.ruc} base={`/portal/ventas/leasing/${bank.ruc}`} docs={bank.docs} search={search} />
    </div>
  );
}
