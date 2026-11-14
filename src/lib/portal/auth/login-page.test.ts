/**
 * Corrida F, punto 6: la página de entrada (GET del enlace del bot). En iPhone, desde WhatsApp, se quedó en "Entrar al
 * portal" sin entrar sola. El token sigue gastándose SOLO con POST (la vista previa de WhatsApp hace GET y no debe
 * gastarlo); la página tiene la identidad del portal, botón grande, una línea de explicación, modo oscuro, y un envío
 * automático que corre una sola vez al cargar y marca `via=auto` para el registro.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { hasTechText } from "../../guard/user-text";
import { JsonPortalStore } from "../store";
import type { PortalUser } from "../store/types";
import { loginGet, loginPost } from "./login";
import { configErrorPage, expiredLinkPage, noSessionPage } from "./pages";
import { createLoginLink } from "./tokens";

const env = { PORTAL_SESSION_SECRET: "test-secret-0123456789abcdef", PORTAL_BASE_URL: "https://portal.example.pe" };
// vista previa de enlaces de WhatsApp (GET sin Fetch Metadata) y el navegador interno de iOS
const WHATSAPP_PREVIEW = { "user-agent": "WhatsApp/2.24.21.80 i" };
const IOS_INAPP = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none" };

let store: JsonPortalStore;
let frank: PortalUser;

beforeEach(async () => {
  store = JsonPortalStore.memory();
  frank = await store.upsertUser({ nombre: "Frank Rodríguez", whatsapp: "51900000001", rol: "vendedor" });
});

describe("página de entrada al portal", () => {
  it("la vista previa de WhatsApp (GET) no gasta el token; el navegador entra después con POST (envío automático)", async () => {
    const link = await createLoginLink(store, frank, { env });
    const preview = await loginGet(new Request(link.url, { headers: WHATSAPP_PREVIEW }), { env });
    expect(preview.status).toBe(200);
    const page = await loginGet(new Request(link.url, { headers: IOS_INAPP }), { env });
    const html = await page.text();
    expect(html).toContain('method="post"');
    expect(html).not.toContain(`action="${link.url}`); // el token no viaja en la URL del POST
    const body = new URLSearchParams({ t: link.token, via: "auto" });
    const res = await loginPost(new Request("https://portal.example.pe/portal/login", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://portal.example.pe", host: "portal.example.pe" } }), store, { env });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://portal.example.pe/portal");
  });

  it("presentable: identidad del portal, botón grande, una línea de explicación, móvil y modo oscuro", async () => {
    const link = await createLoginLink(store, frank, { env });
    const html = await (await loginGet(new Request(link.url), { env })).text();
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('class="brand">360 <span>Tyres</span>');
    expect(html).toContain("--accent:#f5b400");
    expect(html).toContain("@media (prefers-color-scheme:dark)");
    expect(html).toContain('<button class="btn" type="submit">Entrar al portal</button>');
    expect(html).toMatch(/min-height:3\.25rem/);
    expect(html).toContain("Pulsa el botón para entrar");
    // antes: <body style="font-family: system-ui…; margin: 2rem"> sin estilos propios
    expect(html).not.toContain('style="font-family: system-ui');
  });

  it("envío automático: una sola vez, al terminar de cargar, marca via=auto y no se repite al volver atrás", async () => {
    const link = await createLoginLink(store, frank, { env });
    const html = await (await loginGet(new Request(link.url), { env })).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    expect(script).toContain("if(done)return;done=true");
    expect(script).toContain("f.elements.via.value='auto'");
    expect(script).toContain("addEventListener('load'");
    expect(script).toContain("e.persisted");
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain('<input type="hidden" name="via" value="boton">');
  });

  it("las demás páginas del login comparten la identidad y no muestran nombres de variables ni comandos", async () => {
    for (const res of [noSessionPage(), expiredLinkPage(), configErrorPage("Falta PORTAL_SESSION_SECRET: el portal no puede generar ni aceptar enlaces de acceso.")]) {
      const html = await res.text();
      expect(html).toContain('class="brand">360 <span>Tyres</span>');
      const visible = html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>|<[^>]+>/g, " ");
      expect(hasTechText(visible), visible).toBe(false);
    }
  });
});
