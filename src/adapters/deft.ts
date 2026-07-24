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
  text: string;
  usage: TokenUsage;
  amountCents?: number | undefined;
}

// The public POST /v1/generate response is exactly { text, usage: { input_tokens, output_tokens,
// thinking_tokens } } — see https://deftwriting.com/developers. It carries no `id` and no billed
// `amount_cents`; depending on either is what made this adapter throw "invalid generation response" on
// every real response and report Deft cost as $0.00. Only fields documented on that page may appear here.
interface DeftResponse {
  text?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    thinking_tokens?: unknown;
  };
  error?: { code?: unknown; message?: unknown };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Deft's published per-token pricing, in cents (https://deftwriting.com/developers): $2.50 per 1M input
// tokens plus $12 per 1M output-and-thinking tokens, rounded up to the nearest cent. Computed here from
// the public token counts because the public response does not expose a billed amount.
const DEFT_INPUT_CENTS_PER_MILLION = 250;
const DEFT_OUTPUT_CENTS_PER_MILLION = 1200;

function deftCostCents(inputTokens: number, outputTokens: number, thinkingTokens: number): number {
  const raw =
    (inputTokens * DEFT_INPUT_CENTS_PER_MILLION +
      (outputTokens + thinkingTokens) * DEFT_OUTPUT_CENTS_PER_MILLION) /
    1_000_000;
  return Math.ceil(raw);
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
  if (typeof body?.text !== "string" || !body.text.trim()) {
    throw new Error("Deft returned an invalid generation response.");
  }

  const input = numberOrZero(body.usage?.input_tokens);
  const output = numberOrZero(body.usage?.output_tokens);
  const thinking = numberOrZero(body.usage?.thinking_tokens);
  // The public response exposes token counts but not a billed amount, so derive Deft's cost from its
  // published per-token pricing. This is the CLI's other cost source alongside OpenRouter (cost-meter.ts).
  const amountCents = deftCostCents(input, output, thinking);
  if (amountCents > 0) recordDeftCost(amountCents);
  return {
    text: body.text.trim(),
    usage: {
      promptTokens: input,
      completionTokens: output + thinking,
      totalTokens: input + output + thinking,
    },
    amountCents,
  };
}
