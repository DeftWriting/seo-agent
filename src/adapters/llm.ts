import type { TokenUsage } from "../types.js";

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
  messages: LlmMessage[];
  plugins?: LlmPlugin[] | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  baseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
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
  };
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

export async function completeJson(options: CompleteJsonOptions): Promise<LlmJsonResult> {
  const endpoint = `${(options.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "")}/chat/completions`;
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
      ...(options.plugins?.length ? { plugins: options.plugins } : {}),
      response_format: { type: "json_object" },
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const body = (await response.json().catch(() => null)) as OpenRouterResponse | null;
  if (!response.ok) {
    throw new Error(
      `OpenRouter request failed (${response.status}): ${body?.error?.message ?? response.statusText}`,
    );
  }

  const raw = contentToString(body?.choices?.[0]?.message?.content);
  if (!raw) throw new Error("OpenRouter returned an empty response.");
  const promptTokens = body?.usage?.prompt_tokens ?? 0;
  const completionTokens = body?.usage?.completion_tokens ?? 0;

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
