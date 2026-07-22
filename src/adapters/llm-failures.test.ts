import assert from "node:assert/strict";
import test from "node:test";
import { classifyLlmFailure } from "./llm-failures.js";
import { OpenRouterError } from "./llm.js";

test("auth failures are fail-fast: every model would fail identically", () => {
  assert.deepEqual(classifyLlmFailure(new OpenRouterError(401, "bad key")), { reason: "auth", action: "fail_fast" });
  assert.deepEqual(classifyLlmFailure(new OpenRouterError(403, "forbidden")), { reason: "auth", action: "fail_fast" });
});

test("rate limits and 5xx retry the same model rather than burning a fallback", () => {
  assert.deepEqual(classifyLlmFailure(new OpenRouterError(429, "slow down")), { reason: "rate_limited", action: "retry_same" });
  assert.deepEqual(classifyLlmFailure(new OpenRouterError(500, "oops")), { reason: "upstream_error", action: "retry_same" });
  assert.deepEqual(classifyLlmFailure(new OpenRouterError(503, "unavailable")), { reason: "upstream_error", action: "retry_same" });
});

test("schema/request rejections use a fallback instead of retrying a model that cannot serve them", () => {
  assert.deepEqual(classifyLlmFailure(new OpenRouterError(400, "invalid schema")), { reason: "unsupported_request", action: "use_fallback" });
  assert.deepEqual(classifyLlmFailure(new OpenRouterError(422, "unprocessable")), { reason: "unsupported_request", action: "use_fallback" });
});

test("timeouts use a fallback: a model that did not finish in budget usually will not on a second try", () => {
  const abortError = new DOMException("The operation was aborted.", "TimeoutError");
  assert.deepEqual(classifyLlmFailure(abortError), { reason: "timeout", action: "use_fallback" });
});

test("dropped connections and unparseable bodies retry the same model", () => {
  assert.deepEqual(classifyLlmFailure(new Error("terminated")), { reason: "connection", action: "retry_same" });
  assert.deepEqual(classifyLlmFailure(new Error("fetch failed")), { reason: "connection", action: "retry_same" });
  assert.deepEqual(classifyLlmFailure(new Error("The model did not return valid JSON.")), { reason: "invalid_output", action: "retry_same" });
});

test("an unrecognized error shape falls back rather than looping on the same model", () => {
  assert.deepEqual(classifyLlmFailure("not an error object"), { reason: "unknown", action: "use_fallback" });
});
