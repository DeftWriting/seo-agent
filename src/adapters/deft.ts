import type { TokenUsage } from "../types.js";
import { recordDeftCost } from "./cost-meter.js";

export interface GenerateWithDeftOptions {
  apiKey: string;
  prompt: string;
  thinkingLevel?: "faster" | "smarter" | undefined;
  endpoint?: string | undefined;
  signal?: AbortSignal | undefined;
  idempotencyKey?: string | undefined;
}

export interface DeftGenerationResult {
  id: string;
  text: string;
  usage: TokenUsage;
  amountCents?: number | undefined;
}

interface DeftResponse {
  id?: unknown;
  text?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    thinking_tokens?: unknown;
    amount_cents?: unknown;
  };
  error?: { code?: unknown; message?: unknown };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function generateWithDeft(
  options: GenerateWithDeftOptions,
): Promise<DeftGenerationResult> {
  const configuredEndpoint = options.endpoint ?? "https://deftwriting.com";
  const endpoint = configuredEndpoint.endsWith("/v1/generate")
    ? configuredEndpoint
    : `${configuredEndpoint.replace(/\/$/, "")}/v1/generate`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      prompt: options.prompt,
      thinkingLevel: options.thinkingLevel ?? "faster",
      detailMode: "strict",
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = (await response.json().catch(() => null)) as DeftResponse | null;
  if (!response.ok) {
    const message =
      body?.error && typeof body.error.message === "string"
        ? body.error.message
        : response.statusText;
    throw new Error(`Deft generation failed (${response.status}): ${message}`);
  }
  if (typeof body?.id !== "string" || typeof body.text !== "string" || !body.text.trim()) {
    throw new Error("Deft returned an invalid generation response.");
  }

  const input = numberOrZero(body.usage?.input_tokens);
  const output = numberOrZero(body.usage?.output_tokens);
  const thinking = numberOrZero(body.usage?.thinking_tokens);
  const amountCents = numberOrZero(body.usage?.amount_cents) || undefined;
  // Deft's own billed amount is the CLI's other cost source alongside OpenRouter (see cost-meter.ts).
  if (amountCents !== undefined) recordDeftCost(amountCents);
  return {
    id: body.id,
    text: body.text.trim(),
    usage: {
      promptTokens: input,
      completionTokens: output + thinking,
      totalTokens: input + output + thinking,
    },
    amountCents,
  };
}
