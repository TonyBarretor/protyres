/**
 * GET /portal/empresas/:id/credito/pdf -> descarga el PDF del reporte de crédito adjunto en la ficha.
 * Sin sesión -> /portal/login. Es un reporte con datos de terceros (Ley 29733): solo lo descarga quien puede editar la
 * empresa (vendedor dueño o supervisor/admin); el resto ve en la ficha que hay un PDF, no su contenido.
 */
import { NextResponse } from "next/server";
import { LOGIN_PATH } from "@/lib/portal/auth/constants";
import { canEditCompany } from "@/lib/portal/auth/permissions";
import { getCurrentUser } from "@/lib/portal/auth/session";
import { getPortalStore } from "@/lib/portal/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Content-Disposition con nombre ASCII de respaldo y el nombre real en UTF-8 (RFC 6266 / 5987). */
function attachment(fileName: string): string {
  const ascii = fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL(LOGIN_PATH, req.url));
  const id = Number.parseInt((await params).id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return new Response("Empresa no encontrada.", { status: 404 });
  const store = await getPortalStore();
  const company = await store.getCompany(id);
  if (!company) return new Response("Empresa no encontrada.", { status: 404 });
  if (!canEditCompany(user, company)) return new Response("Solo el dueño de la empresa (o supervisor) puede descargar el reporte de crédito.", { status: 403 });
  const pdf = await store.getCreditPdf(company.id);
  if (!pdf) return new Response("La empresa no tiene un PDF de crédito adjunto.", { status: 404 });
  const bytes = Buffer.from(pdf.data, "base64");
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": attachment(pdf.name),
      "content-length": String(bytes.length),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
