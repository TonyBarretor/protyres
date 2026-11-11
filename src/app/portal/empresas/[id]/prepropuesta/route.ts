/**
 * GET /portal/empresas/:id/prepropuesta -> descarga la pre-propuesta en PDF ("Pre-propuesta - EMPRESA - dd-mm-aaaa.pdf")
 * firmada por el usuario de la sesión, y registra la actividad `prepropuesta` (canal portal). Botón "Generar
 * pre-propuesta" de la ficha. Sin sesión -> /portal/login. Si falta un dato obligatorio vuelve a la ficha con el aviso.
 */
import { NextResponse } from "next/server";
import { LOGIN_PATH } from "@/lib/portal/auth/constants";
import { getCurrentUser } from "@/lib/portal/auth/session";
import { generatePrepropuesta, logPrepropuesta, PrepropuestaError } from "@/lib/portal/prepropuesta";
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
  const now = new Date();
  try {
    const gen = await generatePrepropuesta(store, company.id, user, now);
    await logPrepropuesta(store, gen, user, "portal", now);
    return new Response(new Uint8Array(gen.pdf), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": attachment(gen.fileName),
        "content-length": String(gen.pdf.length),
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof PrepropuestaError) {
      const back = new URL(`/portal/empresas/${company.id}`, req.url);
      back.searchParams.set("error", err.message);
      return NextResponse.redirect(back, 303);
    }
    throw err;
  }
}
