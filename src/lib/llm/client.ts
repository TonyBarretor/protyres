import Anthropic from "@anthropic-ai/sdk";

let cached: Anthropic | null | undefined;

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export function llmModel(): string {
  return process.env.LLM_MODEL || DEFAULT_MODEL;
}

export function llmAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY && process.env.LLM_DISABLED !== "1";
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
 */
export async function structuredCall<T>(params: {
  system: string;
  content: ContentBlock[];
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T | null> {
  const client = getAnthropic();
  if (!client) return null;
  const res = await client.messages.create({
    model: llmModel(),
    max_tokens: params.maxTokens ?? 4096,
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
  });
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") return null;
  return block.input as T;
}
