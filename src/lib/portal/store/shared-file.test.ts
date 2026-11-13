/**
 * Prueba manual del piloto: `npm run dev` (PORTAL_STORE=json) y `npm run portal:simulate -- --persist` comparten
 * data/portal-store.json. El servidor cargaba el archivo una sola vez: el segundo enlace pedido con el simulador daba
 * "Enlace vencido o ya usado" (el token nuevo no estaba en su memoria) y su siguiente escritura pisaba lo del simulador.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __setPortalStoreForTests, getPortalStore } from "./index";
import { JsonPortalStore } from "./json-portal-store";

const prev = process.env.PORTAL_STORE_PATH;
afterEach(() => {
  __setPortalStoreForTests(null);
  if (prev === undefined) delete process.env.PORTAL_STORE_PATH;
  else process.env.PORTAL_STORE_PATH = prev;
});

describe("store JSON compartido entre procesos", () => {
  it("getPortalStore() ve lo que otro proceso escribió en el archivo después de cargarlo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-shared-"));
    const file = path.join(dir, "portal-store.json");
    process.env.PORTAL_STORE_PATH = file;
    __setPortalStoreForTests(null);

    const server = await getPortalStore();
    await server.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
    await server.flush();

    // otro proceso (el simulador) abre el archivo, agrega algo y escribe
    const sim = new JsonPortalStore(file);
    await sim.upsertUser({ nombre: "Juan Bustios", whatsapp: "51900000002", rol: "supervisor" });
    await sim.flush();
    // mtime con resolución gruesa en algunos discos: se fuerza una marca distinta
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);

    const again = await getPortalStore();
    expect(await again.getUserByWhatsapp("51900000002")).not.toBeNull();
    expect(await again.getUserByWhatsapp("51900000001")).not.toBeNull();
  });

  it("sin cambios en el archivo devuelve la misma instancia (no relee 40 MB en cada petición)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-shared-"));
    process.env.PORTAL_STORE_PATH = path.join(dir, "portal-store.json");
    __setPortalStoreForTests(null);
    const a = await getPortalStore();
    await a.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
    await a.flush();
    expect(await getPortalStore()).toBe(a);
  });
});
