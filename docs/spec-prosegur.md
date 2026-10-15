# Spec: Prosegur quotes (PDF + Excel), quote numbering, stored files, ingestion lock

Project: `/home/claude/protyres` — Next.js 16 WhatsApp quoting bot for a tyre reseller (360° Tyres / Professional Tyres S.A.C., RUC 20565716396). The salesman (Frank) chats with the bot; the bot finds prices, builds a quote, renders the PDF (`src/lib/quote/pdf.tsx`) and emails it (`src/lib/quote/email.ts`, Resend). Store abstraction `PriceStore` (`src/lib/store/types.ts`) with two implementations: `JsonStore` (`json-store.ts`, used by tests via `JsonStore.memory()`) and `PgStore` (`pg-store.ts`, Supabase Postgres via `postgres` + drizzle schema in `src/db/schema.ts`; migrations are plain idempotent SQL in `src/cli/migrate.ts`, run with `npm run db:migrate`). User-facing strings are Spanish; code comments English. Tests: vitest (`npx vitest run`, all must stay green; 160 tests today) and `npx tsc --noEmit -p .`. Do NOT run prettier (the codebase uses long lines deliberately).

Key files to read first: `src/lib/whatsapp/handler.ts` (routing, choose/review states, ingest flow, presentQuote/sendQuote/rebuildQuote, info commands), `src/lib/quote/request.ts` (regex request parser: lines, terms, plates, application), `src/lib/quote/build.ts` (itemFromCandidate, manualItem, buildQuote, formatQuoteNumber), `src/lib/quote/types.ts`, `src/lib/quote/pdf.tsx`, `src/lib/quote/email.ts`, `src/lib/store/*.ts`, `src/db/schema.ts`, `src/cli/migrate.ts`, `src/lib/settings.ts` + `config/pilot.json`, `config/providers.json`, `src/lib/ingest/*`, `src/lib/whatsapp/handler.test.ts` (how flows are tested with a fake client), `scratch/c529pdf.ts` (how to render a sample PDF outside tests).

## 1. Customer profiles (`config/customers.json`, loaded in settings)

```json
{
  "customers": [
    {
      "name": "Prosegur",
      "aliases": ["prosegur", "prosegur sa", "prosegur s.a.", "prosegur s.a"],
      "company": "PROSEGUR SA",
      "email": "",
      "format": "prosegur",
      "defaults": { "paymentType": "FACTURA", "paymentTerm": "30 días", "deliveryTerm": "48 HRS POST OC", "validityDays": 7, "pricesIncludeTax": false },
      "required": ["unit", "ub", "requester"],
      "excel": {
        "template": "config/templates/prosegur-cotizacion.xlsx",
        "fileName": "{DDMMYY}-{UB}-{UNIDAD}-{PROVEEDOR}-{N}",
        "supplierName": "PROFESSIONAL TYRES S.A.C.",
        "supplierRuc": "20565716396"
      }
    }
  ]
}
```

Profile detection (in the handler when a request starts): the message starts with `prosegur` (optionally followed by the request on the next lines) OR the parsed customer company/name matches an alias OR the text contains "para prosegur". When matched: `state.profile = "prosegur"`, the quote gets `customerProfile: "prosegur"`, and the profile's defaults are appended to the request text as term lines (`para PROSEGUR SA`, `correo <email>` if set, `pago: FACTURA`, `plazo: 30 días`, `entrega: 48 HRS POST OC`, `validez 7 días`, `sin igv`) **only for fields the salesman did not write himself**. A bare `prosegur` message with nothing else → reply with a 6-line mini guide (what to send: tyres with `x` quantity and `UB nnnn`, `unidad:`, `solicitante:`, `atención:`, `número 451`).

## 2. New request/quote fields

- `RequestLine.ub?: string` (per item: "UB 1830", "ub 1830", "u.b. 1830" anywhere in the line; strip it from the model like plates are stripped today — see `extractPlate`/`withoutPlate` in request.ts; UB codes are 3–5 digits). `QuoteItem.ub?: string`.
- `QuoteRequest`/`Quote`: `unit?: string` (term `unidad: Ayacucho` / `unidad atendida:` / `sede:`), `ub?: string` (term `ub: 1830`, default for items without their own), `requester?: string` (term `solicitante:`). Add them to `parseTerms` (and to the STOP lookahead list of keys), to the review-state term regex in the handler (`atenci[oó]n|...|unidad|ub|solicitante`), to `describeRequest` (shown in "Entendí:"), and to the LLM schema (`src/lib/llm/parse-request.ts`: unit, ub, requester, line.ub).
- 360° PDF (`pdf.tsx`): MEDIDA shows `… UB 1830` after the plate when `it.ub` is set (the client's own Excel does this: "215/75R17.5 18PR UB 1830").
- Customer memory (`findLastQuoteForCustomer` / `rememberCustomer`) should also reuse `unit`, `ub`, `requester` when quoting the same company again (they vary per unit; still worth prefilling, the salesman can override).

## 3. Prosegur Excel (`src/lib/quote/prosegur-xlsx.ts`)

Fill the template `config/templates/prosegur-cotizacion.xlsx` with ExcelJS (`exceljs` is already a dependency; `workbook.xlsx.readFile` / `load` then `writeBuffer`). The template is the client's official "Formato Proveedores" (GESTIÓN DE FLOTA CASH – COTIZACIÓN PROVEEDORES, FCRP 31/07/2023). Cells (sheet 1, `Formato Proveedores (2)`):

- `E1` = `Nombre de Archivo: <fileName without extension>` (e.g. `Nombre de Archivo: 151026-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-451`)
- `C5` = supplierName, `C6` = supplierRuc (number), `G5` = quote number as a number (451 — the numeric part of the quote number), `G6` = unit (upper case), `K5` = requester (upper case), `K6` = quote date as a real Date (the template has `=TODAY()`; replace it with the date value and keep the cell's number format).
- Rows 19..29 are the 11 item rows (row 19 holds the sample item in the template; clear it). Per item i: `A` = i, `B` = unit (upper), `C` = item.ub ?? quote.ub (as number if numeric), `D` = blank, `E` = `LLANTAS` (`AROS` for rims, `ACCESORIOS` for other non-tyre items), `F` = `215/75R17.5 18PR FENIXWAY VALOR 99` (size display + ply + brand + model, upper case; non-tyre: the item description upper case), `G` = quantity, `H` = `UNI`, `I` = `REPUESTO`, `J` = `USD`, `K` = unit price **net of IGV** (`QuoteItem.unitPrice` is already net; never apply IGV here), `L` = formula `=+K19*G19` with `result` = K×G (ExcelJS `{ formula, result }`). More than 11 items → throw a clear Spanish error (the bot replies with it) — do not try to insert rows.
- Keep `L30`/`L31`/`L32` formulas (Sub Total / IGV / Total) but set their `result` values too (sum, ×0.18, sum) so viewers that don't recalc show numbers.
- Leave Reporte, Diagnóstico, dates, hours, técnicos blank (clear them if the template has values).
- Must preserve: the Prosegur logo image (1 image anchored at A1), 37 merged ranges, column widths, fills/fonts, the notes in A30/A31. **Verify the round trip** with a script (not a vitest test): write a sample to `/mnt/user-data/outputs/ejemplo-prosegur.xlsx`, convert with `soffice --headless --convert-to pdf --outdir <dir> <xlsx>` and `pdftoppm -r 110 -png`, and look at the PNG with the Read tool to confirm the logo, the header boxes and the filled rows look like the template (openpyxl/`python3 -I` is available for a cell-level check too). If ExcelJS drops the image, fall back to re-adding it: read the image from the template zip (`xl/media/image1.png`) and `workbook.addImage` + `worksheet.addImage(id, { tl: {col:0,row:0}, ext: {width:470,height:154} })`.
- File name: `{DDMMYY}-{UB}-{UNIDAD}-{PROVEEDOR}-{N}` from the profile (`151026-1830-AYACUCHO-PROFESSIONAL TYRES S.A.C.-451.xlsx`; DDMMYY from the quote date; UB = quote-level ub or the first item's; UNIDAD upper; N = numeric part of the quote number). The salesman can override it (`archivo excel: Nombre`).
- Export `renderProsegurXlsx(quote, settings, profile): Promise<{ buffer: Buffer; fileName: string }>`.

## 4. Quote numbering (settings.quote.numberFormat is `{MES} {YYYY} - {NNN}` → "OCTUBRE 2026 - 018")

- Counters become **per salesman** (keyed by the WhatsApp number: counter name `quote:<phone>`), falling back to the global counter for a phone with no counter yet (`PriceStore.nextQuoteCounter(start, key?)` + a new `setQuoteCounter(value, key)`; implement in JsonStore and PgStore; `counters` table already exists).
- `número 451` / `numero 451` / `nro 451` / `n° 451` (in the choose state, in the review state, or as a line of the request): this quote becomes `formatQuoteNumber(format, 451, date)` → "OCTUBRE 2026 - 451", and the salesman's counter is set so the next quote is 452. If a quote with that number already exists → reply asking to confirm (`número 451 confirmar`) or choose another.
- `nombre: TEXTO LIBRE` → sets this quote's number/name verbatim (no counter change) — the "just in case" override.
- Renumbering an already presented quote (review state) must keep stored data consistent: save under the new number, delete the old draft record (`PriceStore.deleteQuote(number)` — add it), re-present. Only drafts can be renumbered (not sent quotes).

## 5. File names and sending

- PDF file name default: `${quote.number}.pdf` ("OCTUBRE 2026 - 451.pdf"; keep spaces, use the existing `safeName` for slashes/odd chars only). Prosegur Excel: §3. Overrides: `archivo: Nombre` (PDF), `archivo excel: Nombre` (Excel) in choose/review states; stored on the quote (`quote.files?: { pdfName?: string; xlsxName?: string }`) so a resend uses them.
- presentQuote for a Prosegur quote: send the PDF (as today) **and** the Excel as a second WhatsApp document, caption "Formato Prosegur · <fileName>". The review message says both files will be attached to the email.
- `enviar`: `sendQuoteEmail` gets an `attachments` array (PDF + Excel for Prosegur; PDF only otherwise). Recipient = quote email (profile email prefilled; `correo x@y` overrides as today). If no email and the profile has none → ask, as today.

## 6. Stored files + history commands

- New table `quote_files (quote_number text, kind text, file_name text, mime_type text, data text /* base64 */, created_at timestamptz default now(), primary key (quote_number, kind))` in `migrate.ts` (idempotent) and `schema.ts`; `PriceStore.saveQuoteFile({quoteNumber, kind, fileName, mimeType, data})`, `getQuoteFiles(quoteNumber)`, `listQuotes({ company?: string; limit?: number })` (newest first; company match case/accent-insensitive on `data->'customer'->>'company'` — see the `FOLD` helper in pg-store.ts; JsonStore equivalent). Save the exact PDF (+ Excel) when the quote is **sent** (overwrite on resend).
- Commands (any state, they don't disturb an ongoing quote): `cotizaciones` → last 10 of this salesman; `cotizaciones Prosegur` → last 10 for that company (number · date · total · status · items count). `reenviar 451` / `archivos 451` / `pdf 451` → resend the stored files to WhatsApp (if nothing stored, regenerate from the stored quote data). `451` may also be given as the full number "OCTUBRE 2026 - 451".

## 7. Ingestion lock

- `ADMIN_NUMBERS` env (comma-separated digits, e.g. `18605180534`); helper `isAdmin(phone)`. Document in `.env.example` and README. Tony will set it in Vercel.
- When the bot asked "¿De qué proveedor es?" (`state.step === "need_provider"`): accept only (a) a known provider name or alias (the names in `config/providers.json` `providers` + the ones already in the store `listProviders`, matched case/accent-insensitively), (b) `cancelar` (drops the pending file, replies "Cancelado"), (c) `proveedor nuevo: NOMBRE` — admins only; a non-admin gets "Solo el administrador puede registrar proveedores nuevos. Responde con uno conocido (JCH, Steel, Protyres) o *cancelar*." Anything else → repeat the question listing the known providers; **never** create a provider from free text again. Also accept `proveedor: X` with a known X as today.
- Files that look like a quote or a request are refused for ingestion: before ingesting an xlsx/pdf, check its text/cells for the headers `ITEM` + `MEDIDA` + `MARCA` (our own quote format), or `COTIZACIÓN PROVEEDORES` / `Formato Proveedores` / `Nombre de Archivo:` (Prosegur), or a leading `COTIZACI[OÓ]N` title with `Cliente:`/`Atención:` → reply "Esto parece una cotización, no una lista de precios, así que no la cargo. Escríbeme el pedido como texto (llantas con cantidad, cliente, correo…)". Put the detector in `src/lib/ingest/` and unit-test it with the two files in the scratchpad (`/tmp/claude-0/-home-claude-protyres/2a318646-a2a8-5636-b8b2-b74dc360eca9/scratchpad/prosegur/prosegur-451.xlsx` and `seller-451-reference.xlsx` — copy them into `samples/` if useful for tests; they contain no secrets).
- Admin commands: `borrar proveedor NOMBRE` → `PriceStore.deleteProvider(name)` (rows removed, count replied; also clear its sync marks if any); `proveedores` already exists? if not, list providers with row counts. Non-admins get a refusal.

## 8. Tests to add (vitest)

- request.ts: `UB 1830` per line (stripped from the model), `unidad:`/`ub:`/`solicitante:` terms, `número 451` not read as a quantity or size.
- prosegur-xlsx.ts: build a quote with 2 items (use `manualItem` like `scratch/c529pdf.ts`), render, reload with ExcelJS and assert E1, G5, G6, K5, rows 19–20 (A..L), L30 result, the image count (`worksheet.getImages().length === 1`), merged cells count ≥ 30; a 12-item quote throws.
- handler.test.ts: `prosegur` + request without unidad/ub/solicitante → bot asks for them → salesman sends the three lines → options → `número 451` → `ok` → two documents sent (PDF named "OCTUBRE 2026 - 451.pdf", Excel named "151026-…-451.xlsx" using the quote date) → `enviar` → email has 2 attachments → `quote_files` has 2 rows → `reenviar 451` resends 2 documents → `cotizaciones Prosegur` lists it. Next quote of the same salesman gets 452. Lock tests: unknown provider name repeats the question and creates nothing; `proveedor nuevo: X` from a non-admin is refused and from an admin (set `ADMIN_NUMBERS` in the test) works; a Prosegur-format xlsx is refused for ingestion; `borrar proveedor` as admin removes rows.
- Keep every existing test green.

## 9. Deliverables

1. Commits in `/home/claude/protyres` (small, descriptive; end each message with the attribution lines given in the agent brief).
2. `npm run db:migrate` must work for the new table (just add the SQL; Tony runs it on his Mac).
3. `/mnt/user-data/outputs/protyres-v14-prosegur.tgz` containing **every** file added or changed since commit `7a73899` (`git diff --name-only 7a73899 HEAD` + untracked new files such as `config/customers.json`, `config/templates/prosegur-cotizacion.xlsx`, `docs/spec-prosegur.md`, samples). No `.git`, no `node_modules`.
4. `/mnt/user-data/outputs/ejemplo-prosegur.xlsx` + `/mnt/user-data/outputs/ejemplo-prosegur.png` (rendered) + `/mnt/user-data/outputs/ejemplo-prosegur-360.pdf` (the matching 360° PDF) for a 2-item Prosegur quote numbered 451, unidad AYACUCHO, UB 1830, solicitante JOHANN CASTAÑEDA.
5. A final summary: files changed, new commands (exact wording the salesman types), env vars to set, anything left open.
