/**
 * `npm run llm:check`: comprueba que ANTHROPIC_API_KEY (de .env) sirve para el modelo LLM_MODEL (por defecto el del repo).
 * Hace una llamada mínima y dice OK o el error exacto (401 = clave inválida; 404 = modelo no disponible). Sin la clave, o
 * con LLM_DISABLED=1, lo dice y sale con 1: los reportes y pedidos se interpretan solo por reglas.
 */
import "./env";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, llmAvailable, llmModel } from "../lib/llm/client";

async function main(): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("✗ Falta ANTHROPIC_API_KEY en .env: los reportes se arman solo por reglas.");
    return 1;
  }
  if (!llmAvailable()) {
    console.log("✗ LLM_DISABLED=1: el modelo está apagado a propósito.");
    return 1;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key.startsWith("sk-ant-")) console.log("⚠️  La clave no empieza con «sk-ant-»: probablemente no es una clave de la API de Anthropic.");
  const model = llmModel();
  try {
    const r = await getAnthropic()!.messages.create({ model, max_tokens: 16, messages: [{ role: "user", content: "Responde solo: ok" }] });
    console.log(`✓ Modelo ${r.model} responde (stop_reason ${r.stop_reason}). El reporte por voz/texto usará el modelo.`);
    return 0;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) console.log(`✗ 401: la clave ANTHROPIC_API_KEY no es válida. Pon una clave «sk-ant-…» de console.anthropic.com en .env.`);
    else if (err instanceof Anthropic.NotFoundError) console.log(`✗ 404: el modelo «${model}» no existe o no está disponible para esta clave. Ajusta LLM_MODEL.`);
    else if (err instanceof Anthropic.RateLimitError) console.log("✗ 429: límite de uso; la clave sí funciona, reintenta luego.");
    else if (err instanceof Anthropic.APIError) console.log(`✗ Error ${err.status}: ${err.message}`);
    else console.log(`✗ No pude llamar a la API: ${(err as Error).message}`);
    return 1;
  }
}

main().then((code) => process.exit(code));
