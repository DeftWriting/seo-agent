import type { TokenUsage } from "../types.js";
import { recordLlmCost, recordLlmFailure, recordLlmFallback } from "./cost-meter.js";
import { classifyLlmFailure } from "./llm-failures.js";

export class OpenRouterError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

export interface LlmPlugin {
  id: "web";
  engine?: "exa" | "native" | undefined;
  max_results?: number | undefined;
  search_prompt?: string | undefined;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteJsonOptions {
  apiKey: string;
  model: string;
  // Cross-provider on purpose: the one schema rejection this pipeline has hit in practice was one
  // provider refusing a strict JSON schema shape, which a same-provider fallback would fail identically.
  // A fallback only ever runs when the primary attempt fails, so it costs nothing on the normal path.
  fallbackModel?: string | undefined;
  messages: LlmMessage[];
  plugins?: LlmPlugin[] | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  baseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  // A short, stable name for this call's purpose (e.g. "fact_checker", "line_edit", "final_edit"),
  // reported into the active cost meter alongside the pipeline step it ran under. Defaults to "openrouter"
  // when omitted; purely descriptive, never sent to the model.
  costLabel?: string | undefined;
}

export interface LlmJsonResult {
  value: unknown;
  raw: string;
  usage: TokenUsage;
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    server_tool_use_details?: { web_search_requests?: number };
  };
  model?: string;
  error?: { message?: string };
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

export function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced.trim());
      } catch {
        // Fall through to a balanced-object extraction.
      }
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("The model did not return valid JSON.");
  }
}

const DEFAULT_TIMEOUT_MS = 90_000;
const RETRY_BACKOFF_MS = 750;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RequestOptions extends CompleteJsonOptions {
  usePlugins: boolean;
}

async function requestOnce(options: RequestOptions): Promise<LlmJsonResult> {
  const endpoint = `${(options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "")}/chat/completions`;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/deftwriting/seo-agent",
      "X-Title": "Deft SEO Agent",
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0,
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options.usePlugins && options.plugins?.length ? { plugins: options.plugins } : {}),
      response_format: { type: "json_object" },
      // A CLI user pays for their own key directly, so cost is measured on every call, always — unlike
      // the hosted product, where this is opt-in per metered scope (see adapters/cost-meter.ts).
      usage: { include: true },
    }),
    signal,
  });

  const body = (await response.json().catch(() => null)) as OpenRouterResponse | null;
  if (!response.ok) {
    throw new OpenRouterError(response.status, body?.error?.message ?? response.statusText);
  }

  const raw = contentToString(body?.choices?.[0]?.message?.content);
  if (!raw) throw new Error("OpenRouter returned an empty response.");
  const promptTokens = body?.usage?.prompt_tokens ?? 0;
  const completionTokens = body?.usage?.completion_tokens ?? 0;

  recordLlmCost({
    label: options.costLabel ?? "openrouter",
    model: body?.model ?? options.model,
    costUsd: typeof body?.usage?.cost === "number" ? body.usage.cost : null,
    webSearchRequests: body?.usage?.server_tool_use_details?.web_search_requests ?? 0,
    inputTokens: promptTokens,
    outputTokens: completionTokens,
  });

  return {
    value: parseJsonResponse(raw),
    raw,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: body?.usage?.total_tokens ?? promptTokens + completionTokens,
    },
  };
}

export async function completeJson(options: CompleteJsonOptions): Promise<LlmJsonResult> {
  // Each candidate model gets at most two attempts, and only when the first failure was the kind a
  // second identical request could plausibly survive (see classifyLlmFailure). Plugins (web search) are
  // only ever sent to the primary model: the one schema failure this pipeline has hit in practice was a
  // provider rejecting a strict schema alongside server-side tools, so a fallback drops them rather than
  // risk failing the same way twice.
  const candidates =
    options.fallbackModel && options.fallbackModel !== options.model
      ? [options.model, options.fallbackModel]
      : [options.model];
  let firstError: unknown = null;

  for (const [index, model] of candidates.entries()) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const started = Date.now();
      try {
        const result = await requestOnce({ ...options, model, usePlugins: index === 0 });
        if (index > 0) recordLlmFallback();
        return result;
      } catch (error) {
        firstError ??= error;
        const { reason, action } = classifyLlmFailure(error);
        recordLlmFailure({ model, reason, ms: Date.now() - started, attempt });
        if (action === "fail_fast") throw error;
        if (action === "retry_same" && attempt === 1) {
          await delay(RETRY_BACKOFF_MS);
          continue;
        }
        break;
      }
    }
  }
  throw firstError;
}
