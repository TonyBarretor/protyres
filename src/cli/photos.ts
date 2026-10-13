/**
 * Build / refresh the tyre photo library (photos stored in our database, not links).
 *
 *   npm run photos -- --all                              every source in config/photo-sources.json
 *   npm run photos -- --source JCH --dry --limit 20      preview: what would be stored, nothing written
 *   npm run photos -- --source Steel
 *   npm run photos -- --woocommerce https://tienda.com --provider "Nombre"   any other WooCommerce shop
 *   npm run photos -- --stats                            how many photos the library has
 *
 * Options: --force (re-download existing)  --limit N  --dry
 *          --browser   download through a real Chrome window from the start (sites behind Cloudflare, e.g. JCH).
 *                      Without it the importer tries plain HTTP first and opens Chrome only if the site blocks it.
 *          --headless  keep that Chrome window hidden (Cloudflare lets a visible window through more often)
 *          --no-browser  never open Chrome (fail instead)
 * Needs Google Chrome installed; PHOTOS_CHROME_PATH=/path/to/chrome overrides which one is used.
 */
import "./env";
import { parseArgs } from "node:util";
import { importPhotos, loadPhotoSources, type PhotoSource } from "../lib/photos/library";
import { getStore } from "../lib/store";

const { values } = parseArgs({
  options: {
    all: { type: "boolean", default: false },
    source: { type: "string" },
    woocommerce: { type: "string" },
    provider: { type: "string" },
    dry: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    limit: { type: "string" },
    stats: { type: "boolean", default: false },
    browser: { type: "boolean", default: false },
    "no-browser": { type: "boolean", default: false },
    headless: { type: "boolean", default: false },
  },
});

async function main() {
  const cfg = loadPhotoSources();
  const store = await getStore();
  try {
    if (values.stats) {
      const keys = await store.photoKeys();
      console.log(`Fotos en la biblioteca: ${keys.size}`);
      return;
    }
    let sources: PhotoSource[] = [];
    if (values.woocommerce) sources = [{ provider: values.provider ?? new URL(values.woocommerce).hostname, type: "woocommerce", url: values.woocommerce }];
    else if (values.source) {
      const s = cfg.sources.find((x) => x.provider.toLowerCase() === values.source!.toLowerCase());
      if (!s) throw new Error(`no conozco la fuente "${values.source}"; las configuradas son: ${cfg.sources.map((x) => x.provider).join(", ")}`);
      sources = [s];
    } else if (values.all) sources = cfg.sources;
    else throw new Error("indica --all, --source NOMBRE o --woocommerce URL --provider NOMBRE (o --stats)");

    for (const s of sources) {
      console.log(`\n${s.provider} (${s.type}${s.url ? ` · ${s.url}` : ""})${values.dry ? " · modo prueba, no se guarda nada" : ""}`);
      const st = await importPhotos(store, s, {
        dry: values.dry,
        force: values.force,
        limit: values.limit ? parseInt(values.limit, 10) : undefined,
        image: cfg.image,
        browser: values["no-browser"] ? "never" : values.browser ? "always" : undefined,
        browserOptions: { headless: values.headless },
        log: (l) => console.log(l),
      });
      console.log(`productos vistos: ${st.seen} · por código: ${st.matchedByCode} · por nombre: ${st.matchedByName} · sin identificar: ${st.unmatched}`);
      console.log(`${values.dry ? "se guardarían" : "guardadas"}: ${st.stored} · ya existían: ${st.skippedExisting} · fallidas: ${st.failed}`);
      for (const x of st.samples) console.log(`  ${x}`);
    }
    const keys = await store.photoKeys();
    console.log(`\nFotos en la biblioteca: ${keys.size}`);
  } finally {
    await store.close();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
