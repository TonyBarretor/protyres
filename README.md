# Protyres – cotizador de llantas (piloto)

Bot de WhatsApp para el vendedor de Protyres. Lee las cuatro fuentes que hoy consultan a mano, las normaliza en una
sola tabla, y a partir de un pedido (texto del vendedor, mensaje reenviado del cliente o correo de licitación) arma
la cotización en PDF y el correo listo para enviar.

| fuente | archivo | qué aporta |
|---|---|---|
| Stock propio (Odoo) | `STOCK PROTYRES ddmmaaaa From Odoo.pdf` | código, descripción, marca, modelo, cantidad disponible, reserva |
| Lista propia (gerente de ventas) | `SourceOwnProviderListaPrecios.pdf` | precio de lista **sin IGV** (el pie del PDF dice "incluyen", el cliente confirmó que no), descuento máximo (20 %), tipo |
| Proveedor Steel | `SourceProviderSteelLista-precios-….xls` (en realidad HTML) | precio sin IGV, stock, aplicación |
| Proveedor JCH | `SourceProviderJch dd-mm.xlsx` | precio (col. "LIMA PREMIUN"), stock por almacén (Arriola + Frutales + Lurín) |

Cómo se arma el precio de venta:

* **Ítem propio** (está en la lista propia): precio de lista menos el descuento que indique el vendedor (`dscto 10%`),
  nunca más del máximo de la lista. Se muestra el stock de Odoo (la fila de la lista y la del stock se unen por el
  código Odoo, p.ej. P0360, o por marca + modelo + medida cuando la lista no trae código).
* **Ítem de proveedor** (Steel, JCH o un mensaje reenviado): costo sin IGV + margen (`pricing.provider.marginPct`,
  15 % por defecto). Sale en la cotización como "a pedido".
* **Ítem sin precio en ninguna lista** (parches, aros…): el vendedor escribe `precio 3 4.50` y entra como precio manual.

```
vendedor  →  "Fenixway 295/80R22.5 Valor 87 x4 para Transportes ABC, juan@abc.com, dscto 10%"
bot       →  1. Fenixway 295/80R22.5 VALOR 87 x4
               a) 🏭 STOCK · stock 34 · Fenixway Valor 87 295/80R22.5 18PR   US$ 315.25 (lista US$ 350.28 −10%)
               b) 🚚 Steel · stock 8 · …                                       US$ 220.58 (costo … Steel)
vendedor  →  "ok"            (o "1b", "quitar 2", "precio 3 4.50", "dscto 15", "con igv")
bot       →  PDF + vista previa del correo
vendedor  →  "enviar"        (o "correo otro@x.com", "cancelar")
bot       →  "Enviado ✔"
```

Pedidos con varias líneas (correos de licitación con tabla, mensajes reenviados) se entienden igual: una línea por
ítem, cantidades sumadas cuando se repiten, código de referencia del cliente en la cotización.

La cotización sale en el formato de 360° Tyres (bandas negro/amarillo, número "OCTUBRE 2026 - 016", cajas de datos,
tabla ITEM / MEDIDA / MARCA / MODELO / APLICACIÓN / ORIGEN / CANTIDAD / PRECIO UNIT. / PRECIO TOTAL, firma del asesor).
Las imágenes están en `config/branding/` (sacadas de sus cotizaciones actuales). Datos por cotización que el vendedor
puede escribir en el pedido o después: `atención: Sra. X`, `dirección: Lima`, `pago: factura crédito`, `plazo: 45 días`,
`entrega: 48 hrs post OC`, `validez: 5 días`, `tc 3.4`, `con igv` / `sin igv`. El asesor comercial y su firma se eligen
por el número de WhatsApp que escribe (`salespeople` en `config/pilot.json`).

Para cargar precios: el vendedor **reenvía** al bot el mensaje / PDF / Excel / foto de la lista; si el nombre del
archivo coincide con una regla de `config/providers.json` no pregunta nada, si no pregunta de qué proveedor es.

## Cómo está armado

```
src/lib/tyre/          parser de medidas (camión, agrícola, industrial, montacargas, moto) + marcas + atributos (PR, índice, posición)
src/lib/ingest/        lectores: Excel/CSV/HTML (tabular.ts), PDF genérico (pdf.ts), PDFs de Protyres (protyres-pdf.ts),
                       texto de WhatsApp (whatsapp-text.ts), reglas por archivo (sources.ts → config/providers.json)
src/lib/llm/           extracción con Claude (listas difíciles, fotos, PDFs escaneados) y lectura de pedidos
src/lib/quote/         pedido → líneas (request.ts) → candidatos (match.ts) → precio (pricing.ts) → PDF (pdf.tsx) → correo (email.ts)
src/lib/whatsapp/      cliente Graph API, parser del webhook, lógica de conversación (handler.ts)
src/lib/store/         almacenamiento: JSON local (data/store.json) o Postgres/Supabase (pg-store.ts)
src/lib/drive/         lectura de la carpeta compartida de Google Drive
src/app/api/           rutas Next.js: /api/whatsapp/webhook, /api/ingest/refresh, /api/health
src/cli/               terminal: ingest, prices, quote, wa:simulate
config/pilot.json      empresa, IGV, descuento máximo, margen proveedores, textos de la cotización, vendedor
config/providers.json  qué archivo es de qué proveedor y cómo leerlo (columnas, IGV incluido, moneda)
clientdata/            los archivos reales del cliente (no se versionan)
samples/               listas sintéticas para las pruebas
```

Sin ninguna cuenta externa todo funciona en modo local: parseo por reglas (sin LLM), el correo se escribe en `out/`
en vez de enviarse, y la conversación se simula en la terminal.

## Probar en 2 minutos

```bash
npm install
npm test                                            # 149 pruebas (incluyen los archivos reales si están en clientdata/)

npm run ingest -- clientdata/*                      # carga stock, lista propia, Steel y JCH (reconoce cada archivo por nombre)
npm run prices                                      # qué hay cargado
npm run prices -- 295/80R22.5                       # stock propio, lista propia y proveedores para una medida
npm run prices -- --find "parche vipal"             # búsqueda por texto

npm run quote -- "Fenixway 295/80R22.5 Valor 87 x4 para Transportes ABC, juan@abc.com, dscto 10%"
npm run quote -- --file pedido.txt --pick "1a 2b" --remove 3 --price "4=890"   # correo de licitación pegado en un .txt
#   → out/COT-0001.pdf y out/COT-0001.email.txt

npm run wa:simulate                                 # chatear con el bot sin WhatsApp
```

Cuando el cliente mande una lista nueva: copiarla a `clientdata/` y `npm run ingest -- "clientdata/<archivo>"`. Si el
nombre no coincide con ninguna regla: `--provider "Nombre" --kind provider|own|stock`.

## Configuración

`config/pilot.json`

| clave | qué es |
|---|---|
| `company.*` | razón social, nombre comercial, `signatureName`, RUC, dirección, `logoPath`, `headerImagePath`, `footerImagePath` |
| `pricing.taxPct` / `taxLabel` | IGV 18 % |
| `pricing.own.pricesIncludeTax` | la lista propia trae IGV (true) |
| `pricing.own.maxDiscountPct` / `defaultDiscountPct` | descuento máximo y por defecto (si la lista trae "Descuento máximo", manda la lista) |
| `pricing.provider.marginPct` / `pricesIncludeTax` | margen sobre costo de proveedor; si sus listas traen IGV |
| `pricing.showPricesWithTax` | cómo se muestran los unitarios en la cotización (el total es el mismo) |
| `pricing.currency` / `exchangeRates` | moneda de la cotización y tipo de cambio para listas en soles |
| `pricing.quoteValidityDays` / `stalePriceDays` | validez; a partir de cuántos días un precio de proveedor se marca como viejo |
| `quote.numberFormat` / `counterStart` | "{MES} {YYYY} - {NNN}" y desde qué número sigue la numeración |
| `quote.validityDays` / `deliveryTerm` / `paymentType` / `paymentTerm` / `exchangeRate` | valores por defecto de las cajas de la cotización |
| `quote.brandOrigin` | marca → ORIGEN ("CHINA PREMIUM", "INDIA"…) |
| `salespeople` | número de WhatsApp → nombre, cargo, dirección, celular, correo; `default` para la terminal |

`config/providers.json` – reglas por nombre de archivo (`match` es una expresión regular) y opciones por proveedor:
`kind` (own / stock / provider), `priceIncludesTax`, `maxDiscountPct`, `currency`, `columns` (letra o encabezado;
`stock` acepta varias columnas separadas por coma, se suman), `aliases` (otros nombres que el bot acepta, p.ej.
"J.CH. Comercial" para JCH).

`config/customers.json` – clientes con reglas propias (hoy Prosegur): `aliases` (cómo lo escribe el vendedor),
`company` (lo que sale en la cotización), `email` (vacío = el del pedido o el de la última cotización), `defaults`
(pago, plazo, entrega, validez, con/sin IGV cuando el vendedor no los escribe), `required` (lo que el bot pide antes
de mostrar opciones: `unit`, `ub`, `requester`) y `excel` (plantilla del cliente, patrón del nombre del archivo
`{DDMMYY}-{UB}-{UNIDAD}-{PROVEEDOR}-{N}` y los datos del proveedor). La plantilla de Prosegur está en
`config/templates/prosegur-cotizacion.xlsx` (su "Formato Proveedores" oficial, FCRP 31/07/2023).

Variables de entorno: copiar `.env.example` a `.env`. Nada es obligatorio para el modo local.

## Fase B – cuentas (todas gratis para el piloto)

1. **Anthropic** – https://console.anthropic.com → API key → `ANTHROPIC_API_KEY`. Activa la lectura con LLM: fotos de
   llantas y capturas de pantalla, PDFs escaneados, pedidos escritos de cualquier forma. Modelo por defecto: Haiku 4.5.
2. **Meta for Developers** – https://developers.facebook.com
   1. Crear app → tipo *Business* → añadir producto **WhatsApp**.
   2. *API Setup*: **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`, **token** → `WHATSAPP_TOKEN` (temporal 24 h; el
      permanente se genera en Meta Business Suite → Usuarios del sistema, permisos `whatsapp_business_messaging` y
      `whatsapp_business_management`).
   3. Añadir el número del vendedor en *To* (número de prueba: hasta 5 destinatarios) y confirmar el código.
   4. *App settings → Basic* → **App secret** → `WHATSAPP_APP_SECRET`. Inventar un `WHATSAPP_VERIFY_TOKEN`.
   5. Con la app desplegada (o con `ngrok http 3000` en local): *WhatsApp → Configuration → Webhook* → URL
      `https://<app>/api/whatsapp/webhook`, verify token = el inventado → *Verify and save* → suscribirse a **messages**.
   6. `WHATSAPP_ALLOWED_NUMBERS=51999000111,51988000222` para que solo esos números usen el bot.
   7. `ADMIN_NUMBERS=18605180534` (dígitos, separados por coma): los únicos que pueden registrar un proveedor nuevo
      por WhatsApp (`proveedor nuevo: NOMBRE`) o borrarlo (`borrar proveedor NOMBRE`). Vacío = nadie.
3. **Resend** – https://resend.com → API key → `RESEND_API_KEY`. `EMAIL_FROM` de un dominio verificado (para probar
   sirve `onboarding@resend.dev`, solo entrega a tu propio correo). `EMAIL_REDIRECT_TO=tu@correo` desvía todos los
   envíos a ti durante las pruebas.
4. **Google Drive** – https://console.cloud.google.com → proyecto → habilitar **Google Drive API** → cuenta de
   servicio → clave JSON → `secrets/service-account.json` (`GOOGLE_SERVICE_ACCOUNT_FILE`). El cliente comparte su
   carpeta (solo lectura) con el correo de la cuenta de servicio; el ID de la carpeta va en `GOOGLE_DRIVE_FOLDER_ID`.
5. **Supabase** – https://supabase.com → proyecto → cadena de conexión → `DATABASE_URL` → `npm run db:migrate` (o `npm run db:push`).
   Sin `DATABASE_URL` se usa `data/store.json` (bien en local; en Vercel el disco no persiste). `db:migrate` es
   idempotente: correrlo después de cada actualización (la v14 crea `quote_files` —los archivos enviados de cada
   cotización— y agrega `sync_marks.provider`) **antes** de desplegar.
6. **Despliegue** – Vercel (`vercel`) o Railway. Variables = las de `.env`. `curl https://<app>/api/health` debe
   mostrar `whatsapp: true`. Para refrescar Drive cada hora: cron que llame `GET /api/ingest/refresh` con
   `Authorization: Bearer $CRON_SECRET`.

## Comandos del bot

| mensaje | qué hace |
|---|---|
| pedido en texto libre / correo pegado / mensaje reenviado | una línea por ítem, hasta 5 opciones por línea |
| `ok` | cotiza con la opción *a* de cada línea |
| `1b 3c` · `2` (una sola línea) | elige opciones |
| `quitar 2` · `cantidad 2 6` · `precio 3 4.50` | quita una línea, cambia cantidad, pone precio manual |
| `dscto 15` · `con igv` / `sin igv` · `correo x@y.com` | descuento, presentación, destinatario |
| `atención: Sra. X` · `dirección: Lima` · `pago: letras 30 días` · `plazo: 45 días` · `entrega: 48 hrs post OC` · `validez: 5 días` · `tc 3.4` | datos de las cajas de la cotización |
| `unidad: Ayacucho` · `ub: 1830` (o `UB 1830` en la línea de la llanta) · `solicitante: Johann Castañeda` | unidad atendida, UB y solicitante (Prosegur) |
| `número 451` (`numero`, `nro`, `n°`) · `número 451 confirmar` · `nombre: TEXTO` | fija el número ("OCTUBRE 2026 - 451", el siguiente del vendedor será 452); si ya existe pide confirmar; `nombre:` pone el número tal cual sin tocar el contador. En una cotización ya mostrada la renumera (solo borradores) |
| `archivo: Nombre` · `archivo excel: Nombre` | nombre del PDF (por defecto "OCTUBRE 2026 - 451.pdf") y del Excel del cliente |
| `enviar` | manda el correo con el PDF (y el Excel de Prosegur); los archivos enviados quedan guardados |
| `cotizaciones` · `cotizaciones Prosegur` | tus últimas 10 / las últimas 10 de esa empresa (número · fecha · total · estado · ítems), en cualquier momento |
| `reenviar 451` · `archivos 451` · `pdf 451` (o el número completo) | te reenvía los archivos guardados (o los genera de nuevo) |
| mensaje reenviado / PDF / Excel / foto de lista | carga de precios: solo de proveedores conocidos (JCH, Steel, Protyres o los ya cargados); una cotización no se carga |
| `proveedor nuevo: NOMBRE` · `borrar proveedor NOMBRE` | solo administradores (`ADMIN_NUMBERS`) |
| `precios 11R22.5` · `stock 295/80R22.5` | todas las opciones para una medida |
| `proveedores` · `ayuda` · `cancelar` | |

### Prosegur (cliente con formato propio)

- El pedido empieza con `prosegur` (o dice "para Prosegur"): el bot pone PROSEGUR SA y sus condiciones (FACTURA,
  30 días, 48 HRS POST OC, validez 7 días, sin IGV) salvo lo que el vendedor escriba, y pide **unidad**, **UB** y
  **solicitante** si faltan (`ok` sigue sin ellos). `prosegur` solo → mini guía de qué mandar.
- Con `ok` llegan dos documentos: el PDF 360° (MEDIDA "215/75R17.5 18PR UB 1830") y el Excel "Formato Proveedores"
  lleno (`151026-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-451.xlsx`, precios sin IGV, máximo 11 ítems). `enviar` adjunta
  ambos al correo.
- La próxima cotización a Prosegur reutiliza unidad, UB, solicitante y correo de la anterior (se cambian igual).
- Ejemplo y verificación visual del Excel: `npx tsx --tsconfig tsconfig.cli.json scripts/prosegur-sample.ts out`
  (necesita LibreOffice `soffice` y `pdftoppm` para el PNG).

## Límites conocidos del piloto

- Sin LLM: las fotos de llantas y las capturas de pantalla no se leen (se usa solo el texto del mensaje), y los
  modelos en mensajes de WhatsApp se recortan por reglas. Con `ANTHROPIC_API_KEY` mejora mucho.
- El stock de Odoo es el del último PDF cargado; conectar Odoo en vivo es fase 2.
- Ítems que no son llantas (parches, aros, cámaras) solo se cotizan si están en la lista propia / stock, o con precio manual.
- Audios no se procesan.
- Número de prueba de Meta: máximo 5 números; el token temporal caduca a las 24 h (usar el de usuario del sistema).

## Fotos y datos del cliente

- **Fotos de producto**: Steel publica foto y ficha técnica por producto; se guardan al ingerir (`photoUrl` / `sheetUrl`) y se reutilizan por marca+modelo aunque el ítem cotizado venga del stock o de otro proveedor. El PDF las muestra en una franja debajo de los ítems (foto + "MARCA MODELO"), todo en una sola página: con fotos la tabla rellena menos filas vacías y las fotos se reducen a lo que quepa; solo si ya no cabe nada pasan a una página anexa.
  - `foto 1b` / `foto 2` → el bot manda la foto (y la ficha) de una opción o de un ítem de la cotización.
  - Enviar una imagen con el texto `foto Fenixway Valor 87` → queda guardada para ese modelo (tabla `photos`).
  - `foto buscar 2` → búsqueda en internet (Google Custom Search: `GOOGLE_CSE_KEY` + `GOOGLE_CSE_ID`); el bot propone y el vendedor responde `foto ok` / `foto otra` / `foto no`. Nunca se usa una foto de internet sin aprobación.
  - `PHOTOS_DISABLED=1` evita descargar imágenes al renderizar (tests).
- **Biblioteca de fotos propia** (`npm run photos`): descarga las fotos de los proveedores y las guarda reducidas (600 px JPEG) en la tabla `photos`, para no depender de que el proveedor mantenga el enlace. Fuentes en `config/photo-sources.json`: JCH (WooCommerce, SKU = código de su lista) y Steel (URLs de su lista). `--dry --limit 20` para previsualizar; `--woocommerce URL --provider Nombre` para cualquier otra tienda WooCommerce; `--stats` para contar. Sin IA: el emparejamiento es por código y, si no, por marca/modelo del nombre.
  - **Webs detrás de Cloudflare** (JCH): rechazan descargas directas (HTTP 403 a curl/Node) y su verificación «eres humano» se queda en bucle con Playwright normal. El importador abre entonces una ventana de Google Chrome con `patchright` (Playwright parcheado para no delatarse; dependencia de desarrollo; usa el Chrome instalado y un perfil propio en `.cache/chrome-profile`) y descarga catálogo e imágenes desde dentro de la página. `"browser": true` en la fuente abre Chrome desde el inicio; sin esa marca se intenta primero la descarga directa y se abre Chrome solo si la web la bloquea. `--headless` oculta la ventana, `--no-browser` nunca la abre, `PHOTOS_CHROME_PATH` elige otro Chrome/Chromium. Si Cloudflare muestra la casilla «Verificar que eres humano», se marca a mano en la ventana y el importador sigue solo.
- **Memoria de clientes**: al cotizar de nuevo al mismo cliente (correo o razón social) el bot reutiliza atención, dirección y condiciones de la última cotización y lo avisa; se cambian con `atención: …`, `dirección: …`, `pago: …`, `plazo: …`, `entrega: …`.
- Antes de `enviar`, el bot avisa si faltan *atención* o *dirección* y muestra las condiciones vigentes.
