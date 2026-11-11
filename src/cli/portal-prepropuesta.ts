/**
 * Pre-propuesta en PDF para una empresa del padrón, con el store JSON local (nunca la base) y sin registrar actividad.
 *
 *   npm run portal:prepropuesta -- --ruc 20602221505
 *   npm run portal:prepropuesta -- --ruc 20602221505 --as frank --out out/zbuss.pdf
 *
 * --as: usuario del portal (nombre o número de WhatsApp; por defecto "frank"). Sus datos de contacto salen de
 * config/pilot.json (salespeople) por su número. Guarda en out/prepropuesta-<ruc>.pdf salvo --out.
 */
import "./env";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { generatePrepropuesta } from "../lib/portal/prepropuesta";
import { getPortalStore } from "../lib/portal/store";
import { foldText } from "../lib/portal/store/shared";

const { values } = parseArgs({
  options: {
    ruc: { type: "string" },
    as: { type: "string", default: "frank" },
    out: { type: "string" },
  },
});

async function main(): Promise<void> {
  // solo el store JSON local: este comando nunca se conecta a DATABASE_URL
  process.env.PORTAL_STORE = "json";
  const ruc = (values.ruc ?? "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(ruc)) throw new Error("Uso: npm run portal:prepropuesta -- --ruc <RUC de 11 dígitos> [--as frank] [--out archivo.pdf]");
  const store = await getPortalStore();
  try {
    const company = await store.getCompanyByRuc(ruc);
    if (!company) throw new Error(`El RUC ${ruc} no está en el padrón (store JSON). Corre antes npm run portal:import-mtc -- --json.`);
    const as = values.as ?? "frank";
    const digits = as.replace(/\D/g, "");
    const users = await store.listUsers();
    const user = digits.length >= 8 ? users.find((u) => u.whatsapp === digits) : users.find((u) => foldText(u.nombre).startsWith(foldText(as.trim())));
    if (!user) throw new Error(`No encontré al usuario «${as}» en el portal (usuarios: ${users.map((u) => u.nombre).join(", ") || "ninguno"}).`);
    const gen = await generatePrepropuesta(store, company.id, user, new Date());
    const out = path.resolve(values.out ?? path.join("out", `prepropuesta-${ruc}.pdf`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, gen.pdf);
    console.log(`${gen.fileName}: ${gen.pages} páginas, ${Math.round(gen.pdf.length / 1024)} KB -> ${path.relative(process.cwd(), out)}`);
    console.log(`Empresa: ${company.razonSocial} (RUC ${company.ruc}) · ${gen.data.empresa.unidades} unidades · vendedor: ${gen.data.vendedor.nombre}`);
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
