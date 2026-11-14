import Anthropic from "@anthropic-ai/sdk";
import { maxTokensFor, meteredModelCall, type UsagePurpose } from "../guard/usage";

let cached: Anthropic | null | undefined;

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export function llmModel(): string {
  return process.env.LLM_MODEL || DEFAULT_MODEL;
}

export function llmAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY && process.env.LLM_DISABLED !== "1";
}

/**
 * Modelo en el cotizador (corrida E): QUOTE_LLM_MODE = off | shadow | on, leído en cada llamada. Por defecto (sin la
 * variable o con otro valor) "shadow". `off` = cero llamadas al modelo para leer pedidos (solo reglas); `shadow` = el
 * vendedor recibe lo mismo que en off y, después de responder, el modelo lee el pedido y solo se registra la diferencia
 * (quote/shadow.ts, tabla quote_shadow); `on` = el modelo refina lo de las reglas, siempre validado
 * (quote/request.ts mergeModelRequest). Una foto / PDF con leyenda de pedido solo se descarga y se lee en `on`.
 */
export type QuoteLlmMode = "off" | "shadow" | "on";
export function quoteLlmMode(env: Record<string, string | undefined> = process.env): QuoteLlmMode {
  const v = (env.QUOTE_LLM_MODE ?? "").trim().toLowerCase();
  return v === "off" || v === "on" ? v : "shadow";
}

export function getAnthropic(): Anthropic | null {
  if (!llmAvailable()) return null;
  if (cached === undefined) cached = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cached;
}

/** For tests: inject a fake client. */
export function __setAnthropicForTests(client: Anthropic | null | undefined): void {
  cached = client;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string } };

/**
 * Ask the model to fill one tool's input schema and return that input as JSON.
 * Forcing `tool_choice` guarantees structured output.
 * Goes through the usage meter (guard/usage.ts): `purpose` names the use for the daily caps and the llm_usage table; a cap
 * reached throws UsageCapExceeded without calling (callers already treat a throw / null as "no model": rules).
 * max_tokens: config `limits.maxTokens[purpose]`, else `maxTokens`, else 4096.
 */
export async function structuredCall<T>(params: {
  purpose: UsagePurpose;
  system: string;
  content: ContentBlock[];
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T | null> {
  const client = getAnthropic();
  if (!client) return null;
  const model = llmModel();
  const res = await meteredModelCall(params.purpose, model, () => client.messages.create({
    model,
    max_tokens: maxTokensFor(params.purpose, params.maxTokens ?? 4096),
    system: params.system,
    tools: [
      {
        name: params.toolName,
        description: params.toolDescription,
        input_schema: params.inputSchema as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: params.toolName },
    messages: [{ role: "user", content: params.content }],
  }));
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") return null;
  return block.input as T;
}
