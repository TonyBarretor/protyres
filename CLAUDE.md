# protyres

Cotizador de llantas por WhatsApp + portal comercial de 360 Tyres (Next.js 16 App Router, TypeScript estricto, Postgres
vía `postgres`, vitest). Especificaciones y estado del portal: `data/prompts-portal/` (ignorado por git; `PROGRESO.md`
lleva el registro de cada corrida).

## Cómo trabajar en este repo

### Reglas del repo
- Explora antes de escribir y reutiliza lo que existe (estilo de `src/lib/store/pg-store.ts`, `src/lib/whatsapp/handler.ts`,
  `src/lib/portal/**`, `src/cli/*.ts`).
- **Nunca ejecutes prettier.** Respeta el estilo: comillas dobles, punto y coma, líneas de hasta ~160 caracteres.
- Node 24. No añadas dependencias si una existente sirve; si añades una, dilo y justifícalo.
- Migraciones solo al final de `STATEMENTS` en `src/cli/migrate.ts`, aditivas e idempotentes (`create table if not
  exists`, `add column if not exists`, `create index if not exists`). Prohibido DROP/TRUNCATE/renombrar/cambiar tipos o
  UPDATE/DELETE sobre tablas existentes.
- No te conectes a la base real (`DATABASE_URL`): todo se prueba con el store JSON/en memoria.
- **El cotizador no cambia de comportamiento**: las pruebas golden (`src/lib/whatsapp/__golden__/`) deben quedar idénticas.
  No cambies precios, orden de opciones ni la selección por defecto sin preguntar.
- Datos de clientes y CSV reales nunca en git: van bajo `data/` (ignorado). Fixtures de prueba pequeños e inventados.
- Arquitectura: lógica en `src/lib/portal/**`, UI en `src/app/portal/**`, CLI en `src/cli/portal-*.ts`, config en
  `config/*.json`. Textos al usuario en español (Perú), tono breve con *negritas* de WhatsApp.
- Commit en la rama de trabajo sin push, salvo que se pida otra cosa.

### Verificación ("en verde")
- `npx vitest run` (hay 1 falla preexistente que depende de `clientdata/`: `quote-detect.test.ts > the client's real
  lists ...`; ignórala), `npx tsc --noEmit -p .`, `npm run build`.
- Guiones del simulador sin errores: `npm run portal:simulate -- --as frank --script scripts/guion-frank.txt` y
  `... --script scripts/guion-voz.txt` (trabajan sobre copias en `out/simulacion/`; `data/` no cambia).
- Modelo de lenguaje: `npm run llm:check` dice si `ANTHROPIC_API_KEY` funciona; si no, los reportes van por reglas y el
  log del bot dice por qué.
- Voz real: `@audio <archivo>` en un guion usa Deepgram de verdad (`DEEPGRAM_API_KEY`); `@voz <texto>` inyecta la
  transcripción. Si el cotizador de Frank quedó a medias en `data/`, empieza el guion con `cancelar`.

### Ciclo de trabajo: buscar, reproducir, corregir, volver a verificar todo
1. **Buscar**: ejercita el sistema de verdad (simulador, audios, navegador) y anota cada error nuevo en `PROGRESO.md`.
2. **Reproducir con una prueba** que falle por ese motivo, antes de tocar el código.
3. **Corregir la causa** (no el síntoma ni el caso puntual) hasta que esa prueba pase.
4. **Volver a verificar todo**, no solo lo que falló: todas las pruebas, tsc, build, los dos guiones y la pasada completa
   de lo que se estaba probando (todos los audios, todas las pantallas).
5. Repite hasta que una pasada completa no muestre errores nuevos.

Límites:
- No debilites ni saltes pruebas. Una prueba existente solo cambia si el comportamiento pedido cambia, y se dice por qué.
- Si un mismo problema no cede tras 4 intentos con enfoques distintos, revierte esos intentos, documenta tu mejor
  hipótesis en `PROGRESO.md` y sigue con lo demás.
- No preguntes salvo que algo exija borrar datos o cambiar precios o la selección por defecto del cotizador.
- Errores de transcripción pura (Deepgram oyó otra cosa) no se arreglan forzando el caso: se resuelven con comparación
  aproximada (`src/lib/portal/voice/fuzzy.ts`) o preguntando al vendedor, y se listan aparte.
