import { OpenRouterError } from "./llm.js";

// How a failed OpenRouter call should be answered. The distinction that matters is not "did it fail"
// but "would doing the same thing again plausibly work":
//   retry_same   — the model and request are fine, the attempt was unlucky (rate limit, 5xx, a dropped
//                  connection, or an empty/unparseable body from an otherwise healthy call). Retrying
//                  the SAME model is the highest-value response; switching models throws away a
//                  measured-good model because of a blip.
//   use_fallback — this model cannot serve this request (it rejected the schema or is unavailable), or
//                  it timed out and a second identical try would likely time out again. A different
//                  model, ideally from a different provider family, might succeed.
//   fail_fast    — the request or the configured key is wrong (bad credentials). Every model will fail
//                  identically, so burning a fallback only adds latency.
export type LlmFailureAction = "retry_same" | "use_fallback" | "fail_fast";
export type LlmFailureReason =
  | "timeout"
  | "rate_limited"
  | "upstream_error"
  | "connection"
  | "invalid_output"
  | "unsupported_request"
  | "auth"
  | "unknown";

const CONNECTION_PATTERNS = /terminated|socket|econnreset|econnrefused|network|fetch failed|premature close/i;

export function classifyLlmFailure(error: unknown): { reason: LlmFailureReason; action: LlmFailureAction } {
  if (error instanceof DOMException && error.name === "TimeoutError") return { reason: "timeout", action: "use_fallback" };
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return { reason: "timeout", action: "use_fallback" };
  }

  if (error instanceof OpenRouterError) {
    const status = error.status;
    if (status === 401 || status === 403) return { reason: "auth", action: "fail_fast" };
    if (status === 429) return { reason: "rate_limited", action: "retry_same" };
    if (status >= 500) return { reason: "upstream_error", action: "retry_same" };
    if (status === 400 || status === 404 || status === 422) return { reason: "unsupported_request", action: "use_fallback" };
    // A healthy HTTP call that returned an empty or unparseable body is worth one more roll of the dice.
    return { reason: "invalid_output", action: "retry_same" };
  }

  if (error instanceof Error && CONNECTION_PATTERNS.test(error.message)) return { reason: "connection", action: "retry_same" };
  // JSON/shape validation failure of an otherwise successful response.
  if (error instanceof Error) return { reason: "invalid_output", action: "retry_same" };
  return { reason: "unknown", action: "use_fallback" };
}
