# Spec addendum: Prosegur contract prices and shorthand (v15)

Builds on `docs/spec-prosegur.md` (already implemented: profile, Prosegur Excel, numbering, stored files, lock). Read that file and the current code first (`src/lib/quote/profiles.ts`, `src/lib/whatsapp/handler.ts` Prosegur flow, `src/lib/quote/request.ts`, `src/lib/settings.ts` customers schema, `config/customers.json`, store files).

Goal: the salesman types three messages and nothing more. Prosegur buys only 3 models under a 2-year contract with fixed prices (net of IGV), all the same size (215/75R17.5 18PR), for every Prosegur unit. The bot must stop asking what it already knows.

```
Vendedor:  prosegur ayacucho 1830
           2 v99
           4 v89
Bot:       (short summary + PDF 360° + Excel Prosegur)
Vendedor:  enviar
```

## 1. Contract items

`config/customers.json`, Prosegur profile, new key:

```json
"contract": {
  "note": "Contrato Prosegur 2 años · precios sin IGV",
  "size": "215/75R17.5",
  "ply": 18,
  "items": [
    { "id": "v99", "aliases": ["v99", "v 99", "valor 99", "mixta", "mixt"], "brand": "Fenixway", "model": "Valor 99", "application": "MIXT", "price": 123.17 },
    { "id": "v89", "aliases": ["v89", "v 89", "valor 89", "posterior", "post", "tracción", "traccion"], "brand": "Fenixway", "model": "Valor 89", "application": "POST", "price": 126.42 },
    { "id": "f77", "aliases": ["f77", "f 77", "flama 77"], "brand": "Fenixway", "model": "Flama 77", "application": null, "price": 116.34 }
  ]
}
```

Items may carry their own `size`/`ply` (default: the contract's). `currency` defaults to USD. Add the schema to `settings.ts` (zod) with sensible defaults.

Runtime overrides live in the DB so prices change without a deploy: table `contract_prices (customer text, item_id text, brand text, model text, size text, ply integer, application text, price numeric(12,2), currency text default 'USD', aliases text /* json array */, updated_by text, updated_at timestamptz default now(), primary key (customer, item_id))` — add to `src/cli/migrate.ts` (idempotent) and `src/db/schema.ts`. `PriceStore.getContractItems(customer)` / `setContractItem(customer, item)` / `deleteContractItem(customer, itemId)` in JsonStore and PgStore. Effective contract = config items merged with DB rows (DB wins per `id`; DB-only ids are extra items). `customer` key = the profile id (`profileId(p)`).

Commands:
- `contrato prosegur` (anyone): lists the effective items — `v99 · Fenixway Valor 99 · 215/75R17.5 18PR · MIXT · US$ 123.17` one per line, plus the note.
- Admin only (`isAdmin`): `contrato prosegur v99 125.50` (price), `contrato prosegur f77 aplicación POST` (application), `contrato prosegur nuevo: f66 = Fenixway Flama 66 215/75R17.5 18PR POST 118.00` (new item; aliases = id + "flama 66"), `contrato prosegur borrar f66`. Non-admins get "Solo el administrador cambia los precios de contrato."

## 2. Shorthand parsing (only when the request belongs to the Prosegur profile)

- Header: `prosegur [unidad…] [ub|u.b.]? [NNNN]` → `unit` = the words after "prosegur" up to a 3–5 digit number or the end of the line ("prosegur ayacucho 1830", "prosegur ayacucho ub 1830", "coti para prosegur ayacucho" → unit Ayacucho; "prosegur" alone → no unit). The 3–5 digit number is the quote-level UB. `unidad:` / `ub:` / `solicitante:` lines keep working.
- Item lines (newline- or comma-separated after the header): a line is a contract line when it contains an alias of an effective item (accent/case-insensitive, word boundaries; aliases with spaces match with any whitespace). Quantity: `x2`, `2 v99`, `v99 2`, `quiero 2`, `2 unds` — any standalone integer that is not the UB (`ub 1845` sets a per-line UB) and not the size token (`215`, `215/75`, `215/75R17.5`, `18pr` are ignored). No quantity → 1. Position words in the line are only hints; the contract item fixes the application. Examples that must parse to [v99 ×2, v89 ×4]: `prosegur ayacucho 1830\n2 v99\n4 v89` · `prosegur ayacucho 1830, 2 v99, 4 v89` · `prosegur ayacucho 1830\n215 mixta v99 quiero 2\n215 posterior v89 quiero 4` · `prosegur ayacucho ub 1830\nv99 x2\nv89 x4 ub 1845` (second item UB 1845).
- A full line on a Prosegur quote that names a contract item by brand + model (`215/75R17.5 18PR Fenixway Valor 99 x2`) is also a contract line.
- Lines that match no contract item fall back to the normal parser (price lists + options) — only those lines go through the options step.

## 3. Contract items in the quote

- New `QuoteItem.origin` value `"contract"`; `provider: "contrato"`; `unitPrice = listPrice = price`, `discountPct = 0`; brand/model/size/ply/application from the item; description `215/75R17.5 18PR FENIXWAY VALOR 99` (same builder as the Excel description); `countryOfOrigin` via `settings.quote.brandOrigin` as today; `ub` per line or quote-level. Summaries show `📑 contrato` instead of a provider.
- When every line is a contract line: **skip the options step** — go straight to `presentQuote` (PDF + Excel). Mixed requests: options only for the non-contract lines, contract lines are pre-chosen (render them as `📑 contrato · US$ 123.17` with no letters).
- `precio 2 130` on a contract item still works (manual override, as today).
- Application unknown (`application: null`, e.g. f77): before building, the bot asks once — `¿Qué aplicación lleva la Flama 77? (MIXT, POST, DEL…)` — the answer (upper case) is saved with `setContractItem` so it is never asked again, then the quote continues. The salesman can still change it per quote with `aplicación N …`.
- Missing unit/UB → ask as today (one message naming only what is missing). Solicitante / atención: reuse the last Prosegur quote **of the same unit** (extend the customer memory lookup with `unit`); if none, ask once for the solicitante; attention defaults to the solicitante's name when no `atención:` was given.

## 4. Shorter messages

Tony's feedback: the bot's texts are too long for the salesman. For Prosegur quotes the summary + review message must fit in ~6 lines:

```
Prosegur · Ayacucho · UB 1830 · solicitante Johann Castañeda
1. 215/75R17.5 18PR Fenixway Valor 99 MIXT x2 · US$ 123.17
2. 215/75R17.5 18PR Fenixway Valor 89 POST x4 · US$ 126.42
Total US$ 752.02 sin IGV · OCTUBRE 2026 - 452 · correo: compras@prosegur.com
Responde *enviar*, o corrige: *precio 2 130*, *cantidad 1 3*, *aplicación 2 MIXT*, *atención: …*, *número 453*, *cancelar*
```

The bare `prosegur` guide becomes 3 lines: header line format, item line format (`2 v99`), `enviar`. Keep the existing long texts for non-Prosegur flows unchanged.

## 5. Tests

- request/profile parsing: the four shorthand examples above, per-line UB, mixed contract + non-contract line, full-line match by brand+model.
- handler: the 3-message flow end to end (prosegur header → contract items → no options → 2 documents → `enviar` → 2 attachments, counter continues); f77 asks for the application once, persists it, second quote doesn't ask; admin `contrato prosegur v99 125.50` changes the next quote's price and non-admin is refused; `contrato prosegur` lists; solicitante remembered per unit.
- Everything existing stays green (`npx vitest run`, `npx tsc --noEmit -p .`).

## 6. Deliverables

- Commits on main (attribution lines as before). Tarball `/mnt/user-data/outputs/protyres-v15-contrato.tgz` with every file added/changed since commit `6ba0ddf` (tracked + new; no .git / node_modules).
- `/mnt/user-data/outputs/ejemplo-prosegur-chat.txt`: the exact bot replies of the 3-message flow, produced by running the handler with the fake WhatsApp client (a small script under `scripts/`, like `scripts/prosegur-sample.ts`), so Tony can show it to the salesman.
- README: a short "Prosegur (contrato)" section with the exact commands.
- Final summary: files, commands, open points.
